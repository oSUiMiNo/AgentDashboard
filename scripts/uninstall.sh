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
# | ログ | 消す | アプリが自分のために書いた作業記録で、利用者の資産ではない |
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
# 記録の置き場所の**控え**。実行ファイルが見つからないときだけ使う。
#
# **本来は実行ファイルへ聞く**（`agentdashboard state-dir`）。こちらで組み立てると、
# 実装の既定を変えたときに黙って食い違い、**消したつもりで記録だけが残る**。
# ここは `AgentConfig::resolved_state_dir` の Unix 分岐と同じ組み立て方で、
# 部品（`.local/state` と名前）は Rust 側の定数と門で突き合わせている。
STATE_DIR_FALLBACK="${XDG_STATE_HOME:-${HOME}/.local/state}/${APP_NAME}"

# 版の保管庫と、それに付く小物（記録の置き場所の中にある）。
#
# **記録とは扱いが違う。** あちらの基準は「戻せないものは残す」だが、保管庫の中身は
# 実行ファイルなので**落とし直せる＝戻せる**。だから `--purge` を待たずに消す——
# 残すと版1つあたり数十MB が誰にも気づかれずに溜まり続ける。
#
# 名前は実装（`session_host_core::version`）と揃える。食い違いは `crates/dist/tests/uninstall.rs` が見張る
VERSIONS_DIR_NAME="versions"
VERSION_FILE_NAMES="version-current version-attempt version-state.json"

# ログの置き場所（記録の置き場所の中にある）。
#
# **記録とは扱いが違う。** ログはアプリが自分のために書いた作業記録であって、
# 利用者の資産ではない。しかも作業ディレクトリのパスとプロンプト本文が載るので、
# 消した人の機械に残り続けるのは筋が悪い。だから `--purge` を待たずに消す。
#
# 名前は実装（`session_host_core::logging::LOGS_DIR_NAME`）と揃える。
# 食い違いは `crates/dist/tests/uninstall.rs` が見張る
LOGS_DIR_NAME="logs"

# fish だけは**アプリ専用の設定ファイル**を作られる。他のツールと共有していないので、
# 入れる側が作ったものは消す側も消す（`~/.local/bin/env.fish` のほうは共有なので残す）
FISH_CONF="${XDG_CONFIG_HOME:-${HOME}/.config}/fish/conf.d/${APP_NAME}.env.fish"

# **古い置き場所。** v0.1.0 には Windows の道が無く、`HOME` も無いので記録が
# 一時領域（`%LOCALAPPDATA%\Temp\`）へ落ちていた。いまの実行ファイルはそこを
# 知らないので、聞いても返ってこない。
#
# 放っておくと**誰も消せない記録**になるので、`--purge` のときだけ掃く。名前は
# アプリ名そのものなので、巻き添えの心配は無い。
LEGACY_STATE_DIR="${TMPDIR:-/tmp}/${APP_NAME}"

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

# 記録の置き場所は**実行ファイルに聞く**。**消す前に聞く**——聞く相手を先に消したら
# 二度と分からない。
#
# こうしておくと、設定（`config.toml` の `state_dir`）や環境変数で変えた場所も対象に
# なる。自分で組み立てていたときは既定しか見ておらず、**変えた人の記録は
# 「完了しました」と言いながら残っていた**。
state_dir_from_binary() {
    for dir in ${SEARCH_DIRS}; do
        for candidate in "${dir}/${APP_NAME}" "${dir}/bin/${APP_NAME}"; do
            [ -x "${candidate}" ] || continue
            answer="$("${candidate}" state-dir 2>/dev/null | head -1)" || continue
            [ -n "${answer}" ] || continue
            printf '%s\n' "${answer}"
            return 0
        done
    done
    return 1
}

STATE_DIR="$(state_dir_from_binary || true)"
if [ -n "${STATE_DIR}" ]; then
    say "記録の置き場所（実行ファイルに聞きました）: ${STATE_DIR}"
else
    # **黙って既定を消しに行かない。** 聞けなかったことは言う——設定で置き場所を
    # 変えていた人は、ここで自分の場所を確かめられる
    STATE_DIR="${STATE_DIR_FALLBACK}"
    say "記録の置き場所（実行ファイルに聞けないので既定）: ${STATE_DIR}"
    say "  設定で置き場所を変えていた場合は、そちらは消えません"
fi

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
say "== シェルの設定（アプリ専用のものだけ） =="
# **fish だけは事情が違う。** インストーラは fish に対してだけ
# `conf.d/agentdashboard.env.fish` を**新規に作る**（他のシェルは既存のファイルへ
# 1行足すだけ）。アプリ名そのもののファイルなので「他のツールと共有だから触らない」が
# 当てはまらず、残すと**消えた env.fish を読み続けて fish が毎回エラーを出す**
if [ -e "${FISH_CONF}" ]; then
    remove "${FISH_CONF}"
else
    say "  ありませんでした（fish を使っていなければ作られません）"
fi

say ""
say "== インストールの控え =="
remove "${RECEIPT}"
# 空になったフォルダだけ畳む。**他のものが入っているなら残す**
if [ "${DRY_RUN}" -eq 0 ] && [ -d "${RECEIPT_DIR}" ]; then
    rmdir "${RECEIPT_DIR}" 2>/dev/null && say "  消しました: ${RECEIPT_DIR}" || true
fi

say ""
say "== 版の保管庫 =="
# 記録の中にあるが、中身は実行ファイルなので**落とし直せる**。`--purge` を待たない。
# ポインタと小物も一緒に消す——**残すと入れ直したときに、消えた版を指したまま
# 「指す先が見つかりません」が出続ける**
version_found=0
for name in "${VERSIONS_DIR_NAME}" ${VERSION_FILE_NAMES}; do
    target="${STATE_DIR}/${name}"
    if [ -e "${target}" ]; then
        version_found=1
        remove "${target}"
    fi
done
[ "${version_found}" -eq 0 ] && say "  ありませんでした"

say ""
say "== ログ =="
# 保管庫とは別のブロックにしてある。混ぜると「保管庫は無いがログはある」ときに
# 「ありませんでした」が嘘をつく
if [ -e "${STATE_DIR}/${LOGS_DIR_NAME}" ]; then
    remove "${STATE_DIR}/${LOGS_DIR_NAME}"
else
    say "  ありませんでした"
fi

say ""
say "== 記録（一覧・履歴） =="
if [ "${PURGE}" -eq 1 ]; then
    remove "${STATE_DIR}"
    # 古い版が一時領域へ置いた記録も掃く。**いまの実行ファイルはここを知らない**ので、
    # 聞いても返ってこない。放っておくと誰も消せない記録になる
    if [ -e "${LEGACY_STATE_DIR}" ] && [ "${LEGACY_STATE_DIR}" != "${STATE_DIR}" ]; then
        say "  古い版が一時領域へ置いた記録も見つかりました"
        remove "${LEGACY_STATE_DIR}"
    fi
else
    if [ -d "${STATE_DIR}" ]; then
        say "  残しました: ${STATE_DIR}"
        say "  （消すと一覧と履歴が戻せません。消すなら --purge を付けてください）"
    else
        say "  ありませんでした"
    fi
    if [ -d "${LEGACY_STATE_DIR}" ] && [ "${LEGACY_STATE_DIR}" != "${STATE_DIR}" ]; then
        say "  残しました（古い版が一時領域へ置いたもの）: ${LEGACY_STATE_DIR}"
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
say "  （fish の ${FISH_CONF} だけはアプリ専用なので、上で消しています）"
say "  他に使っているものが無ければ、その行と env を手で消してください。"

say ""
if [ "${DRY_RUN}" -eq 1 ]; then
    say "（--dry-run なので、実際には何も消していません）"
else
    say "完了しました。"
fi
