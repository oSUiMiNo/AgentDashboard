//! フックの受信口（設計§7 の HookIngest）。
//!
//! セッションに注入した settings は `POST /hook/{token}/{event}` を叩くように書いてある
//! （[`crate::session::hooks_settings`]）。ここで受けたものを状態機械
//! （[`crate::state`]）へ通し、変わった分をブラウザへ配る。
//!
//! # 認証は「合言葉」だけ
//!
//! 待ち受けは 127.0.0.1 のみで、URL にセッションごとのランダムな合言葉を埋めてある。
//! カードIDをそのまま載せていないのは、値が推測できると外から状態を書き換えられてしまう
//! ため。個人用のローカルツールとしてはこれで十分な強度になる。
//!
//! # 遅らせない・拒まない
//!
//! - 応答は即返す。フックは非同期モードで動くとはいえ、SessionEnd だけは CLI 側の
//!   タイムアウトが 1.5 秒しかない
//! - 知らないイベント名は**受け流す**。Claude Code が将来イベントを増やしても、
//!   ダッシュボードが 4xx を返してログを汚すようなことにはしない

use crate::{
    session::SessionManager,
    state::{HookEvent, HookInput},
};
use axum::{
    Router,
    extract::{Path, State},
    http::StatusCode,
    routing::post,
};
use protocol::ContextUsage;
use serde_json::Value;
use std::sync::Arc;

/// 受信口が必要とするもの。**ブラウザ向けの状態（`AppState`）とは別に持つ。**
///
/// フックの宛先はどちらのモードでも「セッションホストの 127.0.0.1」であり（設計§7）、
/// セルフホストモードではサーバ側の待ち受けとは**別のプロセス・別のポート**になる
/// （設計§5-3）。ここがブラウザ配信側の状態に相乗りしていると、その分離ができない。
#[derive(Clone)]
pub struct HookState {
    pub manager: Arc<SessionManager>,
}

/// フックと `statusLine` の受信口をまとめたルータ。
///
/// ローカルモードではブラウザ向けのルータと同じポートへ合成され（`agentdashboard_core`）、
/// セルフホストモードではセッションホスト自身のポートで単独に立つ（フェーズ3）。
pub fn routes(manager: Arc<SessionManager>) -> Router {
    Router::new()
        .route("/hook/{token}/{event}", post(receive))
        // 注入した statusLine がいまのモデルを知らせてくる（設計§4）
        .route("/model/{token}", post(receive_model))
        .with_state(HookState { manager })
}

/// フックの受信口を**自分のポートで**開く（セルフホスト化設計§5-3）。
///
/// # 先にポートを確定させてから設定を作る
///
/// 注入する settings にはフックの宛先 URL が焼き込まれるので、**セッションを起こす前に
/// 番号が決まっていないと届かない**。だから「開く」と「配る」を2つに分けてある——
/// 呼び出し側は [`bind`] で番号を取り、その番号を `SessionHostConfig::hook_port` に入れて
/// マネージャを作り、最後に [`serve`] を呼ぶ。
///
/// 待ち受けは **127.0.0.1 のみ**。フックの宛先はどちらのモードでも PC の中で、
/// ネットワークへ出す理由が無い（要件7）。
pub async fn bind(port: u16) -> std::io::Result<(tokio::net::TcpListener, u16)> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let bound = listener.local_addr()?.port();
    Ok((listener, bound))
}

/// [`bind`] で取った待ち受けでフックを受け始める。
pub fn serve(listener: tokio::net::TcpListener, manager: Arc<SessionManager>) {
    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, routes(manager)).await {
            // ここが落ちると状態が永久に「不明」のままになる。黙って終わらない
            tracing::error!("フックの受信口が止まりました: {err}");
        }
    });
}

/// `POST /hook/{token}/{event}` の受け口。
pub async fn receive(
    State(state): State<HookState>,
    Path((token, event)): Path<(String, String)>,
    body: String,
) -> StatusCode {
    let Some(session) = state.manager.resolve_token(&token) else {
        // カードの存在を漏らさないため、合言葉違いは一律で「そんなURLは無い」とする
        return StatusCode::NOT_FOUND;
    };

    let Some(event) = HookEvent::parse(&event) else {
        tracing::debug!(
            card_id = %session.card_id,
            "注入していないフックイベントを受け取りました: {event}"
        );
        return StatusCode::NO_CONTENT;
    };

    // 壊れたJSONでも受け流す。フックの中身が読めないことより、CLI 側を止めない方が大事
    let payload = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    state
        .manager
        .handle_hook(&session, &HookInput::new(event, payload));

    StatusCode::NO_CONTENT
}

/// `POST /model/{token}` の受け口（設計§4）。
///
/// 注入した `statusLine` が、セッションの JSON をそのまま送ってくる。フックと同じ
/// 合言葉を使い回すので、認証の考え方も同じ（127.0.0.1 のみ＋推測できない合言葉）。
///
/// # 読むのは要る欄だけ
///
/// 届く JSON には14個のキーが入っている（フェーズ0 で実測。記録は設計§11 前提1）が、
/// 読むのは `model.id` ／ `model.display_name` ／ `context_window` の3箇所だけで、
/// **残りは読まない。**
///
/// **丸ごとデシリアライズしない**のは、CLI 側がキーを増減してもここが壊れないように
/// するため。欄が無ければ「まだ分からない」として扱い、知らない欄は無視する。
/// **この作りは読む欄が増えても変えない**——増えたのは数であって、作りではない。
///
/// # モデルと使用率は別々に読む
///
/// `context_window` は `model.id` の検査より**前**で読む。下に置くと、モデル名が
/// 欠けた payload で使用率も一緒に落ちる——**モデル名が読めないことと、使用率が
/// 読めないことは別の事情**である（コンテキスト残量設計§1）。
///
/// # 変わったときだけ配る
///
/// `refreshInterval` の周期で届くので、毎回カードを送り直すとセッション数だけ無駄が
/// 積み上がる。値が動いたときだけ配信する（フックの `permission_mode` と同じ判断）。
pub async fn receive_model(
    State(state): State<HookState>,
    Path(token): Path<String>,
    body: String,
) -> StatusCode {
    let Some(session) = state.manager.resolve_token(&token) else {
        return StatusCode::NOT_FOUND;
    };

    // 壊れた JSON でも受け流す。statusLine を止めない方が大事
    let payload = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);

    // **モデルの検査より前に読む。** 下へ置くと、モデル名が欠けた payload で
    // 使用率も一緒に落ちる（コンテキスト残量設計§1）。
    //
    // 返り値（配る必要があったか）をここで使わないのは、**配るのは向こうの仕事**
    // だから。控えた値が正本で、動いたときだけ軽い便が出る（コンテキスト残量設計§2）
    match read_context_usage(&payload) {
        ContextRead::Read(usage) => {
            state.manager.apply_context_usage(&session, usage);
        }
        // **読めなかったときは触らない。** 控えた値をそのまま残す——ここで
        // `None` を渡すと、壊れた POST 1回でゲージが消える
        ContextRead::Unreadable => {}
    }

    let Some(id) = payload
        .get("model")
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        tracing::debug!(
            card_id = %session.card_id,
            "statusLine の payload に model.id がありません"
        );
        return StatusCode::NO_CONTENT;
    };
    let label = payload
        .get("model")
        .and_then(|model| model.get("display_name"))
        .and_then(Value::as_str)
        .filter(|label| !label.is_empty())
        .map(str::to_string);

    state
        .manager
        .apply_model_report(&session, protocol::ModelId::new(id), label);

    StatusCode::NO_CONTENT
}

/// `statusLine` の payload から、画面に出すぶんの `context_window` を取り出す。
///
/// **欄が無ければ `None`。** `None` は「まだ分からない」であって 0% ではない。
///
/// # 見るのは割合が届いているかどうかだけ
///
/// 起動直後と `/compact` 直後は、どちらも**割合が `null` で届く**（フェーズ0 で実測）。
/// 形が同じなので、場合分けは要らない——割合が読めなければ `None` になる。
///
/// **トークン数の `0` を「まだ分からない」の判定に使ってはいけない。** 使うと、
/// 起動直後と「本当に 0%」が区別できなくなる。
///
/// # 自分で割らない
///
/// 分子と分母は両方届くので割ろうと思えば割れるが、**割ってはいけない**。丸めているのは
/// CLI 側で、こちらで割り直すと丸めが二重になり `/context` の表示と1ずれる
/// （コンテキスト残量設計§3）。
fn read_context_usage(payload: &Value) -> ContextRead {
    let Some(window) = payload.get("context_window") else {
        // **欄ごと無い。** 壊れた JSON（`Value::Null`）もここへ落ちる。
        // 「読めなかった」であって「値が無い」ではない
        return ContextRead::Unreadable;
    };
    let Some(raw) = window.get("used_percentage") else {
        return ContextRead::Unreadable;
    };
    if raw.is_null() {
        // **ここが「まだ分からない」の判定。** 起動直後と `/compact` 直後は、
        // どちらも割合が `null` で届く（フェーズ0 で実測）
        return ContextRead::Read(None);
    }
    // **`as_f64` で受けて丸める**（コンテキスト残量設計§3）。`as_u64` だけで読むと、
    // CLI の版が上がって `24.0` や `24.5` の形を吐いた瞬間、**全セッションのゲージが
    // 恒久的に消える**——同じ payload から読むモデル名は動き続けるので、
    // 「機能が消えた」という症状だけが残って原因が追えない。
    //
    // 実測では小数が1件も来ないが（フェーズ0・30サンプル）、**それはいまの版が
    // そうだったという事実**であって、次の版がそうである保証ではない
    let Some(percentage) = raw.as_f64() else {
        // **読めない形（文字列など）。** 黙って消すと症状だけが残るので、1度だけ残す
        warn_unreadable_percentage(raw);
        return ContextRead::Unreadable;
    };
    ContextRead::Read(Some(ContextUsage {
        used_percentage: percentage.round().clamp(0.0, f64::from(u8::MAX)) as u8,
        // 実数は鍵に入れない（設計§3）。読めないときは 0 として扱う——画面は割合を
        // 主に出すので、実数が欠けてもゲージは成立する
        total_input_tokens: window
            .get("total_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        context_window_size: window
            .get("context_window_size")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }))
}

/// 読めない形で届いたことを、**同じ形が続くあいだ1度だけ**残す。
///
/// **毎回出すと3秒ごとに溢れる**（`statusLine` の周期）。形が変わったときだけ出せば、
/// 「いつから読めなくなったか」は残り、量は増えない。
fn warn_unreadable_percentage(raw: &Value) {
    use std::sync::Mutex;
    static 直前の形: Mutex<Option<String>> = Mutex::new(None);
    // 値そのものではなく**型の名前**で見る。値で見ると、読めない値が毎回違う形
    // （連番など）で来たときに溢れる
    let 形 = match raw {
        Value::String(_) => "string",
        Value::Bool(_) => "bool",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        // 数と null は上で捌いているので、ここへは来ない
        _ => "other",
    };
    let mut 直前 = 直前の形.lock().expect("ロックが壊れていない");
    if 直前.as_deref() == Some(形) {
        return;
    }
    *直前 = Some(形.to_string());
    tracing::warn!(
        shape = 形,
        "statusLine の used_percentage が読めない形で届きました。ゲージは据え置きます"
    );
}

/// `statusLine` の payload から使い具合を読んだ結果。
///
/// # なぜ2段にするのか
///
/// **「割合が `null` で届いた」と「payload が読めなかった」は別物である。** 前者は
/// `/compact` 直後の正しい経路で、控えた値を消すのが正しい。後者は壊れた JSON や
/// 欄ごと無い形で、**消してはいけない**——1回の不正な POST で控えていた値が飛び、
/// ゲージが一瞬「—」になって次の便で戻る、という点滅になる。
///
/// `Option<ContextUsage>` のままだと、この2つが同じ `None` に潰れる。**モデル側は
/// 早期 return で前の値を保っている**ので、使用率だけが非対称だった。
enum ContextRead {
    /// 読めた。`None` は「割合が `null` で届いた」（起動直後と `/compact` 直後）
    Read(Option<ContextUsage>),
    /// **payload が読めなかった。控えた値を消さない**
    Unreadable,
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

    /// 読めた値を取り出す。**`Unreadable` はここで落とす**——テストが
    /// 「読めなかった」を「値が無い」と取り違えないように、別の口にしてある
    fn 読めた(result: ContextRead) -> Option<ContextUsage> {
        match result {
            ContextRead::Read(usage) => usage,
            ContextRead::Unreadable => panic!("読める形のはずが Unreadable でした"),
        }
    }

    /// 「読めなかった」かどうか。**控えた値を消さない側**である
    fn 読めない(result: &ContextRead) -> bool {
        matches!(result, ContextRead::Unreadable)
    }

    /// 実測した payload の形（フェーズ0。値そのものは持ち込まない）。
    fn 実測の形(context_window: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{
              "cwd": "/home/example/dev/app",
              "session_id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
              "model": {{ "id": "claude-opus-5", "display_name": "Opus 5" }},
              "context_window": {context_window},
              "version": "2.1.269"
            }}"#
        ))
        .expect("組み立てた payload が JSON であること")
    }

    /// 捨てていた欄を読むようになったこと。
    #[test]
    fn 使用率を読む() {
        let payload = 実測の形(
            r#"{ "used_percentage": 24, "total_input_tokens": 241500,
                 "context_window_size": 1000000 }"#,
        );

        let usage = 読めた(read_context_usage(&payload)).expect("読めること");
        assert_eq!(usage.used_percentage, 24);
        assert_eq!(usage.total_input_tokens, 241_500);
        assert_eq!(usage.context_window_size, 1_000_000);
    }

    /// **起動直後と `/compact` 直後は「まだ分からない」**（フェーズ0 で実測）。
    ///
    /// どちらも割合が `null`・トークン数が `0`・**分母は入ったまま**という同じ形で
    /// 届く。形が同じなので、判定は1本でよい。
    #[test]
    fn 割合がnullならまだ分からないとして扱う() {
        let payload = 実測の形(
            r#"{ "used_percentage": null, "remaining_percentage": null,
                 "total_input_tokens": 0, "current_usage": null,
                 "context_window_size": 1000000 }"#,
        );

        assert_eq!(
            読めた(read_context_usage(&payload)),
            None,
            "割合が null なら、分母が入っていても「まだ分からない」であること"
        );
    }

    /// **トークン数の `0` を「まだ分からない」の判定に使っていないこと。**
    ///
    /// 使うと、起動直後と「本当に 0%」が区別できなくなる。**割合が届いている
    /// 0% は本物**なので、`Some` にならなければいけない。
    #[test]
    fn 本当の0パーセントはまだ分からないと区別する() {
        let payload = 実測の形(
            r#"{ "used_percentage": 0, "total_input_tokens": 0,
                 "context_window_size": 1000000 }"#,
        );

        let usage =
            読めた(read_context_usage(&payload)).expect("0% は値が届いている状態であること");
        assert_eq!(usage.used_percentage, 0);
    }

    /// 欄が増減しても壊れないこと（この受け口が最初から守っている約束）。
    ///
    /// **欄が無ければ「まだ分からない」**として扱い、知らない欄は無視する。
    #[test]
    fn 欄が無くても知らない欄があっても落ちない() {
        for payload in [
            "{}",
            r#"{"context_window": null}"#,
            r#"{"context_window": {}}"#,
            r#"{"context_window": {"知らない欄": 1}}"#,
        ] {
            let value = serde_json::from_str::<Value>(payload).expect("JSON であること");
            // **欄が無い形は「読めなかった」側**（レビュー対応 対応5）。控えた値を
            // 消さないためで、`/compact` の `null` とは別物である
            assert!(
                読めない(&read_context_usage(&value)),
                "{payload} で「読めなかった」になること"
            );
        }

        // 知らない欄が**増えて**も、要る欄が読めれば通ること
        let 増えた = 実測の形(
            r#"{ "used_percentage": 7, "total_input_tokens": 70000,
                 "context_window_size": 1000000, "あとから増えた欄": {"x": 1} }"#,
        );
        assert_eq!(
            読めた(read_context_usage(&増えた)).map(|u| u.used_percentage),
            Some(7),
            "知らない欄は無視して読めること"
        );
    }

    /// **壊れた payload と「割合が null」を区別する**（レビュー対応 対応5）。
    ///
    /// 区別しないと、1回の不正な POST で控えていた値が消える。モデル側は
    /// `model.id` が読めなければ早期 return で前の値を保っているのに、
    /// 使用率だけが「読めなかった」を「値が無い」として扱っていた。
    #[test]
    fn 読めなかったことと値が無いことを区別する() {
        // 壊れた JSON は `Value::Null` になって届く（受け口が握り潰すため）
        assert!(
            読めない(&read_context_usage(&Value::Null)),
            "壊れた JSON は「読めなかった」であること"
        );

        // 欄ごと無い形も同じ
        let 欄が無い = serde_json::json!({ "model": { "id": "claude-opus-5" } });
        assert!(
            読めない(&read_context_usage(&欄が無い)),
            "context_window ごと無い形も「読めなかった」であること"
        );

        // **こちらは消してよい側。** `/compact` 直後の正しい経路
        let compact直後 = 実測の形(
            r#"{ "used_percentage": null, "total_input_tokens": 0,
                 "context_window_size": 1000000 }"#,
        );
        assert_eq!(
            読めた(read_context_usage(&compact直後)),
            None,
            "割合が null なら「値が無い」側であること"
        );
    }

    /// **小数で届いても消えない**（レビュー対応 対応6）。
    ///
    /// `as_u64` だけで読んでいたので、CLI の版が上がって `24.0` を吐いた瞬間に
    /// 全セッションのゲージが恒久的に消える形だった。実測では小数が1件も来ないが、
    /// **それはいまの版がそうだったという事実**であって、次の版の保証ではない。
    #[test]
    fn 小数で届いても読める() {
        for (形, 期待) in [
            ("24.0", 24u8),
            // **四捨五入**（コンテキスト残量設計§3）。`/context` の表示に最も近い側へ倒す
            ("24.5", 25),
            ("24.4", 24),
            ("0.6", 1),
        ] {
            let payload = 実測の形(&format!(
                r#"{{ "used_percentage": {形}, "total_input_tokens": 240000,
                     "context_window_size": 1000000 }}"#
            ));
            assert_eq!(
                読めた(read_context_usage(&payload)).map(|u| u.used_percentage),
                Some(期待),
                "{形} が {期待} として読めること"
            );
        }
    }

    /// 読めない形（文字列など）は「読めなかった」側になること。
    ///
    /// **黙って消すと、症状だけが残って原因が追えない**——同じ payload から読む
    /// モデル名は動き続けるので、ゲージだけが消える。ログへ1度残す
    /// （[`warn_unreadable_percentage`]）。
    #[test]
    fn 読めない形は控えた値を消さない() {
        for 形 in [r#""24""#, "true", "[24]", "{}"] {
            let payload = 実測の形(&format!(
                r#"{{ "used_percentage": {形}, "total_input_tokens": 240000,
                     "context_window_size": 1000000 }}"#
            ));
            assert!(
                読めない(&read_context_usage(&payload)),
                "{形} は「読めなかった」であること（控えた値を消さない）"
            );
        }
    }
}
