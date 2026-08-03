#!/bin/sh
# AgentDashboard を消す（Linux / macOS）。
#
# # なぜ自前で書くのか
#
# 配布に使っている cargo-dist のインストーラには、**消す機能が付いていない**。
# 入れた人が消そうとすると「どこに何が置かれたのか」を自分で調べることになる。
# しかも置かれる場所は3つに分かれていて、うち1つは**消すと一覧と履歴が丸ごと消える**。
#
# # 何を消して、何を残すか
#
# | もの | 既定 | なぜ |
# |---|---|---|
# | 実行ファイル3本 | 消す | これが本体 |
# | インストールの控え（receipt） | 消す | 入れた記録なので、消したら要らない |
# | 記録・状態（DB・読み込み位置） | **残す** | **戻せない**。消すなら `--purge` を明示する |
# | PATH の通し方（`env` と rcfile の1行） | **触らない** | 同じ仕組みで入れた**他のツールと共有**している |
#
# 最後の行が要点。`~/.local/bin/env` は cargo-dist で配られたツールが共通で使うので、
# ここで消すと**他人の道具を巻き添えにする**。残したことは最後に印字して、消したい人が
# 自分で判断できるようにする。
#
# # 対話の確認を挟まない
#
# `curl … | sh` で走るため、標準入力は端末ではない。そこで「本当に消しますか？」を
# 聞いても答えられない。**安全側を既定にして、戻せない操作は明示の指定でだけ起きる**
# 形にしてある。
#
# # 使い方
#
#   curl --proto '=https' --tlsv1.2 -LsSf \
#     https://github.com/oSUiMiNo/AgentDashboard/releases/latest/download/agentdashboard-uninstaller.sh | sh
#
# 引数を渡すときは `sh -s --` を挟む（パイプの決まり）：
#
#   curl … | sh -s -- --purge
set -eu

APP_NAME="agentdashboard"
# 配る実行ファイル。**増減させたらここも直す**（`crates/dist/tests/uninstall.rs` が見張る）
BINARIES="agentdashboard agentdashboard-agent transcript-parser"

# 既定の置き場所。`dist-workspace.toml` の `install-path` と揃える
DEFAULT_INSTALL_DIR="${HOME}/.local/bin"
RECEIPT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/${APP_NAME}"
RECEIPT="${RECEIPT_DIR}/${APP_NAME}-receipt.json"
# 記録の置き場所。**実装の既定（AgentConfig::resolved_state_dir）と揃える**
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/${APP_NAME}"

PURGE=0
DRY_RUN=0

usage() {
    cat <<'USAGE'
AgentDashboard を消します。

  --purge     記録（一覧・履歴）も消す。既定では残します
  --dry-run   消さずに、消す対象だけ並べる
  -h, --help  この案内

既定では、実行ファイルとインストールの控えだけを消します。
記録を消すと元に戻せないので、明示しない限り消しません。
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1 ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "知らない引数です: $1" >&2; usage >&2; exit 1 ;;
    esac
    shift
done

say() { printf '%s\n' "$*"; }

# 消す（`--dry-run` なら並べるだけ）。**消せなくても止まらない**——途中で止まると
# 中途半端に消えた状態が残り、もう一度走らせても直らない
remove() {
    target="$1"
    if [ ! -e "${target}" ] && [ ! -L "${target}" ]; then
        return 0
    fi
    if [ "${DRY_RUN}" -eq 1 ]; then
        say "  消す予定: ${target}"
        return 0
    fi
    if rm -rf "${target}"; then
        say "  消しました: ${target}"
    else
        say "  消せませんでした（権限を確かめてください）: ${target}" >&2
    fi
}

# 入れた場所を控えから読む。**既定と違う場所へ入れた人にも効かせる**ため。
# jq には頼らない——消すためだけに道具を入れさせない
install_dir_from_receipt() {
    [ -f "${RECEIPT}" ] || return 1
    prefix="$(sed -n 's/.*"install_prefix"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${RECEIPT}" | head -1)"
    [ -n "${prefix}" ] || return 1
    printf '%s\n' "${prefix}"
}

# 探す場所は**控えと既定の両方**。片方だけにしない——控えが読めたときに既定を
# 見なくすると、別の場所へ入れ直したあとに控えの書き込みが失敗した場合などに、
# **既定の場所の3本が生き残ったまま「見つかりませんでした」と出る**
SEARCH_DIRS="${DEFAULT_INSTALL_DIR}"
RECEIPT_DIR_FOUND="$(install_dir_from_receipt || true)"
if [ -n "${RECEIPT_DIR_FOUND}" ]; then
    say "控えに書かれた場所を見ます: ${RECEIPT_DIR_FOUND}"
    # 控えが既定を指していることもある。**同じ場所を2回走査しない**
    # （表示が二重になり、消したものを数え間違える）
    if [ "${RECEIPT_DIR_FOUND}" != "${DEFAULT_INSTALL_DIR}" ]; then
        SEARCH_DIRS="${RECEIPT_DIR_FOUND} ${SEARCH_DIRS}"
    fi
else
    say "控えが読めないので、既定の場所だけを見ます"
fi
say "見る場所: ${SEARCH_DIRS}"

say ""
say "== 実行ファイル =="
found=0
for dir in ${SEARCH_DIRS}; do
    for binary in ${BINARIES}; do
        # 控えの `install_prefix` は、そのまま置き場所を指す形と、下に `bin` を持つ形がある
        for candidate in "${dir}/${binary}" "${dir}/bin/${binary}"; do
            if [ -e "${candidate}" ] || [ -L "${candidate}" ]; then
                found=1
                remove "${candidate}"
            fi
        done
    done
done
# **全部の候補を見た後**に判定する。途中で打ち切ると、控えの場所に無かっただけで
# 「もう消えている」と言ってしまう
[ "${found}" -eq 0 ] && say "  見つかりませんでした（既に消えているようです）"

say ""
say "== インストールの控え =="
remove "${RECEIPT}"
# 空になったフォルダだけ畳む。**他のものが入っているなら残す**
if [ "${DRY_RUN}" -eq 0 ] && [ -d "${RECEIPT_DIR}" ]; then
    rmdir "${RECEIPT_DIR}" 2>/dev/null && say "  消しました: ${RECEIPT_DIR}" || true
fi

say ""
say "== 記録（一覧・履歴） =="
if [ "${PURGE}" -eq 1 ]; then
    remove "${STATE_DIR}"
else
    if [ -d "${STATE_DIR}" ]; then
        say "  残しました: ${STATE_DIR}"
        say "  （消すと一覧と履歴が戻せません。消すなら --purge を付けてください）"
    else
        say "  ありませんでした"
    fi
fi

say ""
say "== 触っていないもの =="
say "  ${DEFAULT_INSTALL_DIR}/env"
# **インストーラが実際に書き込む顔ぶれをそのまま並べる。** 「等」で濁すと、
# ここに出ていないファイル（.bash_profile など）を使っている人は、案内どおり
# 掃除しても行が残り、シェルを開くたびにエラーになる
say "  次のうち存在するものへ書かれた 1 行:"
say "    .profile / .bashrc / .bash_profile / .bash_login / .zshrc / .zshenv"
say "  同じ仕組みで入れた他のツールと共有しているため、こちらでは消しません。"
say "  他に使っているものが無ければ、その行と env を手で消してください。"

say ""
if [ "${DRY_RUN}" -eq 1 ]; then
    say "（--dry-run なので、実際には何も消していません）"
else
    say "完了しました。"
fi
