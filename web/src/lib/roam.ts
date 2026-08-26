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
  /**
   * 進む向き（度）。線は進行方向を向く＝紐が走っていく読みになる。
   *
   * **巻き戻さない。** `atan2` は (-180, 180] しか返さないので、そのまま並べると
   * 輪を1周する途中で +170° → -170° と折り返し、**線が逆回転して見える**。
   * 前の点の角にいちばん近い等価な角を選んで、通し番号で単調に増やしてある。
   */
  r: number
  /** 輪（③転回）の上の点か。**回遊の検査を輪へ当てないため**に印を持つ */
  loop?: boolean
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
 * 線の箱は 25×7px（インクの太さは 5px で、残りが輪郭の揺れ代）。回転すると半対角は
 * √(12.5²+3.5²) ≈ 12.98px。尺取り虫の頂点で 1.35 倍になるので **17.5px** が要る。
 * 切り上げて 18。
 */
export const MARGIN = 18

/**
 * 矩形の外側、これだけ離れたところに通路を立てる。
 *
 * カード同士の隙間は 12px（`ProjectGroup` の `gap-3`）なので、**両側から立てた線が
 * ちょうど隙間の中央で重なる**——重複を畳めば「隙間の真ん中を通る道」が1本できる。
 */
const 通路 = 6

/** 経路の停留点の数。`roam.css` のキーフレームの停留点と揃える */
export const ROAM_STOPS = 32

/**
 * 輪（③転回）を何区間で描くか。
 *
 * **少ないと多角形に見え、多いと輪が大きくなる。** 等速にすると全区間が同じ長さに
 * なるので、輪の一周は `ROAM_LOOP × ROAM_STEP` に決まってしまう——**小さい輪と等速は
 * 両立しない**（設計§9-7-7 B）。8 は「円に見える最小」あたりで、ずれは
 * 半径の 7.6%（弦と弧の差）である。
 */
export const ROAM_LOOP = 8

/**
 * 1区間の道のり（px）。**ここが速さそのものである。**
 *
 * 停留点はキーフレームの % を等間隔に置いてあるので、**区間の長さを揃えれば速さが
 * 揃う**（設計§9-7-7 C）。前の版は距離を見ずに点を置いていたので、短い区間は遅く、
 * 長い区間は速く——**曲がり角で減速して見えた**。
 *
 * 31区間 × 56px ＝ 1736px を 15秒で走るので **116px/秒**。
 */
export const ROAM_STEP = 56

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
 * 飛散の着地を選ぶ。**通路の線の上へ乗せるが、線に沿った位置は自由にする。**
 *
 * 交点へ吸わせない。格子は場所によって粗く（カードの幅ぶん空く）、交点だけを候補に
 * すると**種を変えても同じ点へ着地する**——3本が重なって飛び、「風に飛ばされた」に
 * 見えなくなる。
 *
 * 飛散は上向きなので、**横の通路（y）へ乗せて x は自由**にする。そのまま横へ歩き出せば
 * 通路の上を進み、最初の角で交点に乗るので、以後はどちらへでも曲がれる。
 *
 * 縁ちょうどの通路は外す。**縁を通る円は、接している向き以外では必ずはみ出す**ので、
 * そこへ着地すると直後の輪が消える（[`輪の形`]）。
 *
 * 近すぎる着地も外す。**1区間ぶんも飛ばないと、飛ばされたように見えない。**
 */
function 着地点(
  ys: number[],
  角: { x: number; y: number },
  狙い: { x: number; y: number },
  field: RoamField,
): { x: number; y: number } {
  const x = 挟む(狙い.x, MARGIN, Math.max(MARGIN, field.width - MARGIN))
  const 縁 = [Math.round(MARGIN), Math.round(Math.max(MARGIN, field.height - MARGIN))]
  let 近い = { y: 狙い.y, 差: Number.POSITIVE_INFINITY }
  let 遠い = { y: 角.y, 隔たり: -1 }

  for (const y of ys) {
    if (縁.includes(y)) continue
    const d = Math.hypot(x - 角.x, y - 角.y)
    if (d > 遠い.隔たり) 遠い = { y, 隔たり: d }
    if (d < ROAM_STEP) continue
    const 差 = Math.abs(y - 狙い.y)
    if (差 < 近い.差) 近い = { y, 差 }
  }

  return { x, y: 近い.差 < Number.POSITIVE_INFINITY ? 近い.y : 遠い.y }
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
 * 輪の半径（詰まっていないとき）。
 *
 * 弦の長さが [`ROAM_STEP`] になる値。**輪も回遊も同じ速さで通す**ための逆算である
 * （設計§9-7-7 C）——小さい輪にすると、そのぶん点数が減って多角形に見えてしまう。
 */
const 輪の半径 = ROAM_STEP / (2 * Math.sin(Math.PI / ROAM_LOOP))

/** 2点の隔たり */
function 隔たり(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** 角を (-180, 180] へ畳む。**巻き戻しを防ぐための道具** */
function 畳む(度: number): number {
  return ((((度 + 180) % 360) + 360) % 360) - 180
}

/**
 * 入口を通り、場の内側に収まる円を作る。
 *
 * **中心は入口の法線（＝進行方向と直角）に置きたい。** そこへ置くと入口の接線が進行方向と
 * 一致し、**折れ目なく輪へ入る**。ただし入口が場の縁に近いと、その向きの円ははみ出す
 * ——縁を通る円は、接している向き以外では必ず外へ出る。
 *
 * **半径を詰めて逃がさない。** 詰める形にすると、入口が縁に乗ったときに半径が 0 まで
 * 潰れて輪が消える。**中心を動かして逃がさない**のも同じで、そちらは輪が入口へ戻らなく
 * なり、出口だけ軸に沿わない区間が生まれる。
 *
 * したがって**向きのほうを振る**。法線から左右へ 15度 ずつ広げて、**本命の半径が入る
 * 向きのうち法線にいちばん近いもの**を採る。入口が縁から遠ければ法線がそのまま通るので、
 * **普段は折れ目が出ない**。
 */
function 輪の形(
  着地: { x: number; y: number },
  進行: { x: number; y: number },
  field: RoamField,
  回り: number,
): { 中心: { x: number; y: number }; 半径: number } {
  const 左 = MARGIN
  const 右 = Math.max(MARGIN, field.width - MARGIN)
  const 上 = MARGIN
  const 下 = Math.max(MARGIN, field.height - MARGIN)

  // 中心を「着地から 角 の向きへ r」に置いたとき、はみ出さない最大の r
  const 上限 = (角: number): number => {
    const 成分 = { x: Math.cos(角), y: Math.sin(角) }
    let r = 輪の半径
    const 縛る = (座標: number, 向き: number, 手前: number, 奥: number): void => {
      // 座標 + 向き*r - r >= 手前  →  r * (1 - 向き) <= 座標 - 手前
      if (1 - 向き > 1e-9) r = Math.min(r, (座標 - 手前) / (1 - 向き))
      // 座標 + 向き*r + r <= 奥    →  r * (1 + 向き) <= 奥 - 座標
      if (1 + 向き > 1e-9) r = Math.min(r, (奥 - 座標) / (1 + 向き))
    }
    縛る(着地.x, 成分.x, 左, 右)
    縛る(着地.y, 成分.y, 上, 下)
    return Math.max(0, r)
  }

  const 円 = (角: number, 半径: number): { 中心: { x: number; y: number }; 半径: number } => ({
    中心: { x: 着地.x + Math.cos(角) * 半径, y: 着地.y + Math.sin(角) * 半径 },
    半径,
  })

  const 法線 = Math.atan2(進行.x * 回り, -進行.y * 回り)
  let 最良 = { 角: 法線, 半径: -1 }
  for (let 段 = 0; 段 <= 12; 段 += 1) {
    for (const 側 of 段 === 0 ? [1] : [1, -1]) {
      const 角 = 法線 + 側 * 段 * (Math.PI / 12)
      const r = 上限(角)
      // **法線にいちばん近い「入る向き」で打ち切る**（普段は 段 0 のまま抜ける）
      if (r >= 輪の半径) return 円(角, 輪の半径)
      if (r > 最良.半径) 最良 = { 角, 半径: r }
    }
  }
  return 円(最良.角, 最良.半径)
}

/**
 * 跳ねたカードから飛び出して、輪を描き、枠を縫って回遊する経路を1本ぶん作る。
 *
 * | 停留点 | 何 |
 * |---|---|
 * | 0 | **カードの右上の角**（設計§9-7-2 の①。左上には切り欠きがあるので使わない） |
 * | 1〜 | 風に流された先へ、[`ROAM_STEP`] ずつ（②） |
 * | 続く [`ROAM_LOOP`] 区間 | **輪**。位置が円周を1周し、向きは接線（③） |
 * | 残り | 通路を直進し、角で種由来の確率で直角に曲がる（④） |
 *
 * **すべての区間をほぼ同じ長さにする**（設計§9-7-7 C）。キーフレームの % が等間隔
 * なので、長さが揃えばそのまま等速になる。前の版は距離を見ていなかったので、
 * **曲がり角で減速して見えた**。
 *
 * **道はまっすぐ、紐はパタパタ**（設計§9-7-2）。蛇行させると④の「割と直線的」と
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
  const 流れ = (-100 + 散らす(seed, 1) * 110) * (Math.PI / 180)
  const 距離 = 60 + 散らす(seed, 2) * 90
  const 狙い = { x: 角.x + Math.cos(流れ) * 距離, y: 角.y + Math.sin(流れ) * 距離 }
  const 着地 = 着地点(ys, 角, 狙い, field)
  let ix = 近い番号(xs, 着地.x)
  let iy = 近い番号(ys, 着地.y)

  // 飛散も等間隔に割る。**ここだけ速いと「加速して減速する塊」に見える**——
  // 飛び出しの勢いは①の尺取り虫（`scale`）が担うので、移動の速さは変えない
  const 飛散 = Math.max(1, Math.min(4, Math.round(隔たり(角, 着地) / ROAM_STEP)))
  const 点: { x: number; y: number; loop?: boolean }[] = [角]
  for (let n = 1; n <= 飛散; n += 1) {
    点.push({
      x: 角.x + (着地.x - 角.x) * (n / 飛散),
      y: 角.y + (着地.y - 角.y) * (n / 飛散),
    })
  }

  // ③ 転回——**位置が円周を1周する**（設計§9-7-7 B）。向きは接線なので、1周ぶんの
  // 回転は足さなくても出る。前の版は座標を止めて `rotate` だけ回しており、
  // **プロペラに見えていた**
  const 伸び = 隔たり(角, 着地)
  const 進行 = 伸び > 0 ? { x: (着地.x - 角.x) / 伸び, y: (着地.y - 角.y) / 伸び } : { x: 1, y: 0 }
  const 回り = 散らす(seed, 5) < 0.5 ? 1 : -1
  const 輪 = 輪の形(着地, 進行, field, 回り)
  const 起点 = Math.atan2(着地.y - 輪.中心.y, 着地.x - 輪.中心.x)
  for (let k = 1; k <= ROAM_LOOP; k += 1) {
    const θ = 起点 + 回り * 2 * Math.PI * (k / ROAM_LOOP)
    点.push({
      x: 輪.中心.x + Math.cos(θ) * 輪.半径,
      y: 輪.中心.y + Math.sin(θ) * 輪.半径,
      loop: true,
    })
  }
  // **閉じる点は、入ってきた点そのものにする。** 三角関数で1周させると数値が
  // わずかにずれ、**そのずれが回遊の全部の点へ伝わる**（着地は通路の上に居るので、
  // ずれると「通路の上にある」が成り立たなくなる）
  点[点.length - 1] = { x: 着地.x, y: 着地.y, loop: true }

  // ④ 回遊——いまの軸へ何本か直進し、角で気まぐれに直角へ折れる。
  // **1本を [`ROAM_STEP`] ごとに割る**ので、長い直進でも速さが変わらない
  // **まず横へ歩き出す。** 着地は横の通路の上に居るので、縦へ動くと通路から外れる
  // （最初の角で交点に乗るので、そこから先はどちらへでも曲がれる）
  let 横 = true
  let 向き = 散らす(seed, 4) < 0.5 ? 1 : -1
  let 現在 = { x: 点[点.length - 1].x, y: 点[点.length - 1].y }
  let 残り = ROAM_STOPS - 1 - 飛散 - ROAM_LOOP
  let 回 = 0

  while (残り > 0 && 回 < ROAM_STOPS * 4) {
    回 += 1
    const 歩 = 1 + Math.floor(散らす(seed, 回 * 7) * 3)
    for (let n = 0; n < 歩 && 残り > 0; n += 1) {
      // **近すぎる通路は跨いで進む。** 隣り合う枠から立った線は数 px しか離れて
      // いないことがあり、そこで刻むと区間の長さが揃わない
      let 次 = 現在
      for (let 試し = 0; 試し < xs.length + ys.length; 試し += 1) {
        if (横) {
          if (ix + 向き < 0 || ix + 向き >= xs.length) 向き = -向き
          ix = Math.round(挟む(ix + 向き, 0, xs.length - 1))
        } else {
          if (iy + 向き < 0 || iy + 向き >= ys.length) 向き = -向き
          iy = Math.round(挟む(iy + 向き, 0, ys.length - 1))
        }
        次 = { x: xs[ix], y: ys[iy] }
        // **1区間ぶんに近い距離が空くまで跨ぐ。** 半分で妥協すると、round で1区間に
        // 畳まれた短い走りがそのまま「そこだけ遅い区間」になる
        if (隔たり(現在, 次) >= ROAM_STEP * 0.75) break
      }

      const 長 = 隔たり(現在, 次)
      const 本来 = Math.max(1, Math.round(長 / ROAM_STEP))
      const 割 = Math.min(残り, 本来)
      for (let k = 1; k <= 割; k += 1) {
        点.push({
          x: 現在.x + (次.x - 現在.x) * (k / 本来),
          y: 現在.y + (次.y - 現在.y) * (k / 本来),
        })
      }
      残り -= 割
      現在 = { x: 点[点.length - 1].x, y: 点[点.length - 1].y }
    }

    // **曲がるかどうかだけが予測できない。** 角度は常に直角で、道そのものは読める
    // ——生き物っぽさを経路の乱れではなく分岐の気まぐれで出す（設計§9-7-4）
    if (散らす(seed, 回 * 13) < 0.45) {
      横 = !横
      向き = 散らす(seed, 回 * 17) < 0.5 ? 1 : -1
    }
  }

  // 数が足りない（格子が縮退している）ときは最後の点で埋める。**ここに落ちるのは
  // 場が余白より狭いときだけ**である
  while (点.length < ROAM_STOPS) 点.push({ ...点[点.length - 1] })

  // 向きは**次の点へ進む向き**。最後の点だけは、その手前の区間の向きを引き継ぐ。
  // **巻き戻さない**——前の角にいちばん近い等価な角を選んで単調に増やす
  const 出力: RoamStop[] = []
  let 前の角 = 0
  点.slice(0, ROAM_STOPS).forEach((点い, i) => {
    const 次 = 点[i + 1]
    let 生 = 前の角
    if (次 !== undefined) {
      const dx = 次.x - 点い.x
      const dy = 次.y - 点い.y
      // 動かない区間（格子が1本しか無い）は、向きを保つ
      if (dx !== 0 || dy !== 0) 生 = (Math.atan2(dy, dx) * 180) / Math.PI
    }
    const 度 = i === 0 ? 生 : 前の角 + 畳む(生 - 前の角)
    前の角 = 度
    出力.push(
      点い.loop === true
        ? { x: 点い.x, y: 点い.y, r: 度, loop: true }
        : { x: 点い.x, y: 点い.y, r: 度 },
    )
  })
  return 出力
}

/**
 * 停留点を CSS のカスタムプロパティへ写す。
 *
 * キーフレーム側は `var(--roam-x0)` … の形で読むだけにしてある——**経路の決め方を
 * CSS へ持ち込まない**ので、値の出どころが1つに保たれる。
 *
 * **角度に細工をしない。** 前の版は停留点2以降へ 360度 を足して「その場で1回転」を
 * 作っていたが、いまは**経路そのものが回る**ので足す必要が無い（設計§9-7-7 B）。
 * 巻き戻しの防止は [`planRoute`] が済ませてある。
 */
export function routeVars(stops: RoamStop[]): Record<string, string> {
  const vars: Record<string, string> = {}
  stops.forEach((stop, i) => {
    vars[`--roam-x${i}`] = `${Math.round(stop.x)}px`
    vars[`--roam-y${i}`] = `${Math.round(stop.y)}px`
    vars[`--roam-r${i}`] = `${Math.round(stop.r)}deg`
  })
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
