//! 「どこまで読んだか」の置き場所（設計§8・セルフホスト化設計§6-1）。
//!
//! パーサを差し替えても履歴が欠けないよう、再開位置はセッションホスト側が持つ。置き場所は
//! `$XDG_STATE_HOME/agentdashboard/offsets.json`（[`crate::config::SessionHostConfig::resolved_state_dir`]）。
//! 一時ディレクトリやビルド成果物の隣に置いてはいけない——消えた瞬間に全再パースになり、
//! ブラウザへ履歴が二重に届く。
//!
//! # 進めてよいのは「記録に入った」後
//!
//! フェーズ2 まで、位置を書くのは**ノードを配った直後**だった。配る先がメモリの窓
//! だったころはそれで足りたが、記録が DB になり、さらにネットワークを跨ぐようになると
//! 「配った」と「残った」の間が開く。**その間に落ちるとノードが静かに消える。**
//!
//! そこで、位置を進める条件を「記録に入ったことを確かめてから」（＝ack。§6-1）に
//! 揃えた。**ローカルモードも同じ**——保証がモードで食い違うと、ローカルで緑なのに
//! セルフホストで欠ける、という一番たちの悪い形になる。
//!
//! 最悪の場合は同じノードがもう一度届くが、同じIDは上書きされるので害が無い。
//! **欠落より重複を選ぶ。**
//!
//! # 読む側と書く側が別々にいる
//!
//! 監視を頼むとき（[`OffsetStore::resume`]）に読むのはパーサの世話役、記録に入ったと
//! 分かったとき（[`OffsetStore::commit`]）に書くのは報告の運び手。**同じ置き場所を
//! 2人が使う**ので、共有できる形（`Arc` ＋ 内側の錠）にしてある。

use protocol::CardId;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// 記録の形の版。**ノードの形を変えて、古い行が新しい形で出せなくなったら上げる。**
///
/// 上げると、そのカードを次に監視するときに**一度だけ**頭から読み直す（[`OffsetStore::is_stale`]）。
///
/// # なぜ「パーサの版」ではないのか
///
/// 版を上げるたびに読み直すと、**中身が変わっていない版でも全カードを読み直す**ことになる。
/// ここが数えているのは版ではなく**記録の形**で、形が変わったときだけ手で上げる。
///
/// | 版 | 何が変わったか |
/// |---|---|
/// | 0 | この仕組みより前に書かれた位置（`#[serde(default)]` でここへ落ちる） |
/// | 1 | 発言に「誰が入れたか」の名乗りと、スラッシュコマンドの展開が付いた |
pub const TRANSCRIPT_SHAPE: u32 = 1;

/// 永続化する再開位置。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Offsets {
    /// カード → そのセッションのファイルごとの再開位置
    cards: HashMap<String, CardOffsets>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CardOffsets {
    /// 監視している本体トランスクリプトのパス。
    ///
    /// **resume で別ファイルに変わったら、保存済みの位置は使わない**（先頭から読み直す）。
    path: String,
    files: BTreeMap<String, u64>,
    /// この位置を書いた時点の[記録の形の版](TRANSCRIPT_SHAPE)。
    ///
    /// **`#[serde(default)]` は、この欄を知らない版が書いた `offsets.json` を読むため。**
    /// 既定の `0` は「形が付く前に読んだ」を意味し、そのまま**読み直しの対象**になる。
    #[serde(default)]
    shape: u32,
}

/// 再開位置の読み書き。
#[derive(Debug)]
pub struct OffsetStore {
    path: PathBuf,
    state: Mutex<Offsets>,
}

impl OffsetStore {
    /// 置き場所を開く。壊れていたら**既定値として読む**——位置が読めないなら先頭から
    /// 読み直せばよく、ここで起動できなくなるほうが困る。
    pub fn open(dir: PathBuf) -> Arc<Self> {
        let path = dir.join("offsets.json");
        let state = crate::jsonfile::load_or_default(&path);
        Arc::new(Self {
            path,
            state: Mutex::new(state),
        })
    }

    /// 監視を頼むときに渡す「ここから読め」。
    ///
    /// パスが変わっていたら空を返す（＝先頭から）。`/rewind` や resume で別ファイルに
    /// なったのに古い位置から読むと、**書かれていない場所を指したまま何も届かなくなる**。
    pub fn resume(&self, card_id: CardId, path: &str) -> BTreeMap<String, u64> {
        self.state
            .lock()
            .expect("ロックが壊れていない")
            .cards
            .get(&card_id.to_string())
            .filter(|saved| saved.path == path)
            .map(|saved| saved.files.clone())
            .unwrap_or_default()
    }

    /// **記録に入ったことが確かめられたので**位置を進める（設計§6-1）。
    pub fn commit(&self, card_id: CardId, transcript_path: &str, source: &str, next_offset: u64) {
        if next_offset == 0 {
            return;
        }
        {
            let mut state = self.state.lock().expect("ロックが壊れていない");
            let entry = state
                .cards
                .entry(card_id.to_string())
                .or_insert_with(|| CardOffsets {
                    path: transcript_path.to_string(),
                    files: BTreeMap::new(),
                    shape: TRANSCRIPT_SHAPE,
                });
            // **場所が変わったら、読み位置も捨てる。** `path` だけ差し替えて `files` を
            // 残すと、`resume()` が**前のセッションのファイルまで返す**——パーサは
            // それを**このカードの `card_id` で読み続ける**ので、隣のセッションの行が
            // リアルタイムで流れ込む（実測：`offsets.json` に残骸が1件あった）。
            //
            // **`report_transcript_reset` を取り逃がしても効く保険である。** あちらは
            // フックの経路、こちらは読み位置の経路で、**別々に壊れうる**
            if entry.path != transcript_path {
                entry.files.clear();
            }
            entry.path = transcript_path.to_string();
            entry.files.insert(source.to_string(), next_offset);
            // **読んだ結果を書くこの場所が、形の版を刻む唯一の場所である。** 監視を頼む側で
            // 刻むと、読み直す前に「新しい形で読んだ」ことになり、一度も読み直されない
            entry.shape = TRANSCRIPT_SHAPE;
        }
        self.save();
    }

    /// このカードの記録が**古い形のまま**か。真なら頭から読み直す価値がある。
    ///
    /// # 位置を持っていないカードは「古く」ない
    ///
    /// 保存された位置が無い（＝まだ一度も読んでいない／既に忘れた）なら、どのみち頭から
    /// 読むので読み直す必要が無い。**パスが変わっているときも同じ**——[`Self::resume`] が
    /// 空を返すので、放っておいても頭から読まれる。
    ///
    /// **ここで真を返すのは「古い形で最後まで読み終えている」カードだけ**である。
    pub fn is_stale(&self, card_id: CardId, path: &str) -> bool {
        self.state
            .lock()
            .expect("ロックが壊れていない")
            .cards
            .get(&card_id.to_string())
            .filter(|saved| saved.path == path)
            .is_some_and(|saved| saved.shape < TRANSCRIPT_SHAPE)
    }

    /// そのカードの位置を忘れる（巻き戻しと監視の取り止め）。
    ///
    /// 巻き戻し（`/rewind`）で忘れるのは、**同じファイルの続きを読み直す必要がある**ため。
    /// 位置を残したまま先へ進むと、巻き戻した先のやりとりが二度と読まれない。
    pub fn forget(&self, card_id: CardId) {
        {
            let mut state = self.state.lock().expect("ロックが壊れていない");
            if state.cards.remove(&card_id.to_string()).is_none() {
                return;
            }
        }
        self.save();
    }

    fn save(&self) {
        let state = self.state.lock().expect("ロックが壊れていない").clone();
        crate::jsonfile::save(&self.path, &state);
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 履歴の場所が変わったら、**前のセッションの読み位置を捨てる**。
    ///
    /// **捨てないと、隣のセッションが流れ込む。** `path` だけ差し替えて `files` を残すと
    /// `resume()` が前のファイルまで返し、パーサは**このカードの `card_id` で**それを
    /// 読み続ける。実機の `offsets.json` に、実際にその残骸が1件あった。
    #[test]
    fn 履歴の場所が変わったら前の読み位置を捨てる() {
        let dir = temp_dir("switch");
        let store = OffsetStore::open(dir.clone());
        let card = CardId::new();

        store.commit(card, "/p/前.jsonl", "/p/前.jsonl", 100);
        assert_eq!(
            store.resume(card, "/p/前.jsonl").len(),
            1,
            "まず1件覚えていること"
        );

        // ここで `/resume` や `/clear` が起きて、別の JSONL へ移った
        store.commit(card, "/p/後.jsonl", "/p/後.jsonl", 10);

        let 残り = store.resume(card, "/p/後.jsonl");
        assert_eq!(残り.len(), 1, "**前のファイルが残っていないこと**");
        assert!(
            残り.contains_key("/p/後.jsonl"),
            "新しいファイルだけを覚えていること: {残り:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **同じ場所への commit では捨てない。** 読み進めるたびに捨てたら、
    /// サブエージェントのファイルが毎回失われる。
    #[test]
    fn 同じ場所なら読み位置を捨てない() {
        let dir = temp_dir("same");
        let store = OffsetStore::open(dir.clone());
        let card = CardId::new();

        store.commit(card, "/p/主.jsonl", "/p/主.jsonl", 100);
        store.commit(card, "/p/主.jsonl", "/p/主/subagents/子.jsonl", 20);
        store.commit(card, "/p/主.jsonl", "/p/主.jsonl", 300);

        let 残り = store.resume(card, "/p/主.jsonl");
        assert_eq!(残り.len(), 2, "**子のぶんが消えていないこと**: {残り:?}");
        assert_eq!(残り.get("/p/主.jsonl"), Some(&300));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-offsets-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れること");
        dir
    }

    #[test]
    fn 進めた位置を書いて読み直せる() {
        let dir = temp_dir("roundtrip");
        let card_id = CardId::new();
        let store = OffsetStore::open(dir.clone());

        store.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 1234);

        let reopened = OffsetStore::open(dir.clone());
        assert_eq!(reopened.resume(card_id, "/p/s.jsonl")["/p/s.jsonl"], 1234);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 壊れた保存ファイルは既定値として読む() {
        // 位置が読めないなら先頭から読み直せばよい。ここで落ちると起動できなくなる
        let dir = temp_dir("broken");
        std::fs::write(dir.join("offsets.json"), "{壊れている").unwrap();

        let store = OffsetStore::open(dir.clone());
        assert!(store.resume(CardId::new(), "/p/s.jsonl").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn パスが変わったカードは保存位置を使わない() {
        // resume でトランスクリプトが別ファイルに変わったら、先頭から読み直す
        let dir = temp_dir("path");
        let card_id = CardId::new();
        let store = OffsetStore::open(dir.clone());
        store.commit(card_id, "/p/old.jsonl", "/p/old.jsonl", 999);

        assert!(store.resume(card_id, "/p/new.jsonl").is_empty());
        assert_eq!(store.resume(card_id, "/p/old.jsonl")["/p/old.jsonl"], 999);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 巻き戻したら位置を忘れる() {
        let dir = temp_dir("forget");
        let card_id = CardId::new();
        let store = OffsetStore::open(dir.clone());
        store.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 500);

        store.forget(card_id);

        assert!(store.resume(card_id, "/p/s.jsonl").is_empty());
        // 保存先にも残っていない（次の起動でも忘れたまま）
        let reopened = OffsetStore::open(dir.clone());
        assert!(reopened.resume(card_id, "/p/s.jsonl").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn サブエージェントのファイルは別々に持つ() {
        // 1つのカードが複数のファイルを読む（本体＋サブエージェント）。まとめて1つの
        // 位置にすると、片方の進みがもう片方を飛ばす
        let dir = temp_dir("multi");
        let card_id = CardId::new();
        let store = OffsetStore::open(dir.clone());

        store.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 10);
        store.commit(card_id, "/p/s.jsonl", "/p/subagents/a.jsonl", 20);

        let resumed = store.resume(card_id, "/p/s.jsonl");
        assert_eq!(resumed["/p/s.jsonl"], 10);
        assert_eq!(resumed["/p/subagents/a.jsonl"], 20);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 位置0は書かない() {
        // まだ1バイトも読めていない状態を「0 から読め」として保存すると、次の起動で
        // 「保存済み」と見えてしまう。無いことと 0 は区別する
        let dir = temp_dir("zero");
        let card_id = CardId::new();
        let store = OffsetStore::open(dir.clone());

        store.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 0);

        assert!(store.resume(card_id, "/p/s.jsonl").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// この版で読んだカードは、読み直しの対象にならない。
    #[test]
    fn いまの形で読んだ位置は読み直さない() {
        let dir = temp_dir("shape-fresh");
        let card_id = CardId::new();
        let store = OffsetStore::open(dir.clone());

        store.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 10);

        assert!(!store.is_stale(card_id, "/p/s.jsonl"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// **この欄を知らない版が書いた `offsets.json` は、読み直しの対象になる。**
    ///
    /// 実機で起きるのはこの形だけである——欄が無い保存ファイルが既に置いてあり、
    /// そこへ新しい版が繋がる。
    #[test]
    fn 形の欄が無い保存ファイルは読み直しの対象になる() {
        let dir = temp_dir("shape-old");
        let card_id = CardId::new();
        std::fs::create_dir_all(&dir).expect("作れる");
        // **欄を落とした古い形をそのまま書く。** 構造体から作ると、いまの版の既定が
        // 入ってしまい「古い保存ファイル」を再現できない
        std::fs::write(
            dir.join("offsets.json"),
            format!(
                r#"{{"cards":{{"{card_id}":{{"path":"/p/s.jsonl","files":{{"/p/s.jsonl":10}}}}}}}}"#
            ),
        )
        .expect("書ける");
        let store = OffsetStore::open(dir.clone());

        assert!(store.is_stale(card_id, "/p/s.jsonl"), "古い形は読み直す");
        // 位置そのものは読める（読み直しを頼まない経路では、いままでどおり続きから読む）
        assert_eq!(store.resume(card_id, "/p/s.jsonl")["/p/s.jsonl"], 10);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// **古い形の位置が残ったまま読み進めたら、形も新しくなる。**
    ///
    /// 位置を書けるということは**いまのパーサが読んだ**ということなので、形は追随しなければ
    /// ならない。追随させないと、その入れ物は**永久に「古い」と言い続け**、監視を頼むたびに
    /// 読み直しを試みる。
    ///
    /// [`OffsetStore::forget`] を経由する経路では入れ物ごと作り直されるので、ここを踏むのは
    /// **捨てずに読み進めた**とき（元のファイルが無くて読み直しを見送った場合など）である。
    #[test]
    fn 古い形の位置を進めたら形も新しくなる() {
        let dir = temp_dir("shape-follow");
        let card_id = CardId::new();
        std::fs::create_dir_all(&dir).expect("作れる");
        std::fs::write(
            dir.join("offsets.json"),
            format!(
                r#"{{"cards":{{"{card_id}":{{"path":"/p/s.jsonl","files":{{"/p/s.jsonl":10}}}}}}}}"#
            ),
        )
        .expect("書ける");
        let store = OffsetStore::open(dir.clone());
        assert!(store.is_stale(card_id, "/p/s.jsonl"));

        // **忘れずに**進める（入れ物は作り直されない）
        store.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 20);

        assert!(
            !store.is_stale(card_id, "/p/s.jsonl"),
            "読み進めたのに古いままだと、監視のたびに読み直そうとする"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// パスが違えば、放っておいても頭から読まれるので読み直しを頼まない。
    #[test]
    fn 場所が変わったカードは読み直しの対象にしない() {
        let dir = temp_dir("shape-path");
        let card_id = CardId::new();
        std::fs::create_dir_all(&dir).expect("作れる");
        std::fs::write(
            dir.join("offsets.json"),
            format!(
                r#"{{"cards":{{"{card_id}":{{"path":"/p/old.jsonl","files":{{"/p/old.jsonl":10}}}}}}}}"#
            ),
        )
        .expect("書ける");
        let store = OffsetStore::open(dir.clone());

        assert!(!store.is_stale(card_id, "/p/new.jsonl"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 位置を持っていないカードは、どのみち頭から読むので対象にしない。
    #[test]
    fn 位置を持たないカードは読み直しの対象にしない() {
        let dir = temp_dir("shape-none");
        let store = OffsetStore::open(dir.clone());

        assert!(!store.is_stale(CardId::new(), "/p/s.jsonl"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 読み直したあとは、二度目が起きない。
    #[test]
    fn 読み直して位置を書けば二度目は起きない() {
        let dir = temp_dir("shape-once");
        let card_id = CardId::new();
        std::fs::create_dir_all(&dir).expect("作れる");
        std::fs::write(
            dir.join("offsets.json"),
            format!(
                r#"{{"cards":{{"{card_id}":{{"path":"/p/s.jsonl","files":{{"/p/s.jsonl":10}}}}}}}}"#
            ),
        )
        .expect("書ける");
        let store = OffsetStore::open(dir.clone());
        assert!(store.is_stale(card_id, "/p/s.jsonl"));

        // 読み直しは「位置を忘れて、頭から読んで、また書く」形になる
        store.forget(card_id);
        store.commit(card_id, "/p/s.jsonl", "/p/s.jsonl", 10);

        assert!(!store.is_stale(card_id, "/p/s.jsonl"), "二度目は起きない");
        let _ = std::fs::remove_dir_all(dir);
    }
}
