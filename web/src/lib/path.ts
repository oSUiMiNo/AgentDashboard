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

/** 番号を付けるかどうかを決めるのに要る、枠の最小の姿。 */
export interface NamedProject {
  path: string
  created_at: number
}

/** パスの末尾の名前（区切りだけの並びでも落ちない）。 */
function basename(path: string): string {
  const names = path.split('/').filter((name) => name !== '')
  return names.length === 0 ? path : names[names.length - 1]
}

/**
 * 帯に出す PJT の名前（設計§14-5）。
 *
 * # 名前だけにする
 *
 * 以前はパスを「前半」と「末尾2階層」に割って出していたが、**帯の1行目には
 * 始末のボタンも並ぶ**ようになったので、パスの長さに幅を明け渡せなくなった。
 * **フルパスは `title` に残す**ので、確かめたいときは乗せれば読める。
 *
 * # 同じ名前が複数あるときだけ番号を付ける
 *
 * `~/a/app` と `~/b/app` はどちらも `app` になり、**一覧では見分けられない**。
 * そこで**衝突しているものにだけ**番号を付ける。
 *
 * | 状況 | 出るもの |
 * |---|---|
 * | 同じ名前が1つだけ | `app` |
 * | 同じ名前が複数 | `app (1)` ／ `app (2)` … |
 *
 * **衝突していないものには付けない**（全部に付けると読む量が増える）。逆に
 * **衝突しているものには全部に付ける**——片方だけに付けると「番号の無いほうは
 * 何番なのか」が分からなくなる。
 *
 * **順番は枠が作られた順。** 一覧の並びと同じ根拠にしてあるので、**押した瞬間に
 * 番号が入れ替わらない**。作られた時刻が同じときはパスの並び順で決める（安定させる
 * ためで、意味は無い）。
 */
export function projectDisplayName(
  path: string,
  projects: readonly NamedProject[],
): string {
  const name = basename(path)
  const 同名 = projects
    .filter((project) => basename(project.path) === name)
    .sort(
      (a, b) =>
        a.created_at - b.created_at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
  if (同名.length <= 1) {
    return name
  }
  const 番号 = 同名.findIndex((project) => project.path === path)
  // 記録に無いパス（消えた直後など）は、番号を付けずに名前だけ出す
  return 番号 < 0 ? name : `${name} (${番号 + 1})`
}
