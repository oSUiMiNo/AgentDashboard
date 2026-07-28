# AgentDashboard の開発コマンド。
#
# Rust ツールチェーンはホストに入れず Docker コンテナへ隔離しているため、cargo は必ず
# scripts/cargo（docker run のラッパー）を経由する。一方、Node はホストに導入済みなので
# web 側はホストでそのまま動かす。この「Rust はコンテナ／Web はホスト／成果物はホストで実行」
# の役割分担が本 Makefile の前提。

SHELL := /bin/bash
CARGO := ./scripts/cargo
DOCKER_IMAGE := agentdashboard-rust:1.97.1
RELEASE_BIN := server/target/release/agentdashboard
DEBUG_BIN := server/target/debug/agentdashboard

.DEFAULT_GOAL := help

.PHONY: help setup setup-rust setup-web dev dev-web dev-server \
        test test-rust test-web e2e build-debug \
        lint lint-rust lint-web fmt \
        build build-web build-server ci fixtures clean

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

# E2E は実際の core サーバに繋いで動かす（web/playwright.config.ts）。
# web → core の順にビルドするのは、core が web/dist をコンパイル時に取り込むため。
# 順序を崩すと古い画面が配信され、直したはずの不具合が再現し続ける。
e2e: build-web build-debug ## E2E テスト（Playwright / chromium・実サーバに接続）
	cd web && npm run e2e

build-debug: ## core をデバッグビルドする（E2E が使うバイナリ）
	$(CARGO) build

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

build-server: ## core をリリースビルドする（web/dist を同梱する）
	$(CARGO) build --release
	@echo "生成物: $(RELEASE_BIN)"
	@./$(RELEASE_BIN) --version

# --- まとめて -----------------------------------------------------------------

ci: lint test build ## ローカルCI。静的検査 → テスト → ビルドを通しで実行する

fixtures: ## ゴールデンフィクスチャを採取して匿名化する（本物の claude をホストで実行）
	./scripts/gen-fixtures.sh

clean: ## ビルド成果物を消す
	rm -rf server/target web/dist web/node_modules
