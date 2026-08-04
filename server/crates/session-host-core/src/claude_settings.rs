//! 利用者のグローバル設定 `~/.claude/settings.json` の `model` キーを守る（設計§6）。
//!
//! # なぜダッシュボードがこのファイルを気にするのか
//!
//! `/model <値>` は、CLI にとって「ピッカーで Enter を押した」のと同じ扱いで、
//! **選択を利用者のグローバル設定へ保存する**（v2.1.153 以降）。実測でも
//! `opus[1m]` が `sonnet` へ書き換わるのを確認している（設計§11 前提3）。
//!
//! そしてダッシュボードが起こすセッションは全員がこのファイルを共有する
//! （子プロセスへ渡す環境変数の許可リストに `HOME` が入っているため）。放っておくと
//! 「1つのセッションで切り替えたら、次に起こしたセッションもそのモデルで始まる」に
//! なる。要件が名指しで心配している連動の、いちばん見つけにくい顔である。
//!
//! # 既存の [`crate::settings`] とは別物にしてある
//!
//! | | `settings.rs` | ここ |
//! |---|---|---|
//! | 対象 | PJT の `config.toml` | 利用者の `~/.claude/settings.json` |
//! | 形式 | TOML | JSON |
//! | 書いてよいキー | `always_bypass_permissions` | **`model` だけ** |
//! | 所有者 | このダッシュボード | **利用者と、他の claude プロセス** |
//!
//! 対象の所有者が違うので、同じ関数に相乗りさせない。書いてよいキーを型のレベルで
//! 1つに限定し、他のキーを渡せない形にしてある。
//!
//! # 書き方は「解析して書き直す」ではなく「その場を差し替える」
//!
//! `serde_json` で読んで書き直すと、**キーの並びが辞書順に変わり、インデントも
//! こちらの都合になる**。利用者のファイルを預かっている以上それは実害なので、
//! 生のテキストから `"model"` の値の範囲だけを見つけて差し替える。触らなかった
//! バイトは1つも動かない。`settings.rs` が `toml_edit` でやっていることの JSON 版。

use protocol::ModelId;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 書き換えてよい唯一のキー。**ここを増やしてはいけない。**
const MODEL_KEY: &str = "model";

/// 回復の結果。呼び出し側はログに出すだけだが、テストからは判定に使う。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    /// こちらが汚したので、覚えている値へ戻した
    Restored { to: Option<ModelId> },
    /// 利用者が自分で変えたものだったので、戻さず新しい既定として覚え直した
    Adopted { model: Option<ModelId> },
    /// 汚れていなかった（切替が保存されなかった等）
    Clean,
    /// ファイルが無い・壊れている・権限が無い。**何もしない**
    Skipped { reason: String },
    /// 書き込みに失敗した。以後グローバル既定を読みに行かなくなる
    Failed { reason: String },
}

/// 覚えている状態。
#[derive(Debug, Default, Clone)]
struct Remembered {
    /// 利用者の既定モデル。**注入する値であり、回復で戻す先でもある**。
    /// `None` は「利用者が指定していない」で、そのときは何も注入しない
    default_model: Option<ModelId>,
    /// 一度でも読めたか。読めていないうちは注入の判断ができない
    loaded: bool,
    /// 回復に失敗している。`true` の間は**グローバル既定を読みに行かない**
    /// （汚れた値を利用者の既定として取り込まないため）
    broken: bool,
}

/// 利用者のグローバル設定の見張り役。
pub struct ClaudeSettings {
    path: PathBuf,
    /// **切替と回復の一連をプロセス全体で直列化する**（設計§6）。
    ///
    /// セッションごとではなくプロセス全体で1本にするのは、対象がプロセスに1つしか
    /// 無いファイルだから。直列化しないと、2本が同時に切り替えたときに
    /// 「B が A の切替先を元の値だと思い込む」→「元の値が二度と戻らない」が起きる。
    /// 「読んだ時点と違ったら書かない」という自衛だけでは、汚染を防ぐのではなく
    /// **汚染を固定する**ことになる。
    ///
    /// 切替は人が押す操作なので、直列化しても実害は無い。
    switch_lock: tokio::sync::Mutex<()>,
    /// 切替の一連が走っている間だけ立つ。
    ///
    /// **セッションの起動は同期の経路で、非同期のロックを取れない。** そのため
    /// [`Self::refresh_default`] は「ロックを待つ」代わりに「立っていたら読みに行かない」で
    /// 身を守る。切替中のファイルには CLI が書いた汚れた値が入っているので、
    /// そのまま読むと**それを利用者の既定として取り込んでしまう**（設計§6 の4手の別経路）。
    switching: std::sync::atomic::AtomicBool,
    state: Mutex<Remembered>,
}

impl ClaudeSettings {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            switch_lock: tokio::sync::Mutex::new(()),
            switching: std::sync::atomic::AtomicBool::new(false),
            state: Mutex::new(Remembered::default()),
        }
    }

    /// 既定の置き場所（`$HOME/.claude/settings.json`）を見に行く。
    pub fn discover() -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        Self::new(PathBuf::from(home).join(".claude").join("settings.json"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 切替の一連を包むロックを取る。
    ///
    /// 呼び出し側はこのガードを持ったまま「送る → 確定を待つ → 回復する」を行う。
    /// ガードを落とすまで、他のセッションの切替は待たされる。
    pub async fn lock_switch(&self) -> SwitchGuard<'_> {
        let guard = self.switch_lock.lock().await;
        self.switching
            .store(true, std::sync::atomic::Ordering::SeqCst);
        SwitchGuard {
            owner: self,
            _guard: guard,
        }
    }

    /// いまのグローバル既定を読み直して覚える。セッションを起こすたびに呼ぶ。
    ///
    /// **回復に失敗している間は読みに行かない。** 汚れた値をそのまま「利用者の既定」
    /// として取り込むと、以後ずっと汚れた値を注入し続けることになる。
    pub fn refresh_default(&self) -> Option<ModelId> {
        // 切替中のファイルには CLI が書いた汚れた値が入っている。**読んではいけない。**
        if self.switching.load(std::sync::atomic::Ordering::SeqCst) {
            return self.remembered_default();
        }
        {
            let state = self.state.lock().expect("ロックが壊れていない");
            if state.broken {
                return state.default_model.clone();
            }
        }

        match self.read_model() {
            Ok(model) => {
                let mut state = self.state.lock().expect("ロックが壊れていない");
                state.default_model = model.clone();
                state.loaded = true;
                model
            }
            // 読めないときは覚えている値を使う。作りに行かない
            Err(reason) => {
                tracing::debug!(
                    path = %self.path.display(),
                    "利用者のグローバル設定を読めませんでした（何もしません）: {reason}"
                );
                self.state
                    .lock()
                    .expect("ロックが壊れていない")
                    .default_model
                    .clone()
            }
        }
    }

    /// 覚えている既定。読みに行かない。
    pub fn remembered_default(&self) -> Option<ModelId> {
        self.state
            .lock()
            .expect("ロックが壊れていない")
            .default_model
            .clone()
    }

    /// 回復に失敗した状態か。
    pub fn is_broken(&self) -> bool {
        self.state.lock().expect("ロックが壊れていない").broken
    }

    /// 切替のあと、汚れたグローバル既定を元へ戻す（設計§6 の副の仕掛け）。
    ///
    /// # 判断
    ///
    /// > グローバル既定が、**ダッシュボードが直近に切り替えた値で説明が付く**なら、
    /// > こちらが起こした汚染とみなして覚えている値へ戻す。
    /// > 説明が付かなければ**利用者が自分で変えたもの**とみなし、戻さずに覚え直す。
    ///
    /// この区別が要るのは、**利用者が意図して変えた既定をダッシュボードが勝手に
    /// 取り消してはいけない**から。稀に「利用者の変更先」と「こちらの切替先」が偶然
    /// 一致して誤って戻すことがあるが、そのときは覚え直しの経路に乗るので次で追いつく。
    ///
    /// # 「説明が付く」は厳密一致ではない
    ///
    /// CLI は送った別名をそのまま保存するとは限らない（`opus` → `opus[1m]` を実測。
    /// 設計§11）。**厳密一致で見ると、正規化された値を「利用者が変えたもの」と
    /// 読み違えて汚染を採用してしまう。** 何を説明が付くとみなすかは
    /// [`explains_pollution`] にまとめてある。`resolved` は送った別名の解決先で、
    /// [`crate::model_aliases::ModelAliases::resolve`] から渡す。
    ///
    /// # 戻した値がそのまま残るとは限らない
    ///
    /// 戻したあとにも同じ正規化が起きる。意味は同じなので追いかけない。
    /// 「戻したのに一致しない」を異常として扱わないこと。
    pub fn recover(&self, switched_to: &ModelId, resolved: Option<&ModelId>) -> Recovery {
        // 回復に失敗している間は**読みに行かない**。[`Self::refresh_default`] と揃える。
        // ここだけ読むと、隔離したはずの汚れた値を「利用者が変えた」として取り込む
        if self.is_broken() {
            return Recovery::Skipped {
                reason: "回復に失敗した状態なので読みに行きません".to_string(),
            };
        }
        let current = match self.read_model() {
            Ok(current) => current,
            Err(reason) => return Recovery::Skipped { reason },
        };

        let restore_to = self.remembered_default();
        // 覚えている値のままなら、戻すことも覚え直すことも無い。
        // **汚染かどうかを判断する前に片付く**ので、以降の分岐は「動いた」場合だけを見る
        if current == restore_to {
            return Recovery::Clean;
        }

        if !explains_pollution(current.as_ref(), switched_to, resolved) {
            // 利用者が自分で変えた
            let mut state = self.state.lock().expect("ロックが壊れていない");
            tracing::info!(
                path = %self.path.display(),
                "グローバル既定が利用者によって変わっていたので、新しい既定として覚えます: {:?} -> {:?}",
                state.default_model.as_ref().map(ModelId::as_str),
                current.as_ref().map(ModelId::as_str),
            );
            state.default_model = current.clone();
            state.loaded = true;
            return Recovery::Adopted { model: current };
        }

        // **書く前の値をログに残す。** 事故が起きたときに手で戻せるようにする（設計§9）
        tracing::info!(
            path = %self.path.display(),
            "モデル切替でグローバル既定が汚れたので戻します: {:?} -> {:?}",
            current.as_ref().map(ModelId::as_str),
            restore_to.as_ref().map(ModelId::as_str),
        );

        match self.write_model(restore_to.as_ref()) {
            Ok(()) => {
                self.state.lock().expect("ロックが壊れていない").broken = false;
                Recovery::Restored { to: restore_to }
            }
            Err(reason) => {
                // 回復に失敗しても切替そのものは成功として扱う。ただし失敗した状態を
                // 覚えておき、以後グローバル既定を読みに行かない（設計§9）
                self.state.lock().expect("ロックが壊れていない").broken = true;
                tracing::warn!(
                    path = %self.path.display(),
                    "グローバル既定を戻せませんでした。以後は覚えている値を使います: {reason}"
                );
                Recovery::Failed { reason }
            }
        }
    }

    /// `model` キーを読む。**ファイルが無い・壊れているときは `Err`。**
    fn read_model(&self) -> Result<Option<ModelId>, String> {
        let text = std::fs::read_to_string(&self.path).map_err(|err| err.to_string())?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|err| format!("JSON として読めません: {err}"))?;
        Ok(value
            .get(MODEL_KEY)
            .and_then(serde_json::Value::as_str)
            .map(ModelId::new))
    }

    /// `model` キーだけを書き換える。`None` ならキーごと消す。
    fn write_model(&self, model: Option<&ModelId>) -> Result<(), String> {
        let text = std::fs::read_to_string(&self.path).map_err(|err| err.to_string())?;
        // 書く前に必ず読めることを確かめる。壊れたファイルに追い打ちをかけない
        serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|err| format!("JSON として読めません（書き換えを中止します）: {err}"))?;

        let updated = set_top_level_string(&text, MODEL_KEY, model.map(ModelId::as_str))?;
        // 書いた結果が JSON として読めることも確かめてから置き換える
        serde_json::from_str::<serde_json::Value>(&updated)
            .map_err(|err| format!("書き換えた結果が JSON になりませんでした: {err}"))?;

        std::fs::write(&self.path, updated).map_err(|err| err.to_string())
    }
}

/// 切替の一連を包むガード。落ちると「切替中」の印も下りる。
pub struct SwitchGuard<'a> {
    owner: &'a ClaudeSettings,
    _guard: tokio::sync::MutexGuard<'a, ()>,
}

impl Drop for SwitchGuard<'_> {
    fn drop(&mut self) {
        self.owner
            .switching
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// ファイルにある値が、こちらの切替で説明が付くか（設計§6 の回復の判断）。
///
/// 説明が付くとみなすのは次の3つ。**厳密一致だけを見てはいけない。**
///
/// | 形 | 例 | なぜ |
/// |---|---|---|
/// | 送った別名と同じ | `opus` ← `opus` | いちばん普通の姿 |
/// | 送った別名の解決先 | `claude-opus-5` ← `opus` | CLI がフルIDで保存した場合 |
/// | キーが消えた＋送ったのが `default` | なし ← `default` | 指定を消す操作なので、消えるのが正しい |
///
/// 比べるのは**角括弧より前**だけ。CLI が `opus` を `opus[1m]` へ正規化して保存する
/// のを実測しており（設計§11）、そのまま比べると一致しない。
///
/// # 迷ったら「説明が付く」側へ倒す
///
/// 汚染を利用者の既定として採用すると、**元の値がファイルからもメモリからも消える**。
/// 誤って戻した場合は覚え直しの経路で次の切替に追いつくので、損害が非対称である。
fn explains_pollution(
    current: Option<&ModelId>,
    switched_to: &ModelId,
    resolved: Option<&ModelId>,
) -> bool {
    let Some(current) = current else {
        // キーごと消えている。指定を消す操作を送ったときだけ、こちらの仕業と言える
        return switched_to.as_str() == ModelId::DEFAULT;
    };
    same_model(current, switched_to)
        || resolved.is_some_and(|resolved| same_model(current, resolved))
}

/// 綴りの違いを無視して同じモデルを指しているか。
fn same_model(left: &ModelId, right: &ModelId) -> bool {
    base_name(left) == base_name(right)
}

/// 角括弧の修飾（`[1m]` など）を落とした部分。
fn base_name(model: &ModelId) -> &str {
    model
        .as_str()
        .split_once('[')
        .map_or(model.as_str(), |(base, _)| base)
}

/// トップレベルの文字列キーを差し替える。`value` が `None` ならキーごと消す。
///
/// 触らなかったバイトは1つも動かさない。並び順・インデント・改行はそのまま残る。
fn set_top_level_string(text: &str, key: &str, value: Option<&str>) -> Result<String, String> {
    match find_top_level_key(text, key) {
        Some(span) => Ok(match value {
            Some(value) => {
                let mut out = String::with_capacity(text.len() + value.len());
                out.push_str(&text[..span.value_start]);
                out.push_str(&encode_json_string(value));
                out.push_str(&text[span.value_end..]);
                out
            }
            None => remove_span(text, &span),
        }),
        None => match value {
            // 元から無いキーを消す指示なら、何もしないのが正しい
            None => Ok(text.to_string()),
            Some(value) => insert_top_level(text, key, value),
        },
    }
}

/// トップレベルのキー1つ分の範囲。
#[derive(Debug, PartialEq, Eq)]
struct KeySpan {
    /// キーの `"` の位置
    key_start: usize,
    /// 値の開始
    value_start: usize,
    /// 値の終端（この位置は含まない）
    value_end: usize,
}

/// トップレベル（深さ1）にあるキーを探す。入れ子の中の同名キーは拾わない。
fn find_top_level_key(text: &str, key: &str) -> Option<KeySpan> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => {
                depth += 1;
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            b'"' => {
                let start = index;
                let end = scan_string(bytes, index)?;
                // 深さ1の文字列のうち、直後が `:` のものだけがキー
                if depth == 1 {
                    let after = skip_whitespace(bytes, end);
                    if after < bytes.len() && bytes[after] == b':' {
                        let name = &text[start + 1..end - 1];
                        let value_start = skip_whitespace(bytes, after + 1);
                        let value_end = scan_value(bytes, value_start)?;
                        if name == key {
                            return Some(KeySpan {
                                key_start: start,
                                value_start,
                                value_end,
                            });
                        }
                        index = value_end;
                        continue;
                    }
                }
                index = end;
            }
            _ => index += 1,
        }
    }
    None
}

/// `"` から始まる文字列の終端（閉じ `"` の次）を返す。
fn scan_string(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

/// 値1つ分の終端を返す。
fn scan_value(bytes: &[u8], start: usize) -> Option<usize> {
    if start >= bytes.len() {
        return None;
    }
    match bytes[start] {
        b'"' => scan_string(bytes, start),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut index = start;
            while index < bytes.len() {
                match bytes[index] {
                    b'"' => index = scan_string(bytes, index)?,
                    b'{' | b'[' => {
                        depth += 1;
                        index += 1;
                    }
                    b'}' | b']' => {
                        depth -= 1;
                        index += 1;
                        if depth == 0 {
                            return Some(index);
                        }
                    }
                    _ => index += 1,
                }
            }
            None
        }
        // 数値・true・false・null。区切りに当たるまで
        _ => {
            let mut index = start;
            while index < bytes.len() && !matches!(bytes[index], b',' | b'}' | b']') {
                index += 1;
            }
            // 末尾の空白は値に含めない
            while index > start && bytes[index - 1].is_ascii_whitespace() {
                index -= 1;
            }
            Some(index)
        }
    }
}

fn skip_whitespace(bytes: &[u8], from: usize) -> usize {
    let mut index = from;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

/// キー1つ分を、前後どちらかのカンマごと取り除く。
///
/// # 行を占めているなら行ごと消す
///
/// 手前の改行とインデントを残すと、**空白だけの行が1本残る**。元々 `model` キーを
/// 持たない利用者は切替のたびに「挿す→消す」を繰り返すので、そのままだと
/// **切替1回につき1行ずつファイルが伸びていく**。「触らなかったバイトは1つも
/// 動かない」という約束は、消したあとの形にも掛かっている。
fn remove_span(text: &str, span: &KeySpan) -> String {
    let bytes = text.as_bytes();

    // 後ろにカンマがあればそれごと消す（残ると `,}` になって壊れる）
    let after = skip_whitespace(bytes, span.value_end);
    if after < bytes.len() && bytes[after] == b',' {
        let end = after + 1;
        return match whole_line(bytes, span.key_start, end) {
            // 行ごと消す。**残りには手を付けない** — 次の行のインデントは
            // その行のものであって、消したキーの後始末ではない
            Some((start, end)) => format!("{}{}", &text[..start], &text[end..]),
            // 1行に複数のキーが並ぶ書式。行ごと消すと巻き添えになるので、
            // キーからカンマまでを抜いて、詰まった先頭の空白だけ落とす
            None => format!(
                "{}{}",
                &text[..span.key_start],
                text[end..].trim_start_matches([' ', '\t'])
            ),
        };
    }

    // 最後の要素だった。前のカンマを消す
    let mut before = span.key_start;
    while before > 0 && bytes[before - 1].is_ascii_whitespace() {
        before -= 1;
    }
    if before > 0 && bytes[before - 1] == b',' {
        return format!("{}{}", &text[..before - 1], &text[span.value_end..]);
    }

    // 手前にカンマが無い＝これが唯一のキーだった。**中身の空白ごと落として `{}` に戻す。**
    // ここを残すと、空のオブジェクトでも「挿す→消す」のたびに改行が1つずつ増える
    let rest = skip_whitespace(bytes, span.value_end);
    format!("{}{}", &text[..before], &text[rest..])
}

/// キーが自分の行を占めているなら、消すべき範囲を「手前のインデントから行末の改行まで」で返す。
///
/// 占めていない（同じ行に他のキーがある）ときは `None`。
fn whole_line(bytes: &[u8], key_start: usize, entry_end: usize) -> Option<(usize, usize)> {
    let line_start = bytes[..key_start]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |at| at + 1);
    // 行頭からキーまでがインデントだけであること
    if !bytes[line_start..key_start]
        .iter()
        .all(|byte| matches!(byte, b' ' | b'\t'))
    {
        return None;
    }
    // 行末までに他の中身が無いこと
    let mut end = entry_end;
    while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b'\n' {
        end += 1;
    } else if end < bytes.len() {
        return None;
    }
    Some((line_start, end))
}

/// トップレベルの先頭へキーを1つ挿す。
fn insert_top_level(text: &str, key: &str, value: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let open = text
        .find('{')
        .ok_or_else(|| "JSON オブジェクトではありません".to_string())?;
    let after = skip_whitespace(bytes, open + 1);

    // 空のオブジェクトならカンマは要らない
    let empty = after < bytes.len() && bytes[after] == b'}';
    // 既存の行のインデントを真似る。読めなければ2スペース
    let indent = text[open + 1..]
        .lines()
        .nth(1)
        .map(|line| {
            line.chars()
                .take_while(|ch| *ch == ' ' || *ch == '\t')
                .collect::<String>()
        })
        .filter(|indent| !indent.is_empty())
        .unwrap_or_else(|| "  ".to_string());

    let entry = format!(
        "\n{indent}{}: {}{}",
        encode_json_string(key),
        encode_json_string(value),
        if empty { "\n" } else { "," }
    );
    let mut out = String::with_capacity(text.len() + entry.len());
    out.push_str(&text[..open + 1]);
    out.push_str(&entry);
    out.push_str(&text[open + 1..]);
    Ok(out)
}

fn encode_json_string(value: &str) -> String {
    serde_json::Value::String(value.to_string()).to_string()
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 実物に近い形。キーの並びは辞書順ではない
    const SAMPLE: &str = r#"{
  "permissions": {
    "defaultMode": "auto",
    "model": "この入れ子は触ってはいけない"
  },
  "model": "claude-fable-5[1m]",
  "effortLevel": "xhigh",
  "enabledPlugins": {
    "context7@claude-plugins-official": true
  }
}
"#;

    fn model_of(text: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(text)
            .unwrap()
            .get("model")
            .and_then(|value| value.as_str())
            .map(str::to_string)
    }

    #[test]
    fn 値だけが差し替わり他のキーも並びも変わらない() {
        let updated = set_top_level_string(SAMPLE, "model", Some("opus")).unwrap();
        assert_eq!(model_of(&updated).as_deref(), Some("opus"));

        // 触っていない部分がバイト単位で残っていること
        assert_eq!(
            updated,
            SAMPLE.replace(r#""claude-fable-5[1m]""#, r#""opus""#)
        );
    }

    #[test]
    fn 入れ子の同名キーは巻き込まない() {
        // `permissions.model` を書き換えてしまうと、利用者の設定が壊れる
        let updated = set_top_level_string(SAMPLE, "model", Some("opus")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(
            parsed["permissions"]["model"],
            "この入れ子は触ってはいけない"
        );
        assert_eq!(parsed["permissions"]["defaultMode"], "auto");
        assert_eq!(parsed["effortLevel"], "xhigh");
        assert_eq!(
            parsed["enabledPlugins"]["context7@claude-plugins-official"],
            true
        );
    }

    #[test]
    fn キー無しへ戻すとキーごと消える() {
        // 元が「指定なし」だった利用者には、指定なしの状態を返す
        let updated = set_top_level_string(SAMPLE, "model", None).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert!(parsed.get("model").is_none(), "実際: {updated}");
        assert_eq!(parsed["effortLevel"], "xhigh");
        assert_eq!(parsed["permissions"]["defaultMode"], "auto");
    }

    #[test]
    fn 末尾のキーを消してもカンマが残らない() {
        let text = "{\n  \"a\": 1,\n  \"model\": \"opus\"\n}\n";
        let updated = set_top_level_string(text, "model", None).unwrap();
        serde_json::from_str::<serde_json::Value>(&updated)
            .unwrap_or_else(|err| panic!("JSON として読めること: {err}\n{updated}"));
        assert!(!updated.contains("model"));
    }

    #[test]
    fn 元から無いキーは挿し込まれる() {
        let text = "{\n  \"effortLevel\": \"xhigh\"\n}\n";
        let updated = set_top_level_string(text, "model", Some("sonnet")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(parsed["model"], "sonnet");
        assert_eq!(parsed["effortLevel"], "xhigh");
    }

    #[test]
    fn 空のオブジェクトにも挿せる() {
        let updated = set_top_level_string("{}", "model", Some("haiku")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert_eq!(parsed["model"], "haiku");
    }

    #[test]
    fn 元から無いキーを消す指示では何も変わらない() {
        let text = "{\n  \"effortLevel\": \"xhigh\"\n}\n";
        assert_eq!(set_top_level_string(text, "model", None).unwrap(), text);
    }

    #[test]
    fn 記号を含む値も壊れない() {
        let updated = set_top_level_string(SAMPLE, "model", Some(r#"変な"値\"#)).unwrap();
        assert_eq!(model_of(&updated).as_deref(), Some(r#"変な"値\"#));
    }

    #[test]
    fn 挿してから消すと元のバイト列に戻る() {
        // 元から `model` を持たない利用者は、切替のたびに「挿す→消す」を繰り返す。
        // 1バイトでもずれると、それが切替の回数だけ積み上がる
        for original in [
            "{\n  \"effortLevel\": \"xhigh\"\n}\n",
            "{\n  \"a\": 1,\n  \"b\": 2\n}\n",
            "{}",
        ] {
            let inserted = set_top_level_string(original, "model", Some("sonnet")).unwrap();
            let removed = set_top_level_string(&inserted, "model", None).unwrap();
            assert_eq!(removed, original, "挿し込み後: {inserted:?}");
        }
    }

    #[test]
    fn 挿す消すを繰り返してもファイルが伸びない() {
        // 空白だけの行が1本ずつ増えていくのが、この不具合の見え方だった
        for original in ["{\n  \"effortLevel\": \"xhigh\"\n}\n", "{}", "{\"a\":1}"] {
            let mut text = original.to_string();
            let mut lengths = Vec::new();
            for _ in 0..3 {
                text = set_top_level_string(&text, "model", Some("sonnet")).unwrap();
                text = set_top_level_string(&text, "model", None).unwrap();
                lengths.push(text.len());
            }
            assert!(
                lengths.windows(2).all(|pair| pair[0] == pair[1]),
                "{original:?} で伸びた: {lengths:?}\n{text:?}"
            );
        }
    }

    #[test]
    fn 一行に詰めた書式では隣のキーを巻き込まない() {
        // 行ごと消してよいのは、キーがその行を占めているときだけ
        let text = r#"{"a": 1, "model": "opus", "b": 2}"#;
        let updated = set_top_level_string(text, "model", None).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&updated).unwrap();
        assert!(parsed.get("model").is_none(), "実際: {updated}");
        assert_eq!(parsed["a"], 1);
        assert_eq!(parsed["b"], 2);
    }

    #[test]
    fn 消したあとに空白だけの行が残らない() {
        for text in [
            SAMPLE,
            "{\n  \"model\": \"opus\",\n  \"a\": 1\n}\n",
            "{\n  \"a\": 1,\n  \"model\": \"opus\"\n}\n",
        ] {
            let updated = set_top_level_string(text, "model", None).unwrap();
            serde_json::from_str::<serde_json::Value>(&updated)
                .unwrap_or_else(|err| panic!("JSON として読めること: {err}\n{updated}"));
            assert!(
                !updated
                    .lines()
                    .any(|line| line.trim().is_empty() && !line.is_empty()),
                "空白だけの行が残った: {updated:?}"
            );
        }
    }

    // ---- 汚染の判定（A-2）--------------------------------------------------------

    #[test]
    fn 正規化された綴りも自分の汚染として見分ける() {
        // CLI は送った別名をそのまま保存するとは限らない（設計§11）。
        // ここを厳密一致で見ると、汚染を「利用者が変えたもの」として採用してしまう
        let sent = ModelId::new("opus");
        assert!(explains_pollution(
            Some(&ModelId::new("opus[1m]")),
            &sent,
            None
        ));
        assert!(explains_pollution(Some(&ModelId::new("opus")), &sent, None));
        // 逆向き（修飾付きを送って、修飾なしで保存された）も同じ
        assert!(explains_pollution(
            Some(&ModelId::new("opus")),
            &ModelId::new("opus[1m]"),
            None
        ));
    }

    #[test]
    fn フルIDで保存されていても自分の汚染として見分ける() {
        assert!(explains_pollution(
            Some(&ModelId::new("claude-opus-5")),
            &ModelId::new("opus"),
            Some(&ModelId::new("claude-opus-5")),
        ));
        // 解決先を覚えていなければ言い当てられない。**そのときは覚え直す側へ落ちる**
        assert!(!explains_pollution(
            Some(&ModelId::new("claude-opus-5")),
            &ModelId::new("opus"),
            None,
        ));
    }

    #[test]
    fn 指定を消す切替ではキーが消えるのが正しい姿() {
        assert!(explains_pollution(None, &ModelId::new("default"), None));
        // 別のモデルを送ったのにキーが消えたなら、それは利用者の操作
        assert!(!explains_pollution(None, &ModelId::new("opus"), None));
    }

    #[test]
    fn 別のモデルへ変わっていたら自分の汚染とはみなさない() {
        assert!(!explains_pollution(
            Some(&ModelId::new("opus[1m]")),
            &ModelId::new("sonnet"),
            Some(&ModelId::new("claude-sonnet-5")),
        ));
    }

    // ---- ファイルを相手にする側 ------------------------------------------------

    /// 既存の `settings.rs` のテストと同じ作法。依存を増やさない。
    ///
    /// **本物の `~/.claude/settings.json` は絶対に対象にしない。** テストが壊れたときに
    /// 利用者の設定が巻き添えになる経路を、そもそも作らない。
    fn temp_settings(label: &str, body: &str) -> (PathBuf, ClaudeSettings) {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-claude-settings-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, body).expect("書けること");
        let store = ClaudeSettings::new(path);
        (dir, store)
    }

    #[test]
    fn こちらが切り替えた値なら覚えている値へ戻す() {
        let (_dir, store) = temp_settings("restore", SAMPLE);
        // 起動時に読んで覚える
        assert_eq!(
            store.refresh_default(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );

        // CLI が /model sonnet で汚した状態を作る
        store.write_model(Some(&ModelId::new("sonnet"))).unwrap();

        let outcome = store.recover(&ModelId::new("sonnet"), None);
        assert_eq!(
            outcome,
            Recovery::Restored {
                to: Some(ModelId::new("claude-fable-5[1m]"))
            }
        );
        assert_eq!(
            store.read_model().unwrap(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
    }

    #[test]
    fn cliが正規化して保存しても覚えている値へ戻す() {
        // **A-2。** 送った別名と保存された綴りが違うだけで「利用者が変えた」と読み違えると、
        // 汚染をそのまま新しい既定として採用し、以後すべての新規セッションへ注入し続ける
        let (_dir, store) = temp_settings("normalized", SAMPLE);
        store.refresh_default();

        // /model opus を送ったら opus[1m] で保存された（設計§11 で実測した形）
        store.write_model(Some(&ModelId::new("opus[1m]"))).unwrap();

        assert_eq!(
            store.recover(&ModelId::new("opus"), None),
            Recovery::Restored {
                to: Some(ModelId::new("claude-fable-5[1m]"))
            }
        );
        assert_eq!(
            store.read_model().unwrap(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
        assert_eq!(
            store.remembered_default(),
            Some(ModelId::new("claude-fable-5[1m]")),
            "汚れた値を利用者の既定として覚えてはいけない"
        );
    }

    #[test]
    fn フルidで保存されていても覚えている値へ戻す() {
        let (_dir, store) = temp_settings("fullid", SAMPLE);
        store.refresh_default();
        store
            .write_model(Some(&ModelId::new("claude-opus-5")))
            .unwrap();

        assert_eq!(
            store.recover(&ModelId::new("opus"), Some(&ModelId::new("claude-opus-5"))),
            Recovery::Restored {
                to: Some(ModelId::new("claude-fable-5[1m]"))
            }
        );
    }

    #[test]
    fn 指定を消す切替でキーが消えても覚えている値へ戻す() {
        // `default` は「指定を消してアカウントの既定へ」なので、キーが消えるのが正しい姿。
        // これを利用者の操作と読むと、利用者の既定が消えたまま覚え直されてしまう
        let (_dir, store) = temp_settings("default-switch", SAMPLE);
        store.refresh_default();
        store.write_model(None).unwrap();

        assert_eq!(
            store.recover(&ModelId::new(ModelId::DEFAULT), None),
            Recovery::Restored {
                to: Some(ModelId::new("claude-fable-5[1m]"))
            }
        );
        assert_eq!(
            store.read_model().unwrap(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
    }

    #[test]
    fn 利用者が自分で変えた値は戻さず覚え直す() {
        // ダッシュボードが勝手に取り消してはいけない（設計§6）
        let (_dir, store) = temp_settings("adopt", SAMPLE);
        store.refresh_default();

        // 利用者が自分のターミナルで opus にした
        store.write_model(Some(&ModelId::new("opus"))).unwrap();

        let outcome = store.recover(&ModelId::new("sonnet"), None);
        assert_eq!(
            outcome,
            Recovery::Adopted {
                model: Some(ModelId::new("opus"))
            }
        );
        assert_eq!(store.read_model().unwrap(), Some(ModelId::new("opus")));
        assert_eq!(store.remembered_default(), Some(ModelId::new("opus")));
    }

    #[test]
    fn 元がキー無しなら戻したときもキー無しになる() {
        let (_dir, store) = temp_settings("nokey", "{\n  \"effortLevel\": \"xhigh\"\n}\n");
        assert_eq!(store.refresh_default(), None);

        store.write_model(Some(&ModelId::new("sonnet"))).unwrap();
        assert_eq!(
            store.recover(&ModelId::new("sonnet"), None),
            Recovery::Restored { to: None }
        );
        assert_eq!(store.read_model().unwrap(), None);
    }

    #[test]
    fn ファイルが無ければ何もせず作りにも行かない() {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-claude-settings-missing-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let store = ClaudeSettings::new(path.clone());

        assert_eq!(store.refresh_default(), None);
        assert!(matches!(
            store.recover(&ModelId::new("sonnet"), None),
            Recovery::Skipped { .. }
        ));
        assert!(!path.exists(), "利用者の設定ファイルを生やしてはいけない");
    }

    #[test]
    fn 壊れたJSONには何も書かない() {
        let (_dir, store) = temp_settings("broken", "{ これは JSON ではない");
        assert_eq!(store.refresh_default(), None);
        assert!(matches!(
            store.recover(&ModelId::new("sonnet"), None),
            Recovery::Skipped { .. }
        ));
        assert_eq!(
            std::fs::read_to_string(store.path()).unwrap(),
            "{ これは JSON ではない",
            "壊れたファイルに追い打ちをかけない"
        );
    }

    #[test]
    fn 汚れていなければ何もしない() {
        let (_dir, store) = temp_settings("clean", SAMPLE);
        store.refresh_default();
        assert_eq!(
            store.recover(&ModelId::new("sonnet"), None),
            Recovery::Clean
        );
    }

    #[test]
    #[cfg(unix)]
    fn 回復に失敗したら以後グローバル既定を読みに行かない() {
        use std::os::unix::fs::PermissionsExt as _;

        // 汚れた値を利用者の既定として取り込まないための歯止め（設計§9）
        let (_dir, store) = temp_settings("broken-write", SAMPLE);
        store.refresh_default();
        store.write_model(Some(&ModelId::new("sonnet"))).unwrap();

        // **読めるが書けない**状態を作る。ディレクトリを r-x にしても既存ファイルの
        // 書き換えは止まらない（作成と削除しか制限されない）ので、ファイル自身を読み取り専用にする
        let path = store.path().to_path_buf();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o400);
        std::fs::set_permissions(&path, perms).unwrap();

        let outcome = store.recover(&ModelId::new("sonnet"), None);

        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms).unwrap();

        assert!(
            matches!(outcome, Recovery::Failed { .. }),
            "実際: {outcome:?}"
        );
        assert!(store.is_broken());
        // 汚れた値（sonnet）を読み込まず、覚えている値を返し続ける
        assert_eq!(
            store.refresh_default(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
    }

    // ---- 直列化（本イシューでいちばん重要なテスト）--------------------------------

    /// CLI が `/model <値>` を保存する動きを真似る。
    ///
    /// 実物では claude 側がこれをやる（設計§11 前提3 で実測）。擬似 claude は利用者の
    /// HOME を安全に差し替えられないので汚さない。**汚れたあとどうなるかを見るには、
    /// ここで汚す役を自分でやるしかない。**
    fn cli_saves(store: &ClaudeSettings, model: &str) {
        store.write_model(Some(&ModelId::new(model))).unwrap();
    }

    #[tokio::test]
    async fn 二本が同時に切り替えても元の既定が失われない() {
        // 設計§6 に書いた4手の並びを再現する。**このテストが本イシューでいちばん重要**。
        //
        //   A：opus を控える → A：/model sonnet   → CLI が sonnet を書く
        //   B：控える（★sonnet を「元の値」だと思い込む）→ B：/model haiku
        //   A：値が違うので諦める → B：sonnet へ戻す → opus が二度と戻らない
        //
        // ロックが1本あればこの並びは起きない。
        let (_dir, store) = temp_settings("serialize", SAMPLE);
        let store = std::sync::Arc::new(store);
        store.refresh_default();
        let original = store.remembered_default();
        assert_eq!(original, Some(ModelId::new("claude-fable-5[1m]")));

        let a = {
            let store = std::sync::Arc::clone(&store);
            tokio::spawn(async move {
                let _guard = store.lock_switch().await;
                cli_saves(&store, "sonnet");
                // 相手に割り込む隙を与える。ロックが効いていればここでは入れない
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                store.recover(&ModelId::new("sonnet"), None)
            })
        };
        let b = {
            let store = std::sync::Arc::clone(&store);
            tokio::spawn(async move {
                let _guard = store.lock_switch().await;
                cli_saves(&store, "haiku");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                store.recover(&ModelId::new("haiku"), None)
            })
        };
        let (first, second) = tokio::join!(a, b);
        first.unwrap();
        second.unwrap();

        assert_eq!(
            store.read_model().unwrap(),
            original,
            "並行して切り替えても、利用者の既定が失われないこと"
        );
        assert_eq!(store.remembered_default(), original);
    }

    #[tokio::test]
    async fn ロックはプロセス全体で1本になっている() {
        // セッションごとに持つと、対象がプロセスに1つしかないファイルを守れない
        let (_dir, store) = temp_settings("one-lock", SAMPLE);
        let guard = store.lock_switch().await;

        let blocked =
            tokio::time::timeout(std::time::Duration::from_millis(100), store.lock_switch()).await;
        assert!(blocked.is_err(), "先客がいる間は待たされること");

        drop(guard);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), store.lock_switch())
                .await
                .is_ok(),
            "解放されたら取れること"
        );
    }

    #[tokio::test]
    async fn 直列化されていれば汚染が固定されない() {
        // 「読んだ時点と違ったら書かない」という自衛だけでは、汚染を防ぐのではなく
        // **汚染を固定する**ことになる（設計§6）。順番に行えば必ず元へ戻る
        let (_dir, store) = temp_settings("sequential", SAMPLE);
        store.refresh_default();

        for model in ["sonnet", "haiku", "opus"] {
            let _guard = store.lock_switch().await;
            cli_saves(&store, model);
            assert_eq!(
                store.recover(&ModelId::new(model), None),
                Recovery::Restored {
                    to: Some(ModelId::new("claude-fable-5[1m]"))
                }
            );
        }
        assert_eq!(
            store.read_model().unwrap(),
            Some(ModelId::new("claude-fable-5[1m]"))
        );
    }

    #[tokio::test]
    async fn 切替中は既定を読みに行かない() {
        // **設計§6 の4手の別経路。** セッションの起動は同期なので非同期のロックを
        // 取れず、素朴に読むと切替中の汚れた値を利用者の既定として取り込む
        let (_dir, store) = temp_settings("in-flight", SAMPLE);
        store.refresh_default();
        let original = store.remembered_default();

        let guard = store.lock_switch().await;
        // CLI が /model sonnet を保存した状態
        cli_saves(&store, "sonnet");

        assert_eq!(
            store.refresh_default(),
            original,
            "切替中に読むと、汚れた値を既定として取り込んでしまう"
        );
        assert_eq!(store.remembered_default(), original);

        drop(guard);
        // 切替が終われば、また読みに行く
        assert_eq!(store.refresh_default(), Some(ModelId::new("sonnet")));
    }

    #[test]
    fn 回復に失敗している間はrecoverも読みに行かない() {
        // refresh_default だけ塞いでも、recover が読んで Adopted すれば同じこと
        let (_dir, store) = temp_settings("broken-recover", SAMPLE);
        store.refresh_default();
        let original = store.remembered_default();
        store.state.lock().unwrap().broken = true;

        cli_saves(&store, "sonnet");
        assert!(matches!(
            store.recover(&ModelId::new("haiku"), None),
            Recovery::Skipped { .. }
        ));
        assert_eq!(
            store.remembered_default(),
            original,
            "隔離したはずの汚れた値を取り込んではいけない"
        );
    }
}
