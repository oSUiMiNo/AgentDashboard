# 経路の表

---
<br/>
<br/>

## 何のための表か
「ブラウザ→サーバ→セッションホスト→パーサ」という4つの経路のうち、いま見ている1行がどれを通ったログかを、`ad logs --json` の実際の欄（`proc`／`target`／`kind`）から見分けるための表。`bin/narrow` はこの表に基づいて集計する。

**注意：ローカルモードでは `proc` だけでは4経路を区別できない。** サーバとセッションホストは1プロセス（`dashboard`）へ統合されているため（`server/crates/core/src/local.rs`）、`proc=dashboard` が3経路（サーバ／セッションホスト／パーサ）を兼ねる。**真の識別子は `target`**（モジュールパスの接頭辞）である。

<br/>

## 経路と欄の対応

| 経路 | `proc` | `target`（代表） | 目印になる `kind` の例 |
|---|---|---|---|
| ブラウザ | `browser`（認証済み）／`browser-anon`（未認証） | `browser` | `ws_close`／`ws_error`／`slash_candidates`／`unhandled`／`transcript_tail` |
| サーバ | `dashboard` | `server_core::ws`／`server_core::branch`／`agentdashboard_core::cli`／`tower_sessions::service` | （`kind` 欄を持たない行が多い。`target` で判定） |
| セッションホスト | `dashboard` | `session_host_core::session`／`session_host_core::attachments`／`session_host_core::resources`／`session_host_core::logging` | （同上） |
| パーサ | `dashboard`（パーサ本体ではなく、パーサを監督している側が書く） | `session_host_core::parser` | 「transcript-parser を起こしました」「パーサから最初の報告が届きました」「transcript-parser が終了しました」 |

<br/>

## 相関キー
- `card_id` — どのカード（セッション）の行か。ブラウザ・サーバ・セッションホストの行に付く
- `parser_pid` — パーサ経路の行を束ねる。同じ `parser_pid` を持つ行が同じパーサ子プロセスの一生を表す
- `account_id`／`client_id` — 認証まわり（サーバ経路の一部）

<br/>

## この表の実測条件
2026-09-16、実機（`~/AgentDashboard` で走っているインスタンス）の直近ログを `--level trace` で2時間分見て、`target` の出現数を数えた結果に基づく。件数の多寡は「その時間帯に何をしていたか」に強く依存するので、**件数そのものではなく「どの `target` がどの経路に属するか」の対応関係だけを恒久的な知識として扱うこと**。

観測された `target` の内訳（多い順、上位）：`session_host_core::session`（セッションホスト経路の大半）、`browser`（ブラウザ経路）、`server_core::ws`（サーバ経路）、`session_host_core::attachments`、`tower_sessions::service`、`session_host_core::parser`（パーサ経路。`parser_pid` で相関）。7日分の warn 水位サンプルでは他に `agentdashboard_core::cli`、`server_core::branch`、`session_host_core::logging`、`session_host_core::resources` も出現した。

`proc` の実測値は3種のみ（`dashboard`／`browser`／`browser-anon`）。CLI のヘルプは `session-host` という `proc` 値も列挙しているが、このインスタンスの実ログでは一度も出現していない（ローカルモードでは登場しない可能性がある）。
