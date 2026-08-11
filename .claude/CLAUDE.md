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

## 用語
**この道具はコーディングエージェント（claude）を複数動かして管理するもの**なので、「エージェント」という語は claude の側に取ってある。それを抱えている常駐プログラムを同じ語で呼ぶと、読むたびにどちらの話か考えることになる。

### 言い換えの表
| 区分 | 旧名 | 新名 |
|---|---|---|
| 呼称 | PC 側エージェント／エージェント | **セッションホスト**（文脈が明らかなら「ホスト」） |
| crate | `session-host-core` | `session-host-core` |
| crate | `agentdashboard-agent`（`crates/agent`） | `session-host`（`crates/session-host`） |
| 型 | `SessionHost` ／ `SessionHostHub` ／ `SessionHostConn` ／ `SessionHostCommand` | `SessionHost` ／ `SessionHostHub` ／ `SessionHostConn` ／ `SessionHostCommand` |
| 型 | `RemoteSessionHost` ／ `LocalSessionHost` | `RemoteSessionHost` ／ `LocalSessionHost` |
| 型 | `SessionHostConfig` ／ `SessionHostLink` ／ `SessionHostView` | `SessionHostConfig` ／ `SessionHostLink` ／ `SessionHostView` |

### 据え置くもの（変えてはいけない）
| 据え置くもの | なぜ |
|---|---|
| バイナリ `agentdashboard-agent` | **既に入れた人の環境が壊れる**（入れる側・消す側・手順書がこの名前を指している） |
| 設定ファイル `agent.toml` | 同上 |
| URL `/agent/ws`・JSON の `agent_id` | **版交渉の相手（古い PC）が繋がらなくなる** |
| DB の `agents` 表・`agent_id` 列 | 移行が要る |
| `crates/protocol` の型（`AgentMessage` ／ `ServerToAgent` ／ `AgentId`） | 共有境界で変更のハードルが高く、**据え置く線の名前と対**になっている。型だけ変えると型と線の名前がずれる |
| `AgentMeta`（`transcript-parser`） | **これは本当にコーディングエージェント**（claude のサブエージェント）。残すのが正しい |

### 守ること
- **旧名を見つけ次第、その場で直す。** 別の作業の途中でも、目に入ったら直す。一括置換の日を待たない
- **一括置換で直さない。** 「エージェント」には**コーディングエージェントを指す正しい用法**が混ざっている（実装方針の文、`transcript-parser` の親子関係の説明、`protocol.ts` の申告の説明など）。1件ずつ意味を見る
- **新しく紛らわしい語が出たら、この表へ足してから言い換える。** 表に無い言い換えを勝手に始めない——人によって別の名前を使い始めると、旧名より状況が悪くなる

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

**常駐しているものに触る前に `.claude/docs/knowledge/いま動いているもの.html` を読む。** どのポートで何の版が動いていて、どの URL がどれを指しているかが書いてある。**URL とその先の対応を取り違えると、原因追跡が丸ごと空振りする**（実際に起きた）。起こす・落とす・張り替える・外に立てるをしたら、その場でここを直す（`.claude/docs/guideline.md`「長く生かしたいプロセスを起こすとき」）。

---
<br/>
<br/>

## 品質ガイドライン
- **cargo は必ず `scripts/cargo` 経由で呼ぶ**。ホストに Rust ツールチェーンは入っていない
- タスク完了の定義は「テストが通ること」。`make ci`（lint → test → build）が通って初めて完了とみなす
- 各フェーズの終わりには ⛳チェックポイントがあり、対応するテスト計画のフェーズを消化してから次へ進む
- 自己修復機構の制約上、`crates/protocol` は共有境界であり変更のハードルが高い。未知の構造は `Node::Unknown` へ写像して吸収する
- **原因を追うときは、コードを読む前に `agentdashboard logs` を読む。** 残す側の約束は `.claude/docs/guideline.md`「ログを残すとき」に集めてある（利用者向けの読み方は `README.md`）
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
| `server/crates/session-host-core/` | PC 側の一式（PTY・フック受信・状態導出・パース・自己修復）。**portable-pty を持つのはここだけ** |
| `server/crates/server-core/` | ブラウザ配信（WebSocket・REST・web アセット）。PTY に触らない |
| `server/crates/server-core/src/db/` | 記録の置き場所（設計§3）。**DB を持つのはここだけ**。表を増やしたら migration にも足す |
| `server/crates/server-core/src/registry.rs` | カードの記録。エージェントの報告を**DB へ書いてからブラウザへ配る**（設計§9-1）。**アカウントの絞り込みはここの入口に集約**（§8-6） |
| `server/crates/server-core/src/auth.rs` | 入口の鍵（設計§8-1〜§8-3）。**3通りのかけ方を1つの型で表す**。判定を通らずに答えを出す道を作らないこと |
| `server/crates/server-core/src/account.rs` | ペアリングトークンの発行・失効と PC の一覧（§8-4・§11-1） |
| `server/crates/server-core/tests/tenancy.rs` | アカウント分離の総当たり（§8-6 の表の全行）。**enforcement を足したらここへ足す** |
| `server/crates/server-core/src/gateway.rs` | エージェントの受け口（`/agent/ws`）。版交渉・トークン照合・帰属の決定。ブラウザ向けの指示を A2S へ中継する `RemoteSessionHost` もここ |
| `server/crates/session-host-core/src/link.rs` | PC からサーバへ繋ぐ側。履歴を束ねて送り、**ack が返ってから位置を進める**（設計§6-1） |
| `server/crates/session-host-core/src/offsets.rs` | 「どこまで読んだか」の置き場所。**読む側（パーサ）と進める側（運び手）で共有する** |
| `server/crates/session-host-core/src/logging.rs` | ログの出力層と読む口の土台。**7欄を組み立てるのはここだけ**。同じ名前の欄を渡すと `f_<名前>` へ退避する。行を出す場所を増やす前にガイドライン「ログを残すとき」を読む |
| `server/crates/core/tests/swallowed.toml` | 結果を捨てている箇所の台帳。**製品コードの `let _ =` は1件残らずここに理由付きで載る**。実コードと食い違うと落ちる。鍵は行番号ではなく式の断片 |
| `server/crates/core/tests/cli_surface.toml` | 画面と CLI の口の対応台帳。**画面に口を足したらここへ足す**。ブラウザが叩ける口（`ClientMessage` と REST）が1つ残らず載り、CLI へ写したか・載せない理由が残る。実コードと食い違うと落ちる |
| `server/crates/session-host/src/lib.rs` | セッションホストの中身。フックの受信口を自分で開く（設計§5-3）。**実行ファイルは `crates/dist` が持つ** |
| `server/crates/dist/` | 利用者へ配る一式。実行ファイル3本の**入口だけ**（各1行）を持つ（§25 読み替え1）。中身を書かないこと |
| `dist-workspace.toml` ／ `scripts/dist` | 配布物の作り方。**`.github/workflows/release.yml` は `dist generate` が作る**ので手で書き換えない |
| `.github/build-setup.yml` | CI のビルド前に差し込む手順（web の焼き込み）。**こちらは手で書く**。`working-directory:` は使えない（§25 読み替え6）。**`workflows/` の外に置いてある**——あそこは GitHub がワークフローとして登録する場所で、`on:` を持たないこれを置くとプッシュのたびに失敗が1件積み上がる |
| `docs/proxy/` | 前段（Caddy・nginx）の設定。**compose が実際にマウントする実物**（§25 読み替え4） |
| `server/agent.toml.example` | エージェント単体の設定の雛形。**接続の3キーと hook_port はこちらにだけ置く**（§21 読み替え8） |
| `server/crates/core/src/local.rs` | 両者を1プロセスで束ねる配線（`server_core::session_host::SessionHost` のローカル実装） |
| `server/crates/core/src/config.rs` | `config.toml` の読み込みと、両側への射影（設計§12・セルフホスト化設計§13-2） |
| `server/crates/server-core/src/embed.rs` | web アセットの単一バイナリ同梱 |
| `server/crates/core/tests/dependencies.rs` | crate 境界（依存の逆流）の機械検査。**新しい依存を入れたらここへ足す** |
| `server/crates/transcript-parser/` | 自己修復が唯一書き換えてよい範囲（設計§9） |
| `server/crates/testkit/` | フック受信モックサーバと擬似 claude |
| `server/crates/session-host-core/src/session/screen.rs` | 端末エミュレータと画面の配信（設計§7）。**画面を作るのはここだけ**——vt100 を使うもう1箇所は `core/src/client/render.rs`（CLI が画面を読むため。作らずに描くだけ）で、どちらも `dependencies.rs` が見張る（`server-core` へ漏れていないこと・両者が通常依存で持つこと） |
| `server/crates/server-core/src/gateway.rs` | エージェントの受け口。画面のフレームはここで種別を移し替えてブラウザへ流す（0x04→0x03 / 0x05→0x01） |
| `server/config.toml.example` | 設定の雛形。**全キーが `AGENTDASHBOARD_<キー>` で上書きできる**（設計§14-1） |
| `docker/compose.test.yml` ／ `scripts/test-compose` | 永続化層を PostgreSQL に対しても流す（`make test-compose`）。**新しい DB テストは両方へ通す** |
| `docker/compose.yml` ／ `docker/Dockerfile.server` | セルフホストの本番構成。**利用者が取ってくる1枚**なので `build:` を書かない（材料を持っているのは開発者だけ）。指す箱の版はワークスペースと揃える |
| `.github/workflows/docker-image.yml` | サーバの箱を GHCR へ置く（`publish-jobs` から呼ばれる再利用ワークフロー）。**中でビルドし直さない**——リリースに上がった実行ファイルをそのまま入れる。作った箱は必ず起こして確かめる |
| `docs/setup/` ／ `docs/service/` | 手順書と常駐の雛形。**検収が数えるのは4種**（ローカル・セルフホスト・ペアリング・リバースプロキシ）で、消す道はそこへ後から足した5つ目。**セルフホストの入口は2つ**（実行ファイルだけ／compose）。手順書に載せる設定は実体を置き、そのファイルを検証が読む |
| `scripts/uninstall.sh` ／ `.ps1` | 消す道。**入れる側を触ったら同じコミットでこちらも直す**。記録は既定で残し、共有の場所（`~/.local/bin/env`・rcfile）には触らない |
| `server/crates/dist/tests/uninstall.rs` | 消す道の門。**偽のインストール一式を作って実際に走らせる**。置き場所は実装と `dist-workspace.toml` から引くので、片方を直すともう片方が落ちる |
| `docker/compose.e2e.yml` ／ `scripts/e2e-compose` | サーバ2台＋PostgreSQL＋Valkey＋前段（Caddy・nginx）をブラウザで通す（`make e2e-compose`）。**ブラウザ→A・PC→B の配置でしか出ない壊れ方**を捕まえる |
| `server/crates/dist/tests/artifacts.rs` ／ `guides.rs` | 配布物の顔ぶれと、手順書が名指ししているものの実在。**配ってからしか気づけない失敗**を `make ci` で捕まえる |
| `fixtures/` | ゴールデンフィクスチャ（自己修復のテストゲートを兼ねる）・端末録画（`.cast`）・画面のゴールデン（`.screen`） |
| `server/crates/session-host-core/tests/screen_golden.rs` | 録画から描いた画面のゴールデン比較。作り直すのは `AGENTDASHBOARD_UPDATE_SCREEN_GOLDEN=1`。**作り直したら必ず `scripts/sanitize-fixtures.py` を通す** |
| `scripts/e2e-remote` ／ `web/e2e/remote.spec.ts` | セルフホスト構成（サーバ＋エージェント）の E2E。**ローカルモードでは画面配信の経路を通らない**ので、実物のブラウザで確かめるのはここだけ |
| `scripts/e2e-fleet` ／ `web/e2e/fleet.spec.ts` | PC を3台つないだ E2E（`make e2e` に含む）。**PC が2台以上だと起動フォームに選択が現れる**ので、1台構成の土台には足せない。台数を変えるのはスクリプトの数字1つ |
| `server/crates/session-host-core/tests/pty_record.rs` | 実 claude の TUI を製品と同じ PTY 経路で録画する（`make record-terminal`）。**本物の claude を起動しクォータを消費する** |
| `server/crates/session-host-core/tests/screen_probe.rs` | 端末エミュレータ（vt100）の再現性と画面サイズの実測（`make probe-screen`）。合否ではなく数値を出す |
| `scripts/sanitize-fixtures.py` | フィクスチャの匿名化と残存検査。**公開リポジトリへ置く前に必ず通す** |
