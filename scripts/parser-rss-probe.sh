#!/usr/bin/env bash
# パーサの嵩（RSS）がセッション本数でどう増えるかを実測する
# （ローカルイシュー「ダッシュボードでセッションを動かすとWSLが落ちやすい」テスト計画フェーズ6）。
#
# 何のためにあるか
# ----------------
# `transcript-parser` の中で「見に行け」の合図が無制限に積まれると、溜まった数がそのまま
# 嵩になる。パーサ自身の `open` が inotify の通知を生み、その通知でまた読みに行く——という
# 輪が閉じると、**セッションが2本以上のときだけ**増え方が跳ねる（1本では跳ねない）。
# 直す前の実測は 2本で +336.8 MB/分・5本で +501.4 MB/分だった。
#
# 直したあとに「±0 になった」と言うには、同じ測り方で前後を比べる必要がある。そのための道具。
#
# 崖は1本と2本の間にあるので、**必ず2本以上でも測る**こと。1本だけ見て「増えない」と
# 結論すると、直っていなくても直ったことになる。
#
# 使い方
# ------
#   scripts/parser-rss-probe.sh <セッション本数> [秒数]
#
#   scripts/parser-rss-probe.sh 1        # 崖の手前（元から増えない）
#   scripts/parser-rss-probe.sh 2        # ここから増えるのが直す前の姿
#   scripts/parser-rss-probe.sh 5 60     # 本数を増やしても崩れないこと
#
# 直す前の版と比べたいときは、実行ファイルを名指しする。
#
#   BIN=/path/to/old/transcript-parser scripts/parser-rss-probe.sh 2
#
# 何を見るか
# ----------
# - **MB/分**が ±0 に張り付いていること（増え続けるなら輪が閉じている）
# - **read 回/秒**が桁で小さいこと（直す前は毎秒 49,262 回）
# - 最後の1行。SIGTERM を送ってから**何秒で終わるか**。終わらないなら止める道が壊れている
#
# 本物の claude は起動しない（課金なし）。パーサは stdin/stdout の JSON Lines で喋るので
# 単体で駆動できる。
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BIN:-${REPO_ROOT}/server/target/release/transcript-parser}"

if [[ ! -x "${BIN}" ]]; then
    echo "エラー: パーサが見つかりません: ${BIN}" >&2
    echo "  先に make build するか、BIN=<パス> で名指ししてください" >&2
    exit 1
fi

N="${1:?セッション本数を渡してください（例: 2）}"
SECS="${2:-30}"

WORK=$(mktemp -d /tmp/parser-rss-probe.XXXXXX)
mkdir -p "${WORK}/proj"
trap 'rm -rf "${WORK}"' EXIT

mkfifo "${WORK}/in"
"${BIN}" < "${WORK}/in" > "${WORK}/out" 2> "${WORK}/err" &
PARSER=$!
exec 9> "${WORK}/in"
sleep 1

# セッションを N 本ぶん見張らせる。同じ親フォルダを共有するのは実運用と同じ形
for i in $(seq 1 "${N}"); do
    F="${WORK}/proj/0000000${i}-0000-0000-0000-00000000000${i}.jsonl"
    printf '{"type":"user","uuid":"a%s","parentUuid":null,"message":{"role":"user","content":"hi"}}\n' "${i}" > "${F}"
    printf '{"cmd":"watch","card_id":"%s","path":"%s","from_offsets":{}}\n' \
        "$(cat /proc/sys/kernel/random/uuid)" "${F}" >&9
done
sleep 2

R0=$(awk '/^VmRSS/{print $2}' "/proc/${PARSER}/status")
IO0=$(awk -F': ' '/^syscr/{print $2}' "/proc/${PARSER}/io")
sleep "${SECS}"
R1=$(awk '/^VmRSS/{print $2}' "/proc/${PARSER}/status")
IO1=$(awk -F': ' '/^syscr/{print $2}' "/proc/${PARSER}/io")

printf '  セッション %s 本： RSS %.1f → %.1f MB（%+.1f MB / %s秒 ＝ %+.1f MB/分）  read %s 回/秒\n' \
    "${N}" \
    "$(echo "${R0}" | awk '{print $1/1024}')" \
    "$(echo "${R1}" | awk '{print $1/1024}')" \
    "$(echo "${R1} ${R0}" | awk '{print ($1-$2)/1024}')" \
    "${SECS}" \
    "$(echo "${R1} ${R0} ${SECS}" | awk '{print ($1-$2)/1024*60/$3}')" \
    "$(( (IO1 - IO0) / SECS ))"

# 止まるかも見る。合図が溜まっていると、止める指示がその後ろで埋もれる
exec 9>&-
S=$(date +%s)
kill "${PARSER}" 2>/dev/null
for _ in $(seq 1 10); do
    ps -p "${PARSER}" -o pid --no-headers >/dev/null 2>&1 || break
    sleep 1
done
if ps -p "${PARSER}" -o pid --no-headers >/dev/null 2>&1; then
    echo "    → SIGTERM から 10 秒たっても終わらない。SIGKILL する"
    kill -9 "${PARSER}" 2>/dev/null
else
    echo "    → $(( $(date +%s) - S )) 秒で終わった"
fi
