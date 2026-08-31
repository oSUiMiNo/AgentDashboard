/**
 * 作業ディレクトリのパスを「前半」と「末尾2階層」に割る（設計§3）。
 *
 * # なぜ割るのか
 *
 * 帯に出すパスを `truncate` で末尾から切ると、**違いが出るところがちょうど消える**。
 *
 * ```
 * /tmp/claude-1000/-home-osuim-Dev-AgentDashboard/eda20c6e-611b-49d5-81c8-3ebac2…
 * /tmp/claude-1000/-home-osuim-Dev-AgentDashboard/eda20c6e-611b-49d5-81c8-3ebac2…
 * ```
 *
 * 実体は `…/accept/proj` と `…/accept/proj2` で、**末尾だけが違う**。
 *
 * # 文字数では切らない
 *
 * 表示できる幅は画面とフォントで変わるので、**文字数で切ると環境ごとに切れ方が変わる**。
 * 代わりに DOM を2つに割り、**前半だけ**を `min-w-0 truncate` にして縮ませる。
 * 末尾は `shrink-0` で必ず残る。
 *
 * # 足したぶんは1文字も落とさない
 *
 * `head + tail` は**必ず元のパスと一致する**（末尾の区切りや連続する区切りも
 * どちらかに残る）。表示のためだけの関数なので、**割った結果が元と違う**のは
 * 「短くなった」ではなく「嘘を出した」ことになる。
 */

export interface SplitPath {
  /** 親のほう。狭くなるとここだけが「…」で切れる */
  head: string
  /** 末尾2階層。必ず残す */
  tail: string
}

/**
 * パスを前半と末尾2階層に割る。
 *
 * 階層が2つ以下のときは割らない（前半が空・末尾が全部）。
 *
 * | 入力 | head | tail |
 * |---|---|---|
 * | `/home/me/dev/app` | `/home/me` | `/dev/app` |
 * | `/dev/app` | （空） | `/dev/app` |
 * | `/app` | （空） | `/app` |
 * | `/` | （空） | `/` |
 */
export function splitPathTail(path: string): SplitPath {
  const names = path.split('/').filter((name) => name !== '')
  if (names.length <= 2) {
    return { head: '', tail: path }
  }

  // 末尾2つのうち**手前**の名前が始まる位置を、後ろから探す。
  // 同じ名前が何度も出るパス（`/a/b/a/b`）でも、後ろから探せば末尾側に当たる
  const second = names[names.length - 2]
  const index = path.lastIndexOf(`/${second}/`)
  if (index < 0) {
    // 区切りに挟まれた形で見つからないパス。**割らずに全部を末尾へ回す**
    return { head: '', tail: path }
  }
  return { head: path.slice(0, index), tail: path.slice(index) }
}
