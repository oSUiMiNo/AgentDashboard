#!/usr/bin/env bash
# ゴールデンフィクスチャ（実トランスクリプト JSONL）を採取する。
#
# 本物の claude CLI と ~/.claude の認証情報はホスト側にあるため、このスクリプトは
# コンテナではなくホストで実行する。
#
# 既存の作業ログから採るのではなく、使い捨ての一時ディレクトリで合成ファイルを相手に
# セッションを走らせて「その場で作る」方式を採っている。業務プロジェクトの実ログには
# 機微情報が含まれるため、最初から機微情報が入らない作り方にするのが安全側だという判断。
#
# 採取したいのは次の4要素（テスト計画フェーズ1）:
#   1. ツールコール（Read / Bash / Write など）
#   2. Edit の差分（old_string / new_string）
#   3. サブエージェント（subagents/agent-*.jsonl と meta.json）
#   4. sidechain（isSidechain レコード）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_PROJECTS="${HOME}/.claude/projects"
MODEL="${FIXTURE_MODEL:-haiku}"

CLAUDE_VERSION="$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
FIXTURE_DIR="${REPO_ROOT}/fixtures/v${CLAUDE_VERSION}"

WORK_DIR="$(mktemp -d -t agentdashboard-fixture-XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "claude バージョン: ${CLAUDE_VERSION}"
echo "採取先            : ${FIXTURE_DIR}"
echo "一時作業ディレクトリ: ${WORK_DIR}"

mkdir -p "${FIXTURE_DIR}"

# --- 題材となる合成ファイルを置く -------------------------------------------------
# 実在のコードではなく、この場で作った当たり障りのない内容だけを使う。
cat > "${WORK_DIR}/notes.md" <<'EOF'
# サンプルメモ

- [ ] TODO: 集計処理のテストを書く
- [ ] TODO: README を更新する
EOF

cat > "${WORK_DIR}/calc.py" <<'EOF'
def add(a, b):
    return a + b


def total(values):
    result = 0
    for value in values:
        result = add(result, value)
    return result
EOF

# --- claude をセッションごとに起動する --------------------------------------------
# Claude 関連の環境変数は引き継がせない。継承すると別セッションが同じセッションIDを
# 名乗る事故が起きることが実機検証で確認されている（設計§6 の許可リスト方式と同じ考え方）。
run_session() {
    local label="$1"
    local prompt="$2"
    local session_id
    session_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"

    echo
    echo "--- 採取: ${label} (session_id=${session_id}) ---"

    (
        cd "${WORK_DIR}"
        env -i \
            HOME="${HOME}" \
            PATH="${PATH}" \
            TERM="${TERM:-xterm-256color}" \
            LANG="${LANG:-C.UTF-8}" \
            SHELL="${SHELL:-/bin/bash}" \
            claude \
                --session-id "${session_id}" \
                --model "${MODEL}" \
                --permission-mode acceptEdits \
                --allowed-tools Read Edit Write Bash Glob Grep Task Agent \
                -p "${prompt}" \
            > "${WORK_DIR}/${label}.stdout" 2>&1
    ) || {
        echo "警告: ${label} のセッションが非ゼロ終了しました。出力を確認してください:" >&2
        tail -5 "${WORK_DIR}/${label}.stdout" >&2 || true
    }

    collect "${label}" "${session_id}"
}

# 採取したトランスクリプトを fixtures へ写す。
collect() {
    local label="$1"
    local session_id="$2"

    local transcript
    transcript="$(find "${CLAUDE_PROJECTS}" -name "${session_id}.jsonl" -print -quit 2>/dev/null || true)"
    if [[ -z "${transcript}" ]]; then
        echo "警告: ${label} のトランスクリプトが見つかりません (${session_id}.jsonl)" >&2
        return
    fi

    local dest="${FIXTURE_DIR}/${label}"
    rm -rf "${dest}"
    mkdir -p "${dest}"
    cp "${transcript}" "${dest}/session.jsonl"

    # サブエージェントは <セッションID>/subagents/ に別ファイルで置かれる
    local session_dir="${transcript%.jsonl}"
    if [[ -d "${session_dir}" ]]; then
        cp -r "${session_dir}" "${dest}/session"
    fi

    echo "採取しました: ${dest}"
}

# 引数でラベルを絞れる。既に採ってあるものを採り直すと、ゴールデンスナップショットの
# 期待値がずれて無関係なテストが落ちるため、追加採取のときは絞って呼ぶ。
should_run() {
    [[ $# -eq 0 ]] && return 0
    local wanted="$1"
    shift
    for label in "$@"; do
        [[ "${label}" == "${wanted}" ]] && return 0
    done
    return 1
}

should_run "basic-tools" "$@" && run_session "basic-tools" \
    'notes.md を Read で読み、1つ目の TODO 行を Edit ツールで "DONE:" に書き換えてください。次に Bash で ls -la を実行し、最後に summary.txt を Write で作成して作業内容を1行で書いてください。'

should_run "subagent" "$@" && run_session "subagent" \
    'Task ツールでサブエージェントを1つ起動し、このディレクトリにある .py ファイルの関数一覧を調べさせてください。サブエージェントの報告を受け取ったら、その内容を1行で要約して答えてください。'

# 多段ネスト（spawnDepth 2以上）を採る。深さ1の meta は toolUseId で親のツールコールに
# 繋がるが、深さ2以上は parentAgentId で親エージェントに繋がる。鍵が変わるので、
# 実物が無いとマウント処理を検証できない。
should_run "nested-subagent" "$@" && run_session "nested-subagent" \
    'サブエージェントを1つ起動してください。そのサブエージェントには「さらに自分でサブエージェントをもう1つ起動して、このディレクトリの notes.md を読ませ、その結果を報告させる」よう指示してください。最終的な報告を1行で要約して答えてください。'

# 失敗したツールコールを採る。basic-tools が持っているのは「利用者に拒否された」形
# （toolUseResult が文字列になる）で、**ツール自身が失敗した**形は別物。あわせて
# 1ターンで複数ファイルを編集させ、Edit が連続する並びも入れておく。
should_run "failing-tools" "$@" && run_session "failing-tools" \
    'まず missing-file.md を Read ツールで読んでください（このファイルは存在しないので失敗します）。失敗を確認したら、notes.md の2つ目の TODO 行を Edit で "DONE:" に書き換え、続けて calc.py の add 関数の中に説明のコメント行を Edit で1行足してください。最後に何をしたか1行で答えてください。'

# --- 採取結果の点検 ---------------------------------------------------------------
echo
echo "=== 採取カバレッジの確認 ==="
check() {
    local what="$1"
    local pattern="$2"
    if grep -rql "${pattern}" "${FIXTURE_DIR}" 2>/dev/null; then
        echo "  OK   ${what}"
    else
        echo "  未採取 ${what}（パターン: ${pattern}）"
    fi
}
check "ツールコール"        '"tool_use"'
check "ツール結果"          'toolUseResult'
check "Edit の差分"         'old_string'
check "sidechain"           '"isSidechain":true'
check "サブエージェント"    'subagents'
check "多段ネスト"          '"spawnDepth":2'
check "親エージェント参照"  'parentAgentId'
check "失敗したツールコール" '"is_error":true'

echo
echo "=== 機微情報の除去 ==="
python3 "${REPO_ROOT}/scripts/sanitize-fixtures.py" "${FIXTURE_DIR}" --extra "${WORK_DIR}=/work/sample"

echo
echo "完了しました。採取先: ${FIXTURE_DIR}"
