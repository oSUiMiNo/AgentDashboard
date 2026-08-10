#!/usr/bin/env bash
# パーサがどのスレッドで何回読んでいるかを実測する
# （ローカルイシュー「ダッシュボードでセッションを動かすとWSLが落ちやすい」テスト計画フェーズ6）。
#
# 何のためにあるか
# ----------------
# 嵩（`parser-rss-probe.sh`）が増えているとき、それが**通知の洪水**によるものかどうかは
# 「どのスレッドが CPU を食っているか」で分かる。見張り（notify）のスレッドが回しているなら
# 通知が過剰、本体が回しているなら読みすぎ、という切り分けになる。
#
# あわせて `read` の回数を数える。直す前の実測は**毎秒 49,262 回**で、これはパーサ自身の
# `open` が通知を生み、その通知でまた読みに行くという輪が閉じていたことの直接の証拠だった。
#
# 使い方
# ------
#   scripts/parser-cpu-probe.sh <見張らせる .jsonl のパス> [秒数]
#
# 相手は**実在するトランスクリプト**を渡す。動いているセッションのものを渡せば、
# 実運用に近い条件で測れる。
#
#   scripts/parser-cpu-probe.sh ~/.claude/projects/<プロジェクト>/<セッションID>.jsonl
#
# 直す前の版と比べたいときは、実行ファイルを名指しする。
#
#   BIN=/path/to/old/transcript-parser scripts/parser-cpu-probe.sh <パス>
#
# 何を見るか
# ----------
# - **read 回/秒**。輪が閉じていれば万単位、閉じていなければ1桁〜十数回
# - スレッド別の CPU。どれも 0% 近くに落ちていること
#
# 本物の claude は起動しない（課金なし）。
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BIN:-${REPO_ROOT}/server/target/release/transcript-parser}"

if [[ ! -x "${BIN}" ]]; then
    echo "エラー: パーサが見つかりません: ${BIN}" >&2
    echo "  先に make build するか、BIN=<パス> で名指ししてください" >&2
    exit 1
fi

TARGET="${1:?見張らせる .jsonl のパスを渡してください}"
SECS="${2:-15}"

if [[ ! -f "${TARGET}" ]]; then
    echo "エラー: トランスクリプトが見つかりません: ${TARGET}" >&2
    exit 1
fi

CARD=$(cat /proc/sys/kernel/random/uuid)
WORK=$(mktemp -d /tmp/parser-cpu-probe.XXXXXX)
trap 'rm -rf "${WORK}"' EXIT

mkfifo "${WORK}/in"
"${BIN}" < "${WORK}/in" > "${WORK}/out" 2> "${WORK}/err" &
PARSER=$!
exec 9> "${WORK}/in"
sleep 1

printf '{"cmd":"watch","card_id":"%s","path":"%s","from_offsets":{}}\n' "${CARD}" "${TARGET}" >&9

declare -A T0
for t in "/proc/${PARSER}/task/"*; do
    tid=$(basename "${t}")
    T0[${tid}]=$(awk '{print $14+$15}' "${t}/stat" 2>/dev/null)
done
IO0=$(awk -F': ' '/^syscr/{print $2}' "/proc/${PARSER}/io")

sleep "${SECS}"

IO1=$(awk -F': ' '/^syscr/{print $2}' "/proc/${PARSER}/io")
echo "  read $(( (IO1 - IO0) / SECS )) 回/秒"
for t in "/proc/${PARSER}/task/"*; do
    tid=$(basename "${t}")
    name=$(awk '{print $2}' "${t}/stat" 2>/dev/null)
    now=$(awk '{print $14+$15}' "${t}/stat" 2>/dev/null)
    delta=$(( now - ${T0[${tid}]:-0} ))
    printf "    %-20s tid=%s  CPU %s%%\n" "${name}" "${tid}" "$(( delta * 100 / (SECS * 100) ))"
done

exec 9>&-
kill "${PARSER}" 2>/dev/null
sleep 1
kill -9 "${PARSER}" 2>/dev/null
