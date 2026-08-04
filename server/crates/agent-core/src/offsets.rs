//! 「どこまで読んだか」の置き場所（設計§8・セルフホスト化設計§6-1）。
//!
//! パーサを差し替えても履歴が欠けないよう、再開位置はセッションホスト側が持つ。置き場所は
//! `$XDG_STATE_HOME/agentdashboard/offsets.json`（[`crate::config::AgentConfig::resolved_state_dir`]）。
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
                });
            entry.path = transcript_path.to_string();
            entry.files.insert(source.to_string(), next_offset);
        }
        self.save();
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
}
