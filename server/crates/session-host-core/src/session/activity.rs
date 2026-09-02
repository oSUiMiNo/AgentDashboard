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
