#!/usr/bin/env bash
# 権限モード（`--permission-mode`）の実挙動を実測する（ローカルイシュー「権限確認省略モード」設計§10）。
#
# 何のためにあるか
# ----------------
# ダッシュボードは「いまどのモードか」を2つの経路で知る。フックの payload に載る
# `permission_mode` と、TUI のフッタに出る `⏵⏵ accept edits on` のような表示である。
# どちらも Claude Code 側の都合で変わりうるので、実装の前に実物で確かめ、
# 疑わしくなったら測り直せるようにしてある。
#
# 測るのは次の5つ。
#   1. 9つのフックイベントのうち、どれが `permission_mode` を運ぶか
#   2. `--permission-mode manual` で起動したとき、フックが返す値は何か（`manual` か `default` か）
#   3. 各モードのフッタの実文字列
#   4. Shift+Tab の巡回順（どのモードがサイクルに入るか）
#   5. `bypassPermissions` 起動時に出る警告ダイアログの文言と、承認するためのキー
#
# クォータについて
# ----------------
# 実際にトークンを使うのは**セッションAの1ターンだけ**。他のセッションは起動して画面を
# 見るだけなので、モデルへの問い合わせは発生しない。モデルは既定で haiku に固定している。
#
# なぜ利用者の設定を外して起動するのか
# ------------------------------------
# `--settings` は「追加読み込み」なので、普通に起動すると利用者のグローバルフックも動く。
# セッション開始時にスキルが自動起動する設定になっていると、そのスキルが出す権限確認が
# こちらの送ったキーを吸ってしまい、実測が完走しない（初期実装フェーズ3で実測した事故）。
# `--setting-sources project,local` で利用者の設定ソースだけを読み込み対象から外す。
# 利用者の設定ファイルには一切触らない。
#
# なぜ tmux 越しに動かすのか
# --------------------------
# フッタは TUI がレンダリングした画面にしか現れない。tmux なら `capture-pane` で
# レンダリング後の画面をそのまま読める。生の PTY を自前で読むと ANSI の解釈を自作することになる。
#
# 記録の置き場所について
# ----------------------
# 画面キャプチャとフック payload には、その環境の構成情報が混ざりうる。本リポジトリは
# 公開設定なので、既定の出力先はリポジトリの外にしてある。
#
# 使い方: ./scripts/permission-mode-probe.sh [出力先ディレクトリ]
set -euo pipefail

OUT_DIR="${1:-${TMPDIR:-/tmp}/agentdashboard-permission-mode-probe}"
SESSION_NAME="permission-mode-probe"
MODEL="${PERMISSION_PROBE_MODEL:-haiku}"

for tool in claude tmux python3; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "エラー: ${tool} が PATH にありません。この実測はホストで行います。" >&2
        exit 1
    fi
done

CLAUDE_VERSION="$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
WORK_DIR="$(mktemp -d -t permission-mode-probe-XXXXXX)"
HOOKS_FILE="${WORK_DIR}/hooks.jsonl"
SETTINGS_FILE="${WORK_DIR}/settings.json"
SESSION_IDS=()
PROJECT_DIR=""

cleanup() {
    tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
    # CLI は終了する間際にもトランスクリプトへ書く。先に消すと、その書き込みで
    # ディレクトリが復活して片付けたつもりの残骸が残る。落ちきるまで待つ
    for _ in $(seq 1 10); do
        tmux has-session -t "${SESSION_NAME}" 2>/dev/null || break
        sleep 1
    done
    sleep 2
    rm -rf "${WORK_DIR}"
    # 実測で生えたトランスクリプトは利用者の ~/.claude に残るので片付ける。
    # 消す先が本当に projects 配下かを必ず確かめる（空文字や "." を掴むと事故になる）
    case "${PROJECT_DIR}" in
        "${HOME}/.claude/projects/"?*)
            rm -rf "${PROJECT_DIR}"
            ;;
    esac
}
trap cleanup EXIT

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

echo "claude バージョン: ${CLAUDE_VERSION}"
echo "作業ディレクトリ  : ${WORK_DIR}"
echo "記録先            : ${OUT_DIR}"
echo

# --- 題材となる合成ファイル -------------------------------------------------------
cat > "${WORK_DIR}/notes.md" <<'EOF'
# サンプルメモ

- [ ] TODO: 集計処理のテストを書く
EOF

# --- フック設定 -------------------------------------------------------------------
# 受信サーバを立てず、payload をそのままファイルへ落とす。ここで見たいのは
# 「どのイベントが permission_mode を運ぶか」だけなので、転送経路は要らない。
python3 - "${SETTINGS_FILE}" "${HOOKS_FILE}" <<'PY'
import json
import shlex
import sys

settings_path, hooks_path = sys.argv[1], sys.argv[2]
events = [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "Notification", "Stop", "SubagentStart", "SubagentStop", "SessionEnd",
]
quoted = shlex.quote(hooks_path)
command = f"cat >> {quoted}; printf '\\n' >> {quoted}"

hooks = {}
for event in events:
    entry = {"hooks": [{"type": "command", "command": command}]}
    # ツールに紐づくイベントだけが matcher を取る
    if event in ("PreToolUse", "PostToolUse"):
        entry["matcher"] = "*"
    hooks[event] = [entry]

with open(settings_path, "w", encoding="utf-8") as handle:
    json.dump({"hooks": hooks}, handle, ensure_ascii=False, indent=2)
PY

# --- tmux の世話 ------------------------------------------------------------------
capture() {
    tmux capture-pane -p -t "${SESSION_NAME}" > "${OUT_DIR}/screen-$1.txt"
}

screen() {
    tmux capture-pane -p -t "${SESSION_NAME}" 2>/dev/null || true
}

# フッタの目印だけを抜き出す。`⏸ manual mode on` / `⏵⏵ accept edits on` の形。
footer() {
    screen | grep -oE '(⏸|⏵⏵)[^│|]*(mode on|edits on|ask on|permissions on)' | tail -1 || true
}

send_text() {
    tmux send-keys -t "${SESSION_NAME}" -l "$1" 2>/dev/null || true
    sleep 1
    tmux send-keys -t "${SESSION_NAME}" Enter 2>/dev/null || true
}

# キーを1つ送る。セッションが既に落ちている場合もあるので握り潰す
send_key() {
    tmux send-keys -t "${SESSION_NAME}" "$1" 2>/dev/null || true
}

# 応答が終わるまで待つ。「esc to interrupt」が画面から消えたら1ターン完了。
wait_idle() {
    local limit="${1:-30}"
    for _ in $(seq 1 "${limit}"); do
        sleep 5
        if ! screen | grep -qi "esc to interrupt"; then
            return 0
        fi
    done
    echo "警告: 応答待ちがタイムアウトしました" >&2
    return 0
}

# セッションを1本立ち上げる。引数: <ラベル> <モード（空なら指定なし）>
boot() {
    local label="$1" mode="$2"
    local session_id
    session_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    SESSION_IDS+=("${session_id}")

    local mode_args=""
    [[ -n "${mode}" ]] && mode_args="--permission-mode ${mode}"

    cat > "${WORK_DIR}/launch.sh" <<EOF
#!/usr/bin/env bash
cd "${WORK_DIR}"
exec env -i \\
  HOME="${HOME}" \\
  PATH="${PATH}" \\
  TERM=xterm-256color \\
  LANG="${LANG:-C.UTF-8}" \\
  SHELL="${SHELL:-/bin/bash}" \\
  claude --setting-sources project,local \\
         --settings "${SETTINGS_FILE}" \\
         --session-id "${session_id}" \\
         --model "${MODEL}" \\
         ${mode_args}
EOF
    chmod +x "${WORK_DIR}/launch.sh"

    tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
    tmux new-session -d -s "${SESSION_NAME}" -x 200 -y 50 "${WORK_DIR}/launch.sh"
    sleep 8
    capture "${label}-00-boot"

    # 初回はフォルダ信頼の確認が出る。既定の「Yes, I trust this folder」を選ぶ
    if screen | grep -q "I trust this folder"; then
        echo "    （フォルダ信頼の確認に応答しました）"
        send_key Enter
        sleep 6
        capture "${label}-01-trusted"
    fi
}

quit() {
    send_text "/exit"
    sleep 3
    tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
    sleep 1
}

# --- セッションA: フックの payload を集める（★ここだけトークンを使う）--------------
echo "==> セッションA: --permission-mode manual で起動し、フックの payload を集めます"
boot "A-manual" "manual"
echo "manual: $(footer)" | tee -a "${OUT_DIR}/footers.txt"

echo "    ターンを1回回します（ファイル編集で権限確認を出す）"
send_text 'notes.md の TODO 行を DONE に書き換えてください。'
sleep 15
capture "A-manual-02-permission"

# 権限確認が出ていたら既定（許可）を選ぶ
if screen | grep -qiE "do you want|Yes, and|allow "; then
    echo "    （権限確認に応答しました）"
    send_key Enter
    sleep 3
fi
wait_idle
capture "A-manual-03-after-turn"

# --- Shift+Tab の巡回順（トークンを使わない）--------------------------------------
echo "==> Shift+Tab の巡回順を測ります"
{
    echo "起動時(manual): $(footer)"
    for step in $(seq 1 8); do
        send_key BTab
        sleep 2
        echo "${step}回目: $(footer)"
        capture "A-manual-cycle-${step}"
    done
} | tee "${OUT_DIR}/cycle-manual.txt"

quit
sleep 2

# --- 他のモードのフッタ（トークンを使わない）--------------------------------------
for mode in acceptEdits plan dontAsk auto; do
    echo "==> ${mode} で起動してフッタを見ます"
    boot "${mode}" "${mode}"
    echo "${mode}: $(footer)" | tee -a "${OUT_DIR}/footers.txt"
    quit
    sleep 2
done

# --- bypassPermissions（警告ダイアログの有無と文言）--------------------------------
echo "==> bypassPermissions で起動して警告ダイアログを見ます"
boot "bypass" "bypassPermissions"
cp "${OUT_DIR}/screen-bypass-00-boot.txt" "${OUT_DIR}/bypass-dialog.txt"
echo "    起動直後の画面は ${OUT_DIR}/bypass-dialog.txt に残しました"
echo "bypassPermissions: $(footer)" | tee -a "${OUT_DIR}/footers.txt"

echo "==> bypassPermissions 起動時の巡回順を測ります"
{
    echo "起動時: $(footer)"
    for step in $(seq 1 8); do
        send_key BTab
        sleep 2
        echo "${step}回目: $(footer)"
    done
} | tee "${OUT_DIR}/cycle-bypass.txt"
quit

# --- フック payload の解析 --------------------------------------------------------
cp "${HOOKS_FILE}" "${OUT_DIR}/hooks.jsonl" 2>/dev/null || true

echo
echo "=== 判定 ==="
python3 - "${OUT_DIR}" <<'PY'
import json
import pathlib
import sys

out_dir = pathlib.Path(sys.argv[1])
path = out_dir / "hooks.jsonl"
if not path.exists():
    print("  フックの payload が1件も届いていません")
    raise SystemExit(0)

seen = {}
for line in path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        continue
    event = payload.get("hook_event_name", "(不明)")
    entry = seen.setdefault(event, {"count": 0, "modes": set()})
    entry["count"] += 1
    entry["modes"].add(payload.get("permission_mode", "(無し)"))

print("  イベントごとの permission_mode:")
for event in sorted(seen):
    entry = seen[event]
    modes = ", ".join(sorted(str(mode) for mode in entry["modes"]))
    print(f"    {event:<18} {entry['count']:>2}件  permission_mode = {modes}")

missing = [event for event, entry in seen.items() if entry["modes"] == {"(無し)"}]
print()
print(f"  permission_mode を運ばないイベント: {missing or 'なし'}")
values = {mode for entry in seen.values() for mode in entry["modes"]} - {"(無し)"}
print(f"  観測した permission_mode の値      : {sorted(values)}")
PY

echo
echo "  フッタの実文字列:"
sed 's/^/    /' "${OUT_DIR}/footers.txt" 2>/dev/null || echo "    （記録なし）"
echo
echo "  Shift+Tab の巡回（manual 起動）:"
sed 's/^/    /' "${OUT_DIR}/cycle-manual.txt"
echo
echo "  Shift+Tab の巡回（bypassPermissions 起動）:"
sed 's/^/    /' "${OUT_DIR}/cycle-bypass.txt"

# 片付け用にプロジェクトディレクトリを解決しておく
for session_id in "${SESSION_IDS[@]}"; do
    transcript="$(find "${HOME}/.claude/projects" -name "${session_id}.jsonl" -print -quit 2>/dev/null || true)"
    if [[ -n "${transcript}" ]]; then
        PROJECT_DIR="$(dirname "${transcript}")"
        break
    fi
done

echo
echo "記録は ${OUT_DIR} に残しました（画面キャプチャ・フック payload）"
