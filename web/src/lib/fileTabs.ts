/**
 * タブに出す名前を決める（`サイドバーで開いたファイルを、タブで並べて切り替える` 要件）。
 *
 * # なぜファイル名だけでは足りないのか
 *
 * このリポジトリの文書は**同じ名前が別のフォルダに何十枚もある**——`要件.md`・`計画.md`・
 * `設計.md`・`実行レポート.md` は、イシューの数だけ存在する。タブの字をファイル名だけに
 * すると、**`要件.md` が3枚並んで、どれがどれか分からなくなる。**
 *
 * だから**衝突したものだけ**、区別が付くまで親のフォルダを足す。VSCode が同じことをして
 * いるので、利用者は説明なしに読める。
 *
 * # 衝突していないものは伸ばさない
 *
 * 全部に親を付けると、**衝突していない1枚まで長くなる**。タブ帯は横に流れるので、
 * 長い字はそれだけ他のタブを画面の外へ押し出す。**伸ばす代金は、必要な枚数だけが払う。**
 *
 * # 測る側と混ぜない
 *
 * ここは**文字列だけを見る純関数**である。`getBoundingClientRect` で実際の幅を測って
 * 詰める形にはしていない——jsdom は矩形を固定で返すので、**測る側と混ぜるとテストが
 * 何も確かめないまま緑になる**（`lib/reorder.ts` と `lib/useReorder.ts` が同じ理由で
 * 分かれている）。
 */

/** 末尾から `depth` 段ぶんを繋いだ字。段が足りなければ在るぶん全部。 */
function 末尾から(segments: string[], depth: number): string {
  return segments.slice(Math.max(0, segments.length - depth)).join('/')
}

/**
 * それぞれのパスに、**そのタブだけを指す最短の字**を割り当てる。
 *
 * 返す配列は**渡した並びと同じ長さ・同じ順**である。
 *
 * ```
 * ['/a/x/要件.md', '/a/y/要件.md', '/a/z/計画.md']
 *   → ['x/要件.md', 'y/要件.md', '計画.md']
 * ```
 *
 * **同じパスが2つ渡されたら、同じ字を返す**（そこは呼ぶ側が重複を作らない約束だが、
 * ここで例外にはしない——タブ帯が描けなくなるほうが困る）。
 */
export function tabLabels(paths: string[]): string[] {
  const segments = paths.map((path) => path.split('/').filter((s) => s !== ''))
  const depths = paths.map(() => 1)

  /*
    **衝突している組だけ、伸ばせるものを1段ずつ伸ばす。**

    伸ばせない（もう根まで来ている）ものが混ざった組は、そこで止める——止めないと
    伸ばせるものだけが伸び続け、**終わらない**。同じパスが2つ渡された場合がこれにあたる。
  */
  for (;;) {
    const 組: Map<string, number[]> = new Map()
    depths.forEach((depth, i) => {
      const label = 末尾から(segments[i] ?? [], depth)
      const 仲間 = 組.get(label)
      if (仲間 === undefined) {
        組.set(label, [i])
      } else {
        仲間.push(i)
      }
    })

    let 伸ばした = false
    for (const 仲間 of 組.values()) {
      if (仲間.length < 2) {
        continue
      }
      /*
        **同じパスどうしは伸ばさない。** 伸ばしても永久に区別が付かないので、
        字が長くなるだけで何も得られない（そして根まで来て止まる）。
      */
      if (new Set(仲間.map((i) => paths[i])).size < 2) {
        continue
      }
      // **全員が伸ばせるときだけ伸ばす。** 1人でも根まで来ていたら、その組は諦める
      if (仲間.every((i) => depths[i]! < (segments[i]?.length ?? 0))) {
        for (const i of 仲間) {
          depths[i] = depths[i]! + 1
        }
        伸ばした = true
      }
    }
    if (!伸ばした) {
      break
    }
  }

  return paths.map((path, i) => 末尾から(segments[i] ?? [], depths[i] ?? 1) || path)
}

/**
 * 選ばれているタブが見えるようにするための、帯の新しい送り位置。
 *
 * # なぜ要るのか
 *
 * タブ帯は横スクロールする。**覚えていた並びを復元した直後の送り位置は必ず 0** なので、
 * タブが8枚もあると**選ばれている1枚が画面の外に居る**——**帯に見えているどのタブとも
 * 一致しない中身が出ている**ことになり、壊れて見える。矢印キーで端まで移ったときも同じ。
 *
 * # 既に見えているなら動かさない
 *
 * 隣のタブへ移るたびに帯が動くと、**押した的が毎回ずれる**。
 *
 * # 測る側と混ぜない
 *
 * **矩形の数値だけを受け取る純関数**である。`getBoundingClientRect` をこの中で呼ぶと、
 * jsdom が固定値を返すので**何も確かめないまま緑になる**（`lib/fileSearch.ts` の
 * `scrollOffsetFor` と同じ理由）。
 *
 * @param 帯 見えている幅と、いまの送り位置
 * @param タブ 帯の中身の座標での左端と幅
 */
export function stripScrollFor(
  帯: { 幅: number; いまの位置: number },
  タブ: { 左: number; 幅: number },
): number {
  const 左端 = 帯.いまの位置
  const 右端 = 帯.いまの位置 + 帯.幅
  if (タブ.左 >= 左端 && タブ.左 + タブ.幅 <= 右端) {
    return 帯.いまの位置
  }
  // 左へはみ出していたら左端へ、右へはみ出していたら右端へ寄せる
  const 先 =
    タブ.左 < 左端 ? タブ.左 : タブ.左 + タブ.幅 - 帯.幅
  return Math.max(0, 先)
}

/**
 * タブを1枚動かした並び（`from` を抜いて `to` へ差す）。
 *
 * **範囲の外は何もしない。** 呼ぶ側が端で止める判断を持たなくて済むので、
 * 「左端でさらに左へ」を毎回書かずに済む。
 */
export function moveTab(paths: string[], from: number, to: number): string[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= paths.length ||
    to >= paths.length
  ) {
    return paths
  }
  const out = [...paths]
  const [運ぶもの] = out.splice(from, 1)
  if (運ぶもの === undefined) {
    return paths
  }
  out.splice(to, 0, 運ぶもの)
  return out
}

/**
 * 指がここに居るとき、どの位置へ落とすか。**中心がいちばん近いものを選ぶ。**
 *
 * # なぜ「またいだ矩形」ではなく「近い中心」なのか
 *
 * タブは**幅がばらばら**である（名前の長さで決まる。衝突すると親フォルダが付いて
 * さらに伸びる）。矩形の中に入ったかどうかで決めると、**細いタブの上を素通りできて
 * しまい、幅で入れ替えやすさが変わる**。中心までの距離なら、どの幅でも
 * **半分だけ重なった時点で入れ替わる**——`lib/reorder.ts` が2次元で「矩形までの距離」を
 * 使っているのと同じ考え方を、1次元へ落としたものである。
 *
 * **`reorder.ts` をそのまま流用しない**（要件で「合わない」と書いたとおり）。
 * あちらは落とし先を「行 → 矩形までの距離 → 1歩 → 封印」の4段で決めており、
 * **行の概念が要る**。1本の帯には行が無いので、段が丸ごと余る。
 *
 * @param centers 各タブの中心の x（帯の並び順）
 * @param x いま指が居る x
 */
export function dropIndexFor(centers: number[], x: number): number {
  let 当たり = -1
  let 近さ = Number.POSITIVE_INFINITY
  centers.forEach((center, i) => {
    const 差 = Math.abs(center - x)
    if (差 < 近さ) {
      近さ = 差
      当たり = i
    }
  })
  return 当たり
}
