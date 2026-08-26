/**
 * 画面を回遊する効果線の経路（カード設計§9-7）。
 *
 * # 線は、風に飛ばされた紙片である
 *
 * 前の版は「画面内へランダムに散らした4点を巡る」だった。**決めずに作ったので、
 * 動きが何も語っていなかった**（実物を見た利用者の指摘・2026-08-26。設計§9-7-1）。
 *
 * 決めた読みはこう。跳ねたカードの角から紙片がちぎれて飛び出し（①発生）、風に
 * 流され（②飛散）、その場で1回転して向きを変え（③転回）、あとは**画面の構造
 * ——カードとグループの枠の隙間——を縫って漂う**（④回遊）。
 *
 * **回遊が構造をなぞるのが要点である。** ランダムに漂う線は「何かのゴミ」にしか
 * 見えないが、枠の隙間を縫って進む線は「そこに道がある」と読める。
 *
 * # DOM を読む関数と、純関数を分けてある
 *
 * [`measureField`] だけが DOM を読み、[`planRoute`] は数値しか受け取らない。
 * **分けないと単体テストが「何も証明しない経路」を通る**——jsdom の
 * `getBoundingClientRect` は全部 0 を返すので、測る側と決める側が同じ関数に居ると
 * 格子が縮退したまま緑になる。
 *
 * # 座標は「場」に対する位置である
 *
 * 層は一覧のスクロールする入れ物の**内側**（`data-roam-field` の中）に居るので、
 * 線は中身と一緒にスクロールする（設計§9-7-5）。したがってここが返すのは
 * ビューポート座標ではなく**場の左上を原点とする座標**である。
 *
 * # 乱数を使わない
 *
 * `Math.random()` を使うとテストが揺れるし、壊し方を当てても再現しない。
 * **種（`seed`）から決まる**形にしてあるので、同じ種なら必ず同じ経路になる。
 * 見た目のばらつきは、種が線ごとに違うことで出る。
 */

/** 停留点。`x` / `y` は場の左上を原点とする座標 */
export interface RoamStop {
  x: number
  y: number
  /** 進む向き（度）。線は進行方向を向く＝漫画のスピード線の読みになる */
  r: number
}

/** 場に対する矩形 */
export interface RoamRect {
  x: number
  y: number
  w: number
  h: number
}

/** 跳ねた瞬間に測った、場の様子 */
export interface RoamField {
  /** 場の大きさ（＝層の大きさ＝中身の全高） */
  width: number
  height: number
  /** 跳ねたカードの矩形 */
  card: RoamRect
  /** 通路を立てる材料。カードとグループの矩形 */
  rects: RoamRect[]
}

/**
 * 場の縁から、これだけ内側に留める。
 *
 * **点ではなくボックスで収める必要がある。** スクロール可能オーバーフロー域には
 * 「包含ブロックである子孫の**変形後のボーダーボックス**」が数えられる（CSS
 * Overflow 3 §3.5）ので、中心が内側でも角がはみ出せばスクロール範囲が伸びる。
 *
 * 線は 16×4px で、回転すると半対角は √(8²+2²) ≈ 8.25px。尺取り虫の頂点で 1.35 倍に
 * なるので **11.2px** が要る。切り上げて 12。
 */
export const MARGIN = 12

/**
 * 矩形の外側、これだけ離れたところに通路を立てる。
 *
 * カード同士の隙間は 12px（`ProjectGroup` の `gap-3`）なので、**両側から立てた線が
 * ちょうど隙間の中央で重なる**——重複を畳めば「隙間の真ん中を通る道」が1本できる。
 */
const 通路 = 6

/** 経路の停留点の数。`roam.css` のキーフレームの停留点と揃える */
export const ROAM_STOPS = 10

/**
 * 転回で足す角（度）。**その場で1回転**（設計§9-7-2 の③）。
 *
 * **`animation-composition: add` は使わない。** 停留点2以降の角度へこれを足せば、
 * 1本のキーフレームのまま「座標は止まったまま向きだけ1周する」区間が作れる。
 * 軸は外側のボックスの中心＝**線の中心**（設計の指定どおり）。
 */
export const ROAM_TURN = 360

/**
 * 種から 0〜1 の値を作る。
 *
 * **暗号の用途ではない。** ばらけて、同じ種なら同じ値が出ればよい。
 */
function 散らす(seed: number, 回: number): number {
  const x = Math.sin(seed * 12.9898 + 回 * 78.233) * 43758.5453
  return x - Math.floor(x)
}

function 挟む(値: number, 下: number, 上: number): number {
  if (上 < 下) {
    // 場が余白より狭い。真ん中へ寄せる以外にできることが無い
    return (下 + 上) / 2
  }
  return Math.min(上, Math.max(下, 値))
}

/** 近い順に並んだ通路のうち、`値` にいちばん近いものの番号 */
function 近い番号(線: number[], 値: number): number {
  let 番号 = 0
  let 差 = Number.POSITIVE_INFINITY
  線.forEach((座標, i) => {
    const d = Math.abs(座標 - 値)
    if (d < 差) {
      差 = d
      番号 = i
    }
  })
  return 番号
}

/**
 * 通路の格子を立てる。
 *
 * 矩形の外側 `通路` px に線を引き、**1px に丸めて重複を畳む**。カード同士の隙間は
 * 両側から立てた線が重なるので、畳んだ結果が「隙間の中央を通る道」になる。
 *
 * **1本も立たないことがある**（矩形が0個＝場に何も無い）。そのときは場の縁だけを
 * 道にする——**無いままにすると歩けず、無限ループか `NaN` が本番でだけ出る。**
 */
function 格子(field: RoamField): { xs: number[]; ys: number[] } {
  const 左 = MARGIN
  const 右 = Math.max(MARGIN, field.width - MARGIN)
  const 上 = MARGIN
  const 下 = Math.max(MARGIN, field.height - MARGIN)

  const xs = new Set<number>()
  const ys = new Set<number>()
  for (const r of field.rects) {
    xs.add(Math.round(挟む(r.x - 通路, 左, 右)))
    xs.add(Math.round(挟む(r.x + r.w + 通路, 左, 右)))
    ys.add(Math.round(挟む(r.y - 通路, 上, 下)))
    ys.add(Math.round(挟む(r.y + r.h + 通路, 上, 下)))
  }
  xs.add(Math.round(左))
  xs.add(Math.round(右))
  ys.add(Math.round(上))
  ys.add(Math.round(下))

  return {
    xs: [...xs].sort((a, b) => a - b),
    ys: [...ys].sort((a, b) => a - b),
  }
}

/**
 * 跳ねたカードから飛び出して、枠を縫って回遊する経路を1本ぶん作る。
 *
 * | 停留点 | 何 |
 * |---|---|
 * | 0 | **カードの右上の角**（設計§9-7-2 の①。左上には切り欠きがあるので使わない） |
 * | 1 | 風に流された先。種ごとに向きが違う（②）。**格子の上へ着地する**ので、④が道から始まる |
 * | 2〜 | 通路を直進し、角で種由来の確率で直角に曲がる（④） |
 *
 * **道はまっすぐ、紙はパタパタ**（設計§9-7-2）。蛇行させると④の「割と直線的」と
 * 食い違い、①〜③で作った「風に飛ばされた」の読みも消える。
 */
export function planRoute(field: RoamField, seed: number): RoamStop[] {
  const { xs, ys } = 格子(field)

  // ① 発生——カードの右上の角。**縁から出すので、飛び出しの向きが外側で揃う**
  const 角 = {
    x: 挟む(field.card.x + field.card.w, MARGIN, Math.max(MARGIN, field.width - MARGIN)),
    y: 挟む(field.card.y, MARGIN, Math.max(MARGIN, field.height - MARGIN)),
  }

  // ② 飛散——右上の四半へ、種ごとに違う向きと距離で流される。着地は格子の上
  const 角度 = (-100 + 散らす(seed, 1) * 110) * (Math.PI / 180)
  const 距離 = 60 + 散らす(seed, 2) * 90
  let ix = 近い番号(xs, 角.x + Math.cos(角度) * 距離)
  let iy = 近い番号(ys, 角.y + Math.sin(角度) * 距離)

  const 点: { x: number; y: number }[] = [角, { x: xs[ix], y: ys[iy] }]

  // ④ 回遊——いまの軸へ何本か直進し、角で気まぐれに直角へ折れる
  let 横 = 散らす(seed, 3) < 0.5
  let 向き = 散らす(seed, 4) < 0.5 ? 1 : -1

  for (let i = 2; i < ROAM_STOPS; i += 1) {
    // **1〜3本ぶん直進する。** 1本ずつ進むと停留点のたびに折れて蛇行に見える
    const 歩 = 1 + Math.floor(散らす(seed, i * 7) * 3)
    for (let n = 0; n < 歩; n += 1) {
      if (横) {
        const 次 = ix + 向き
        // 端に着いたら向きを返す。**場の外へは出ない**
        if (次 < 0 || 次 >= xs.length) 向き = -向き
        ix = 挟む(ix + 向き, 0, xs.length - 1)
      } else {
        const 次 = iy + 向き
        if (次 < 0 || 次 >= ys.length) 向き = -向き
        iy = 挟む(iy + 向き, 0, ys.length - 1)
      }
    }
    点.push({ x: xs[ix], y: ys[iy] })

    // **曲がるかどうかだけが予測できない。** 角度は常に直角で、道そのものは読める
    // ——生き物っぽさを経路の乱れではなく分岐の気まぐれで出す（設計§9-7-4）
    if (散らす(seed, i * 13) < 0.45) {
      横 = !横
      向き = 散らす(seed, i * 17) < 0.5 ? 1 : -1
    }
  }

  // 向きは**次の点へ進む向き**。最後の点だけは、その手前の区間の向きを引き継ぐ
  return 点.map((点い, i) => {
    const 次 = 点[i + 1] ?? 点い
    const 前 = 点[i - 1] ?? 点い
    const dx = i + 1 < 点.length ? 次.x - 点い.x : 点い.x - 前.x
    const dy = i + 1 < 点.length ? 次.y - 点い.y : 点い.y - 前.y
    return {
      x: 点い.x,
      y: 点い.y,
      // 同じ点に留まった（＝格子が1本しか無い）ときは、手前の向きのまま 0 度にする
      r: dx === 0 && dy === 0 ? 0 : (Math.atan2(dy, dx) * 180) / Math.PI,
    }
  })
}

/**
 * 停留点を CSS のカスタムプロパティへ写す。
 *
 * キーフレーム側は `var(--roam-x0)` … の形で読むだけにしてある——**経路の決め方を
 * CSS へ持ち込まない**ので、値の出どころが1つに保たれる。
 *
 * **転回のぶんをここで足す。** 停留点1で座標を止めたまま `--roam-turn` へ回し、
 * 以降の角度にも同じだけ足しておくと、**1本のキーフレームのまま「その場で1回転」**
 * が書ける（[`ROAM_TURN`]）。回転の軸は外側のボックス中心＝線の中心である。
 */
export function routeVars(stops: RoamStop[]): Record<string, string> {
  const vars: Record<string, string> = {}
  stops.forEach((stop, i) => {
    vars[`--roam-x${i}`] = `${Math.round(stop.x)}px`
    vars[`--roam-y${i}`] = `${Math.round(stop.y)}px`
    vars[`--roam-r${i}`] = `${Math.round(stop.r) + (i >= 2 ? ROAM_TURN : 0)}deg`
  })
  // 転回の着地点。停留点1と同じ座標のまま、向きだけ1周した先
  vars['--roam-turn'] = `${Math.round(stops[1]?.r ?? 0) + ROAM_TURN}deg`
  return vars
}

/* ───────────────── ここから下だけが DOM を読む ───────────────── */

/** 場の様子の控え。**跳ねるたびに測り直さない**（下記） */
let 控え: {
  場: Element
  幅: number
  高さ: number
  矩形: RoamRect[]
  時刻: number
} | null = null

/**
 * 控えを使い回す時間。
 *
 * **後から足すのではなく最初から入れてある**——後付けにすると「跳ねた瞬間の値」と
 * いう前提が途中で変わる。1回の跳ねで出る3本が同じ格子を共有するのは当然として、
 * 跳ねをまたいでも使い回す（枠の並びは 1秒では動かない）。
 */
const 控えの寿命 = 1_000

/** テストが状態を持ち越さないようにする。**製品コードからは呼ばない** */
export function resetField(): void {
  控え = null
}

/**
 * 跳ねた瞬間に1回だけ、場の様子を測る。
 *
 * **読み切ってから書く。** `getBoundingClientRect` が強制するのはレイアウトの1回の
 * フラッシュで、読み取りを連続させれば十数個読んでも1回で済む。間に書き込みを挟むと
 * その回数だけレイアウトが走る（layout thrashing）。
 *
 * **座標は場に対する位置**（`scrollTop` を読まない）。層が場の内側に居るので、
 * 引き算だけで済む——スクロール中に取得のタイミングがずれる事故も起きない。
 */
export function measureField(frame: Element): RoamField | null {
  const 場 = frame.closest('[data-roam-field]')
  if (場 === null) return null

  const 場の矩形 = 場.getBoundingClientRect()
  const カード = frame.getBoundingClientRect()

  const 生きている =
    控え !== null &&
    控え.場 === 場 &&
    控え.幅 === 場の矩形.width &&
    控え.高さ === 場の矩形.height &&
    performance.now() - 控え.時刻 < 控えの寿命

  if (!生きている) {
    const 矩形: RoamRect[] = []
    // **1つの `querySelectorAll` で両方を拾う。** 2回に分けても正しいが、
    // 読む回数を増やす理由が無い
    for (const el of 場.querySelectorAll(
      '[data-testid="tile-shell"],[data-testid="project-group"]',
    )) {
      const r = el.getBoundingClientRect()
      矩形.push({
        x: r.left - 場の矩形.left,
        y: r.top - 場の矩形.top,
        w: r.width,
        h: r.height,
      })
    }
    控え = {
      場,
      幅: 場の矩形.width,
      高さ: 場の矩形.height,
      矩形,
      時刻: performance.now(),
    }
  }

  return {
    width: 場の矩形.width,
    height: 場の矩形.height,
    card: {
      x: カード.left - 場の矩形.left,
      y: カード.top - 場の矩形.top,
      w: カード.width,
      h: カード.height,
    },
    // 控えは共有しているので**渡す前に写す**（受け手が並べ替えても控えが濁らない）
    rects: [...(控え?.矩形 ?? [])],
  }
}
