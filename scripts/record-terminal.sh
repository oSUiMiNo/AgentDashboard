#!/usr/bin/env bash
# 実 claude の TUI を PTY 越しに録画し、匿名化してフィクスチャへ置く（計画.md フェーズ0）。
#
# 何のためにあるか
# ----------------
# セルフホスト化ではリモートのブラウザへ画面を配信する（設計§7）。その画面を作る端末
# エミュレータが「本物の claude の出力で本当に成立するか」を確かめるための素材を採る。
# 採った録画は実機検証#1・#2・#4 と #3 の前倒し計測（`make probe-screen`）の入力になり、
# フェーズ4 では vt100 ゴールデンのフィクスチャを兼ねる。
#
# 録画そのものは Rust 側（server/crates/agent-core/tests/pty_record.rs）にある。製品と
# 同じ PTY 経路で録らないと、本番でエミュレータに届くバイト列とは別物を録ることになるため。
#
# なぜ書き出し先がリポジトリの外なのか
# ------------------------------------
# 本リポジトリは公開設定。録画は**生の端末バイト列**で、匿名化を通す前のものが
# リポジトリに入ると取り返しがつかない。既定の出力先をリポジトリ外にしておき、
# 残存検査を通ったものだけを fixtures/ へ置く。
#
# 使い方: ./scripts/record-terminal.sh [出力先ディレクトリ]
#         環境変数 AGENTDASHBOARD_RECORD_MODEL でモデルを差し替えられる（既定 haiku）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${TMPDIR:-/tmp}/agentdashboard-terminal-record}"

if ! command -v claude >/dev/null 2>&1; then
    echo "エラー: 本物の claude が PATH にありません。録画はホストで行います。" >&2
    exit 1
fi

CLAUDE_VERSION="$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
FIXTURE_DIR="${REPO_ROOT}/fixtures/v${CLAUDE_VERSION}/terminal"

echo "claude バージョン: ${CLAUDE_VERSION}"
echo "録画の一時置き場  : ${OUT_DIR}"
echo "設置先            : ${FIXTURE_DIR}"

mkdir -p "${OUT_DIR}"
# 前回の録画が混ざらないようにする。指定ディレクトリごと消すのではなく、
# 自分が作る種類のファイルだけを消す（利用者が任意のディレクトリを渡せるため）
rm -f "${OUT_DIR}"/*.cast

# --- 採取 -------------------------------------------------------------------------
# 「コンテナでビルド → ホストで実行」の分業と、利用者のグローバル設定の退避は
# scripts/test-cli が持っている。対象だけ差し替えて再利用する。
echo "==> 録画します（本物の claude を3セッション起動します）"
export AGENTDASHBOARD_RECORD_DIR="${OUT_DIR}"
TEST_PACKAGE="agent-core" TEST_TARGET="pty_record" "${REPO_ROOT}/scripts/test-cli" "$@"

shopt -s nullglob
CASTS=("${OUT_DIR}"/*.cast)
shopt -u nullglob
if [[ ${#CASTS[@]} -eq 0 ]]; then
    echo "エラー: 録画が1本もありません" >&2
    exit 1
fi

# --- 匿名化と残存検査 --------------------------------------------------------------
echo "==> 匿名化します"
python3 "${REPO_ROOT}/scripts/sanitize-fixtures.py" "${OUT_DIR}"

# --- 設置 -------------------------------------------------------------------------
mkdir -p "${FIXTURE_DIR}"
for cast in "${CASTS[@]}"; do
    cp "${cast}" "${FIXTURE_DIR}/"
    printf '  %s  %s\n' "$(basename "${cast}")" "$(du -h "${cast}" | cut -f1)"
done

echo "==> ${#CASTS[@]} 本を ${FIXTURE_DIR} へ置きました"
echo "    中身を確かめるには: make probe-screen"
