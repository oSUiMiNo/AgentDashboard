#!/usr/bin/env bash
# モデル切替の実挙動を実測する（ローカルイシュー「LLMモデル切り替えUI」設計§10）。
#
# 何のためにあるか
# ----------------
# ダッシュボードは「いまどのモデルか」を、注入した `statusLine` に送らせて知る。
# そして切替は `/model <値>` を端末へ送って行う。どちらも Claude Code 側の都合で
# 変わりうるので、実装の前に実物で確かめ、疑わしくなったら測り直せるようにしてある。
#
# 測るのは設計§10 の未決事項7件と、設計を書いたあとに公式ドキュメントで見つかった1件。
#   1. 注入した `statusLine` が `--settings` 経由で動き、`model.id` と `display_name` が届くか
#   2. `/model <値>` がメニューを介さず切り替わるか。会話が進んだ状態では確認を求められるか
#   3. `/model` がグローバル設定のどのキーを書き換えるか（`model` だけか、`effortLevel` も動くか）
#   4. 注入設定の `model` が、グローバル既定より優先されるか（設計§6 の主の仕掛けの根拠）
#   5. 利用者が自分の `statusLine` を持っているとき、注入したものとどちらが勝つか
#   6. `statusLine` が走る契機と `refreshInterval` の実際の間隔
#   7. モデルを変えた前後で権限モードが黙って変わらないか
#   8. `--resume` したセッションで、注入した `model` がどう扱われるか
#
# なぜ偽の HOME で動かすのか
# --------------------------
# 前提3・4 は「グローバル設定 `~/.claude/settings.json` がどう読まれ、どう書き換わるか」
# を見るものなので、**利用者の本物の設定ファイルが実測の対象そのもの**になる。
# 退避して trap で戻す手もあるが、途中で強制終了されると戻らない。
#
# そこで `HOME` ごと使い捨てのディレクトリに差し替える。認証情報だけを複製し、
# グローバル設定はこちらで合成する。**利用者の本物の設定ファイルには読み書きとも一切
# 触れない**ので、この実測で利用者の環境が壊れる経路が存在しない。
# 副作用として、利用者のグローバルフックやプラグインも動かなくなる（実測の邪魔が消える）。
#
# クォータについて
# ----------------
# `statusLine` も `/model` も**ローカル実行でトークンを使わない**（公式ドキュメント明記）。
# 実際にトークンを使うのは「会話が進んだ状態で確認が出るか」を見るための**1ターンだけ**で、
# それも haiku に固定してある。
#
# なぜ tmux 越しに動かすのか
# --------------------------
# 確認ダイアログもフッタも TUI がレンダリングした画面にしか現れない。tmux なら
# `capture-pane` でレンダリング後の画面をそのまま読める。
#
# 記録の置き場所について
# ----------------------
# 画面キャプチャと statusLine の payload には、その環境の構成情報が混ざりうる。
# 本リポジトリは公開設定なので、既定の出力先はリポジトリの外にしてある。
#
# 使い方: ./scripts/model-probe.sh [出力先ディレクトリ]
set -euo pipefail

OUT_DIR="${1:-${TMPDIR:-/tmp}/agentdashboard-model-probe}"
# 測る対象を絞る。all / statusline / global-write
# 前提3（グローバル設定が書き換わるか）だけを測り直せるようにしてある。ここは設計§6 の
# 二段構えの根拠そのものなので、疑わしくなったら単独で回せることが要る
SCENARIO="${2:-all}"
SESSION_NAME="model-probe"

# 注入する側のモデル（＝ダッシュボードが `--settings` で指定する想定の値）
INJECTED_MODEL="${MODEL_PROBE_INJECTED:-haiku}"
# 偽 HOME のグローバル既定に書く値。注入と**必ず違う値**にする（どちらが勝つか見るため）
GLOBAL_MODEL="${MODEL_PROBE_GLOBAL:-sonnet}"

for tool in claude tmux python3; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "エラー: ${tool} が PATH にありません。この実測はホストで行います。" >&2
        exit 1
    fi
done

CLAUDE_VERSION="$(claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
WORK_DIR="$(mktemp -d -t model-probe-XXXXXX)"
FAKE_HOME="${WORK_DIR}/home"
FAKE_SETTINGS="${FAKE_HOME}/.claude/settings.json"
INJECT_FILE="${WORK_DIR}/inject.json"
STATUS_FILE="${WORK_DIR}/statusline.jsonl"
RIVAL_FILE="${WORK_DIR}/rival.jsonl"
LAST_SESSION_ID=""

cleanup() {
    tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
    # CLI は終了する間際にもトランスクリプトへ書く。落ちきるまで待ってから消す
    for _ in $(seq 1 10); do
        tmux has-session -t "${SESSION_NAME}" 2>/dev/null || break
        sleep 1
    done
    sleep 2
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

echo "claude バージョン : ${CLAUDE_VERSION}"
echo "作業ディレクトリ  : ${WORK_DIR}"
echo "偽 HOME           : ${FAKE_HOME}"
echo "記録先            : ${OUT_DIR}"
echo "注入するモデル    : ${INJECTED_MODEL}"
echo "偽のグローバル既定: ${GLOBAL_MODEL}"
echo

# --- 偽 HOME を組み立てる ---------------------------------------------------------
mkdir -p "${FAKE_HOME}/.claude"
# 認証情報だけ複製する。無いと起動時にログインを求められて実測が止まる
if [[ -f "${HOME}/.claude/.credentials.json" ]]; then
    cp "${HOME}/.claude/.credentials.json" "${FAKE_HOME}/.claude/.credentials.json"
else
    echo "警告: ${HOME}/.claude/.credentials.json が見つかりません。ログインを求められる可能性があります" >&2
fi
# オンボーディングの案内を毎回出させないための状態ファイル。中身は複製せず最小限を作る
python3 - "${FAKE_HOME}/.claude.json" <<'PY'
import json, sys
# 実測の邪魔になる初回案内だけを黙らせる。利用者の ~/.claude.json は読まない
json.dump(
    {"hasCompletedOnboarding": True, "bypassPermissionsModeAccepted": True, "projects": {}},
    open(sys.argv[1], "w", encoding="utf-8"),
)
PY

# グローバル既定。**注入と違う値**を入れておき、どちらで起動するかを見る（前提4）
python3 - "${FAKE_SETTINGS}" "${GLOBAL_MODEL}" <<'PY'
import json, sys
# 実物のグローバル設定にありがちなキーを一緒に置いておく。/model がこれらを巻き込んで
# 書き換えないか（前提3）を見るための当て馬でもある
json.dump(
    {
        "permissions": {"defaultMode": "acceptEdits"},
        "model": sys.argv[2],
        "effortLevel": "high",
        "enabledPlugins": {},
    },
    open(sys.argv[1], "w", encoding="utf-8"),
    ensure_ascii=False,
    indent=2,
)
PY
cp "${FAKE_SETTINGS}" "${OUT_DIR}/global-settings-00-before.json"

# --- statusLine のコマンド ---------------------------------------------------------
# 受信サーバを立てず、stdin の JSON をそのままファイルへ落とす。ここで見たいのは
# 「何が届くか」「いつ届くか」だけなので、転送経路は要らない。
make_statusline() {
    local script="$1" sink="$2"
    cat > "${script}" <<EOF
#!/usr/bin/env bash
payload="\$(cat)"
printf '%s\t%s\n' "\$(date +%s.%N)" "\${payload}" >> "${sink}"
# ダッシュボードの model-post と同じく、標準出力にはモデルの表示名を書く
printf '%s' "\${payload}" | python3 -c 'import json,sys; d=json.load(sys.stdin); m=d.get("model") or {}; print(m.get("display_name","?"))' 2>/dev/null || true
EOF
    chmod +x "${script}"
}
make_statusline "${WORK_DIR}/statusline.sh" "${STATUS_FILE}"
make_statusline "${WORK_DIR}/rival.sh" "${RIVAL_FILE}"

# 注入する設定（ダッシュボードが `--settings` で渡すものの模造）
write_inject() {
    local model="$1"
    python3 - "${INJECT_FILE}" "${WORK_DIR}/statusline.sh" "${model}" <<'PY'
import json, sys
path, script, model = sys.argv[1], sys.argv[2], sys.argv[3]
settings = {
    "statusLine": {"type": "command", "command": script, "refreshInterval": 3},
}
if model:
    settings["model"] = model
json.dump(settings, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}

# --- tmux の世話 ------------------------------------------------------------------
capture() { tmux capture-pane -p -t "${SESSION_NAME}" > "${OUT_DIR}/screen-$1.txt" 2>/dev/null || true; }
screen()  { tmux capture-pane -p -t "${SESSION_NAME}" 2>/dev/null || true; }

# 権限モードのフッタ（前提7 でモデル切替の前後を比べる）
footer() {
    screen | grep -oE '(⏸|⏵⏵)[^│|]*(mode on|edits on|ask on|permissions on)' | tail -1 || true
}

send_text() {
    tmux send-keys -t "${SESSION_NAME}" -l "$1" 2>/dev/null || true
    sleep 1
    tmux send-keys -t "${SESSION_NAME}" Enter 2>/dev/null || true
}
send_key() { tmux send-keys -t "${SESSION_NAME}" "$1" 2>/dev/null || true; }

wait_idle() {
    local limit="${1:-24}"
    for _ in $(seq 1 "${limit}"); do
        sleep 5
        screen | grep -qi "esc to interrupt" || return 0
    done
    echo "警告: 応答待ちがタイムアウトしました" >&2
    return 0
}

# statusLine が最後に伝えてきたモデルを取り出す
last_model() {
    python3 - "${1:-${STATUS_FILE}}" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("(1件も届いていない)"); raise SystemExit
last = None
for line in path.read_text(encoding="utf-8").splitlines():
    if "\t" not in line:
        continue
    try:
        last = json.loads(line.split("\t", 1)[1])
    except json.JSONDecodeError:
        continue
if last is None:
    print("(読める payload が無い)"); raise SystemExit
model = last.get("model") or {}
print(f'{model.get("id", "?")} / {model.get("display_name", "?")}')
PY
}

# 行数を数える。`grep -c .` は空ファイルで終了コード1を返すので `|| echo 0` と
# 併用すると 0 が2つ出て、数値として読めなくなる（実際に踏んだ）
count_lines() {
    [[ -f "$1" ]] || { echo 0; return; }
    wc -l < "$1" | tr -d ' '
}

# 偽のグローバル設定の `model` を書き換える（測り直しの起点を作る）
set_global_model() {
    python3 - "${FAKE_SETTINGS}" "$1" <<'PY'
import json, sys
path, model = sys.argv[1], sys.argv[2]
settings = json.load(open(path, encoding="utf-8"))
settings["model"] = model
json.dump(settings, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}

# 偽のグローバル設定の `model` を読む
get_global_model() {
    python3 -c "import json,sys; print(json.load(open(sys.argv[1],encoding='utf-8')).get('model','(キー無し)'))" "${FAKE_SETTINGS}"
}

# セッションを1本立ち上げる。引数: <ラベル> <resume するセッションID（空なら新規）>
boot() {
    local label="$1" resume_id="${2:-}"
    local start_args
    if [[ -n "${resume_id}" ]]; then
        start_args="--resume ${resume_id}"
    else
        LAST_SESSION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
        start_args="--session-id ${LAST_SESSION_ID}"
    fi

    cat > "${WORK_DIR}/launch.sh" <<EOF
#!/usr/bin/env bash
cd "${WORK_DIR}"
exec env -i \\
  HOME="${FAKE_HOME}" \\
  PATH="${PATH}" \\
  TERM=xterm-256color \\
  LANG="${LANG:-C.UTF-8}" \\
  SHELL="${SHELL:-/bin/bash}" \\
  claude --settings "${INJECT_FILE}" ${start_args}
EOF
    chmod +x "${WORK_DIR}/launch.sh"

    tmux kill-session -t "${SESSION_NAME}" 2>/dev/null || true
    tmux new-session -d -s "${SESSION_NAME}" -x 200 -y 50 "${WORK_DIR}/launch.sh"
    sleep 10
    capture "${label}-00-boot"

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
    sleep 2
}

# グローバル設定の差分を見る（前提3）
diff_settings() {
    local label="$1"
    cp "${FAKE_SETTINGS}" "${OUT_DIR}/global-settings-${label}.json" 2>/dev/null || true
    python3 - "${OUT_DIR}/global-settings-00-before.json" "${FAKE_SETTINGS}" <<'PY'
import json, pathlib, sys
before = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
after_path = pathlib.Path(sys.argv[2])
if not after_path.exists():
    print("    グローバル設定が消えている"); raise SystemExit
after = json.loads(after_path.read_text(encoding="utf-8"))
changed = [k for k in set(before) | set(after) if before.get(k) != after.get(k)]
if not changed:
    print("    変わったキー: なし")
for key in sorted(changed):
    print(f"    {key}: {before.get(key, '(無し)')!r} -> {after.get(key, '(無し)')!r}")
PY
}

# =====================================================================================
# 前提3 だけを単独で測る。
#
# **この節を分けてあるのは、最初の実測を設計ミスで無駄にしたため。** グローバル既定と
# 同じ値へ `/model` を送っていたので、書き換えが起きても差分がゼロになり、
# 「書き換わらなかった」のか「元と同じ値を書いた」のか区別できなかった。
#
# ここでは3つを必ず別々の値にする。
#   グローバル既定 = opus / 注入 = haiku / 送る先 = sonnet
# こうすると `model` が何に変わったかで、誰が書いたのかが一意に読める。
#
# さらに「注入 model の有無」で2回測る。`--settings` で `model` を固定していると
# CLI が保存を控える、という可能性があるため（設計§6 の副の仕掛けが要るかどうかの分かれ目）。
probe_global_write() {
    local label="$1" inject_model="$2"
    local origin="opus" target="sonnet"

    echo
    echo "==> 前提3（${label}）: グローバル既定=${origin} / 注入=${inject_model:-なし} / 送る先=${target}"
    set_global_model "${origin}"
    cp "${FAKE_SETTINGS}" "${OUT_DIR}/gw-${label}-before.json"
    write_inject "${inject_model}"
    : > "${STATUS_FILE}"

    boot "GW-${label}"
    sleep 8
    echo "    起動時に名乗ったモデル: $(last_model)"
    echo "    送信前のグローバル model: $(get_global_model)"

    send_text "/model ${target}"
    sleep 8
    capture "GW-${label}-02-after-model"
    echo "    送信直後のグローバル model: $(get_global_model)"

    # 保存が終了時まで遅延している可能性があるので、抜けたあとにもう一度見る
    quit
    sleep 3
    local after
    after="$(get_global_model)"
    cp "${FAKE_SETTINGS}" "${OUT_DIR}/gw-${label}-after.json"
    echo "    終了後のグローバル model  : ${after}"

    if [[ "${after}" == "${target}" ]]; then
        echo "    → ★ /model が グローバル既定を書き換えた（設計§6 の副の仕掛けが要る）"
    elif [[ "${after}" == "${origin}" ]]; then
        echo "    → グローバル既定は汚れなかった"
    else
        echo "    → 想定外の値。手で確認すること"
    fi
    echo "    他のキーの差分:"
    python3 - "${OUT_DIR}/gw-${label}-before.json" "${OUT_DIR}/gw-${label}-after.json" <<'PY'
import json, pathlib, sys
before = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
after = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
changed = [k for k in set(before) | set(after) if before.get(k) != after.get(k) and k != "model"]
print("      なし" if not changed else "")
for key in sorted(changed):
    print(f"      {key}: {before.get(key, '(無し)')!r} -> {after.get(key, '(無し)')!r}")
PY
}

if [[ "${SCENARIO}" == "global-write" ]]; then
    probe_global_write "injected" "${INJECTED_MODEL}"
    probe_global_write "bare" ""
    echo
    echo "記録は ${OUT_DIR} に残しました"
    exit 0
fi

# =====================================================================================
echo "==> 前提1・4・6: 注入した statusLine と model の効き方"
write_inject "${INJECTED_MODEL}"
boot "S1"
sleep 12   # refreshInterval=3 が数回まわる分だけ待つ
capture "S1-02-settled"

S1_COUNT="$(count_lines "${STATUS_FILE}")"
S1_MODEL="$(last_model)"
echo "    statusLine の起動回数（約22秒間）: ${S1_COUNT}"
echo "    最後に届いたモデル              : ${S1_MODEL}"
cp "${STATUS_FILE}" "${OUT_DIR}/statusline-S1.jsonl" 2>/dev/null || true

echo
echo "==> 前提2（会話なし）・3・7: /model を送る"
FOOTER_BEFORE="$(footer)"
send_text "/model ${GLOBAL_MODEL}"
sleep 6
capture "S1-03-after-model-command"
echo "    画面の変化は ${OUT_DIR}/screen-S1-03-after-model-command.txt に記録しました"
echo "    グローバル設定の差分（前提3）:"
diff_settings "01-after-model"
FOOTER_AFTER="$(footer)"
echo "    権限モードのフッタ（前提7）: 前=[${FOOTER_BEFORE}] 後=[${FOOTER_AFTER}]"

# 安いモデルへ戻してからターンを回す
send_text "/model ${INJECTED_MODEL}"
sleep 5

echo
echo "==> 前提2（会話あり）: 1ターン回してから /model を送る（★ここだけトークンを使う）"
send_text "OK とだけ返してください。"
wait_idle
capture "S1-04-after-turn"
BEFORE_TURN_COUNT="${S1_COUNT}"
AFTER_TURN_COUNT="$(count_lines "${STATUS_FILE}")"
echo "    応答の前後で statusLine の回数: ${BEFORE_TURN_COUNT} -> ${AFTER_TURN_COUNT}"

send_text "/model ${GLOBAL_MODEL}"
sleep 6
capture "S1-05-model-after-turn"
if screen | grep -qiE "confirm|are you sure|continue\?|re-read|full history"; then
    echo "    ★ 確認を求められました。画面は screen-S1-05-model-after-turn.txt"
    send_key Enter
    sleep 4
    capture "S1-06-confirm-answered"
else
    echo "    確認は出ませんでした（そのまま切り替わった模様）"
fi
sleep 4
echo "    切替後に届いたモデル: $(last_model)"
diff_settings "02-after-second-model"
cp "${STATUS_FILE}" "${OUT_DIR}/statusline-S1-final.jsonl" 2>/dev/null || true
RESUME_TARGET="${LAST_SESSION_ID}"
quit

echo
echo "==> 前提8: resume したセッションで注入した model がどう扱われるか"
: > "${STATUS_FILE}"
write_inject "${INJECTED_MODEL}"
boot "S2-resume" "${RESUME_TARGET}"
sleep 10
capture "S2-resume-02-settled"
echo "    resume 後に届いたモデル: $(last_model)"
echo "    （直前のセッションは ${GLOBAL_MODEL} で終えている。注入は ${INJECTED_MODEL}）"
cp "${STATUS_FILE}" "${OUT_DIR}/statusline-S2-resume.jsonl" 2>/dev/null || true
quit

echo
echo "==> 前提5: 利用者が自分の statusLine を持っているとき、どちらが勝つか"
: > "${STATUS_FILE}"
: > "${RIVAL_FILE}"
# 偽 HOME のグローバル設定にも statusLine を足す
python3 - "${FAKE_SETTINGS}" "${WORK_DIR}/rival.sh" <<'PY'
import json, sys
path, script = sys.argv[1], sys.argv[2]
settings = json.load(open(path, encoding="utf-8"))
settings["statusLine"] = {"type": "command", "command": script}
json.dump(settings, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
write_inject "${INJECTED_MODEL}"
boot "S3-rival"
sleep 12
capture "S3-rival-02-settled"
INJECTED_HITS="$(count_lines "${STATUS_FILE}")"
RIVAL_HITS="$(count_lines "${RIVAL_FILE}")"
echo "    注入した statusLine の起動回数    : ${INJECTED_HITS}"
echo "    利用者の statusLine の起動回数    : ${RIVAL_HITS}"
quit

# =====================================================================================
echo
echo "=== 判定 ==="
python3 - "${OUT_DIR}" "${INJECTED_MODEL}" "${GLOBAL_MODEL}" "${INJECTED_HITS}" "${RIVAL_HITS}" <<'PY'
import json, pathlib, sys

out_dir = pathlib.Path(sys.argv[1])
injected, global_model = sys.argv[2], sys.argv[3]
injected_hits, rival_hits = int(sys.argv[4]), int(sys.argv[5])


def load(name):
    path = out_dir / name
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if "\t" not in line:
            continue
        stamp, body = line.split("\t", 1)
        try:
            rows.append((float(stamp), json.loads(body)))
        except (ValueError, json.JSONDecodeError):
            continue
    return rows


s1 = load("statusline-S1.jsonl")
print(f"  前提1 statusLine が --settings 経由で動くか : {'動いた' if s1 else '★動かなかった'}")
if s1:
    first = s1[0][1]
    keys = sorted(first)
    print(f"        届いた JSON のキー   : {keys}")
    model = first.get("model") or {}
    print(f"        model.id             : {model.get('id')}")
    print(f"        model.display_name   : {model.get('display_name')}")
    print(f"        session_id           : {'あり' if first.get('session_id') else '★無し'}")
    print(f"        transcript_path      : {'あり' if first.get('transcript_path') else '★無し'}")

    started = (s1[0][1].get("model") or {}).get("id", "?")
    verdict = "注入が勝った" if injected in started else (
        f"★グローバル既定({global_model})で始まった" if global_model in started else f"判定不能({started})")
    print(f"  前提4 注入 model がグローバル既定に勝つか  : {verdict}")

    gaps = [round(b[0] - a[0], 1) for a, b in zip(s1, s1[1:])]
    print(f"  前提6 statusLine の起動間隔(秒)            : {gaps}")

final = load("statusline-S1-final.jsonl")
if final:
    last = (final[-1][1].get("model") or {}).get("id", "?")
    print(f"  前提2 /model の結果として名乗ったモデル     : {last}")

resumed = load("statusline-S2-resume.jsonl")
if resumed:
    got = (resumed[0][1].get("model") or {}).get("id", "?")
    verdict = "注入が効いた" if injected in got else (
        "トランスクリプトのモデルを引き継いだ" if global_model in got else f"判定不能({got})")
    print(f"  前提8 resume 時の扱い                      : {verdict}（{got}）")

print(f"  前提5 注入 statusLine の起動回数           : {injected_hits}")
print(f"        利用者 statusLine の起動回数         : {rival_hits}")
if injected_hits and not rival_hits:
    print("        → 注入したものが勝つ（利用者の statusLine は動かない）")
elif rival_hits and not injected_hits:
    print("        → ★利用者のものが勝つ。設計§4 の経路が成立しない")
elif injected_hits and rival_hits:
    print("        → 両方動いた")
PY

echo
echo "  グローバル設定の最終状態:"
sed 's/^/    /' "${OUT_DIR}/global-settings-02-after-second-model.json" 2>/dev/null || echo "    （記録なし）"

echo
echo "記録は ${OUT_DIR} に残しました（画面キャプチャ・statusLine の payload・設定の差分）"
