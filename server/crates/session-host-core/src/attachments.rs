//! 入力欄から届いた画像を、セッションホストのディスクへ置く（設計§5・§11）。
//!
//! # なぜ利用者のプロジェクトへ置かないのか
//!
//! 要件が名指しで禁じている。エージェントが読み書きする場所へこちらの都合のファイルを
//! 混ぜると、`git status` が汚れ、消す責任も曖昧になる。置き場所は `<state_dir>` の下で、
//! **カードごとにディレクトリを分ける**——カードを外したときに、そのぶんだけを畳めるようにする。
//!
//! # なぜ利用者が付けた名前を使わないのか
//!
//! 名前にパスの区切りや制御文字が入りうる。**採番した名前だけをディスクへ置き、
//! 元の名前は記録の側に持つ**（画面に出すのは元の名前）。
//!
//! # 名前に日付を入れる理由
//!
//! **掃除がファイル名だけで年齢を決められるようにするため。** 更新時刻はコピーや復元で
//! 簡単に変わるので当てにしない。この作法は [`crate::logging`] の `parse_log_name` と
//! 同じで、**掃く側と読む側で定義がずれると、掃かれるのに読めないファイルが生まれる**。

use std::path::{Path, PathBuf};

use protocol::CardId;

use crate::config::SessionHostConfig;

/// `<state_dir>` の下のディレクトリ名。
pub const DIR_NAME: &str = "attachments";

/// 置ける1枚の上限。**生ファイルの口（[`protocol::fs::MAX_BLOB_BYTES`]）と同じ値**に揃える。
///
/// 揃えるのは、**運んだ画像を履歴では生ファイルの口で取り返す**ため（設計§10-3）。
/// 上限が食い違うと、置けたのに読めない画像が生まれる。
pub const MAX_ATTACHMENT_BYTES: u64 = protocol::fs::MAX_BLOB_BYTES;

/// 置き場所の根（`<state_dir>/attachments`）。
pub fn root(state_dir: &Path) -> PathBuf {
    state_dir.join(DIR_NAME)
}

/// カード1枚ぶんの置き場所。
pub fn card_dir(state_dir: &Path, card: CardId) -> PathBuf {
    root(state_dir).join(card.0.to_string())
}

/// 置くときに使う名前を組み立てる（`<YYYYMMDD>-<HHMMSS>-<8桁の16進>.<拡張子>`）。
///
/// 時刻は UTC。`unique` は同じ秒に複数枚置いたときの衝突よけで、呼ぶ側が渡す。
pub fn build_name(at: time::OffsetDateTime, unique: &str, extension: &str) -> String {
    let date = at.date();
    let clock = at.time();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}-{unique}.{extension}",
        date.year(),
        u8::from(date.month()),
        date.day(),
        clock.hour(),
        clock.minute(),
        clock.second(),
    )
}

/// ファイル名を `(日付, 時刻)` へ分解する。**合わない名前は `None`**。
///
/// 掃除はここが `Some` を返したものにしか触らない。何が置かれていても、
/// **見覚えのある名前でなければ手を出さない**。
pub(crate) fn parse_name(name: &str) -> Option<(time::Date, time::Time)> {
    let (stem, extension) = name.rsplit_once('.')?;
    if !protocol::fs::is_attachment_extension(extension) {
        return None;
    }
    let mut parts = stem.split('-');
    let day = parts.next()?;
    let clock = parts.next()?;
    let unique = parts.next()?;
    if parts.next().is_some() || unique.is_empty() {
        return None;
    }
    if !unique.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    if day.len() != 8 || clock.len() != 6 {
        return None;
    }
    let year: i32 = day.get(0..4)?.parse().ok()?;
    let month: u8 = day.get(4..6)?.parse().ok()?;
    let date_of_month: u8 = day.get(6..8)?.parse().ok()?;
    let hour: u8 = clock.get(0..2)?.parse().ok()?;
    let minute: u8 = clock.get(2..4)?.parse().ok()?;
    let second: u8 = clock.get(4..6)?.parse().ok()?;
    let month = time::Month::try_from(month).ok()?;
    let date = time::Date::from_calendar_date(year, month, date_of_month).ok()?;
    let clock = time::Time::from_hms(hour, minute, second).ok()?;
    Some((date, clock))
}

/// 掃除の結果。**呼ぶ側がログへ出す**ので、数を持って返す。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SweepOutcome {
    /// 消した件数。
    pub removed: usize,
    /// 消したバイト数。
    pub freed: u64,
    /// 掃いたあとも上限を超えていた。
    pub over_budget: bool,
}

/// 古いものと溢れたぶんを片付ける（設計§11）。
///
/// 段は2つある。
///
/// 1. **`retention_days` を超えたものは、合計の大きさによらず消す**
/// 2. **合計が `max_bytes` を超えていたら、古い順に `sweep_bytes` 分だけ消す**
///
/// 2段目が「上限を下回るまで」ではなく「決めた量だけ」なのが、ログの掃除との違いである
/// （利用者の指定・2026-09-01）。**今日置いたものはどちらの段でも消さない**——
/// いま誰かが送ろうとしている最中かもしれない。
pub fn sweep(
    state_dir: &Path,
    retention_days: u64,
    max_bytes: u64,
    sweep_bytes: u64,
) -> SweepOutcome {
    sweep_at(
        state_dir,
        time::OffsetDateTime::now_utc().date(),
        retention_days,
        max_bytes,
        sweep_bytes,
    )
}

pub(crate) fn sweep_at(
    state_dir: &Path,
    today: time::Date,
    retention_days: u64,
    max_bytes: u64,
    sweep_bytes: u64,
) -> SweepOutcome {
    let mut outcome = SweepOutcome::default();
    let Ok(cards) = std::fs::read_dir(root(state_dir)) else {
        return outcome;
    };

    // 見覚えのある名前だけを候補にする。合わないものには何があっても触らない
    let mut candidates: Vec<(time::Date, time::Time, String, PathBuf, u64)> = Vec::new();
    for card in cards.flatten() {
        let Ok(entries) = std::fs::read_dir(card.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some((date, clock)) = parse_name(name) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            candidates.push((date, clock, name.to_owned(), path, meta.len()));
        }
    }

    // 古い順。日付 → 時刻 → それも同じなら名前
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });

    let today_julian = today.to_julian_day();
    let retention = i32::try_from(retention_days).unwrap_or(i32::MAX);
    let mut remaining: Vec<usize> = Vec::new();
    let mut total: u64 = 0;

    for (index, (date, _, _, path, size)) in candidates.iter().enumerate() {
        // 今日のぶんは、いま送ろうとしている最中かもしれない。数には入れるが消さない
        let removable = *date < today;
        let too_old = removable && today_julian.saturating_sub(date.to_julian_day()) > retention;
        if too_old {
            remove_one(path, *size, &mut outcome);
            continue;
        }
        total = total.saturating_add(*size);
        if removable {
            remaining.push(index);
        }
    }

    // 合計が上限を超えていたら、古い順に「決めた量だけ」消す
    if total > max_bytes {
        let mut freed_now: u64 = 0;
        let mut cursor = 0;
        while freed_now < sweep_bytes {
            let Some(&index) = remaining.get(cursor) else {
                break;
            };
            cursor += 1;
            let (_, _, _, path, size) = &candidates[index];
            if remove_one(path, *size, &mut outcome) {
                freed_now = freed_now.saturating_add(*size);
                total = total.saturating_sub(*size);
            }
        }
        outcome.over_budget = total > max_bytes;
    }

    outcome
}

fn remove_one(path: &Path, size: u64, outcome: &mut SweepOutcome) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => {
            outcome.removed += 1;
            outcome.freed = outcome.freed.saturating_add(size);
            true
        }
        Err(err) => {
            tracing::warn!(
                path = %path.display(),
                error = %err,
                "添付を消せませんでした",
            );
            false
        }
    }
}

/// 起きたときに1回だけ掃く（`入力欄の状態を端末をまたいで保つ` 段1）。
///
/// # なぜ要るのか
///
/// [`sweep`] を呼んでいたのは [`write_blob`] の末尾**だけ**だった。つまり
/// **誰かが新しい添付を置いたときにしか掃除が走らない**。付けたきり送らなかったぶんは、
/// **次に誰かが添付を置くまでディスクに残り続ける**。
///
/// 設計（`メッセージに画像を添付できるようにする` 設計§11）は「**起動時に1回**走らせる
/// （ログの掃除と同じ）」と書いていたが、実装が入っていなかった。ここがその1回にあたる。
///
/// # 呼ぶ場所
///
/// **`logging::install` の直後、入口ごとに1回。** ログの掃除とまったく同じ位置で、
/// 実行ファイルの入口は2つしかない（ダッシュボードとセッションホスト）。
///
/// **[`crate::session::SessionManager`] の組み立ての中へ入れてはいけない。**
/// テストの世話役が同じ道を通るので、**テストを走らせるたびに実機の添付を掃く**ことになる。
///
/// # 走らせ方
///
/// ファイルを数える仕事なので、非同期の文脈から呼ぶなら
/// [`tokio::task::spawn_blocking`] へ逃がすこと。枚数は利用者の使い方次第で伸びる。
pub fn sweep_on_start(config: &SessionHostConfig) {
    let swept = sweep(
        &config.resolved_state_dir(),
        config.attachment_retention_days,
        config.attachment_max_bytes,
        config.attachment_sweep_bytes,
    );
    // **0件のときは黙る。** 起動のたびに出すと、読む人が慣れて見なくなる
    if swept.removed > 0 {
        tracing::info!(
            removed = swept.removed,
            freed = swept.freed,
            over_budget = swept.over_budget,
            "起きたときに添付を掃きました",
        );
    }
}

/// カード1枚ぶんの添付を畳む（設計§11-3）。
///
/// 外したカードの履歴はもう読めないので、添付を残す意味が無い。掃除の2段を待たない。
pub fn forget(state_dir: &Path, card: CardId) {
    let dir = card_dir(state_dir, card);
    if let Err(err) = std::fs::remove_dir_all(&dir) {
        if err.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                path = %dir.display(),
                error = %err,
                "カードの添付を畳めませんでした",
            );
        }
    }
}

/// 添付を1枚置く（`メッセージに画像を添付できるようにする` 設計§4・§5）。
///
/// [`read_blob`] の鏡。**置き場所を決めるのはここ**で、サーバは口を出さない
/// ——`state_dir` の解決は PC 側の設定に属するため。
///
/// # 中身は検めない
///
/// [`read_blob`] と同じ理由。媒体型が表に在ることだけを見て、バイト列の中身は見ない。
/// 拡張子と中身が食い違っていれば、**claude 側が受け取るときに断る**
/// （`Pasted path has image extension but content is not a supported image`）。
/// ここで見に行くと「受け取れない」と「壊れている」が同じ断りに潰れる。
///
/// # 置いたあとに掃く
///
/// 掃除を起動時の1回だけにすると、**長く起こしっぱなしの機械では溜まり続ける**
/// （`README.md` がログの掃除について同じ弱点を書いている）。添付は1枚が数 MB あるので
/// 効き方が大きい。数えるだけなら安いので、置いた直後にも掃く（設計§11-1）。
pub fn write_blob(
    state_dir: &Path,
    card: protocol::CardId,
    media_type: &str,
    data: &[u8],
    retention_days: u64,
    max_bytes: u64,
    sweep_bytes: u64,
) -> Result<protocol::fs::WrittenBlob, crate::hostfs::HostFsError> {
    // **種別を先に見る。** 表に無いものは、置く場所を作るまでもなく相手ではない。
    // svg はここで落ちる——claude の貼り付け処理が拾わないので、置いても添付にならない
    let Some(extension) = protocol::fs::attachment_extension_for(media_type) else {
        return Err(crate::hostfs::HostFsError::new(
            protocol::a2s::HostFailure::Unsupported,
            format!("{media_type} は添付として受け取れる種別ではありません"),
        ));
    };

    // **書く前に大きさで断る。** 書いてから消すのでは、上限を置いた意味が無い
    let bytes = data.len() as u64;
    if bytes > MAX_ATTACHMENT_BYTES {
        let limit = MAX_ATTACHMENT_BYTES;
        return Err(crate::hostfs::HostFsError::new(
            protocol::a2s::HostFailure::TooLarge,
            format!("添付は {bytes} バイトで、上限の {limit} バイトを超えています"),
        ));
    }

    let dir = card_dir(state_dir, card);
    std::fs::create_dir_all(&dir).map_err(|err| crate::hostfs::HostFsError::from_io(&err, &dir))?;

    let unique = uuid::Uuid::new_v4().simple().to_string();
    let name = build_name(time::OffsetDateTime::now_utc(), &unique[..8], extension);
    let path = dir.join(&name);
    std::fs::write(&path, data).map_err(|err| {
        let failure = crate::hostfs::HostFsError::from_io(&err, &path);
        tracing::warn!(
            path = %path.display(),
            bytes,
            reason = ?failure.reason,
            "添付を置けません",
        );
        failure
    })?;

    let shown = path.display().to_string();
    tracing::info!(
        card_id = %card.0,
        path = %shown,
        bytes,
        media_type,
        "添付を置きました",
    );

    let swept = sweep(state_dir, retention_days, max_bytes, sweep_bytes);
    if swept.removed > 0 {
        tracing::info!(
            removed = swept.removed,
            freed = swept.freed,
            over_budget = swept.over_budget,
            "添付を掃きました",
        );
    }

    Ok(protocol::fs::WrittenBlob {
        path: shown,
        media_type: media_type.to_string(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    fn 日時(y: i32, m: u8, d: u8, hh: u8, mm: u8, ss: u8) -> time::OffsetDateTime {
        let date = time::Date::from_calendar_date(y, time::Month::try_from(m).unwrap(), d).unwrap();
        date.with_hms(hh, mm, ss).unwrap().assume_utc()
    }

    #[test]
    fn 名前は日付と時刻と16進で組み立てる() {
        assert_eq!(
            build_name(日時(2026, 9, 1, 21, 43, 6), "a1b2c3d4", "png"),
            "20260901-214306-a1b2c3d4.png"
        );
    }

    #[test]
    fn 組み立てた名前は読み戻せる() {
        let name = build_name(日時(2026, 9, 1, 21, 43, 6), "a1b2c3d4", "png");
        let (date, clock) = parse_name(&name).expect("読み戻せること");
        assert_eq!(date.year(), 2026);
        assert_eq!(clock.hour(), 21);
    }

    #[test]
    fn 拡張子が残る() {
        // 落とすと、置いても絶対に添付にならない（claude の判定が拡張子から始まる）
        for ext in ["png", "jpg", "jpeg", "gif", "webp"] {
            let name = build_name(日時(2026, 9, 1, 0, 0, 0), "00000000", ext);
            assert!(name.ends_with(&format!(".{ext}")), "拡張子が無い: {name}");
            assert!(parse_name(&name).is_some(), "読み戻せない: {name}");
        }
    }

    #[test]
    fn 名前に制御文字が入らない() {
        // 採番した名前は**本文へ混ぜて PTY へ書かれる**（画像添付 設計§6）。ESC が
        // 混ざると貼り付けの終了記号を本文側から打ち込めてしまうので、`sanitize` が
        // 本文から ESC を落としている前提と噛み合わなくなる。
        //
        // **`sanitize` を緩めて通す道を選ばなかった**根拠がここにある——名前を
        // こちらで採る限り、緩める必要が最初から無い（§6-3）。
        for ext in ["png", "jpg", "jpeg", "gif", "webp"] {
            let name = build_name(日時(2026, 9, 1, 21, 43, 6), "a1b2c3d4", ext);
            assert!(
                !name.chars().any(char::is_control),
                "制御文字が入っている: {name:?}"
            );
            // パスの区切りも入らない（利用者が付けた名前を使わないため）
            assert!(!name.contains('/'), "区切りが入っている: {name:?}");
            assert!(!name.contains('\\'), "区切りが入っている: {name:?}");
        }
    }

    #[test]
    fn 見覚えのない名前は読み戻せない() {
        // 掃除はここが Some を返したものにしか触らない
        for name in [
            "notes.txt",
            "20260901-214306-a1b2c3d4.svg", // svg は添付として受け取らない
            "20260901-214306.png",          // 16進が無い
            "2026091-214306-a1b2c3d4.png",  // 日付が8桁でない
            "20260901-2143-a1b2c3d4.png",   // 時刻が6桁でない
            "20260901-214306-zzzz.png",     // 16進でない
            "20260901-214306-a1b2c3d4-x.png",
            ".png",
        ] {
            assert!(parse_name(name).is_none(), "触ってはいけない名前: {name}");
        }
    }

    #[test]
    fn カードごとにディレクトリが分かれる() {
        let state = Path::new("/state");
        let one = CardId(uuid::Uuid::from_u128(1));
        let two = CardId(uuid::Uuid::from_u128(2));
        assert_ne!(card_dir(state, one), card_dir(state, two));
        assert!(card_dir(state, one).starts_with(root(state)));
    }

    #[test]
    fn 運ぶ上限は生ファイルの口と同じ() {
        // 揃えないと、置けたのに履歴で読めない画像が生まれる（設計§8-1）
        assert_eq!(MAX_ATTACHMENT_BYTES, 8_388_608);
        assert_eq!(MAX_ATTACHMENT_BYTES, protocol::fs::MAX_BLOB_BYTES);
    }

    fn 使い捨て(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentdashboard-attachments-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("作れること");
        dir
    }

    /// カード1枚の下へ、名前と大きさを指定して置く。
    fn 置く(state: &Path, card: CardId, name: &str, size: usize) {
        let dir = card_dir(state, card);
        std::fs::create_dir_all(&dir).expect("作れること");
        std::fs::write(dir.join(name), "x".repeat(size)).expect("書けること");
    }

    fn 残っている(state: &Path, card: CardId, name: &str) -> bool {
        card_dir(state, card).join(name).exists()
    }

    fn 日(text: &str) -> time::Date {
        let mut parts = text.split('-');
        let year: i32 = parts.next().unwrap().parse().unwrap();
        let month: u8 = parts.next().unwrap().parse().unwrap();
        let day: u8 = parts.next().unwrap().parse().unwrap();
        time::Date::from_calendar_date(year, time::Month::try_from(month).unwrap(), day).unwrap()
    }

    #[test]
    fn 期限を超えたものは合計の大きさによらず消える() {
        // 段①。1 GiB に遠く届かなくても、古ければ消える（利用者の指定）
        let state = 使い捨て("retention");
        let card = CardId(uuid::Uuid::from_u128(1));
        置く(&state, card, "20260101-000000-aaaaaaaa.png", 10);
        置く(&state, card, "20260830-000000-bbbbbbbb.png", 10);
        let outcome = sweep_at(&state, 日("2026-09-01"), 90, 1 << 30, 1 << 20);
        assert_eq!(outcome.removed, 1, "消えた数が違う: {outcome:?}");
        assert!(!残っている(
            &state,
            card,
            "20260101-000000-aaaaaaaa.png"
        ));
        assert!(残っている(
            &state,
            card,
            "20260830-000000-bbbbbbbb.png"
        ));
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn 合計が上限を超えたら古い順に決めた量だけ消える() {
        // 段②。**「上限を下回るまで」ではない**——ここがログの掃除と違う（利用者の指定）
        let state = 使い捨て("budget");
        let card = CardId(uuid::Uuid::from_u128(2));
        for (index, name) in [
            "20260820-000000-a0000000.png",
            "20260821-000000-b0000000.png",
            "20260822-000000-c0000000.png",
            "20260823-000000-d0000000.png",
        ]
        .iter()
        .enumerate()
        {
            置く(&state, card, name, 100);
            let _ = index;
        }
        // 合計 400、上限 10、一度に掃くのは 250 ぶん
        let outcome = sweep_at(&state, 日("2026-09-01"), 3650, 10, 250);
        assert_eq!(outcome.removed, 3, "決めた量で止まっていない: {outcome:?}");
        assert_eq!(outcome.freed, 300);
        assert!(outcome.over_budget, "まだ超えているのに印が立っていない");
        assert!(!残っている(
            &state,
            card,
            "20260820-000000-a0000000.png"
        ));
        assert!(残っている(
            &state,
            card,
            "20260823-000000-d0000000.png"
        ));
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn 今日置いたものはどちらの段でも消えない() {
        // いま送ろうとしている最中かもしれない
        let state = 使い捨て("today");
        let card = CardId(uuid::Uuid::from_u128(3));
        置く(&state, card, "20260901-000000-a0000000.png", 1000);
        let outcome = sweep_at(&state, 日("2026-09-01"), 0, 1, 1 << 20);
        assert_eq!(outcome.removed, 0, "今日のぶんを消した: {outcome:?}");
        assert!(残っている(
            &state,
            card,
            "20260901-000000-a0000000.png"
        ));
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn 見覚えのない名前には何があっても触らない() {
        // 掃く側と読む側で定義がずれると、掃かれるのに読めないファイルが生まれる
        let state = 使い捨て("unknown");
        let card = CardId(uuid::Uuid::from_u128(4));
        置く(&state, card, "notes.txt", 1000);
        置く(&state, card, "20260101-000000-aaaaaaaa.svg", 1000);
        置く(&state, card, "20260101-000000-aaaaaaaa.png", 10);
        let outcome = sweep_at(&state, 日("2026-09-01"), 0, 1, 1 << 20);
        assert_eq!(outcome.removed, 1, "見覚えのない名前を触った: {outcome:?}");
        assert!(残っている(&state, card, "notes.txt"));
        assert!(残っている(
            &state,
            card,
            "20260101-000000-aaaaaaaa.svg"
        ));
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn 年齢はファイル名で決まり更新時刻に釣られない() {
        // コピーや復元で更新時刻は簡単に変わる
        let state = 使い捨て("mtime");
        let card = CardId(uuid::Uuid::from_u128(5));
        置く(&state, card, "20260101-000000-aaaaaaaa.png", 10);
        // いま書いたので更新時刻は「今日」。それでも名前が古いので消える
        let outcome = sweep_at(&state, 日("2026-09-01"), 90, 1 << 30, 1 << 20);
        assert_eq!(
            outcome.removed, 1,
            "名前ではなく時刻を見ている: {outcome:?}"
        );
        std::fs::remove_dir_all(&state).ok();
    }

    /// 既定の設定で1枚置く。掃除は効かせない（置くことだけを見たいので上限を大きく取る）。
    fn 置いてみる(
        state: &Path,
        card: CardId,
        media_type: &str,
        size: usize,
    ) -> Result<protocol::fs::WrittenBlob, crate::hostfs::HostFsError> {
        write_blob(
            state,
            card,
            media_type,
            &vec![0u8; size],
            90,
            1 << 30,
            200 * 1024 * 1024,
        )
    }

    #[test]
    fn 表に無い種別は置く前に断る() {
        // **場所を作るまでもなく相手ではない。** `svg` もここで落ちる——claude の
        // 貼り付け処理が拾わないので、置いても添付にならない（設計§17）
        let state = 使い捨て("unsupported");
        let card = CardId(uuid::Uuid::from_u128(1));
        for media_type in ["image/svg+xml", "text/plain", "application/pdf"] {
            let err = 置いてみる(&state, card, media_type, 8).expect_err("断ること");
            assert_eq!(
                err.reason,
                protocol::a2s::HostFailure::Unsupported,
                "{media_type}"
            );
        }
        // **1バイトも書かれていないこと。** 断ったのに場所ができていては意味が無い
        assert!(
            !card_dir(&state, card).exists(),
            "断ったのに置き場所ができている"
        );
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn 上限を超えるものは書く前に断る() {
        // 書いてから消すのでは、上限を置いた意味が無い
        let state = 使い捨て("toolarge");
        let card = CardId(uuid::Uuid::from_u128(1));
        let size = (MAX_ATTACHMENT_BYTES + 1) as usize;
        let err = 置いてみる(&state, card, "image/png", size).expect_err("断ること");
        assert_eq!(err.reason, protocol::a2s::HostFailure::TooLarge);
        assert!(
            !card_dir(&state, card).exists(),
            "断ったのに置き場所ができている"
        );
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn 受け取る種別は拡張子つきで置かれる() {
        let state = 使い捨て("accepted");
        let card = CardId(uuid::Uuid::from_u128(1));
        for (media_type, ext) in [
            ("image/png", "png"),
            ("image/jpeg", "jpg"),
            ("image/gif", "gif"),
            ("image/webp", "webp"),
        ] {
            let written = 置いてみる(&state, card, media_type, 16).expect("置けること");
            assert!(
                written.path.ends_with(&format!(".{ext}")),
                "拡張子が違う: {} ({media_type})",
                written.path
            );
            assert_eq!(written.bytes, 16);
            // **縮めていないこと。** 渡したバイト列がそのまま置かれる（設計§8-1）
            let 中身 = std::fs::read(&written.path).expect("読めること");
            assert_eq!(中身.len(), 16, "ダッシュボード側で縮めている");
        }
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn 掃除の古い順は日付と時刻と名前の3段で決まる() {
        // 段②が消す順序。**日付だけで並べると、同じ日に置いたものの間で順序が決まらない**
        // ——決まらないまま「古い順に決めた量だけ」消すと、何が消えるかが実行ごとに変わる
        let state = 使い捨て("order");
        let card = CardId(uuid::Uuid::from_u128(1));
        // 同じ日・同じ時刻で名前だけ違うもの、同じ日で時刻だけ違うもの、を混ぜる
        置く(&state, card, "20260901-000000-aaaaaaaa.png", 400);
        置く(&state, card, "20260901-000000-bbbbbbbb.png", 400);
        置く(&state, card, "20260901-235959-cccccccc.png", 400);
        置く(&state, card, "20260902-000000-dddddddd.png", 400);

        // 合計 1600。上限を 1000 にして 900 ぶん消させる＝古い順に3件
        let _ = sweep_at(&state, 日("2026-09-03"), 90, 1000, 900);

        assert!(
            !残っている(&state, card, "20260901-000000-aaaaaaaa.png"),
            "1番目が残っている"
        );
        assert!(
            !残っている(&state, card, "20260901-000000-bbbbbbbb.png"),
            "2番目が残っている"
        );
        assert!(
            !残っている(&state, card, "20260901-235959-cccccccc.png"),
            "3番目が残っている"
        );
        assert!(
            残っている(&state, card, "20260902-000000-dddddddd.png"),
            "いちばん新しいものまで消えた"
        );
        let _ = std::fs::remove_dir_all(&state);
    }

    #[test]
    fn カードを外すとそのカードのぶんだけ畳まれる() {
        let state = 使い捨て("forget");
        let mine = CardId(uuid::Uuid::from_u128(6));
        let other = CardId(uuid::Uuid::from_u128(7));
        置く(&state, mine, "20260901-000000-a0000000.png", 10);
        置く(&state, other, "20260901-000000-b0000000.png", 10);
        forget(&state, mine);
        assert!(!card_dir(&state, mine).exists(), "自分のぶんが残っている");
        assert!(残っている(
            &state,
            other,
            "20260901-000000-b0000000.png"
        ));
        // 二度目でも落ちないこと（既に無い）
        forget(&state, mine);
        std::fs::remove_dir_all(&state).ok();
    }

    /// 起きたときの掃除が、設定の3値をそのまま [`sweep`] へ渡していること。
    ///
    /// **`sweep` の中身はここで見ない**（上の節が見ている）。ここで確かめたいのは
    /// **入口が繋がっていること**だけ——繋がっていなかったのが段1 で直した穴である。
    #[test]
    fn 起きたときの掃除は設定のとおりに掃く() {
        let state = 使い捨て("start-sweep");
        let card = CardId(uuid::Uuid::new_v4());
        // 今日のぶんは、どの段でも消さない決まりなので、古い日付で置く
        置く(&state, card, "20200101-000000-aaaaaaaa.png", 10);
        置く(&state, card, "20200102-000000-bbbbbbbb.png", 10);

        let mut config = SessionHostConfig::default();
        config.state_dir = Some(state.clone());
        config.attachment_retention_days = 1;

        sweep_on_start(&config);

        assert!(
            !残っている(&state, card, "20200101-000000-aaaaaaaa.png"),
            "保持期間を過ぎたものが残っている"
        );
        assert!(
            !残っている(&state, card, "20200102-000000-bbbbbbbb.png"),
            "保持期間を過ぎたものが残っている"
        );
        std::fs::remove_dir_all(&state).ok();
    }

    /// 掃除の対象が無くても落ちないこと。
    ///
    /// **起動のたびに通る道なので、ここで落ちると起動そのものが落ちる。**
    /// 置き場所がまだ1度も作られていない機械（入れた直後）がこれにあたる。
    #[test]
    fn 置き場所が無くても起きたときの掃除は落ちない() {
        let state = 使い捨て("start-sweep-empty");
        std::fs::remove_dir_all(&state).ok();

        let mut config = SessionHostConfig::default();
        config.state_dir = Some(state.clone());

        sweep_on_start(&config);
    }
}
