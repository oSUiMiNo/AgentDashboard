# CLAUDE.md

---
<br/>
<br/>

## コミットプッシュ・イシュー同期について
本 PJT 内では、ここに本記載が書いてあるうちは、1フェーズ実装し終わったタイミングなどで自動でコミットプッシュをしてほしい。許可する。
また、実機運用は `\home\osuim\AgentDashboard` の方で行っているので、アップデート（フェッチ・プル・必要な場合のみダッシュボードの再起動）まで行ってほしい。

issue-sync は、ユーザーが行うので不要。必要かどうかユーザーに尋ねる必要もない。

---
<br/>
<br/>

## プロジェクト概要
**AgentDashboard** は、複数プロジェクト・複数セッションの Claude Code を一望する個人用の司令塔ダッシュボード。ローカルで動く Web アプリとして提供し、ブラウザから閲覧・操作する。

中心にあるのは「**実行は本物のCLI、表示は構造化UI**」という考え方。サーバは擬似ターミナル（PTY）上で本物の claude CLI を起動するので `/rewind` を含む全スラッシュコマンドが使える。一方で画面は ANSI 出力の解析ではなく、Claude Code が書き出す構造化トランスクリプト（JSONL）とフックイベントから組み立てる。

技術構成は Rust（axum + portable-pty）のバックエンドと React 19 + TypeScript のフロントエンド。JSONL のフォーマット変更に自動対応する自己修復機構を持ち、その変更範囲を物理的に限定するためパーサだけを別プロセスへ切り出している。

---
<br/>
<br/>

## ドキュメント参照ガイドライン
仕様の正は `MyDocs/ローカルイシュー/初期実装/` にある。読む順序は次のとおり。

| ドキュメント | 何が書いてあるか |
|---|---|
| `要件.md` | 何を作るか・なぜ作るか・スコープ |
| `方針.md` | 技術選定とその理由、実機検証の記録 |
| `設計.md` | §1〜§14 の詳細設計。実装時に最も参照する |
| `テスト計画.md` | フェーズ1〜8のテスト項目 |
| `計画.md` | フェーズ0〜6の実装タスクと ⛳チェックポイント |
| `実行レポート.md` | 各フェーズで実際にやったこと・起きた問題・引き継ぎ |

`計画.md` と `テスト計画.md` は設計を `§N` の形で参照している。**設計.md の既存節番号は振り直さない**（詳細は `.claude/docs/guideline.md`）。

実装の進め方は「人間の手作業を介さず、エージェントが実装からテストまで自律的に完走する」ことを基本方針とする。人間の関与が原理的に避けられないタスクには `計画.md` 上で **【要人間】** が付いている。

環境や依存の扱いは `.claude/docs/knowledge/` を参照。

---
<br/>
<br/>

## 品質ガイドライン
- **cargo は必ず `scripts/cargo` 経由で呼ぶ**。ホストに Rust ツールチェーンは入っていない
- タスク完了の定義は「テストが通ること」。`make ci`（lint → test → build）が通って初めて完了とみなす
- 各フェーズの終わりには ⛳チェックポイントがあり、対応するテスト計画のフェーズを消化してから次へ進む
- 自己修復機構の制約上、`crates/protocol` は共有境界であり変更のハードルが高い。未知の構造は `Node::Unknown` へ写像して吸収する
- コミットは作業別に分けて段階的に行う。プッシュはしない

---
<br/>
<br/>

## 重要ファイル
| パス | 役割 |
|---|---|
| `scripts/cargo` | cargo 呼び出しの唯一の入口（docker run のラッパー） |
| `docker/Dockerfile.rust` | Rust ツールチェーンの隔離イメージ |
| `Makefile` | 開発コマンド一式 |
| `server/crates/protocol/src/lib.rs` | サーバ・フロント・パーサが共有するドメインモデル（設計§3） |
| `server/crates/agent-core/` | PC 側の一式（PTY・フック受信・状態導出・パース・自己修復）。**portable-pty を持つのはここだけ** |
| `server/crates/server-core/` | ブラウザ配信（WebSocket・REST・web アセット）。PTY に触らない |
| `server/crates/server-core/src/db/` | 記録の置き場所（設計§3）。**DB を持つのはここだけ**。表を増やしたら migration にも足す |
| `server/crates/server-core/src/registry.rs` | カードの記録。エージェントの報告を**DB へ書いてからブラウザへ配る**（設計§9-1）。**アカウントの絞り込みはここの入口に集約**（§8-6） |
| `server/crates/server-core/src/auth.rs` | 入口の鍵（設計§8-1〜§8-3）。**3通りのかけ方を1つの型で表す**。判定を通らずに答えを出す道を作らないこと |
| `server/crates/server-core/src/account.rs` | ペアリングトークンの発行・失効と PC の一覧（§8-4・§11-1） |
| `server/crates/server-core/tests/tenancy.rs` | アカウント分離の総当たり（§8-6 の表の全行）。**enforcement を足したらここへ足す** |
| `server/crates/server-core/src/gateway.rs` | エージェントの受け口（`/agent/ws`）。版交渉・トークン照合・帰属の決定。ブラウザ向けの指示を A2S へ中継する `RemoteAgent` もここ |
| `server/crates/agent-core/src/link.rs` | PC からサーバへ繋ぐ側。履歴を束ねて送り、**ack が返ってから位置を進める**（設計§6-1） |
| `server/crates/agent-core/src/offsets.rs` | 「どこまで読んだか」の置き場所。**読む側（パーサ）と進める側（運び手）で共有する** |
| `server/crates/agent/src/main.rs` | PC 側エージェントの実行ファイル。フックの受信口を自分で開く（設計§5-3） |
| `server/agent.toml.example` | エージェント単体の設定の雛形。**接続の3キーと hook_port はこちらにだけ置く**（§21 読み替え8） |
| `server/crates/core/src/local.rs` | 両者を1プロセスで束ねる配線（`server_core::agent::AgentHost` のローカル実装） |
| `server/crates/core/src/config.rs` | `config.toml` の読み込みと、両側への射影（設計§12・セルフホスト化設計§13-2） |
| `server/crates/server-core/src/embed.rs` | web アセットの単一バイナリ同梱 |
| `server/crates/core/tests/dependencies.rs` | crate 境界（依存の逆流）の機械検査。**新しい依存を入れたらここへ足す** |
| `server/crates/transcript-parser/` | 自己修復が唯一書き換えてよい範囲（設計§9） |
| `server/crates/testkit/` | フック受信モックサーバと擬似 claude |
| `server/crates/agent-core/src/session/screen.rs` | 端末エミュレータと画面の配信（設計§7）。**vt100 を持つのはここだけ**——サーバへ漏れていないかは `dependencies.rs` が見張る |
| `server/crates/server-core/src/gateway.rs` | エージェントの受け口。画面のフレームはここで種別を移し替えてブラウザへ流す（0x04→0x03 / 0x05→0x01） |
| `server/config.toml.example` | 設定の雛形。**全キーが `AGENTDASHBOARD_<キー>` で上書きできる**（設計§14-1） |
| `docker/compose.test.yml` ／ `scripts/test-compose` | 永続化層を PostgreSQL に対しても流す（`make test-compose`）。**新しい DB テストは両方へ通す** |
| `docker/compose.yml` ／ `docker/Dockerfile.server` | セルフホストの本番構成。イメージへ入れるのは `make build` が作った実行ファイル1本だけ |
| `docker/compose.e2e.yml` ／ `scripts/e2e-compose` | サーバ2台＋PostgreSQL＋Valkey をブラウザで通す（`make e2e-compose`）。**ブラウザ→A・PC→B の配置でしか出ない壊れ方**を捕まえる |
| `fixtures/` | ゴールデンフィクスチャ（自己修復のテストゲートを兼ねる）・端末録画（`.cast`）・画面のゴールデン（`.screen`） |
| `server/crates/agent-core/tests/screen_golden.rs` | 録画から描いた画面のゴールデン比較。作り直すのは `AGENTDASHBOARD_UPDATE_SCREEN_GOLDEN=1`。**作り直したら必ず `scripts/sanitize-fixtures.py` を通す** |
| `scripts/e2e-remote` ／ `web/e2e/remote.spec.ts` | セルフホスト構成（サーバ＋エージェント）の E2E。**ローカルモードでは画面配信の経路を通らない**ので、実物のブラウザで確かめるのはここだけ |
| `server/crates/agent-core/tests/pty_record.rs` | 実 claude の TUI を製品と同じ PTY 経路で録画する（`make record-terminal`）。**本物の claude を起動しクォータを消費する** |
| `server/crates/agent-core/tests/screen_probe.rs` | 端末エミュレータ（vt100）の再現性と画面サイズの実測（`make probe-screen`）。合否ではなく数値を出す |
| `scripts/sanitize-fixtures.py` | フィクスチャの匿名化と残存検査。**公開リポジトリへ置く前に必ず通す** |
