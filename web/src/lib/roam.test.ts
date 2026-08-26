import { describe, expect, it } from 'vitest'
import {
  MARGIN,
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
    const xs = new Set<number>()
    const ys = new Set<number>()
    for (const r of FIELD.rects) {
      xs.add(Math.round(r.x - 6))
      xs.add(Math.round(r.x + r.w + 6))
      ys.add(Math.round(r.y - 6))
      ys.add(Math.round(r.y + r.h + 6))
    }
    // 場の縁も道になる
    xs.add(MARGIN)
    xs.add(FIELD.width - MARGIN)
    ys.add(MARGIN)
    ys.add(FIELD.height - MARGIN)

    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路)
      for (const 点 of 経路.slice(輪[輪.length - 1])) {
        expect(xs.has(点.x) || ys.has(点.y)).toBe(true)
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

  it('輪の点は、ある中心から等しい隔たりにある', () => {
    /*
      ③の転回。**位置が円周を1周する**（設計§9-7-7 B）。

      前の版は座標を止めて `rotate` だけ 360度 回しており、**プロペラに見えていた**
      （0.1.39 を実物で見た利用者の指摘）。その形へ戻すと輪の点が全部同じ座標になり、
      **半径 0 に潰れて**ここが落ちる。
    */
    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路).map((i) => 経路[i])
      const 中心 = 輪.reduce(
        (和, 点) => ({ x: 和.x + 点.x / 輪.length, y: 和.y + 点.y / 輪.length }),
        { x: 0, y: 0 },
      )
      const 隔たり = 輪.map((点) => Math.hypot(点.x - 中心.x, 点.y - 中心.y))
      // 円周上の点の重心は中心なので、どれも同じ距離になる
      expect(Math.min(...隔たり)).toBeGreaterThan(ROAM_STEP / 2)
      expect(Math.max(...隔たり) - Math.min(...隔たり)).toBeLessThan(0.5)
    }
  })

  it('輪は、入ってきた点へ戻る', () => {
    // **半径を詰めるときに中心を動かすと、ここが落ちる。** 出口が入口とずれると、
    // 回遊の1本目だけ軸に沿わない区間が生まれる（設計§9-7-7 B）
    for (const seed of [1, 2, 3, 17, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 輪 = 輪の添字(経路)
      const 入口 = 経路[輪[0] - 1]
      const 出口 = 経路[輪[輪.length - 1]]
      expect(Math.hypot(出口.x - 入口.x, 出口.y - 入口.y)).toBeLessThan(0.5)
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

      キーフレームの % は等間隔なので、**区間の長さが揃えば速さも揃う**。前の版は
      距離を見ずに点を置いており、短い区間と長い区間で 3〜10倍 の開きがあった
      ——それが「角で減速する」の実体だった。時間等分へ戻すとここが落ちる。
    */
    for (const seed of [1, 2, 3, 17, 42, 99]) {
      const 経路 = planRoute(FIELD, seed)
      const 長さ = [...Array(経路.length - 1).keys()].map((i) => 区間(経路, i))
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
      expect(vars[`--roam-x${i}`]).toMatch(/^-?\d+px$/)
      expect(vars[`--roam-y${i}`]).toMatch(/^-?\d+px$/)
      expect(vars[`--roam-r${i}`]).toMatch(/^-?\d+deg$/)
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
