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
    // 返り値（配る必要があるか）をここで使わないのは、**すぐ配る軽い便がまだ無い**
    // ため。控えた値は正本なので、次に全体の報告が飛ぶときに一緒に運ばれる
    state
        .manager
        .apply_context_usage(&session, read_context_usage(&payload));

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
fn read_context_usage(payload: &Value) -> Option<ContextUsage> {
    let window = payload.get("context_window")?;
    // **ここが「まだ分からない」の判定。** 割合が読めないなら、ほかが揃っていても `None`
    let used_percentage = window.get("used_percentage").and_then(Value::as_u64)?;
    Some(ContextUsage {
        used_percentage: used_percentage.min(u64::from(u8::MAX)) as u8,
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
    })
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]

    use super::*;

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

        let usage = read_context_usage(&payload).expect("読めること");
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

        assert!(
            read_context_usage(&payload).is_none(),
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

        let usage = read_context_usage(&payload).expect("0% は値が届いている状態であること");
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
            assert!(
                read_context_usage(&value).is_none(),
                "{payload} で「まだ分からない」になること"
            );
        }

        // 知らない欄が**増えて**も、要る欄が読めれば通ること
        let 増えた = 実測の形(
            r#"{ "used_percentage": 7, "total_input_tokens": 70000,
                 "context_window_size": 1000000, "あとから増えた欄": {"x": 1} }"#,
        );
        assert_eq!(
            read_context_usage(&増えた).map(|u| u.used_percentage),
            Some(7),
            "知らない欄は無視して読めること"
        );
    }
}
