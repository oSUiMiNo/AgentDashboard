//! 停滞したカードの画面から「走っている印」を探す（設計§3・§5・§13-5）。
//!
//! # なぜ画面を読むのか
//!
//! ターンが完了せずに終わると CLI は `Stop` フックを飛ばさない。ダッシュボードはターンの
//! 終わりをフックでしか知らないので、カードは作業中のまま残り、やがて停滞へ落ちる。
//! **停滞から出る道はフックが1件届くことだけ**なので、もう来ないフックを永久に待つ。
//!
//! そこで**停滞に落ちたカードだけ**画面を見に行き、走っている印が無ければ入力待ちへ倒す。
//!
//! # 決め手は「語の直後の `…`」
//!
//! | | 出ている行 |
//! |---|---|
//! | 走っている | `· Unravelling…` ／ `✽ Ebbing… (2m 10s · ↓ 543 tokens · thinking)` |
//! | 走っていない | `✻ Baked for 1m 58s · done 4:27 AM` ——`…` ではなく ` for ` が続く |
//!
//! **字も語も記号も当てにしない。** 語は Unravelling／Channeling／Ebbing と毎回変わり、
//! **記号は幅ではなくアニメーションのコマで変わる**（設計§13-8。広い幅の画面が `✽` を
//! 使っている実物がある）。だから**記号の集合を列挙してはいけない**——版が上がってコマが
//! 増えたときに黙って落ちる。求めるのは**行の頭の形**だけである。
//!
//! # 行の全体ではなく、行の頭を見る
//!
//! `…` は本文の途中にも出る（枠の中で幅に切られた案内の `…for Cla…`、エコーされた
//! コマンドの `pass…)`）。かといって**行の全体**を求めると実物に当たらない——印の後ろには
//! `(経過 · 付随情報)` が続くためである（設計§13-5）。そこで3つを求める。
//!
//! | 見るところ | 求めるもの |
//! |---|---|
//! | 先頭 | **1文字**、続けて空白 |
//! | その次 | **半角の英字だけの語**、続けて `…` |
//! | `…` の後ろ | **何も無い**か、**` (` で始まる** |
//!
//! # 描画してから読む。[`crate::session::permission`] とは入力の性質が正反対
//!
//! 生の PTY バイト列のままでは行の構造が読めない。TUI は語ごとに別々に書いてカーソル移動で
//! 間を埋めるので、**行として並んで見えるのは描画したあとだけ**である。
//!
//! フッタ読み（`permission::parse_footer`）が生バイトをそのまま食えるのは、あちらが
//! **位置を見ない**（`squeeze` で空白を全部落として照合する）ためで、行の形を見るこちらでは
//! その手は使えない。**[`is_running`] へ生バイトを渡してはいけない**ので、先に [`render`] を
//! 通すこと。引数の名前を `screen` にしてあるのはそのためである。
//!
//! # [`render`] と [`is_running`] を1本にまとめないこと
//!
//! 判定を押さえるフィクスチャ20枚は**描画済みのテキスト**で、vt100 の段を1バイトも通らない
//! （設計§13-2）。混ぜた口しか無いと、テストが緑のときに vt100 の段が通ったのかどうかが
//! 分からなくなる。**便利のための合成関数を足さないこと。**

use protocol::Timestamp;

/// 停滞したカードの画面を見に行く間隔（ミリ秒。設計§5-3。利用者の指定）。
///
/// **見張りの周期（`STALLED_SWEEP_INTERVAL`）とは別の数字である。** あちらは「何秒おきに
/// 全部を見て回るか」、こちらは「同じカードを何秒おきに描き直すか」。片方を動かしたときに
/// もう片方が黙って付いてくると、あとから理由を追えなくなる。
///
/// 停滞の判定は既に120秒待った後なので、そこからさらに5秒遅れても人には分からない。
pub const CHECK_INTERVAL_MS: i64 = 5_000;

/// 前に見た時刻から、もう一度見てよいか（設計§5-3）。
///
/// 1秒周期の見張りに相乗りしつつ、**描画は5秒に1回**へ間引くために使う。
pub fn due(last_checked_at: Timestamp, now: Timestamp) -> bool {
    now.saturating_sub(last_checked_at) >= CHECK_INTERVAL_MS
}

/// 端末の生バイトを、使い捨ての vt100 で1枚の画面にする（設計§5-1・§13-1）。
///
/// # `core/src/client/render.rs` は写せない
///
/// あちらが食うのは `TermEmulator` が組み立てた**自己完結したエスケープ列**で、どのパーサに
/// 食わせても再現できて当たり前である。こちらが食うのは**リングの末尾を切り出した生バイト**
/// で、途中から始まるので色も書式も途中の状態から始まる。**成立することは別に実測した**
/// （設計§13-3。末尾 64 KiB で頭から全量再生した画面と一致する）。
///
/// # `TermEmulator` を使わない
///
/// あれは**ローカルモードでは作られない**（画面配信が無効なら `None`）。常時有効にすると
/// 全セッションぶんの端末エミュレータが動きっぱなしになる。停滞したカードは出力が止まって
/// いるので、毎回作り直しても結果は同じである。
///
/// # スクロールバックは持たせない
///
/// [`vt100::Screen::contents`] が返すのは可視画面だけなので、持たせても読めない。停滞した
/// カードの数だけメモリを積むことになる。
pub fn render(tail: &[u8], cols: u16, rows: u16) -> String {
    // **0 を渡さない。** 桁行はブラウザが送ってきた値が `Session::resize` を通って
    // ここまで来るので、`0` が混ざりうる。vt100 の格子は行数から `scroll_bottom` を
    // 導くため、**見張りのタスクごと落ちる**おそれがある——落ちれば停滞の判定だけで
    // なく、全セッションのフッタ読みも止まる。妥当な値には何も影響しない。
    let mut parser = vt100::Parser::new(rows.max(1), cols.max(1), 0);
    parser.process(tail);
    parser.screen().contents()
}

/// 描画済みの画面のどこかに「走っている印」があるか（設計§3）。
///
/// **渡すのは [`render`] を通した画面である。** 生バイトを渡すと、行として並んでいないので
/// ほとんど常に偽を返す——そして偽は「入力待ちへ倒す」側なので、**間違えても静かに動いて
/// しまう**。
pub fn is_running(screen: &str) -> bool {
    screen.lines().any(is_running_line)
}

/// 1行の頭が「走っている印」の形か（設計§13-5 の3条件）。
///
/// **記号の種類は見ない。** 見るのは「1文字であること」だけである（設計§13-8）。
///
/// 公開しているのは、テストが**本物の判定を絞り込む形で**変異体を作れるようにするため。
/// 変異体の側でパースを書き写すと、本物が変わっても変異体だけ古いまま緑になる。
pub fn is_running_line(line: &str) -> bool {
    let Some((mark, rest)) = line.trim().split_once(' ') else {
        return false;
    };
    if mark.chars().count() != 1 {
        return false;
    }
    // **記号と語の間は空白1つ。** 実物20枚では、スピナーが空白1つ（`✽ Ebbing…`）、
    // ツール結果の続き行が空白2つ（`⎿  Running in the background`）で一貫している。
    // ここを緩めると `⎿  Running…` のような行が印に化け、**カードが停滞のまま戻らなく
    // なる**——設計§3-3 が「重い」と名指しした側の外し方である。
    if rest.starts_with(char::is_whitespace) {
        return false;
    }
    let Some((word, after)) = rest.split_once('…') else {
        return false;
    };
    // `…` の直前が半角の語であること。枠の中で切られた案内（`…for Cla…`）や
    // エコーされたコマンド（`pass…)`）はここで落ちる
    !word.is_empty()
        && word.chars().all(|ch| ch.is_ascii_alphabetic())
        // 実物は `…` の後ろに `(経過 · 付随情報)` が続く。何も続かない形（採取済みの
        // フィクスチャ）も同じ印である（設計§13-5）
        && (after.is_empty() || after.starts_with(" ("))
}

/// **走っているサブエージェントの一覧**（`◯`）が画面のいちばん下に出ているか
/// （設計§14 読み替え）。
///
/// # なぜ `subagent_active` を当てにしないのか
///
/// **あの数は、サブエージェントが生きているうちに 0 へ戻る**（実機のログで確認）。
/// フォークが走り続けている最中に `Stop` が届き、そこでは既に 0 だったため、
/// **サブ待ちにならず入力待ちになっていた。**
///
/// ```text
/// 13:29:01 sub=1 status=WaitingSubagents   ← 立った
/// 13:31:18 sub=0 status=WaitingInput       ← まだ走っているのに 0 へ戻った
/// ```
///
/// # `Waiting for N background agents to finish` は使えない
///
/// CLI は確かにこの文を書く。**しかしこれは会話の履歴として流れる本文で、待ちが
/// 終わっても画面から消えない。** 実物のカード1枚に**2回**残っていた（別々のターンで
/// 書かれたもの）。これを根拠に解くと、**サブが終わってもサブ待ちのまま**になる——
/// 直そうとした間違い（終わったのに入力待ち）の裏返しを作ることになる。
///
/// **消えるものだけを根拠にする。** フッタの一覧は毎フレーム描き直されるので、
/// サブが終われば消える（実測：一覧が出ていたカードが、フォークの終了後に消えた）。
///
/// # 拾うのは画面のいちばん下の塊だけ
///
/// フッタはこの形で、**入力欄より下**に描かれる。
///
/// ```text
///   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
///
///   ● main
///   ◯ fork  Verifying version path in /api/versions      13m 59s · ↓ 775.3k tokens
/// ```
///
/// 画面の全体から `◯` を探さないのは、**会話の本文にも記号が出るから**である。実物の
/// カード30枚では `◯` は一覧にしか出ていなかったが、`●` は本文の行頭に普通に出る。
/// 同じ理由で塊の終わりは `●`／`◯` 以外の行とし、**`● main` の綴りは求めない**——
/// 根の名前が変わっただけで黙って効かなくなる作りにしないため。
///
/// # 壊れたときにどちらへ倒れるか
///
/// 画面読みは版で壊れる前提である（設計§8-2）。ここが読めなくなると**サブ待ちに
/// 入らなくなる**＝いままでどおり入力待ちになる。**サブ待ちのまま張り付く側へは
/// 倒れない**ので、壊れ方としては軽いほうを選んである。
pub fn waits_for_subagents(screen: &str) -> bool {
    agent_tree_block(screen).any(is_agent_line)
}

/// 一覧の行の記号。走っているサブエージェント1本につき1行。
const TREE_RUNNING: char = '◯';

/// 一覧の根（`● main`）。**塊の終わりを見分けるためだけに使う。**
const TREE_ROOT: char = '●';

/// 画面のいちばん下にある一覧の塊を、**下から順に**返す。
///
/// 末尾の空行を飛ばし、記号で始まる行が続くあいだだけを取る。フッタとその上の本文は
/// 空行で隔てられているので、ここで止まる。
fn agent_tree_block(screen: &str) -> impl Iterator<Item = &str> {
    screen
        .lines()
        .rev()
        .skip_while(|line| line.trim().is_empty())
        .take_while(|line| {
            let head = line.trim_start();
            head.starts_with(TREE_RUNNING) || head.starts_with(TREE_ROOT)
        })
}

/// 1行が「走っているサブエージェント」の行か。
///
/// 公開しているのは、テストが**本物の判定を絞り込む形で**変異体を作れるようにするため
/// （[`is_running_line`] と同じ理由）。
pub fn is_agent_line(line: &str) -> bool {
    let Some(rest) = line.trim_start().strip_prefix(TREE_RUNNING) else {
        return false;
    };
    // 記号のあとは空白で区切られ、中身がある。`◯` だけの行や、記号に文字が続く行
    // （`◯◯` のような飾り）は一覧ではない
    rest.starts_with(char::is_whitespace) && !rest.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 実物の画面20枚（設計§9-1 ＋ §13-5）。
    ///
    /// **`include_str!` で焼き込む。** 実行時にパスを組み立てると、隔離ワークツリーで
    /// 走らせたときに黙って読めなくなる。焼き込めば**フィクスチャを消した時点で
    /// コンパイルが落ちる**。
    const SAMPLES: &[(&str, &str, bool)] = &[
        // 陽性3枚。記号が広い幅で `·` と `✽` の両方に出ていることに注意（設計§13-8）
        (
            "広い幅 working",
            include_str!("../../../../../fixtures/v2.1.232/screens/working.txt"),
            true,
        ),
        (
            "広い幅 working-long 括弧つき",
            include_str!("../../../../../fixtures/v2.1.232/screens/working-long.txt"),
            true,
        ),
        (
            "狭い幅 working",
            include_str!("../../../../../fixtures/v2.1.232/screens-narrow/working.txt"),
            true,
        ),
        // 陰性17枚。完了の印（` for <時間>`）を走行中と読まないこと
        (
            "広い幅 after-turn",
            include_str!("../../../../../fixtures/v2.1.232/screens/after-turn.txt"),
            false,
        ),
        (
            "狭い幅 after-turn",
            include_str!("../../../../../fixtures/v2.1.232/screens-narrow/after-turn.txt"),
            false,
        ),
        // 枠の中で幅に切られた案内（`…for Cla…`）を拾わないこと（設計§3-2）
        (
            "広い幅 welcome",
            include_str!("../../../../../fixtures/v2.1.232/screens/welcome.txt"),
            false,
        ),
        (
            "狭い幅 welcome",
            include_str!("../../../../../fixtures/v2.1.232/screens-narrow/welcome.txt"),
            false,
        ),
        (
            "前の版 welcome",
            include_str!("../../../../../fixtures/v2.1.228/screens/welcome.txt"),
            false,
        ),
        // 人の答えを待っている画面。設計§4-3 のとおりここへは来ないが、倒れる向きを固定する
        (
            "広い幅 permission",
            include_str!("../../../../../fixtures/v2.1.232/screens/permission.txt"),
            false,
        ),
        (
            "狭い幅 permission",
            include_str!("../../../../../fixtures/v2.1.232/screens-narrow/permission.txt"),
            false,
        ),
        (
            "広い幅 rewind",
            include_str!("../../../../../fixtures/v2.1.232/screens/rewind.txt"),
            false,
        ),
        (
            "狭い幅 rewind",
            include_str!("../../../../../fixtures/v2.1.232/screens-narrow/rewind.txt"),
            false,
        ),
        (
            "広い幅 multi-select",
            include_str!("../../../../../fixtures/v2.1.232/screens/multi-select.txt"),
            false,
        ),
        (
            "狭い幅 multi-select",
            include_str!("../../../../../fixtures/v2.1.232/screens-narrow/multi-select.txt"),
            false,
        ),
        // エコーされたコマンド（`pass…)`）を拾わないこと
        (
            "広い幅 numbered-echo",
            include_str!("../../../../../fixtures/v2.1.232/screens/numbered-echo.txt"),
            false,
        ),
        (
            "狭い幅 numbered-echo",
            include_str!("../../../../../fixtures/v2.1.232/screens-narrow/numbered-echo.txt"),
            false,
        ),
        // 1つ前の版でも同じ答えになること
        (
            "前の版 after-turn",
            include_str!("../../../../../fixtures/v2.1.228/screens/after-turn.txt"),
            false,
        ),
        (
            "前の版 permission",
            include_str!("../../../../../fixtures/v2.1.228/screens/permission.txt"),
            false,
        ),
        (
            "前の版 rewind",
            include_str!("../../../../../fixtures/v2.1.228/screens/rewind.txt"),
            false,
        ),
        (
            "前の版 trust",
            include_str!("../../../../../fixtures/v2.1.228/screens/trust.txt"),
            false,
        ),
    ];

    /// 実機で採った停滞カードの1行（設計§3-1 の表の最終行）。
    ///
    /// **フィクスチャが無いのでリテラルで持っている。** 残っているのは参考のスクリーン
    /// ショット（PNG）だけで、画面のテキストは採れていない。
    const STALLED_LINE: &str = "✻ Baked for 1m 58s · done 4:27 AM";

    /// 渡した判定器で20枚に当てて、答えが食い違った標本の名前を並べる。
    ///
    /// **枚数ではなく名前を返す。** 数だけを見ると、別の標本が落ちても同じ数になる。
    fn misses(judge: impl Fn(&str) -> bool) -> Vec<&'static str> {
        SAMPLES
            .iter()
            .filter(|(_, screen, expected)| judge(screen) != *expected)
            .map(|(name, _, _)| *name)
            .collect()
    }

    #[test]
    fn 実物の画面20枚で外れない() {
        assert_eq!(SAMPLES.len(), 20, "標本の数");
        assert_eq!(misses(is_running), Vec::<&str>::new());
    }

    #[test]
    fn 実機で採った停滞カードの行は走っていない() {
        assert!(!is_running(STALLED_LINE));
    }

    #[test]
    fn 常に走っていないへ変えると陽性3枚だけが落ちる() {
        assert_eq!(
            misses(|_| false),
            [
                "広い幅 working",
                "広い幅 working-long 括弧つき",
                "狭い幅 working"
            ]
        );
    }

    #[test]
    fn 常に走っているへ変えると陰性17枚が落ちる() {
        // **枚数ではなく名前で照合する。** 数だけを見ると、陽性を1枚取り違えて陰性を
        // 1枚足しても同じ17になり、表の期待値が狂ったまま緑になる（`misses` の趣旨）
        assert_eq!(
            misses(|_| true),
            [
                "広い幅 after-turn",
                "狭い幅 after-turn",
                "広い幅 welcome",
                "狭い幅 welcome",
                "前の版 welcome",
                "広い幅 permission",
                "狭い幅 permission",
                "広い幅 rewind",
                "狭い幅 rewind",
                "広い幅 multi-select",
                "狭い幅 multi-select",
                "広い幅 numbered-echo",
                "狭い幅 numbered-echo",
                "前の版 after-turn",
                "前の版 permission",
                "前の版 rewind",
                "前の版 trust",
            ]
        );
    }

    #[test]
    fn 記号と語の間が空白2つなら走っていない() {
        // ツール結果の続き行。実物の `⎿  Running in the background` と同じ空き方で、
        // ここを通すとカードが停滞のまま戻らなくなる（設計§3-3 の「重い」側）
        assert!(!is_running_line("  ⎿  Running…"));
        // 空白1つの本物は通ること（絞りすぎていないことの確認）
        assert!(is_running_line("  ⎿ Running…"));
    }

    #[test]
    fn 記号を中黒だけに狭めると中黒でない陽性2枚が落ちる() {
        // **本物の行判定を絞り込んで作る。** ここでパースを書き写すと、本物が変わっても
        // 変異体だけ古いまま緑になり、変異テストの意味が消える
        let 中黒だけ = |screen: &str| {
            screen
                .lines()
                .any(|line| is_running_line(line) && line.trim_start().starts_with('·'))
        };
        // **広い幅の working-long も `✽` を使っている。** 記号は幅ではなくコマで変わる
        // （設計§13-8）ので、落ちるのは狭い幅の1枚ではない
        assert_eq!(
            misses(中黒だけ),
            ["広い幅 working-long 括弧つき", "狭い幅 working"]
        );
    }

    #[test]
    fn 語の後ろが空白なら走っていない() {
        // 枠の中の案内。`Run /init …` は語の後ろが空白で `…` ではない
        assert!(!is_running_line("  Run /init …"));
    }

    #[test]
    fn 先頭が1文字でなければ走っていない() {
        // エコーされたコマンド
        assert!(!is_running_line("      while time.time()<end: pass…)"));
    }

    #[test]
    fn 記号の種類は問わない() {
        // アニメーションのコマは版で増減する（設計§13-8）。列挙していないことの確認
        for mark in ['·', '✶', '✻', '✽', '✳'] {
            assert!(is_running_line(&format!("{mark} Ebbing…")), "{mark}");
        }
    }

    /// 実機のカードから写した、フッタの一覧つきの画面（設計§14 読み替え）。
    ///
    /// **フィクスチャが無いのでリテラルで持っている。** 走っているフォークが在るカードの
    /// 実物から、行の形を変えずに写した（説明と数字だけ短くしてある）。
    ///
    /// **本文の側に紛らわしいものを混ぜてある。** 履歴に残る
    /// `✻ Waiting for 1 background agent to finish` と、行頭の `●` である。
    /// どちらも実物に出ていて、**どちらも判定に使ってはいけない側**である。
    const TREE_SCREEN: &str = "\
● さっきの返事です
  ⎿  Stop says: 完了前チェック
✻ Waiting for 1 background agent to finish
────────────────────────
❯
────────────────────────
  Opus 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent

  ● main
  ◯ fork  Verifying version path in /api/versions      13m 59s · ↓ 775.3k tokens
";

    /// 一覧が消えたあとの同じ画面。**本文に残った待ちの行はそのまま**である。
    const TREE_GONE: &str = "\
● さっきの返事です
  ⎿  Stop says: 完了前チェック
✻ Waiting for 1 background agent to finish
────────────────────────
❯
────────────────────────
  Opus 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent
";

    #[test]
    fn 実機で採った一覧つきの画面を読み取れる() {
        assert!(waits_for_subagents(TREE_SCREEN));
    }

    /// **一覧が消えれば偽に戻ること。** ここが戻らないと、サブが終わってもカードが
    /// サブ待ちのまま張り付く（直そうとした間違いの裏返し）。
    #[test]
    fn 一覧が消えれば待ちではなくなる() {
        assert!(!waits_for_subagents(TREE_GONE));
        // 末尾に空行が続いても同じ（描き直しの途中で行が空くことがある）
        assert!(!waits_for_subagents(&format!("{TREE_GONE}\n\n   \n")));
        assert!(waits_for_subagents(&format!("{TREE_SCREEN}\n\n   \n")));
    }

    /// **履歴に残った文は根拠にしない**（設計§14 読み替え）。
    ///
    /// `Waiting for N background agents to finish` は会話の本文として流れるので、
    /// 待ちが終わっても消えない。実物のカード1枚に2回残っていた。
    #[test]
    fn 本文に残った待ちの文は拾わない() {
        assert!(
            !waits_for_subagents(
                "✻ Waiting for 1 background agent to finish\nなにか\n✻ Waiting for 2 background agents to finish"
            ),
            "本文の文だけでは立たない"
        );
    }

    /// **本文の途中に記号があっても拾わない。** 拾うのはいちばん下の塊だけである。
    #[test]
    fn 本文の途中の記号は拾わない() {
        let screen = format!("◯ 本文に出てきた記号\nなにか\n{TREE_GONE}");
        assert!(!waits_for_subagents(&screen));
    }

    /// 根だけの一覧（走っているサブが1本も無い）では立たない。
    #[test]
    fn 根だけの一覧では立たない() {
        assert!(!waits_for_subagents("なにか\n\n  ● main\n"));
    }

    #[test]
    fn 一覧の行かどうかを見分ける() {
        assert!(is_agent_line("  ◯ fork  なにか  13m 59s"));
        // 字下げが無い形も受ける（描き直しで欠けることがある）
        assert!(is_agent_line("◯ general-purpose  調べもの"));
        for line in [
            // 記号だけ
            "◯",
            "  ◯   ",
            // 記号に文字が続く（飾り）
            "◯◯ なにか",
            // 根の側
            "  ● main",
            // 走っている印
            "✽ Ebbing… (2m 10s · ↓ 543 tokens · thinking)",
            "",
        ] {
            assert!(!is_agent_line(line), "{line}");
        }
    }

    /// **走っている印と混ざらないこと。** どちらも行の頭に記号が付くので、
    /// 片方の判定がもう片方を拾うと状態が入れ替わる。
    #[test]
    fn 一覧の行と走っている印は互いに拾わない() {
        assert!(
            !is_running_line("◯ fork  なにか  13m 59s · ↓ 775.3k tokens"),
            "一覧の行を走行中と読まない"
        );
        assert!(
            !is_agent_line("✽ Ebbing… (2m 10s · ↓ 543 tokens · thinking)"),
            "スピナーを一覧と読まない"
        );
    }

    /// 実物20枚のどれにも一覧は出ていない（誤爆しないことの確認）。
    #[test]
    fn 実物20枚には一覧が無い() {
        let 拾った: Vec<&str> = SAMPLES
            .iter()
            .filter(|(_, screen, _)| waits_for_subagents(screen))
            .map(|(name, _, _)| *name)
            .collect();
        assert_eq!(拾った, Vec::<&str>::new());
    }

    #[test]
    fn 間隔が5秒に満たなければ見に行かない() {
        assert!(!due(1_000, 1_000));
        assert!(!due(1_000, 5_999));
        assert!(due(1_000, 6_000));
        assert!(due(1_000, 60_000));
    }

    #[test]
    fn 時計が巻き戻っても見に行かない() {
        // **`saturating_sub` が 0 で止まるからではない。** `Timestamp` は `i64` なので
        // 差は負のまま（`-9_000`）で、それが 5_000 未満だから偽になる。飽和が効くのは
        // `i64::MIN` の側だけである。**比較の向きを変えるときはここが崩れる**——絶対値を
        // 取る形へ直すと、時刻が戻った周に毎回 64 KiB を描き直すようになる
        assert!(!due(10_000, 1_000));
        assert!(!due(Timestamp::MAX, 0));
    }
}
