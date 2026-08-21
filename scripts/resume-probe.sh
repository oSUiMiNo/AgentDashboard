#!/usr/bin/env bash
# `--resume` でセッションを引き継いだときの実挙動を実測する
# （ローカルイシュー「接続断のカードを復旧ボタンで戻す」設計§13 の 1〜3）。
#
# 何のためにあるか
# ----------------
# 復旧は「抜け殻のカードを、記録してある CLI のセッションIDで起こし直す」機能である。
# 成立するかどうかは Claude Code 側の3つの振る舞いに乗っている。どれも公式ドキュメントの
# 記述はあるが**実測していない**ので、実装の前に実物で確かめ、疑わしくなったら測り直せる
# ようにしてある。
#
# 測るのは次の3つ。
#   1. 同じセッションIDで `--resume` したとき、**同じ JSONL に追記される**か
#      （別ファイルになるなら、再開位置が効かず履歴を頭から読み直すことになる）
#   2. `--permission-mode` と `--resume` を**組で渡せる**か
#      （渡せないなら「記録どおりのモードで戻す」という要件の判断が成立しない）
#   3. **実体が消えたセッションIDへ `--resume` したときの落ち方**
#      （終了コードと、ターミナルに出る文言。設計§9-5 の見せ方がここで決まる）
#
# クォータについて
# ----------------
# トークンを使うのは**段1と段2の各1ターンだけ**（計2ターン）。段3 は起動の時点で
# 決着するので、モデルへの問い合わせは発生しない見込みである。モデルは既定で haiku に固定。
#
# 製品が組み立てる起動引数との違い
# --------------------------------
# 製品（`session-host-core/src/session/lifecycle.rs` の `build_command_with_env`）が組むのは
#   claude --resume <id> --settings <file> [--permission-mode <mode>]
# で、`--setting-sources` は付けない（修復セッションだけが足す）。この実測は下記の理由で
# `--setting-sources project,local` を付けるので、**argv は製品と完全には同じでない**。
# 測っている対象は CLI 側の振る舞い（追記か別ファイルか・引数を受けるか・落ち方）なので
# 差は効かないが、読む人が「同じ argv で測った」と誤読しないようここに書いておく。
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
# 測定3の主張は「**ターミナルに理由がそのまま出る**」なので、レンダリング後の画面が要る。
# tmux なら `capture-pane` でそれをそのまま読める。生の PTY を自前で読むと ANSI の解釈を
# 自作することになる。
#
# 記録の置き場所について
# ----------------------
# 記録には**採取したトランスクリプトの実物**が含まれる。トランスクリプトには採取内容とは
# 無関係にその環境の構成情報（導入済みスキル一覧・接続中のMCP等）が `attachment` として
# 書き出される。本リポジトリは公開設定なので、既定の出力先はリポジトリの外にしてある。
# 中身を持ち出すときは `scripts/sanitize-fixtures.py` を通すこと。
#
# 使い方： ./scripts/resume-probe.sh [出力先ディレクトリ]
set -euo pipefail

OUT_DIR="${1:-${TMPDIR:-/tmp}/agentdashboard-resume-probe}"
SESSION_NAME="resume-probe"
MODEL="${RESUME_PROBE_MODEL:-haiku}"

if ! command -v claude >/dev/null 2>&1; then
    echo "エラー： 本物の claude が PATH にありません。この実測はホストで行います。" >&2
    exit 1
fi
if ! command -v tmux >/dev/null 2>&1; then
    echo "エラー： tmux がありません。TUI の画面を読むために必要です。" >&2
    exit 1
fi

CLAUDE_VERSION="$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
WORK_DIR="$(mktemp -d -t resume-probe-XXXXXX)"
SESSION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
# 実体が存在しないことが確実なID。段3 で使う
MISSING_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
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

echo "claude バージョン ： ${CLAUDE_VERSION}"
echo "作業ディレクトリ  ： ${WORK_DIR}"
echo "セッションID      ： ${SESSION_ID}"
echo "実在しないID(段3) ： ${MISSING_ID}"
echo "記録先            ： ${OUT_DIR}"
echo

# --- 題材となる合成ファイル -------------------------------------------------------
cat > "${WORK_DIR}/notes.md" <<'EOF'
# サンプルメモ

- [ ] TODO: 集計処理のテストを書く
EOF

# --- スナップショット -------------------------------------------------------------
# 「同じファイルに追記されたか」を後から突き合わせられる形で残す。
# ディレクトリを丸ごと歩くので、**別セッションIDのファイルが増えた**ことも拾える。
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
screen() {
    tmux capture-pane -p -t "${SESSION_NAME}" 2>/dev/null || true
}

capture() {
    screen > "${OUT_DIR}/screen-$1.txt"
}

# 本文を打ってから確定する。
# **`/` で始まるものを打つと候補の一覧が開き、絞り込みが効くまでに間がある。**
# 打った直後（1秒後）に画面を撮ると、一覧はまだ絞り込まれていない。ターンを1度も回して
# いないセッションでは、2秒あければ `/exit` が通ることを実測してある。
#
# **ただし、ターンを1回まわしたあとの段1 では2秒でも `/exit` が効かない。** 3回とも
# 同じで、原因は突き止めていない（段2 の `/exit` は同じ2秒で通り、終了コード 0 が残る）。
# 効かなかったときは黙って進まず、畳んだことを言う（`wait_gone` の呼び出し側）。
# 3つの測定は「落ちきった後」どうしの比較なので、ここが効かなくても値は動かない。
send_text() {
    tmux send-keys -t "${SESSION_NAME}" -l "$1"
    sleep 2
    tmux send-keys -t "${SESSION_NAME}" Enter
}

# トランスクリプトが増えなくなるまで待つ。
# **`wait_idle` が返っても、JSONL への書き出しは終わっていない。** 画面から
# 「esc to interrupt」が消えるのと、記録が落ちきるのは別の出来事で、JSONL は結果整合の
# チャネルである。実測では、`wait_idle` の直後に撮ったスナップショットが 15 行、そのあと
# 落ちきった時点で 23 行だった——**ツールコール・その結果・本文・`turn_duration` の8行が
# まるごと後から来る**。ここを待たずに前後を比べると、増えた行を「別の何かが書いた」と
# 読み違える（実際に読み違えた）
# **1回の「変わらなかった」で満足してはいけない。** 書き出しは飛び飛びなので、
# 2秒の谷にたまたま当たると増え続けている最中に返る（実測で 16 行の時点で返り、
# そのあと 25 行まで増えた）。**続けて3回**変わらないことを見る
wait_settled() {
    local limit="${1:-20}"
    local need=3
    local stable=0
    local previous=-1 current
    for _ in $(seq 1 "${limit}"); do
        sleep 2
        current="$(du -sb "${PROJECT_DIR}" 2>/dev/null | cut -f1)"
        if [[ "${current}" == "${previous}" ]]; then
            stable=$((stable + 1))
            [[ "${stable}" -ge "${need}" ]] && return 0
        else
            stable=0
        fi
        previous="${current}"
    done
    echo "警告： トランスクリプトが増え続けています（落ちきる前に撮っている可能性）" >&2
    return 1
}

# 応答が終わるまで待つ。「esc to interrupt」が画面から消えたら1ターン完了
wait_idle() {
    local limit="${1:-40}"
    for _ in $(seq 1 "${limit}"); do
        sleep 5
        if ! screen | grep -qi "esc to interrupt"; then
            return 0
        fi
    done
    echo "警告： 応答待ちがタイムアウトしました" >&2
    return 1
}

# フッタの目印だけを抜き出す。`⏸ manual mode on` / `⏵⏵ accept edits on` の形
# （`scripts/permission-mode-probe.sh` と同じ抜き方）
footer() {
    screen | grep -oE '(⏸|⏵⏵)[^│|]*(mode on|edits on|ask on|permissions on)' | tail -1 || true
}

# フォルダ信頼の確認が出ていたら既定（Yes, I trust this folder）で答える
answer_trust_if_any() {
    if screen | grep -q "I trust this folder"; then
        echo "==> フォルダ信頼の確認に応答します"
        tmux send-keys -t "${SESSION_NAME}" Enter
        sleep 8
    fi
}

# claude を1本起こす。**`exec` を使わない**——使うと終了コードを控える行まで辿り着けない。
# 終了コードはパイプを挟まずにファイルへ落とす（`make ci | tail` と同じ罠を踏まないため）
launch() {
    local label="$1"
    shift
    local args=("$@")
    {
        echo '#!/usr/bin/env bash'
        printf 'cd %q\n' "${WORK_DIR}"
        printf 'env -i HOME=%q PATH=%q TERM=xterm-256color LANG=%q SHELL=%q \\\n' \
            "${HOME}" "${PATH}" "${LANG:-C.UTF-8}" "${SHELL:-/bin/bash}"
        printf '  claude'
        printf ' %q' "${args[@]}"
        printf '\n'
        printf 'echo $? > %q\n' "${OUT_DIR}/exit-${label}.txt"
    } > "${WORK_DIR}/launch-${label}.sh"
    chmod +x "${WORK_DIR}/launch-${label}.sh"

    tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
    tmux new-session -d -s "${SESSION_NAME}" -x 200 -y 50 "${WORK_DIR}/launch-${label}.sh"
    sleep 8
}

# 画面が落ちるのを待つ。落ちたら 0、生き残ったら 1。
# **`/exit` は即座には終わらない**（実測で20秒では足りず、段1 の終了コードを取り損ねた）ので
# 既定を長めに取ってある。ここで待ち切れないと次の段の `tmux kill-session` が巻き込んで殺し、
# 終了コードの控えが残らない。
wait_gone() {
    local limit="${1:-60}"
    for _ in $(seq 1 "${limit}"); do
        tmux has-session -t "${SESSION_NAME}" 2>/dev/null || return 0
        sleep 1
    done
    return 1
}

# 制御シーケンスを落として、生のバイト列から本文だけを読む。
# 画面（tmux の capture-pane）ではなく**生のバイト列**を見るのは、ブラウザのターミナルへ
# 流れるのがこちらだから（PJTガイドライン「読む対象は画面ではなく生のバイト列」）。
strip_ansi() {
    python3 - "$1" <<'PY'
import pathlib, re, sys

raw = pathlib.Path(sys.argv[1]).read_bytes()
text = raw.decode("utf-8", "replace")
# 順序が意味を持つ。長いものから落とさないと、短い規則が途中で食いちぎる
text = re.sub(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)", "", text)   # OSC（タイトル等）
# CSI。**媒介変数のバイトは 0x30〜0x3F** なので `<` `=` `>` `?` まで含める。
# `[0-9;?]` だけにすると `ESC [ > 4 m` が外れ、`>4m` が字として残る（実測で踏んだ）
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
# 文字集合の切り替え（`ESC ( B`）。**3バイトなので、2バイトの規則より先に落とす**——
# 後にすると `ESC (` だけが消えて `B` が本文に残る（これも実測で踏んだ）
text = re.sub(r"\x1b[()][@-~]", "", text)
# 2バイトの並び（`ESC 7` = カーソル退避 / `ESC 8` = 復帰 など）。
# **これを落とさないと `7` `8` が本文に混ざる**——初回の実測で
# 「78No conversation found ...」と読めて、原因を探すことになった
text = re.sub(r"\x1b[ -~]", "", text)
# 単体の C0 制御文字（`SI` = 0x0F など）。**空白ではないので `strip()` では落ちず**、
# 中身の無い行が1行残る。改行とタブだけは残す
text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
for line in text.splitlines():
    if line.strip() and not line.startswith("Script "):
        print(line)
PY
}

###########################################################################
# 段1： 引き継ぎ元を作る（★1ターンぶんのクォータ）
###########################################################################
echo "==> 段1： --session-id で新規に起こします"
launch "1-fresh" \
    --setting-sources project,local \
    --session-id "${SESSION_ID}" \
    --model "${MODEL}"
answer_trust_if_any
capture "10-fresh-started"
echo "  フッタ： $(footer)"

echo "==> 段1： 1ターン送ります"
send_text 'notes.md の TODO 行を「DONE:」に書き換えてください。'
wait_idle
capture "11-fresh-turn"

if ! resolve_project_dir; then
    echo "エラー： トランスクリプトが見つかりません（${SESSION_ID}.jsonl）" >&2
    exit 1
fi
echo "プロジェクトディレクトリ： ${PROJECT_DIR}"
wait_settled
echo "--- スナップショット： 段1後 ---"
snapshot "1-fresh"

echo "==> 段1： 終了します"
send_text '/exit'
if ! wait_gone; then
    echo "警告： 段1 が自分から終わらないので畳みます（終了コードは残りません）" >&2
    tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
fi
sleep 2
wait_settled
echo "--- スナップショット： 段1が落ちきった後 ---"
snapshot "2-fresh-exited"

###########################################################################
# 段2： 同じIDへ --resume + --permission-mode（★1ターンぶんのクォータ）
###########################################################################
echo
echo "==> 段2： --resume と --permission-mode を組で渡して起こします"
launch "2-resume" \
    --setting-sources project,local \
    --resume "${SESSION_ID}" \
    --permission-mode acceptEdits \
    --model "${MODEL}"
answer_trust_if_any
capture "20-resume-started"
RESUME_FOOTER="$(footer)"
echo "  フッタ： ${RESUME_FOOTER}"
echo "${RESUME_FOOTER}" > "${OUT_DIR}/footer-resume.txt"

if ! tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
    echo "  ！ 段2 が起動しませんでした。組で渡せない可能性があります" >&2
else
    echo "==> 段2： 1ターン送ります"
    send_text 'notes.md にもう1行、「- [ ] TODO: 続きを書く」を足してください。'
    wait_idle
    capture "21-resume-turn"
    wait_settled
    echo "--- スナップショット： 段2のターン後 ---"
    snapshot "3-resumed"

    echo "==> 段2： 終了します"
    send_text '/exit'
    if ! wait_gone; then
        echo "警告： 段2 が自分から終わらないので畳みます（終了コードは残りません）" >&2
        tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
    fi
    sleep 2
    wait_settled
fi
echo "--- スナップショット： 段2が落ちきった後 ---"
snapshot "4-resume-exited"

###########################################################################
# 段3： 実体が消えたセッションIDへ --resume（クォータを使わない見込み）
###########################################################################
#
# **ここだけ tmux を使わない。** 実測すると1秒未満で落ちるので、tmux の画面を撮りに行った
# 頃にはペインごと消えており、**0バイトの記録しか残らない**（初回の実測で踏んだ）。
# `script` で PTY を張って**出力そのもの**を控えれば、落ちる速さに関係なく文言が残る。
echo
echo "==> 段3： 実在しないIDへ --resume します"
cat > "${WORK_DIR}/launch-3-missing.sh" <<EOF
#!/usr/bin/env bash
cd $(printf '%q' "${WORK_DIR}")
env -i HOME=$(printf '%q' "${HOME}") PATH=$(printf '%q' "${PATH}") TERM=xterm-256color \\
    LANG=$(printf '%q' "${LANG:-C.UTF-8}") SHELL=$(printf '%q' "${SHELL:-/bin/bash}") \\
  claude --setting-sources project,local --resume $(printf '%q' "${MISSING_ID}") --model $(printf '%q' "${MODEL}")
echo \$? > $(printf '%q' "${OUT_DIR}/exit-3-missing.txt")
EOF
chmod +x "${WORK_DIR}/launch-3-missing.sh"
# `script` 自身の終了コードは中身の成否を表さないので当てにしない。控えるのは上の1行
script -qec "${WORK_DIR}/launch-3-missing.sh" "${OUT_DIR}/raw-3-missing.txt" >/dev/null 2>&1 || true
echo "  段3の終了コード： $(cat "${OUT_DIR}/exit-3-missing.txt" 2>/dev/null || echo '（控えなし）')"

###########################################################################
# 判定
###########################################################################
echo
echo "=== 判定 ==="
python3 - "${OUT_DIR}" "${SESSION_ID}" <<'PY'
import json, pathlib, sys

out_dir, session_id = pathlib.Path(sys.argv[1]), sys.argv[2]
name = f"{session_id}.jsonl"


def load(label):
    path = out_dir / f"snap-{label}.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return {row["path"]: row for row in data["files"]}


before, after = load("2-fresh-exited"), load("4-resume-exited")
if before is None or after is None:
    print("  スナップショットが揃っていません")
    raise SystemExit(0)

b, a = before.get(name), after.get(name)
print("【測定1】同じ JSONL に追記されるか")
print(f"  段1の後 ： size={b['size']} inode={b['inode']} head={b['head_sha']} lines={b['lines']}")
if a is None:
    print("  段2の後 ： 元のファイルが消えています")
else:
    print(f"  段2の後 ： size={a['size']} inode={a['inode']} head={a['head_sha']} lines={a['lines']}")
    print(f"  inode は同じか            ： {'はい' if a['inode'] == b['inode'] else 'いいえ（作り直された）'}")
    print(f"  先頭4KiBの指紋は同じか    ： {'はい' if a['head_sha'] == b['head_sha'] else 'いいえ'}")
    print(f"  行は増えたか              ： {'はい' if a['lines'] > b['lines'] else 'いいえ'}（{b['lines']} → {a['lines']}）")

new_files = sorted(set(after) - set(before))
print(f"  別のファイルが増えたか    ： {new_files or 'いいえ'}")

old_path = out_dir / "transcript-2-fresh-exited" / name
new_path = out_dir / "transcript-4-resume-exited" / name
if old_path.exists() and new_path.exists():
    old_lines = old_path.read_text(encoding="utf-8").splitlines()
    new_lines = new_path.read_text(encoding="utf-8").splitlines()
    print(f"  既存部分はそのまま残るか  ： {'はい' if new_lines[:len(old_lines)] == old_lines else 'いいえ'}")
    ids = set()
    for line in new_lines:
        if not line.strip():
            continue
        try:
            ids.add(json.loads(line).get("sessionId"))
        except json.JSONDecodeError:
            continue
    ids.discard(None)
    print(f"  ファイル内の sessionId    ： {sorted(ids)}")
    print(f"  頼んだIDと同じか          ： {'はい' if ids == {session_id} else 'いいえ'}")

print()
print("【測定2】--permission-mode と --resume を組で渡せるか")
footer = (out_dir / "footer-resume.txt")
text = footer.read_text(encoding="utf-8").strip() if footer.exists() else ""
print(f"  段2 のフッタ              ： {text or '（読めませんでした）'}")
print(f"  acceptEdits になっているか ： {'はい' if 'edits on' in text else 'いいえ'}")

print()
print("【測定3】実体が消えたIDへ --resume したときの落ち方")
for label in ("1-fresh", "2-resume", "3-missing"):
    path = out_dir / f"exit-{label}.txt"
    value = path.read_text(encoding="utf-8").strip() if path.exists() else "（控えなし＝自分から落ちていない）"
    print(f"  段 {label:<10} の終了コード ： {value}")
PY

echo "  段3 が出した本文（生のバイト列から制御シーケンスを落としたもの）："
if [[ -s "${OUT_DIR}/raw-3-missing.txt" ]]; then
    strip_ansi "${OUT_DIR}/raw-3-missing.txt" | sed 's/^/    /'
else
    echo "    （記録なし）"
fi

echo
echo "記録は ${OUT_DIR} に残しました（画面キャプチャ・スナップショット・終了コード・トランスクリプト実物）"
