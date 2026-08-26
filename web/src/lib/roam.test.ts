import { describe, expect, it } from 'vitest'
import {
  MARGIN,
  ROAM_FLING,
  ROAM_LOOP,
  ROAM_STEP,
  ROAM_STOPS,
  type RoamField,
  type RoamRect,
  planRoute,
  routeVars,
} from '@/lib/roam'

/**
 * 回遊の経路（`lib/roam.ts`）。
 *
 * **ここで確かめられるのは経路の計算だけ。** 実際に線が飛ぶかどうかは CSS が決めるので
 * E2E（`web/e2e/roam.spec.ts`）が見る。
 *
 * # 測る側は、ここでは呼ばない
 *
 * `measureField` は DOM を読むが、jsdom の `getBoundingClientRect` は**全部 0 を返す**
 * ので、ここで呼ぶと**縮退した格子を通って緑になる**——「何も証明しない経路」になる。
 * 純関数だけを相手にし、測った結果は手で組み立てる。
 */

/** カード3枚が2列に並んだ、ありふれた一覧。**通路が立つ形**にしてある */
const CARDS: RoamRect[] = [
  { x: 12, y: 60, w: 288, h: 120 },
  { x: 312, y: 60, w: 288, h: 120 },
  { x: 12, y: 192, w: 288, h: 120 },
]
const GROUP: RoamRect = { x: 0, y: 40, w: 900, h: 300 }

const FIELD: RoamField = {
  width: 1200,
  height: 900,
  card: CARDS[0],
  rects: [GROUP, ...CARDS],
}

/** 場の内側に収まっているか（**ボックスの角まで**含めて） */
function 内側(点: { x: number; y: number }): boolean {
  return (
    点.x >= MARGIN &&
    点.x <= FIELD.width - MARGIN &&
    点.y >= MARGIN &&
    点.y <= FIELD.height - MARGIN
  )
}

/** 区間の長さ。`i` 番目の点から次の点まで */
function 区間(経路: { x: number; y: number }[], i: number): number {
  return Math.hypot(経路[i + 1].x - 経路[i].x, 経路[i + 1].y - 経路[i].y)
}

/**
 * 回遊してよい範囲。**実装（`範囲()`）と同じ手順を、テスト側でも独立に組み立てる。**
 *
 * 実装から export して使い回すと「同じ式を2回書いただけ」になり、**間違いも一緒に
 * 写る**。ここは矩形の合併 ∩ 場の余白の内側、という定義のほうから引き直している。
 */
function 範囲(): { 左: number; 右: number; 上: number; 下: number } {
  return {
    左: Math.max(MARGIN, Math.min(...FIELD.rects.map((r) => r.x - 6))),
    右: Math.min(FIELD.width - MARGIN, Math.max(...FIELD.rects.map((r) => r.x + r.w + 6))),
    上: Math.max(MARGIN, Math.min(...FIELD.rects.map((r) => r.y - 6))),
    下: Math.min(FIELD.height - MARGIN, Math.max(...FIELD.rects.map((r) => r.y + r.h + 6))),
  }
}

/**
 * **実際に描かれる座標**。`routeVars` を通した値を読み直す。
 *
 * `planRoute` の生の値と、CSS へ渡る値は**丸めのぶん違う**。巻きのように小さい形は
 * その差で性質が変わるので、**描かれる側で見る**。
 */
function 描かれる経路(field: RoamField, seed: number): { x: number; y: number }[] {
  const vars = routeVars(planRoute(field, seed))
  return [...Array(ROAM_STOPS).keys()].map((i) => ({
    x: Number.parseFloat(vars[`--roam-x${i}`]),
    y: Number.parseFloat(vars[`--roam-y${i}`]),
  }))
}

/** 輪の点の添字。**印は実装が付けるので、較正のテストが別に要る**（下記） */
function 輪の添字(経路: { loop?: boolean }[]): number[] {
  return 経路.map((点, i) => (点.loop === true ? i : -1)).filter((i) => i >= 0)
}

describe('回遊の経路', () => {
  it('停留点は決めた数だけ', () => {
    // `roam.css` のキーフレームと揃う。ずれると、最後の点だけ使われない／
    // 存在しない変数を読む形になる
    expect(planRoute(FIELD, 1)).toHaveLength(ROAM_STOPS)
  })

  it('最初の点はカードの右上の角', () => {
    // **左上には切り欠きがある**（`tile.css` の `clip-path`）ので、そちらは使わない。
    // 右上は空いている——復旧ボタンは `revivable.kind !== 'live'` のときだけ出るが、
    // 跳ねるのは生きた権限確認待ちのカードなので同時に存在しない（設計§9-7-2）
    const [先頭] = planRoute(FIELD, 1)
    expect(先頭.x).toBe(CARDS[0].x + CARDS[0].w)
    expect(先頭.y).toBe(CARDS[0].y)
  })

  it('回遊の点は、枠から取った通路の上にある', () => {
    /*
      **これが「意味のある動き」を守っている唯一の自動検査である。**

      前の版は画面内へランダムに散らした点を巡っていて、線が何も語らなかった
      （設計§9-7-1）。枠の外側 6px に立てた線の上にしか点が来ないことを見れば、
      ランダム散らしへ戻した瞬間に落ちる。

      **「x と y の両方が格子の交点」から「どちらか一方が通路の上」へ緩めてある。**
      等速にするため1本の通路を [`ROAM_STEP`] ごとに割るようになったので、点は
      **区間の途中**にも来る——通路の上ではあるが、交点ではない（設計§9-7-7 C）。
      ランダムへ戻せば**両方とも外れる**ので、検査は依然として効く。

      **輪（③）は通路の上に無い。** 円周を描くのだから当然で、ここでは見ない。
    */
    // **範囲（カードのある場所）で挟む。** 実装と同じ手順を踏まないと、はみ出した
    // 通路の値がテスト側にだけ残って空振りする
    const 域 = 範囲()
    const 挟む = (v: number, 下: number, 上: number): number => Math.min(上, Math.max(下, v))
    const xs = new Set<number>()
    const ys = new Set<number>()
    for (const r of FIELD.rects) {
      xs.add(Math.round(挟む(r.x - 6, 域.左, 域.右)))
      xs.add(Math.round(挟む(r.x + r.w + 6, 域.左, 域.右)))
      ys.add(Math.round(挟む(r.y - 6, 域.上, 域.下)))
      ys.add(Math.round(挟む(r.y + r.h + 6, 域.上, 域.下)))
    }
    // **場の縁は道にしない**（要件3）。立てると、カードが1枚も無い空き地にも道ができる

    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路)
      for (const 点 of 経路.slice(輪[輪.length - 1])) {
        expect(xs.has(点.x) || ys.has(点.y)).toBe(true)
      }
    }
  })

  it('経路は、カードのある場所からはみ出さない', () => {
    /*
      **これが要件3「回遊してよいのはカードやグループの枠がある範囲だけ」を守っている
      検査である。**

      前の版は場の縁からも通路を立てていたので、**カードが1枚も無い空き地（一覧の下）
      まで縫って回っていた**——そこに枠は無いのに枠沿いに見える動きをしていた
      （0.1.40 を実物で見た利用者の指摘）。

      **場そのものへ戻すと落ちる。** `FIELD` はわざと縦に余らせてあり（高さ 900 に対して
      グループは 340 まで）、**空き地を通れば必ずここに掛かる**。

      巻きも飛散も含めて見る——`MARGIN` の箱は最後の砦（スクロール範囲の押し広げ防止）
      であって、範囲の代わりにはならない。
    */
    const 域 = 範囲()
    // 較正：**範囲は場より狭い**（同じなら、この検査は「場の内側」と区別が付かない）
    expect(域.下).toBeLessThan(FIELD.height - MARGIN - 100)

    for (const seed of [1, 2, 3, 17, 42, 99]) {
      for (const 点 of planRoute(FIELD, seed)) {
        expect(点.x).toBeGreaterThanOrEqual(域.左 - 0.01)
        expect(点.x).toBeLessThanOrEqual(域.右 + 0.01)
        expect(点.y).toBeGreaterThanOrEqual(域.上 - 0.01)
        expect(点.y).toBeLessThanOrEqual(域.下 + 0.01)
      }
    }
  })

  it('回遊の区間は、必ず軸に沿う', () => {
    // **ランダムなのは「曲がるかどうか」であって、角度ではない**（設計§9-7-4）。
    // 道そのものは読めるまま、分岐だけが予測できない——生き物っぽさをここで出す。
    //
    // **輪（③）には当てない。** 円周を描くのだから軸には沿わない（設計§9-7-7 B）
    for (const seed of [1, 5, 42]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路)
      for (let i = 輪[輪.length - 1]; i < 経路.length - 1; i += 1) {
        const dx = 経路[i + 1].x - 経路[i].x
        const dy = 経路[i + 1].y - 経路[i].y
        // 縦か横のどちらか一方しか動かない＝軸に沿っている
        expect(dx === 0 || dy === 0).toBe(true)
      }
    }
  })

  it('巻きは小さく、線が自分と交差する', () => {
    /*
      **これが「その場で小さく巻く」を守っている検査である**（要件1・設計§9-7-9）。

      前の版は**直径 146px の円を1周**しており、実物では「大きく回り込んでいる」ように
      見えて**紐が巻いたようには読めなかった**（0.1.40 を実物で見た利用者の指摘）。
      円は**接するだけで交差しない**ことも、参考画像（`効果線のまわり方.png`）との
      決定的な違いだった。

      いまはトロコイド——**進みながら1周する**ので、`b > a` である限り必ず1回交差する。
      **大きな円へ戻すと「小さい」が落ち、前進を 0 にすると「交差する」が落ちる。**

      **見るのは `routeVars` が出した値、つまり実際に描かれる座標である。**
      `planRoute` の生の値で見てはいけない——巻きは 57px しか広がらず弦は 6〜17px
      しかないので、**丸めの粗さで交差が「接するだけ」に潰れる**。実物で測って
      気づいた（整数へ丸めていた頃、12本のうち交差していたのは2本だけだった）。
    */
    const 交わる = (
      p1: { x: number; y: number },
      p2: { x: number; y: number },
      p3: { x: number; y: number },
      p4: { x: number; y: number },
    ): boolean => {
      const 分母 = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x)
      if (Math.abs(分母) < 1e-9) return false
      const s = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / 分母
      const t = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / 分母
      return s > 1e-9 && s < 1 - 1e-9 && t > 1e-9 && t < 1 - 1e-9
    }

    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = 描かれる経路(FIELD, seed)
      const 輪 = 輪の添字(planRoute(FIELD, seed))
      // 入口（飛散の着地）から出口まで。**交差は入口の側の区間と絡む**ので入口を含める
      const 巻き = 経路.slice(輪[0] - 1, 輪[輪.length - 1] + 1)

      // **小さい。** 前の版は入口から 146px 離れる点があった
      const 広がり = Math.max(...巻き.map((点) => Math.hypot(点.x - 巻き[0].x, 点.y - 巻き[0].y)))
      expect(広がり).toBeLessThan(ROAM_STEP * 1.5)

      // **交差する。** 円をなぞって戻る形（＝接するだけ）へ戻すと 0 になる
      let 交差 = 0
      for (let i = 0; i < 巻き.length - 1; i += 1) {
        for (let j = i + 2; j < 巻き.length - 1; j += 1) {
          if (交わる(巻き[i], 巻き[i + 1], 巻き[j], 巻き[j + 1])) 交差 += 1
        }
      }
      expect(交差).toBeGreaterThan(0)

      /*
        **巻いている間も前へ進んでいる**（要件1「進みは止まらない」）。

        交差の検査だけでは足りない——**その場で円を描いて最後だけ出口へ飛ぶ**形にすると、
        飛んだ辺が他の辺と交わって**交差の数は 1 のまま**になる（実測で踏んだ）。
        真ん中の点が「前進のちょうど半分」あたりに居ることを見れば、その形は落ちる。
      */
      const 入口 = 巻き[0]
      const 出口 = 巻き[巻き.length - 1]
      const 前 = { x: 出口.x - 入口.x, y: 出口.y - 入口.y }
      const 長 = Math.hypot(前.x, 前.y)
      const 半ば = 巻き[Math.floor(巻き.length / 2)]
      const 進み =
        ((半ば.x - 入口.x) * 前.x + (半ば.y - 入口.y) * 前.y) / (長 * 長)
      expect(進み).toBeGreaterThan(0.3)
      expect(進み).toBeLessThan(0.7)
    }
  })

  it('巻きの出口は、回遊の1区間ぶん先にある', () => {
    /*
      **巻きは回遊の1区間を置き換える**（設計§9-7-9）。入口へ戻る形（前の版）へ戻すと
      隔たりが 0 になって落ちる。

      この性質があるから、**巻きが挟まってもその先の経路は1ピクセルも変わらない**
      ——出口は回遊が置いた点そのものなので、通路の上に居る。
    */
    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路)
      const 入口 = 経路[輪[0] - 1]
      const 出口 = 経路[輪[輪.length - 1]]
      const 前進 = Math.hypot(出口.x - 入口.x, 出口.y - 入口.y)
      expect(前進).toBeGreaterThan(ROAM_STEP * 0.6)
      expect(前進).toBeLessThan(ROAM_STEP * 1.4)
      // **軸に沿って進む。** 斜めに出ると、その先の回遊が通路から浮く
      expect(Math.abs(出口.x - 入口.x) < 0.01 || Math.abs(出口.y - 入口.y) < 0.01).toBe(true)
    }
  })

  it('巻きが始まるのは、発生から1区間ぶん進んだところ', () => {
    // **利用者の指定「線がまわるのは発生から1秒後」**（2026-08-26）。等速なので時刻は
    // 道のりで決まる——1区間 56px ÷ 58.3px/秒 ＝ 0.96秒。
    // 飛散を長くすると巻きが遅れるので、**ここが時刻の番人**になる
    for (const seed of [1, 2, 3, 17, 99]) {
      const 輪 = 輪の添字(planRoute(FIELD, seed))
      expect(輪[0]).toBe(ROAM_FLING + 1)
    }
  })

  it('輪は決めた区間の数ぶんある。回遊がいちばん長い', () => {
    // **較正。** 輪の印は実装が自分で付けるので、これが無いと「全部を輪と申告して
    // 直角の検査を空振りさせる」道が開く（どの壊し方でも落ちないテストになる）
    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路)
      expect(輪).toHaveLength(ROAM_LOOP)
      // 輪は連続した並びである
      expect(輪[輪.length - 1] - 輪[0]).toBe(ROAM_LOOP - 1)
      // 回遊が過半を占める。**輪が伸びると「ずっと回っている」になる**
      expect(経路.length - 1 - 輪[輪.length - 1]).toBeGreaterThan((ROAM_STOPS - 1) / 2)
    }
  })

  it('区間の長さがほぼ等しい＝速さが変わらない', () => {
    /*
      **これが「曲がり角で減速しない」を守っている検査である**（設計§9-7-7 C）。

      前の版は距離を見ずに点を置いており、短い区間と長い区間で 3〜10倍 の開きがあった
      ——それが「角で減速する」の実体だった。時間等分へ戻すとここが落ちる。

      **巻きの区間には当てない**（設計§9-7-9）。巻きは 6〜17px の短い区間でできており、
      **キーフレームの % を弧長に比例させることで速さを揃えている**——長さで揃える
      のではない。「角で減速しない」は**回遊についての約束**である。
    */
    for (const seed of [1, 2, 3, 17, 42, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路)
      const 長さ = [...Array(経路.length - 1).keys()]
        .filter((i) => i < 輪[0] - 1 || i >= 輪[輪.length - 1])
        .map((i) => 区間(経路, i))
      expect(Math.max(...長さ) / Math.min(...長さ)).toBeLessThan(2)
      // 較正：**そもそも動いている**（全部 0 なら比は NaN で素通りしうる）
      expect(Math.min(...長さ)).toBeGreaterThan(ROAM_STEP / 3)
    }
  })

  it('場の内側に収まる', () => {
    // 外へ出すと見切れるだけでなく、**スクロールできる範囲を押し広げる**
    // （CSS Overflow 3 §3.5 は「包含ブロックである子孫の変形後のボーダーボックス」を
    // 数える）。`MARGIN` は回転と尺取り虫の拡大を織り込んだ半対角ぶん
    for (const seed of [1, 2, 3, 17, 99]) {
      for (const 点 of planRoute(FIELD, seed)) {
        expect(内側(点)).toBe(true)
      }
    }
  })

  it('同じ種なら同じ経路になる', () => {
    // **乱数を使わない。** 使うとテストが揺れるし、壊し方を当てても再現しない
    expect(planRoute(FIELD, 7)).toEqual(planRoute(FIELD, 7))
  })

  it('種が違えば経路も違う', () => {
    // 較正。同じ経路しか作れないなら、上のテストは「当たらないから通る」空振りになる
    expect(planRoute(FIELD, 7)).not.toEqual(planRoute(FIELD, 8))
  })

  it('風に流される向きは、種ごとに違う', () => {
    // ②の飛散。**3本が揃って同じ方向へ出ると「風」に見えない**（設計§9-7-2）
    // **着地は輪に入る手前の点**（飛散は等間隔に割ってあるので、2点目とは限らない）
    const 行き先 = [1, 2, 3].map((seed) => {
      const 経路 = planRoute(FIELD, seed)
      const 着地 = 経路[輪の添字(経路)[0] - 1]
      return `${着地.x},${着地.y}`
    })
    expect(new Set(行き先).size).toBeGreaterThan(1)
  })

  it('矩形が1つも無くても、歩けて場の内側に収まる', () => {
    // 縮退。**無いままにすると無限ループか `NaN` が本番でだけ出る**——場の縁だけを
    // 道にして歩く
    const 空 = { ...FIELD, rects: [] }
    const 経路 = planRoute(空, 3)
    expect(経路).toHaveLength(ROAM_STOPS)
    for (const 点 of 経路) {
      expect(Number.isFinite(点.x)).toBe(true)
      expect(Number.isFinite(点.y)).toBe(true)
      expect(内側(点)).toBe(true)
    }
  })

  it('場が余白より狭くても、点が裏返らない', () => {
    // 極端に狭い窓では左右の境が交差する。挟む先が無いので真ん中へ寄せる
    const 狭い = { width: 10, height: 10, card: CARDS[0], rects: [] }
    for (const 点 of planRoute(狭い, 3)) {
      expect(Number.isFinite(点.x)).toBe(true)
      expect(Number.isFinite(点.y)).toBe(true)
    }
  })
})

describe('停留点を CSS 変数へ写す', () => {
  it('点ごとに x / y / r の3つを出す', () => {
    const vars = routeVars(planRoute(FIELD, 2))
    // 点ごとの3つだけ。**転回の1つは消えた**（経路そのものが回るので要らない）
    expect(Object.keys(vars)).toHaveLength(ROAM_STOPS * 3)
    for (let i = 0; i < ROAM_STOPS; i += 1) {
      expect(vars[`--roam-x${i}`]).toMatch(/^-?\d+(\.\d)?px$/)
      expect(vars[`--roam-y${i}`]).toMatch(/^-?\d+(\.\d)?px$/)
      expect(vars[`--roam-r${i}`]).toMatch(/^-?\d+(\.\d)?deg$/)
    }
  })

  it('角度を巻き戻さない', () => {
    /*
      `atan2` は (-180, 180] しか返さないので、そのまま並べると**輪を1周する途中で
      +170° → -170° と折り返し、線が逆回転して見える**。前の点にいちばん近い等価な角を
      選んで、通し番号で単調に増やしてある。

      **前の版が角度へ 360度 を足していた細工は消えた**——足すのではなく、経路が回る
      （設計§9-7-7 B）。
    */
    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = planRoute(FIELD, seed)
      for (let i = 1; i < 経路.length; i += 1) {
        // 隣り合う点の向きが 180度 を超えて跳ぶことは無い。**ちょうど 180度 は出る**
        // ——端で跳ね返ると、進む向きがそのまま逆になる
        expect(Math.abs(経路[i].r - 経路[i - 1].r)).toBeLessThan(180.001)
      }
      /*
        輪を1周するあいだに、向きも1周ぶん近く回る（**プロペラへ戻すと 0 になる**）。

        **測るのは弦の向きなので、1周ぶん＝(区間の数 - 1) × 45度 になる。**
        各点が持つのは「次の点へ向かう向き」なので、入口の点（輪の1つ手前）から
        **輪の最後の弦を持つ点**（＝閉じる点の1つ手前）までを見る。
      */
      const 輪 = 輪の添字(経路)
      const 回転 = Math.abs(経路[輪[輪.length - 1] - 1].r - 経路[輪[0] - 1].r)
      expect(回転).toBeGreaterThan(270)
    }
  })
})
