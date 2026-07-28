#!/usr/bin/env bash
# `/rewind` 実行時に JSONL トランスクリプトが物理的にどう変わるかを実測する（設計§13）。
#
# 何のためにあるか
# ----------------
# 巻き戻り検知（`transcript-parser` の tail）は「ファイルが縮んだ」「既読範囲の先頭が
# 書き換わった」の2つしか見ていない。`/rewind` がそのどちらかを起こすのか、それとも
# 別のことをするのかで、検知の作りが妥当かどうかが決まる。
# 形式は Claude Code のバージョンで変わりうるので、疑わしくなったら測り直せるようにしてある。
#
# なぜ利用者の設定を外して起動するのか
# ------------------------------------
# `--settings` は「追加読み込み」なので、普通に起動すると利用者のグローバルフックも動く。
# セッション開始時にスキルが自動起動する設定になっていると、そのスキルが出す権限確認が
# `/rewind` のメニューへ送ったキー入力を吸ってしまい、実測が完走しない（実際に一度失敗した）。
# `--setting-sources project,local` で利用者の設定ソースだけを読み込み対象から外す。
# 利用者の設定ファイルには一切触らない。
#
# なぜ tmux 越しに動かすのか
# --------------------------
# `/rewind` はインタラクティブTUI専用で、メニューを目で見て選ぶ必要がある。tmux なら
# `capture-pane` でレンダリング後の画面をそのまま読めるので、メニューの中身を確認しながら
# キーを送れる。生の PTY を自前で読むと ANSI の解釈を自作することになる。
#
# 記録の置き場所について
# ----------------------
# 記録には**採取したトランスクリプトの実物**が含まれる。トランスクリプトには採取内容とは
# 無関係にその環境の構成情報（導入済みスキル一覧・接続中のMCP等）が `attachment` として
# 書き出される。本リポジトリは公開設定なので、既定の出力先はリポジトリの外にしてある。
# 中身を持ち出すときは `scripts/sanitize-fixtures.py` を通すこと。
#
# 使い方: ./scripts/rewind-probe.sh [出力先ディレクトリ]
set -euo pipefail

OUT_DIR="${1:-${TMPDIR:-/tmp}/agentdashboard-rewind-probe}"
SESSION_NAME="rewind-probe"
MODEL="${REWIND_PROBE_MODEL:-haiku}"

if ! command -v claude >/dev/null 2>&1; then
    echo "エラー: 本物の claude が PATH にありません。この実測はホストで行います。" >&2
    exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
    echo "エラー: tmux がありません。メニュー操作の自動化に必要です。" >&2
    exit 1
fi

CLAUDE_VERSION="$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
WORK_DIR="$(mktemp -d -t rewind-probe-XXXXXX)"
SESSION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
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

# セッションのトランスクリプトが置かれたディレクトリを求める。
# JSONL は結果整合のチャネルなので、起動直後はまだ存在しないことがある。
resolve_project_dir() {
    local transcript
    transcript="$(find "${HOME}/.claude/projects" -name "${SESSION_ID}.jsonl" -print -quit 2>/dev/null || true)"
    [[ -z "${transcript}" ]] && return 1
    PROJECT_DIR="$(dirname "${transcript}")"
    return 0
}

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

echo "claude バージョン: ${CLAUDE_VERSION}"
echo "作業ディレクトリ  : ${WORK_DIR}"
echo "セッションID      : ${SESSION_ID}"
echo "記録先            : ${OUT_DIR}"
echo

# --- 題材となる合成ファイル -------------------------------------------------------
cat > "${WORK_DIR}/calc.py" <<'EOF'
def add(a, b):
    return a + b


def total(values):
    result = 0
    for value in values:
        result = add(result, value)
    return result
EOF

cat > "${WORK_DIR}/notes.md" <<'EOF'
# サンプルメモ

- [ ] TODO: 集計処理のテストを書く
EOF

# --- スナップショット -------------------------------------------------------------
# tail が判定に使う2つの手がかり（サイズ・既読先頭4KiBの指紋）を、そのまま観測できる形で残す。
snapshot() {
    local label="$1"
    python3 - "${PROJECT_DIR}" "${label}" "${OUT_DIR}" <<'PY'
import hashlib, json, pathlib, sys

project_dir, label, out_dir = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
rows = []
for path in sorted(project_dir.rglob("*")):
    if not path.is_file():
        continue
    stat = path.stat()
    data = path.read_bytes()
    rows.append({
        "path": str(path.relative_to(project_dir)),
        "size": stat.st_size,
        "inode": stat.st_ino,
        "head_sha": hashlib.sha256(data[:4096]).hexdigest()[:16],
        "lines": data.count(b"\n"),
    })
payload = {"label": label, "files": rows}
(out_dir / f"snap-{label}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
for row in rows:
    print(f"  {row['path']}  size={row['size']} inode={row['inode']} head={row['head_sha']} lines={row['lines']}")
PY
    # 中身そのものも残す。あとから「どの行が増えたか」を突き合わせるため
    cp -r "${PROJECT_DIR}" "${OUT_DIR}/transcript-${label}"
}

# --- tmux の世話 ------------------------------------------------------------------
send_text() {
    tmux send-keys -t "${SESSION_NAME}" -l "$1"
    sleep 1
    tmux send-keys -t "${SESSION_NAME}" Enter
}

# 応答が終わるまで待つ。「esc to interrupt」が画面から消えたら1ターン完了。
wait_idle() {
    local limit="${1:-40}"
    for _ in $(seq 1 "${limit}"); do
        sleep 5
        if ! tmux capture-pane -p -t "${SESSION_NAME}" | grep -qi "esc to interrupt"; then
            return 0
        fi
    done
    echo "警告: 応答待ちがタイムアウトしました" >&2
    return 1
}

capture() {
    tmux capture-pane -p -t "${SESSION_NAME}" > "${OUT_DIR}/screen-$1.txt"
}

# --- 起動 -------------------------------------------------------------------------
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
         --session-id "${SESSION_ID}" \\
         --model "${MODEL}" \\
         --permission-mode acceptEdits
EOF
chmod +x "${WORK_DIR}/launch.sh"

tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
tmux new-session -d -s "${SESSION_NAME}" -x 200 -y 50 "${WORK_DIR}/launch.sh"
sleep 8

# 初回はフォルダ信頼の確認が出る。既定の「Yes, I trust this folder」を選ぶ
if tmux capture-pane -p -t "${SESSION_NAME}" | grep -q "I trust this folder"; then
    echo "==> フォルダ信頼の確認に応答します"
    tmux send-keys -t "${SESSION_NAME}" Enter
    sleep 8
fi
capture "00-started"

resolve_project_dir || true

# --- 巻き戻す対象を作る（編集を伴う2ターン）--------------------------------------
echo "==> ターン1: calc.py を編集させます"
send_text 'calc.py の add 関数に docstring を1行だけ追加してください。'
wait_idle
capture "01-turn1"

if [[ -z "${PROJECT_DIR}" ]] && ! resolve_project_dir; then
    echo "エラー: トランスクリプトが見つかりません（${SESSION_ID}.jsonl）" >&2
    exit 1
fi
echo "プロジェクトディレクトリ: ${PROJECT_DIR}"
echo "--- スナップショット: ターン1後 ---"
snapshot "01-turn1"

echo "==> ターン2: notes.md を編集させます"
send_text 'notes.md の TODO 行を「DONE:」に書き換えてください。'
wait_idle
capture "02-turn2"
echo "--- スナップショット: ターン2後 ---"
snapshot "02-turn2"

# --- /rewind ----------------------------------------------------------------------
echo "==> /rewind のメニューを開きます"
send_text '/rewind'
sleep 4
capture "03-rewind-menu"

# メニューは「巻き戻し先の候補が古い順、最後に (current)」で、初期選択は (current)。
# 2つ上＝ターン1の直前まで戻る（2ターンとも巻き戻る、最も差が大きいケース）
tmux send-keys -t "${SESSION_NAME}" Up
sleep 1
tmux send-keys -t "${SESSION_NAME}" Up
sleep 1
tmux send-keys -t "${SESSION_NAME}" Enter
sleep 4
capture "04-rewind-confirm"

# 確認画面。既定の「1. Restore code and conversation」を選ぶ
tmux send-keys -t "${SESSION_NAME}" Enter
sleep 8
capture "05-after-rewind"
echo "--- スナップショット: 巻き戻し直後（まだ何も発言していない）---"
snapshot "03-after-rewind"

# --- 巻き戻した先で新しく発言する -------------------------------------------------
# 巻き戻すと、巻き戻し対象だった発言が入力欄に戻ってくる。消してから別の内容を送る
echo "==> 巻き戻した先で新しい枝を作ります"
tmux send-keys -t "${SESSION_NAME}" C-u
sleep 1
send_text 'これは巻き戻し後の新しい枝です。calc.py の total 関数に docstring を1行だけ追加してください。'
wait_idle
capture "06-after-fork-turn"
echo "--- スナップショット: 新しい枝で1ターン後 ---"
snapshot "04-after-fork"

# --- 判定 -------------------------------------------------------------------------
echo
echo "=== 判定 ==="
python3 - "${OUT_DIR}" "${SESSION_ID}" <<'PY'
import json, pathlib, sys

out_dir, session_id = pathlib.Path(sys.argv[1]), sys.argv[2]
name = f"{session_id}.jsonl"


def load(label):
    data = json.loads((out_dir / f"snap-{label}.json").read_text(encoding="utf-8"))
    return {row["path"]: row for row in data["files"]}


before, after_rewind, after_fork = load("02-turn2"), load("03-after-rewind"), load("04-after-fork")
b, r, f = before.get(name), after_rewind.get(name), after_fork.get(name)

print(f"  巻き戻し前 : size={b['size']} inode={b['inode']} head={b['head_sha']} lines={b['lines']}")
print(f"  巻き戻し直後: size={r['size']} inode={r['inode']} head={r['head_sha']} lines={r['lines']}")
print(f"  新しい枝の後: size={f['size']} inode={f['inode']} head={f['head_sha']} lines={f['lines']}")
print()
print(f"  ファイルは縮んだか          : {'はい' if r['size'] < b['size'] else 'いいえ'}")
print(f"  先頭4KiBの指紋は変わったか  : {'はい' if r['head_sha'] != b['head_sha'] else 'いいえ'}")
print(f"  inode は変わったか（作り直し）: {'はい' if r['inode'] != b['inode'] else 'いいえ'}")
new_files = sorted(set(after_fork) - set(before))
print(f"  別セッションIDのファイルが増えたか: {new_files or 'いいえ'}")

# 追記された行を調べ、新しい枝がどう繋がるかを見る
old_lines = (out_dir / "transcript-02-turn2" / name).read_text(encoding="utf-8").splitlines()
new_lines = (out_dir / "transcript-04-after-fork" / name).read_text(encoding="utf-8").splitlines()
print(f"  既存部分はそのまま残っているか  : {'はい' if new_lines[:len(old_lines)] == old_lines else 'いいえ'}")

roots = []
for index, line in enumerate(new_lines):
    try:
        rec = json.loads(line)
    except json.JSONDecodeError:
        continue
    if rec.get("type") in ("user", "assistant") and rec.get("parentUuid") is None:
        roots.append(index + 1)
print(f"  parentUuid が null の根の行番号 : {roots}")
session_ids = {json.loads(l).get("sessionId") for l in new_lines if l.strip()} - {None}
print(f"  ファイル内の sessionId          : {sorted(session_ids)}")
PY

echo
echo "記録は ${OUT_DIR} に残しました（画面キャプチャ・スナップショット・トランスクリプト実物）"
