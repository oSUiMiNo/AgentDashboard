# AgentDashboard の開発コマンド。
#
# Rust ツールチェーンはホストに入れず Docker コンテナへ隔離しているため、cargo は必ず
# scripts/cargo（docker run のラッパー）を経由する。一方、Node はホストに導入済みなので
# web 側はホストでそのまま動かす。この「Rust はコンテナ／Web はホスト／成果物はホストで実行」
# の役割分担が本 Makefile の前提。

SHELL := /bin/bash
CARGO := ./scripts/cargo
# scripts/cargo の IMAGE_TAG と必ず揃えること（食い違うと作ったイメージが使われない）
DOCKER_IMAGE := agentdashboard-rust:1.97.1-2
RELEASE_BIN := server/target/release/agentdashboard
DEBUG_BIN := server/target/debug/agentdashboard

.DEFAULT_GOAL := help

.PHONY: help setup setup-rust setup-web dev dev-web dev-server \
        test test-rust test-web test-cli test-compose e2e e2e-compose build-debug perf \
        lint lint-rust lint-web fmt \
        build build-web build-server dist-local ci fixtures record-terminal capture-screens \
        probe-screen clean prune

help: ## このヘルプを表示する
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- 初期セットアップ ---------------------------------------------------------

setup: setup-rust setup-web ## 開発に必要なものを一式そろえる

setup-rust: ## Rust ツールチェーンの Docker イメージを作る
	docker build -f docker/Dockerfile.rust -t $(DOCKER_IMAGE) .

setup-web: ## web の依存と Playwright の chromium を入れる
	cd web && npm install
	cd web && npx playwright install chromium

# --- 開発 ---------------------------------------------------------------------

dev: ## 開発時の進め方を表示する（core と vite は別々の端末で動かす）
	@echo "端末を2つ使う："
	@echo "  1) make dev-server  … core を 127.0.0.1:8787 で起動する"
	@echo "  2) make dev-web     … Vite 開発サーバ。/ws と /api は core へ中継される"
	@echo "ブラウザは Vite 側（既定 5173）を開くと HMR が効く。"

dev-web: ## Vite 開発サーバ（/ws と /api は core へ中継）
	cd web && npm run dev

dev-server: ## core をデバッグビルドしてホストで実行する
	$(CARGO) build
	./$(DEBUG_BIN)

# --- テスト -------------------------------------------------------------------

test: test-rust test-web ## Rust と web のテストを両方走らせる

test-rust: ## Rust テスト（コンテナ内・nextest でテスト毎にプロセス分離）
	$(CARGO) nextest run

test-web: ## web の単体テスト（Vitest）
	cd web && npm run test

# 本物の claude を相手にする統合テスト（テスト計画フェーズ4）。
# ビルドはコンテナ、実行はホスト。認証情報をコンテナへ渡さずに済ませるための分担で、
# 詳細は scripts/test-cli を参照。#[ignore] 付きなので make test では走らない。
# 実行するとあなたのアカウントのクォータを消費する。
test-cli: ## 実CLI統合テスト（本物の claude をホストで起動する）
	./scripts/test-cli

# 永続化層を PostgreSQL に対しても流す（テスト計画フェーズ2 の最終項目）。
# ローカルは SQLite・セルフホストは PostgreSQL で**スキーマとコードを共有する**のが前提
# なので、「SQLite では通るのに PostgreSQL で落ちる」を手前で捕まえる。docker が要るため
# CI 既定（make ci）には入れない（設計§15-3）。
test-compose: ## 永続化層のテストを PostgreSQL に対しても流す（docker compose が要る）
	./scripts/test-compose

# インスタンスを2台並べた構成をブラウザで通す（テスト計画フェーズ6 の最終項目）。
# **test-compose とは別のターゲットにしてある** — あちらは PostgreSQL に対する
# 永続化層の検証で1分程度、こちらは compose を立ててブラウザまで通すので数分かかる。
# 混ぜると「型だけ確かめたい」ときに毎回ブラウザの分まで待つことになる。
#
# 依存は build（リリースの実行ファイルをイメージへ入れる）と build-debug
# （ホストで動かすエージェントと擬似 claude）の両方。
e2e-compose: build build-debug ## サーバ2台＋PostgreSQL＋Valkey をブラウザで通す（docker が要る）
	./scripts/e2e-compose

# E2E は実際の core サーバに繋いで動かす（web/playwright.config.ts）。
# web → core の順にビルドするのは、core が web/dist をコンパイル時に取り込むため。
# 順序を崩すと古い画面が配信され、直したはずの不具合が再現し続ける。
e2e: build-web build-debug ## E2E テスト（Playwright / chromium・実サーバに接続）
	cd web && npm run e2e

build-debug: ## core をデバッグビルドする（E2E が使うバイナリ）
	$(CARGO) build

# 性能の「数値」を採るための入口（テスト計画フェーズ6）。
#
# 合否の判定は make test / make e2e に入っている（機械の速さに左右されない性質だけを
# 見ている）。こちらは fps・状態反映の遅延・フレーム数といった**実測値**を出すためのもので、
# 結果は実行レポートへ書き写す。数値を合否にしないのは、他の作業の負荷で落ちるテストは
# 役に立たないため。
#
# その方針どおり、負荷に左右される実測値は `#[ignore]` を付けて make test から外し、
# ここでだけ `--run-ignored all` で走らせる。
perf: build-web build-debug ## 性能の実測値を採る（合否ではなく記録用）
	@echo "=== サーバ側（コアレッシング効果・巨大履歴・遅いクライアント）==="
	$(CARGO) nextest run -p agentdashboard-core --test perf --no-capture --run-ignored all
	@echo "=== ブラウザ側（12セッション同時稼働）==="
	cd web && npx playwright test perf.spec.ts

# --- 静的検査 -----------------------------------------------------------------

lint: lint-rust lint-web ## 書式と静的解析をまとめて確認する

lint-rust: ## rustfmt の差分チェックと clippy
	$(CARGO) fmt --all -- --check
	$(CARGO) clippy --all-targets --all-features -- -D warnings

lint-web: ## 型チェックと oxlint
	cd web && npx tsc -b
	cd web && npm run lint

fmt: ## Rust の書式を自動整形する
	$(CARGO) fmt --all

# --- ビルド -------------------------------------------------------------------

build: build-web build-server ## 単一バイナリを作る（web ビルド → rust-embed 同梱）

build-web: ## フロントエンドを web/dist へビルドする
	cd web && npm run build

# 配布物を手元で1つだけ実際に作る（セルフホスト化設計§14-3）。
#
# 3 OS 分を作れるのは GitHub Actions だけ（macOS へのクロスコンパイルは dist が断る）。
# ここで作れるのは手元の OS 向けの1本で、**アーカイブの中身が本当に揃っているか**を
# 目で見るためのもの。予定の一覧と OS の顔ぶれは `make test` の中で毎回見ている
# （`server/crates/dist/tests/artifacts.rs`）。
#
# build-web が先に要る。web/dist が空のままだと、画面の入っていない実行ファイルが
# アーカイブへ入る（起動はするので、配ってからでないと気づけない）。
dist-local: build-web ## 手元の OS 向けの配布アーカイブを1つ作る
	./scripts/dist build --artifacts=local --target=x86_64-unknown-linux-gnu
	@echo "生成物: target/distrib/"

build-server: ## core をリリースビルドする（web/dist を同梱する）
	$(CARGO) build --release
	@echo "生成物: $(RELEASE_BIN)"
	@./$(RELEASE_BIN) --version

# --- まとめて -----------------------------------------------------------------

ci: lint test build ## ローカルCI。静的検査 → テスト → ビルドを通しで実行する

fixtures: ## ゴールデンフィクスチャを採取して匿名化する（本物の claude をホストで実行）
	./scripts/gen-fixtures.sh

# --- 端末エミュレーションの実機検証（計画.md フェーズ0）------------------------
#
# 採る側と測る側で走らせ方が違う。録画は**本物の claude をホストで**動かすので
# クォータを消費する（`make fixtures` と同じ性質）。測る側は録画を読むだけなので
# コンテナ内で完結し、何度でも走らせてよい。
record-terminal: ## 実 claude の TUI を録画してフィクスチャにする（ホストで実行・クォータ消費）
	./scripts/record-terminal.sh

# 選択ダイアログの目印を実物から採る（ローカルイシュー「送信以外の操作も Ctrl+Enter に
# なっている」テスト計画フェーズ1）。**`make test-cli` の通しには入れない**——採取は
# 一度きりで足りるので、通しのたびにクォータを使わせない。置き場所は既定でリポジトリの
# 外（`AGENTDASHBOARD_SCREEN_CAPTURE_DIR` で変えられる）。
capture-screens: ## 本物の TUI の選択ダイアログの画面を採る（ホストで実行・クォータ消費）
	TEST_TARGET=screen_capture ./scripts/test-cli

# perf と同じ扱い。合否ではなく実測値を出すためのものなので `#[ignore]` を付けて
# make test から外し、ここでだけ `--run-ignored all` で走らせる。
probe-screen: ## 端末エミュレータ（vt100）の再現性と画面サイズを実測する
	$(CARGO) nextest run -p session-host-core --test screen_probe --no-capture --run-ignored all

clean: ## ビルド成果物を消す（自己修復の作業場所も含む）
	rm -rf server/target web/dist web/node_modules
	# **Playwright が消してくれない置き場所。** test-results の外にあるので、
	# ここに書いておかないと誰も消さない
	rm -rf web/.e2e-state web/.e2e-compose
	# Playwright MCP がブラウザを触るたびに勝手に作る置き場所。こちらも
	# test-results の外なので、書かなければ誰も消さない
	rm -rf .playwright-mcp
	git worktree remove --force .selfheal/worktrees/dashboard-maintenance 2>/dev/null || true
	git worktree prune 2>/dev/null || true
	rm -rf .selfheal

# **cargo は古い成果物を自分では消さない。**
#
# 統合テストが多いので、再ビルドのたびに別名の実行ファイルが `deps` へ積み上がる。
# 放っておくと 300 GB を超え、実際に Windows の C: を満杯にして Docker ごと
# 落とした（2026-08-09）。`make clean` は全部消して丸ごと作り直しになるが、
# こちらは**次のビルドの大半を使い回せる形**で嵩だけ落とす。
#
# 消すのはどちらもキャッシュで、消えて困るものは入っていない。
# **消す規則は scripts/prune-target が1つだけ持つ。** ここに `rm -rf` を書き戻すと、
# 自動の掃除（scripts/cargo が呼ぶ）と手で叩く掃除で規則が2つになり、片方だけ直す事故が起きる。
prune: ## ビルドの置き場所を、作り直しを最小にして減らす
	@echo "減らす前:"
	@du -sh server/target 2>/dev/null || true
	./scripts/prune-target --all server/target
	@echo "減らした後:"
	@du -sh server/target 2>/dev/null || true
