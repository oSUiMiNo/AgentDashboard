//! LAN の別端末から開けるアドレスの候補を数え上げる（設計§4）。
//!
//! **外から届く番号を知っている唯一の場所**である。画面はここが返した候補を持っておき、
//! 押された瞬間に写す——押してから聞きに行く形にすると通信が `await` を跨ぐので、
//! 平文 HTTP で開いている端末では**クリップボードへ入らなくなる**（設計§2）。
//!
//! # なぜ居る場所で聞き先が変わるのか
//!
//! **WSL の中からは、外から届く番号が分からない。** WSL が自分に付けている番号
//! （実測 `192.168.147.44`）は横流し（portproxy）の受け先であって、同じ Wi-Fi に居る
//! スマホからは届かない。しかも `192.168.` で始まるので、**見た目では本物と区別が付かない。**
//! だから WSL に居るときは Windows 側へ聞く（§4-3）。
//!
//! # ここは製品コードで唯一 `powershell.exe` を起こす場所である
//!
//! 呼び出しには**必ず時間切れが要る**（[`ASK_TIMEOUT`]）。interop は止まることがあり、
//! ここで固まるとダッシュボードの応答が丸ごと詰まる。
//!
//! # 新しい crate を足していない
//!
//! 数え上げに要るのは `ip` と `powershell.exe` の出力を読むことだけで、どちらも
//! 文字列として届く。`crates/core/tests/dependencies.rs` が依存の増減を見張っており、
//! **この機能のために境界を動かす価値は無い**（設計§4-2）。

use crate::config::ServerConfig;
use crate::ws::AppState;
use axum::{Json, extract::State};
use std::net::Ipv4Addr;
use std::time::Duration;

/// Windows へ聞くのを諦めるまで（設計§4-3）。
///
/// **無いとダッシュボードの応答が丸ごと詰まる。** interop は止まることがあり、
/// この1本が返らないだけで `/api/lan-address` を待っている接続が全部止まる。
pub const ASK_TIMEOUT: Duration = Duration::from_secs(5);

/// どこから来た番号か（設計§5）。
///
/// **外れたときに、どちらの経路を疑えばよいかが分かる**ように残す。`self`
/// （いま開いているアドレス）は**画面が足す**ので、ここには無い（設計§4-6）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Windows へ聞いた番号（§4-3）。推定——届くはずだが、確かめてはいない
    Windows,
    /// `ip` で読んだ番号（§4-2）。同上
    Linux,
}

/// 候補1つ（設計§5）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Candidate {
    /// 番号そのもの。**URL は画面が組み立てる**ので、ここにパスも scheme も持たない（§3）
    pub addr: String,
    /// インターフェースの名前（`Wi-Fi` ／ `eth0` など）。どれのことか人が見分けるため
    pub label: String,
    pub source: Source,
}

/// `GET /api/lan-address` の応答（設計§5）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LanAddressView {
    pub port: u16,
    pub bind_addr: String,
    /// 待ち受けが広がっているか。**偽なら画面はコピーを出さず、広げ方を案内する**
    pub reachable: bool,
    /// 絞り込んだ結果。**空でありうる**
    pub candidates: Vec<Candidate>,
    /// 候補が空のときの理由。人が読む文
    pub note: Option<String>,
}

/// 絞り込む前の1件。
///
/// **どの経路で拾ったかによらず、同じ形へ均してから規則を当てる**（規則は「両方に共通」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nic {
    pub addr: Ipv4Addr,
    pub iface: String,
    /// 既定のゲートウェイを持つインターフェースか（規則6の第1キー）
    pub has_gateway: bool,
    /// `PrefixOrigin` が `Dhcp` か（規則6の第2キー）。
    ///
    /// **絞り込みには使わない。** 固定 IP で運用している家庭では正解が `Manual` になり、
    /// WSL の仮想スイッチと見分けが付かなくなる（設計§4-3）
    pub dhcp: bool,
}

/// `ip -4 -o addr show` の1行から取れるもの。
///
/// `prefix` を別に持つのは、**ゲートウェイが属する網を割り出す**のに要るからで、
/// 規則そのものには使わない（[`gateway_net`]）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAddr {
    pub nic: Nic,
    pub prefix: u8,
}

/// どちらの枝で数えるか（設計§4-1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    /// WSL に居る。Windows 側へ聞く（§4-3）
    Windows,
    /// WSL に居ない。`ip` を読む（§4-2）
    Linux,
}

/// `/proc/sys/kernel/osrelease` の中身から、どちらの枝を選ぶかを決める（設計§4-1）。
///
/// **環境変数 `WSL_DISTRO_NAME` は見ない。** 実測で空だった——常駐プロセスは、それを
/// 持たない親から起きているためで、**見分けの材料にすると WSL に居るのに Linux の枝を
/// 選ぶ**。この関数が引数を1つしか取らないこと自体が、その担保になっている。
pub fn probe_for(osrelease: &str) -> Probe {
    if osrelease.to_ascii_lowercase().contains("microsoft") {
        Probe::Windows
    } else {
        Probe::Linux
    }
}

/// いまこの機械が WSL の中に居るか（設計§4-1）。
///
/// 読めなければ WSL ではないとみなす——読めない Linux はありふれているが、
/// 読めない WSL は無い。
pub fn probe() -> Probe {
    match std::fs::read_to_string("/proc/sys/kernel/osrelease") {
        Ok(text) => probe_for(&text),
        Err(_) => Probe::Linux,
    }
}

/// アドレスが、その網に属するか。
///
/// 規則4が**番号の見た目ではなく網の計算**で判定するための道具である。
/// 「`172.` で始まるものを除く」式にすると、この機械では素通りする（設計§4-4）。
fn in_net(addr: Ipv4Addr, net: Ipv4Addr, prefix: u8) -> bool {
    if prefix == 0 {
        return true;
    }
    if prefix > 32 {
        return false;
    }
    let mask: u32 = u32::MAX << (32 - u32::from(prefix));
    (u32::from(addr) & mask) == (u32::from(net) & mask)
}

/// 絞り込む（設計§4-4 の規則1〜6）。上から順に当てる。
///
/// `wsl_net` は**WSL に居るときだけ** `Some`（規則4）。`None` を渡すと規則4が効かない
/// 状態になるが、**それでも `vEthernet (WSL` は規則5で落ちる**——二重にしてあるのは
/// 「規則4は網の計算を1つでも間違えると素通りし、規則5は名前が変われば効かなくなる」
/// という**外れ方の違い**のためで、片方が外れても残るようにしてある。
pub fn narrow(nics: Vec<Nic>, wsl_net: Option<(Ipv4Addr, u8)>) -> Vec<Nic> {
    let mut kept: Vec<Nic> = nics
        .into_iter()
        .filter(|nic| {
            // 規則1：自分からしか届かない。**名前でも見る**——WSL は `lo` へ
            // `10.255.255.254/32` を付ける（実測）。`127.` で始まらないので網では
            // 落ちず、`scope host` でもないので scope でも落ちない。放っておくと
            // 規則3 が「家の中の番号」として拾い上げてしまう
            if nic.addr.is_loopback() || nic.iface == "lo" {
                return false;
            }
            // 規則2：アドレスを貰えていない印
            if nic.addr.is_link_local() {
                return false;
            }
            // 規則3：家の中の番号だけ残す（`10/8` ／ `172.16/12` ／ `192.168/16`）。
            // **これだけでは1つも落ちない**ことに注意（設計§4-4a）
            if !nic.addr.is_private() {
                return false;
            }
            // 規則4：WSL の横流し網を捨てる
            if let Some((net, prefix)) = wsl_net
                && in_net(nic.addr, net, prefix)
            {
                return false;
            }
            // 規則5：名前でも重ねて捨てる
            if nic.iface.starts_with("vEthernet (WSL") {
                return false;
            }
            true
        })
        .collect();
    // 規則6：ゲートウェイを持つものが先、同点なら `Dhcp` が先。
    // **安定ソート**なので、同点のものは拾った順のまま残る
    kept.sort_by_key(|nic| (!nic.has_gateway, !nic.dhcp));
    kept
}

/// `ip -4 -o addr show` の出力を読む（設計§4-2）。
///
/// 実物はこの形で、**同じインターフェースに複数の行が付く**（`lo` に2本）。
///
/// ```text
/// 1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever
/// 2: eth0    inet 192.168.147.44/20 brd 192.168.159.255 scope global eth0\       valid_lft forever
/// ```
///
/// `brd` や `scope` の語は**読み飛ばす**。`inet` の次だけが番号である。
pub fn parse_ip_addr(out: &str) -> Vec<LocalAddr> {
    let mut found = Vec::new();
    for line in out.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // `<index>: <iface> inet <addr>/<prefix> ...`
        let Some(iface) = tokens.get(1) else {
            continue;
        };
        let Some(at) = tokens.iter().position(|t| *t == "inet") else {
            continue;
        };
        let Some(cidr) = tokens.get(at + 1) else {
            continue;
        };
        let (addr, prefix) = match cidr.split_once('/') {
            Some((addr, prefix)) => (addr, prefix.parse::<u8>().unwrap_or(32)),
            // `/` が無い形も受ける（単独のアドレスとみなす）
            None => (*cidr, 32),
        };
        let Ok(addr) = addr.parse::<Ipv4Addr>() else {
            continue;
        };
        found.push(LocalAddr {
            nic: Nic {
                addr,
                iface: (*iface).to_string(),
                has_gateway: false,
                dhcp: false,
            },
            prefix,
        });
    }
    found
}

/// `ip route show default` から、既定のゲートウェイと、それを持つインターフェースを読む。
///
/// 実物は `default via 192.168.144.1 dev eth0 proto kernel`。
///
/// **読めない行は飛ばして次を見る。** 経路が複数行あるとき、先頭が `via` を持たない形
/// （`default dev tun0` など）だと、そこで諦めると本物のゲートウェイを取り逃がす。
pub fn parse_default_route(out: &str) -> Option<(Ipv4Addr, String)> {
    out.lines().find_map(|line| {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let via = tokens.iter().position(|t| *t == "via")?;
        let addr = tokens.get(via + 1)?.parse::<Ipv4Addr>().ok()?;
        let dev = tokens
            .iter()
            .position(|t| *t == "dev")
            .and_then(|at| tokens.get(at + 1))
            .map(|s| (*s).to_string())
            .unwrap_or_default();
        Some((addr, dev))
    })
}

/// ゲートウェイが属する網を、自分のインターフェースの CIDR から割り出す（規則4）。
///
/// **番号の見た目からは決められない。** 「`192.168.` で始まるかどうか」では、外から届く
/// `192.168.0.12` と横流し用の `192.168.147.44` が同じ顔になる。ゲートウェイを含む
/// CIDR を持っているインターフェースを探すことで、**その機械の実際の網**が分かる。
pub fn gateway_net(locals: &[LocalAddr], gw: Ipv4Addr) -> Option<(Ipv4Addr, u8)> {
    locals
        .iter()
        .find(|local| in_net(gw, local.nic.addr, local.prefix))
        .map(|local| (local.nic.addr, local.prefix))
}

/// Windows へ聞いた答え（JSON）を読む（設計§4-3）。
///
/// `ConvertTo-Json` は**要素が1つだと配列にならない**ので、どちらの形も受ける。
pub fn parse_windows_json(raw: &str) -> Result<Vec<Nic>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw.trim()).map_err(|err| format!("答えを読めません: {err}"))?;
    let rows = match value {
        serde_json::Value::Array(rows) => rows,
        row @ serde_json::Value::Object(_) => vec![row],
        _ => return Err("答えが表の形をしていません".to_string()),
    };
    let mut found = Vec::new();
    for row in rows {
        let Some(addr) = row.get("addr").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(addr) = addr.trim().parse::<Ipv4Addr>() else {
            continue;
        };
        let iface = row
            .get("iface")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let has_gateway = row.get("gw").and_then(|v| v.as_bool()).unwrap_or(false);
        let dhcp = row
            .get("origin")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("Dhcp"));
        found.push(Nic {
            addr,
            iface,
            has_gateway,
            dhcp,
        });
    }
    Ok(found)
}

/// Windows へ投げる PowerShell（設計§4-3）。
///
/// **出力の文字コードを明示している。** インターフェース名には日本語が入りうる
/// （実測に `イーサネット` と `Bluetooth ネットワーク接続` があった）ので、
/// 既定のままだと化けて名前で判定する規則5が効かなくなる。
const ASK_SCRIPT: &str = "\
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
Get-NetIPConfiguration | ForEach-Object { \
  $gw = $null -ne $_.IPv4DefaultGateway; \
  $alias = $_.InterfaceAlias; \
  foreach ($a in $_.IPv4Address) { \
    [PSCustomObject]@{ addr = $a.IPAddress; iface = $alias; gw = $gw; origin = [string]$a.PrefixOrigin } \
  } \
} | ConvertTo-Json -Compress";

/// 聞けなかったときの言い分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskError {
    /// 時間切れ（[`ASK_TIMEOUT`]）
    Timeout,
    /// 起こせなかった・失敗した
    Failed(String),
}

impl AskError {
    /// 画面に出す `note` の文へ（設計§4-5）。
    pub fn note(&self) -> String {
        match self {
            Self::Timeout => "Windows へ聞けませんでした（応答がありませんでした）".to_string(),
            Self::Failed(why) => format!("Windows へ聞けませんでした（{why}）"),
        }
    }
}

/// 外の道具を1つ起こして、標準出力を読む。**時間切れを必ず取る。**
///
/// `kill_on_drop` を付けてあるので、時間切れで捨てた子は置き去りにならない。
pub async fn run_with_timeout(
    program: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, AskError> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let run = async {
        let out = cmd
            .output()
            .await
            .map_err(|err| AskError::Failed(err.to_string()))?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr);
            let why = why.trim();
            let why = if why.is_empty() {
                format!("終了コード {}", out.status)
            } else {
                why.chars().take(200).collect()
            };
            return Err(AskError::Failed(why));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(result) => result,
        Err(_) => Err(AskError::Timeout),
    }
}

/// Windows 側へ聞く（設計§4-3）。
async fn ask_windows() -> Result<Vec<Nic>, AskError> {
    let raw = run_with_timeout(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", ASK_SCRIPT],
        ASK_TIMEOUT,
    )
    .await?;
    parse_windows_json(&raw).map_err(AskError::Failed)
}

/// `ip` を読む（設計§4-2）。ゲートウェイの持ち主にだけ印を付けて返す。
async fn ask_linux() -> Result<(Vec<Nic>, Vec<LocalAddr>), AskError> {
    let addrs = run_with_timeout("ip", &["-4", "-o", "addr", "show"], ASK_TIMEOUT).await?;
    let mut locals = parse_ip_addr(&addrs);
    // 既定の経路は**取れなくてもよい**。取れないと規則6の並びが甘くなるだけで、
    // 絞り込みそのものは効く
    let route = run_with_timeout("ip", &["route", "show", "default"], ASK_TIMEOUT)
        .await
        .ok()
        .and_then(|out| parse_default_route(&out));
    if let Some((_, dev)) = &route {
        for local in &mut locals {
            if &local.nic.iface == dev {
                local.nic.has_gateway = true;
            }
        }
    }
    let nics = locals.iter().map(|local| local.nic.clone()).collect();
    Ok((nics, locals))
}

/// 数え上げた結果から応答を組み立てる（設計§4-5・§5）。
///
/// **聞けなかったときに、手元の番号へ落ちない。** 候補ゼロ＋理由を返す——
/// 間違った番号を渡すより、出さないほうがよい（要件「最悪の壊れ方」）。
pub fn build(
    config: &ServerConfig,
    outcome: Result<Vec<Nic>, AskError>,
    wsl_net: Option<(Ipv4Addr, u8)>,
    source: Source,
) -> LanAddressView {
    let (candidates, note) = match outcome {
        Ok(nics) => {
            let kept = narrow(nics, wsl_net);
            let note = kept
                .is_empty()
                .then(|| "家の中の番号が1つも見つかりませんでした".to_string());
            let candidates = kept
                .into_iter()
                .map(|nic| Candidate {
                    addr: nic.addr.to_string(),
                    label: nic.iface,
                    source,
                })
                .collect();
            (candidates, note)
        }
        Err(err) => (Vec::new(), Some(err.note())),
    };
    LanAddressView {
        port: config.port,
        bind_addr: config.bind_addr.clone(),
        // **判定を作り直さない**（設計§5）。`bind_addr` の綴りは何通りもあり、
        // 条件を書き直すと必ず抜ける
        reachable: config.reachable_from_lan(),
        candidates,
        note,
    }
}

/// いまの機械の候補を数え上げる（設計§4）。
pub async fn collect(config: &ServerConfig) -> LanAddressView {
    match probe() {
        Probe::Windows => {
            // 横流し網は**自分側**から割り出す（規則4）。取れなくても規則5が残る
            let wsl_net = wsl_net_of_self().await;
            build(config, ask_windows().await, wsl_net, Source::Windows)
        }
        Probe::Linux => match ask_linux().await {
            // WSL に居ないので規則4は当てない（設計§4-4）
            Ok((nics, _)) => build(config, Ok(nics), None, Source::Linux),
            Err(err) => build(config, Err(err), None, Source::Linux),
        },
    }
}

/// `GET /api/lan-address` — LAN の別端末から開ける番号の候補（設計§5）。
///
/// **鍵の内側に置く**（`lib.rs` の `protected`）。機械のアドレスは、外から誰でも
/// 読めてよいものではない。
///
/// **合言葉は一切返さない。** 返すのは番号と、それをどこから拾ったかだけである。
pub async fn api_lan_address(State(state): State<AppState>) -> Json<LanAddressView> {
    Json(collect(&state.config).await)
}

/// WSL 側の横流し網を割り出す（規則4）。
async fn wsl_net_of_self() -> Option<(Ipv4Addr, u8)> {
    let addrs = run_with_timeout("ip", &["-4", "-o", "addr", "show"], ASK_TIMEOUT)
        .await
        .ok()?;
    let locals = parse_ip_addr(&addrs);
    let route = run_with_timeout("ip", &["route", "show", "default"], ASK_TIMEOUT)
        .await
        .ok()?;
    let (gw, _) = parse_default_route(&route)?;
    gateway_net(&locals, gw)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// この機械で実際に出た `ip -4 -o addr show`（2026-09-05 実測）。
    const REAL_IP_ADDR: &str = "\
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
1: lo    inet 10.255.255.254/32 brd 10.255.255.254 scope global lo\\       valid_lft forever preferred_lft forever
2: eth0    inet 192.168.147.44/20 brd 192.168.159.255 scope global eth0\\       valid_lft forever preferred_lft forever
";

    fn nic(addr: &str, iface: &str) -> Nic {
        Nic {
            addr: addr.parse().expect("番号として読めること"),
            iface: iface.to_string(),
            has_gateway: false,
            dhcp: false,
        }
    }

    /// この機械で実際に出た Windows 側の8件（設計§4-3 の表）。
    fn real_windows() -> Vec<Nic> {
        vec![
            Nic {
                dhcp: true,
                has_gateway: true,
                ..nic("192.168.0.12", "Wi-Fi")
            },
            nic("192.168.144.1", "vEthernet (WSL (Hyper-V firewall))"),
            nic("192.168.147.44", "vEthernet (WSL)"),
            nic("169.254.119.164", "Wi-Fi 4"),
            nic("169.254.174.111", "Wi-Fi 3"),
            nic("169.254.174.32", "イーサネット"),
            nic("169.254.227.231", "McAfee VPN"),
            nic("169.254.211.240", "Bluetooth ネットワーク接続"),
        ]
    }

    /// この機械の WSL 側の網（実測 `192.168.147.44/20` → `192.168.144.0/20`）。
    fn wsl_net() -> Option<(Ipv4Addr, u8)> {
        Some(("192.168.147.44".parse().expect("読めること"), 20))
    }

    #[test]
    fn 自分からしか届かない番号を候補に入れない() {
        let kept = narrow(vec![nic("127.0.0.1", "lo")], None);
        assert!(kept.is_empty(), "127.0.0.1 が残っている：{kept:?}");
    }

    #[test]
    fn アドレスを貰えていない番号を候補に入れない() {
        let kept = narrow(vec![nic("169.254.119.164", "Wi-Fi 4")], None);
        assert!(kept.is_empty(), "169.254.x.x が残っている：{kept:?}");
    }

    #[test]
    fn 家の中の番号でないものを候補に入れない() {
        // 外向きのグローバルアドレスは、配っても相手から届かない
        let kept = narrow(vec![nic("203.0.113.7", "eth0")], None);
        assert!(kept.is_empty(), "外の番号が残っている：{kept:?}");
    }

    #[test]
    fn 実測の8件を与えると残るのは1つだけ() {
        // 設計§4-4a の検算そのもの。**この機械で実際に出る顔ぶれをそのまま入力にする**
        let kept = narrow(real_windows(), wsl_net());
        let addrs: Vec<String> = kept.iter().map(|n| n.addr.to_string()).collect();
        assert_eq!(
            addrs,
            vec!["192.168.0.12".to_string()],
            "残ったもの：{addrs:?}"
        );
    }

    #[test]
    fn ゲートウェイの網に居る番号を候補に入れない() {
        // 規則4。`192.168.147.44` は `192.168.144.0/20` に入るので落ちる
        let kept = narrow(vec![nic("192.168.147.44", "eth0")], wsl_net());
        assert!(kept.is_empty(), "横流し網の番号が残っている：{kept:?}");
    }

    #[test]
    fn 規則4を外しても名前で落ちる() {
        // 二重にした意味がここで確かめられる（設計§4-4 の規則5）。
        // **網の計算を1つでも間違えると規則4は素通りする**ので、名前でも重ねて捨てる
        let kept = narrow(
            vec![nic("192.168.144.1", "vEthernet (WSL (Hyper-V firewall))")],
            None,
        );
        assert!(kept.is_empty(), "名前で落ちていない：{kept:?}");
    }

    #[test]
    fn 見た目が同じでも網で見分ける() {
        // **`192.168.` で始まるだけで通してしまわない。** 本物と横流しは見た目が同じで、
        // 違うのは「その機械のゲートウェイが属する網に入るかどうか」だけである
        let kept = narrow(
            vec![nic("192.168.0.12", "Wi-Fi"), nic("192.168.147.44", "eth0")],
            wsl_net(),
        );
        let addrs: Vec<String> = kept.iter().map(|n| n.addr.to_string()).collect();
        assert_eq!(
            addrs,
            vec!["192.168.0.12".to_string()],
            "残ったもの：{addrs:?}"
        );
    }

    #[test]
    fn 固定IPの家庭でも正解を捨てない() {
        // `PrefixOrigin` が `Manual` でも落とさない（設計§4-3）。`Dhcp` は
        // **順番の材料**であって、絞り込みの材料ではない
        let manual = Nic {
            dhcp: false,
            has_gateway: true,
            ..nic("192.168.0.12", "Wi-Fi")
        };
        let kept = narrow(vec![manual], None);
        assert_eq!(kept.len(), 1, "固定 IP の正解を捨てている：{kept:?}");
    }

    #[test]
    fn ゲートウェイを持つものが先に並ぶ() {
        let plain = nic("192.168.0.50", "eth1");
        let gw = Nic {
            has_gateway: true,
            ..nic("192.168.0.12", "Wi-Fi")
        };
        let kept = narrow(vec![plain, gw], None);
        assert_eq!(
            kept[0].addr.to_string(),
            "192.168.0.12",
            "ゲートウェイ持ちが先頭に来ていない：{kept:?}"
        );
    }

    #[test]
    fn 同点ならDhcpが先に並ぶ() {
        let manual = nic("192.168.0.50", "eth1");
        let dhcp = Nic {
            dhcp: true,
            ..nic("192.168.0.12", "Wi-Fi")
        };
        let kept = narrow(vec![manual, dhcp], None);
        assert_eq!(
            kept[0].addr.to_string(),
            "192.168.0.12",
            "Dhcp が先に来ていない：{kept:?}"
        );
    }

    #[test]
    fn 生の出力をそのまま分解できる() {
        // **構造化済みのレコードではなく、生テキストを読む経路を通す。**
        // CIDR の切り落とし・`brd` と `scope` の読み飛ばし・
        // **同じインターフェースに複数の行が付く形**まで
        let locals = parse_ip_addr(REAL_IP_ADDR);
        let got: Vec<(String, String, u8)> = locals
            .iter()
            .map(|l| (l.nic.addr.to_string(), l.nic.iface.clone(), l.prefix))
            .collect();
        assert_eq!(
            got,
            vec![
                ("127.0.0.1".to_string(), "lo".to_string(), 8),
                ("10.255.255.254".to_string(), "lo".to_string(), 32),
                ("192.168.147.44".to_string(), "eth0".to_string(), 20),
            ],
            "生の出力を読めていない：{got:?}"
        );
    }

    #[test]
    fn loに付いた番号を候補に入れない() {
        // **これは番号だけでは落ちない**（設計§4-4 の規則1）——`127.` で始まらず、
        // `scope global` が付いており、放っておくと規則3が「家の中の番号」として拾う
        let nics: Vec<Nic> = parse_ip_addr(REAL_IP_ADDR)
            .into_iter()
            .map(|l| l.nic)
            .collect();
        let kept = narrow(nics, None);
        let addrs: Vec<String> = kept.iter().map(|n| n.addr.to_string()).collect();
        assert!(
            !addrs.contains(&"10.255.255.254".to_string()),
            "lo に付いた番号が残っている：{addrs:?}"
        );
    }

    #[test]
    fn 既定の経路からゲートウェイを読む() {
        let got = parse_default_route("default via 192.168.144.1 dev eth0 proto kernel \n");
        assert_eq!(
            got,
            Some((
                "192.168.144.1".parse().expect("読めること"),
                "eth0".to_string()
            )),
            "既定の経路を読めていない：{got:?}"
        );
    }

    #[test]
    fn 経路が複数行でもゲートウェイを取り逃がさない() {
        // **先頭の行で諦めない。** `via` を持たない経路（VPN の tun など）が先に並ぶことが
        // あり、そこで打ち切ると本物のゲートウェイが見えなくなる
        let got = parse_default_route(
            "default dev tun0 scope link\ndefault via 192.168.144.1 dev eth0\n",
        );
        assert_eq!(
            got,
            Some((
                "192.168.144.1".parse().expect("読めること"),
                "eth0".to_string()
            )),
            "2行目のゲートウェイを取り逃がしている：{got:?}"
        );
    }

    #[test]
    fn ゲートウェイが属する網を自分のCIDRから割り出す() {
        // **番号の見た目からは決められない**（設計§4-4）
        let locals = parse_ip_addr(REAL_IP_ADDR);
        let gw: Ipv4Addr = "192.168.144.1".parse().expect("読めること");
        let got = gateway_net(&locals, gw);
        assert_eq!(
            got,
            Some(("192.168.147.44".parse().expect("読めること"), 20)),
            "網を割り出せていない：{got:?}"
        );
    }

    #[test]
    fn osrelease_に_microsoft_があれば_Windows_へ聞く() {
        assert_eq!(
            probe_for("6.6.87.2-microsoft-standard-WSL2"),
            Probe::Windows
        );
        // 大小は無視する
        assert_eq!(probe_for("5.10.0-Microsoft-standard"), Probe::Windows);
    }

    #[test]
    fn osrelease_に_microsoft_が無ければ_ip_を読む() {
        assert_eq!(probe_for("6.8.0-45-generic"), Probe::Linux);
    }

    #[test]
    fn 見分けに環境変数を使っていない() {
        // **`WSL_DISTRO_NAME` は実測で空だった**（常駐プロセスは、それを持たない親から
        // 起きているため）。使うと WSL に居るのに Linux の枝を選ぶので、
        // **この語がソースに現れないこと自体を見張る**
        let source = include_str!("lan_address.rs");
        assert!(
            !source.contains("WSL_DISTRO_NAME\""),
            "見分けに環境変数を使っている"
        );
    }

    #[tokio::test]
    async fn 応答が返らない相手でも時間切れで戻る() {
        let started = std::time::Instant::now();
        let got = run_with_timeout("sleep", &["30"], Duration::from_millis(200)).await;
        assert_eq!(
            got,
            Err(AskError::Timeout),
            "時間切れになっていない：{got:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "時間切れが効いていない（{:?} 待った）",
            started.elapsed()
        );
    }

    #[test]
    fn 時間切れの上限は5秒である() {
        // 設計§4-3。**ここで固まるとダッシュボードの応答が丸ごと詰まる**
        assert_eq!(ASK_TIMEOUT, Duration::from_secs(5));
    }

    #[test]
    fn 聞けなかったときは候補ゼロと理由になる() {
        // **手元の番号へ落ちない**（設計§4-3）。間違った番号を渡すより、出さないほうがよい
        let config = ServerConfig {
            bind_addr: "0.0.0.0".to_string(),
            ..ServerConfig::default()
        };
        let view = build(&config, Err(AskError::Timeout), wsl_net(), Source::Windows);
        assert!(
            view.candidates.is_empty(),
            "候補が出ている：{:?}",
            view.candidates
        );
        let note = view.note.expect("理由が入ること");
        assert!(note.contains("Windows"), "理由が読めない：{note}");
    }

    #[test]
    fn 候補が0個のときは理由が入る() {
        let config = ServerConfig::default();
        let view = build(
            &config,
            Ok(vec![nic("127.0.0.1", "lo")]),
            None,
            Source::Linux,
        );
        assert!(view.candidates.is_empty());
        assert!(view.note.is_some(), "理由が入っていない");
    }

    #[test]
    fn reachable_は4通りすべてで正しい() {
        // **4通り通すことに意味がある**：`bind_addr == "127.0.0.1"` と決め打ちで書いても
        // 1通りだけなら通ってしまい、既存の `reachable_from_lan()` を呼んでいるのか
        // 判定を作り直したのかが見分けられない（設計§5）
        for addr in ["127.0.0.1", "localhost", "::1", "[::1]"] {
            let config = ServerConfig {
                bind_addr: addr.to_string(),
                ..ServerConfig::default()
            };
            let view = build(&config, Ok(Vec::new()), None, Source::Linux);
            assert!(!view.reachable, "{addr} が届くことになっている");
        }
        for addr in ["0.0.0.0", "192.168.0.12", "::"] {
            let config = ServerConfig {
                bind_addr: addr.to_string(),
                ..ServerConfig::default()
            };
            let view = build(&config, Ok(Vec::new()), None, Source::Linux);
            assert!(view.reachable, "{addr} が届かないことになっている");
        }
    }

    #[test]
    fn Windows_の答えは配列でも単体でも読める() {
        // `ConvertTo-Json` は**要素が1つだと配列にならない**
        let one = r#"{"addr":"192.168.0.12","iface":"Wi-Fi","gw":true,"origin":"Dhcp"}"#;
        let got = parse_windows_json(one).expect("読めること");
        assert_eq!(got.len(), 1, "単体を読めていない：{got:?}");
        assert!(got[0].has_gateway && got[0].dhcp);

        let many = format!("[{one},{one}]");
        assert_eq!(parse_windows_json(&many).expect("読めること").len(), 2);
    }

    #[test]
    fn 応答に合言葉が混ざらない() {
        // 設計§5。**合言葉は一切返さない**——欄そのものが無いことを、書き出した
        // JSON の字面で見張る
        let config = ServerConfig::default();
        let view = build(&config, Ok(real_windows()), wsl_net(), Source::Windows);
        let json = serde_json::to_string(&view).expect("書き出せること");
        for word in ["password", "secret", "token", "lan_password"] {
            assert!(!json.contains(word), "{word} が応答に混ざっている：{json}");
        }
    }
}
