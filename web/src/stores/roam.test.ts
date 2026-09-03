import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RoamField, planRoute } from '@/lib/roam'
import {
  ROAM_DELAY_MAX_MS,
  ROAM_DELAY_MIN_MS,
  ROAM_LIFE_MS,
  ROAM_EXIT_MS,
  ROAM_LINES,
  ROAM_MAX,
  ROAM_SKIP,
  emitRoam,
  replanRoam,
  resetRoam,
  roamDefaultDice,
  scheduleRoam,
  setRoamDice,
  useRoamStore,
} from '@/stores/roam'
import { clearReorderingStore, lowerReordering, raiseReordering } from './reordering'

/**
 * 回遊の在庫（`stores/roam.ts`）。
 *
 * **ここが守るのは「仕事を作らない門」のほう。** 見た目の打ち消し（CSS）は
 * `web/src/roam.test.ts` が別に見ている。片方だけ壊れても気づけるように分けてある。
 */

/**
 * 跳ねた瞬間に測った場の様子。**手で組み立てる**——jsdom の
 * `getBoundingClientRect` は全部 0 を返すので、`measureField` を通すと縮退する
 */
const FIELD: RoamField = {
  width: 1200,
  height: 900,
  card: { x: 12, y: 60, w: 288, h: 120 },
  rects: [
    { x: 0, y: 40, w: 900, h: 300 },
    { x: 12, y: 60, w: 288, h: 120 },
    { x: 312, y: 60, w: 288, h: 120 },
  ],
}
const 種 = {
  field: FIELD,
  accent: '#f5a623',
  ink: '75%',
  quiet: 'lively' as const,
}

function 本数(): number {
  return useRoamStore.getState().lines.length
}

beforeEach(() => {
  resetRoam()
  clearReorderingStore()
  // **`toFake` を絞る。** 既定の偽装は `requestAnimationFrame` まで差し替えるので、
  // rAF で束ねている他のストアが黙って止まる（フェーズ4 で踏んだ）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
  resetRoam()
})

describe('飛ばす門', () => {
  it('賑やかなら飛ぶ', () => {
    emitRoam(種)
    expect(本数()).toBeGreaterThan(0)
  })

  it('「控えめ」では1本も飛ばない', () => {
    // **カードは跳ね続けるが、画面を横切る線だけが止まる**（利用者の指定）
    emitRoam({ ...種, quiet: 'calm' })
    expect(本数()).toBe(0)
  })

  it('「静止」では1本も飛ばない', () => {
    emitRoam({ ...種, quiet: 'still' })
    expect(本数()).toBe(0)
  })

  it('OS が「動きを減らす」と言っていれば飛ばない', () => {
    const 元 = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({ matches: query.includes('reduce') })) as typeof window.matchMedia
    try {
      emitRoam(種)
      expect(本数()).toBe(0)
    } finally {
      window.matchMedia = 元
    }
  })
})

describe('量を抑える', () => {
  it('1回の跳ねで飛ぶのは3本', () => {
    // **3本に固定した**（利用者の指定・2026-08-26）。振り付けが「手書きの3本線が
    // 放射状に出てくる」と決まったので、**本数が揺れると①の読みが崩れる**
    emitRoam(種)
    expect(本数()).toBe(ROAM_LINES)
  })

  it('生きている線は上限を超えない。退場中を足しても、はみ出しは1回の放出ぶんまで', () => {
    for (let i = 0; i < 20; i += 1) {
      emitRoam(種)
    }
    const 全部 = useRoamStore.getState().lines
    const 生き = 全部.filter((line) => line.exiting !== true)
    /*
      **上限に達していること**を先に見る（2026-08-28）。これが無いと、`emitRoam` が
      壊れて1本も積まれなくても `0 <= 32` で緑になる。

      **全体は上限を超えてよい**（フェーズ18）——捨てられる線も退場（1.13秒）を
      踏むので、そのあいだ画面に残る。ここは偽タイマで時間が止まっているから
      退場中が積もって見えるだけで、**時間が進めば全部消えて上限へ戻る**。
      それを下で確かめる（残ると DOM が漏れる）。
    */
    expect(生き.length).toBe(ROAM_MAX)
    expect(全部.length - 生き.length).toBe(全部.filter((line) => line.exiting === true).length)
    vi.advanceTimersByTime(ROAM_EXIT_MS + 1)
    expect(本数()).toBe(ROAM_MAX)
    expect(useRoamStore.getState().lines.some((line) => line.exiting === true)).toBe(false)
  })

  it('満杯のときは、いちばん古い線から退場へ回し、演出が終わってから消える', () => {
    /*
      **新しいほうを捨てない**（捨てると「このカードだけ線が出ない」と読めてしまう）。

      **即座に消しもしない**（フェーズ18・要件15-4）。前の版は満杯の線を
      アニメーションを待たずに消していたので、**捨てられる線は退場の演出に一度も
      出会えなかった**——「消える際もコミカルな演出が無い」の一因である。
    */
    while (本数() < ROAM_MAX) {
      emitRoam(種)
    }
    const 最古 = useRoamStore.getState().lines[0].id
    emitRoam(種)
    // まだ居る。**ただし退場中の印が付いている**（層はこれを見て退場を今すぐ踏ませる）
    const いま = useRoamStore.getState().lines
    const 捨てられた = いま.find((line) => line.id === 最古)
    expect(捨てられた).toBeDefined()
    expect(捨てられた?.exiting).toBe(true)
    // 退場（1.13秒）が終わったら、消える
    vi.advanceTimersByTime(ROAM_EXIT_MS + 1)
    expect(useRoamStore.getState().lines.map((line) => line.id)).not.toContain(最古)
  })
})

describe('跳ねから切り離して撃つ', () => {
  /*
    **0.1.43 を実物で見た利用者の指摘「効果線がカードの揺れと連動している」への番人**
    （要件14-1・14-2・設計§20-2-1）。

    合図は跳ねの折り返しのままだが、**籤で半分見送り、残りも 1.2〜3.6秒 遅らせて**撃つ。
    ここが守るのは3つ——**見送ること**、**遅れが固定でないこと**、そして
    **止まっているときタイマを1本も積まないこと**である。

    **確率そのものは検査しない。** 揺らいで落ちる。**籤を両端へ固定して見る。**
  */
  const 測る = () => 種

  it('籤が「出す」側なら、遅れてから出る', () => {
    setRoamDice(() => 0.99)
    scheduleRoam('lively', 測る)
    // **撃つのは後。** ここで出ていたら、遅らせていない
    expect(本数()).toBe(0)
    vi.advanceTimersByTime(ROAM_DELAY_MAX_MS + 1)
    expect(本数()).toBe(ROAM_LINES)
  })

  it('籤が「見送る」側なら、いくら待っても出ない', () => {
    setRoamDice(() => 0)
    scheduleRoam('lively', 測る)
    vi.advanceTimersByTime(ROAM_DELAY_MAX_MS * 10)
    expect(本数()).toBe(0)
  })

  it('遅れは下限と上限のあいだに入る', () => {
    setRoamDice(() => 0.99)
    scheduleRoam('lively', 測る)
    // 下限の直前では、まだ出ていない
    vi.advanceTimersByTime(ROAM_DELAY_MIN_MS - 1)
    expect(本数()).toBe(0)
    vi.advanceTimersByTime(ROAM_DELAY_MAX_MS)
    expect(本数()).toBe(ROAM_LINES)
  })

  it('遅れが固定値でない＝同じカードの連続する2回で違う', () => {
    // **`散らす()` を使っていたら、同じ種で毎回同じ値になる**（要件14-2）
    const 出た: number[] = []
    let 経過 = 0
    const 進める = () => {
      for (let i = 0; i < 60; i += 1) {
        vi.advanceTimersByTime(100)
        経過 += 100
        if (本数() > 0) return 経過
      }
      return -1
    }
    for (const r of [0.9, 0.99, 0.5]) {
      resetRoam()
      経過 = 0
      // 1つ目の籤で見送りを抜け、2つ目で遅れが決まる
      let 回 = 0
      setRoamDice(() => {
        回 += 1
        return 回 === 1 ? 0.99 : r
      })
      scheduleRoam('lively', 測る)
      出た.push(進める())
    }
    expect(new Set(出た).size).toBeGreaterThan(1)
  })

  it('「控えめ」「静止」では、タイマを1本も積まない', () => {
    /*
      **門を「撃つ直前」へ動かすと、ここが落ちる。** 設計§9-7 が門に与えた役割は
      「**仕事を作らない**」ことである——線が出ないことだけを見ると、
      **タイマが回っていても緑になる**（テスト計画の壊し方の表）。
    */
    setRoamDice(() => 0.99)
    for (const quiet of ['calm', 'still'] as const) {
      resetRoam()
      setRoamDice(() => 0.99)
      scheduleRoam(quiet, 測る)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(ROAM_DELAY_MAX_MS * 2)
      expect(本数()).toBe(0)
    }
  })

  it('OS が「動きを減らす」と言っていても、タイマを1本も積まない', () => {
    const 元 = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    try {
      setRoamDice(() => 0.99)
      scheduleRoam('lively', 測る)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      window.matchMedia = 元
    }
  })

  it('見送る確率は、跳ね2回につき1回くらいになる値である', () => {
    // **1/3 では平均 7.2秒にしかならない**（`1/(1-1/3) = 1.5`）。
    // 跳ねの 4.8秒 × 1/(1-p) が 9.6秒 になること
    expect(4.8 / (1 - ROAM_SKIP)).toBeCloseTo(9.6, 5)
  })

  it('籤は毎回ちがう値を返す＝`散らす()` 由来ではない', () => {
    /*
      **`lib/roam.ts` の `散らす()` は種から決まる再現可能な値である**（経路を組み立てる
      ためのもの）。撃つ／撃たないと遅れをあれで引くと、**同じカードの連続する跳ねが
      毎回まったく同じ挙動になる**——「揺れと連動している」という元の指摘へ戻る。

      **既定の籤を直接見る。** `scheduleRoam` を通して見ようとすると、`resetRoam` が
      既定を戻してしまうので**壊しても落ちない**（2026-08-28 に壊し方を当てて分かった）。

      **確率そのものは検査しない。** 見るのは「1点に固まっていないこと」だけである。
    */
    const 出た = new Set(Array.from({ length: 40 }, () => roamDefaultDice()))
    expect(出た.size).toBeGreaterThan(1)
    for (const 値 of 出た) {
      expect(値).toBeGreaterThanOrEqual(0)
      expect(値).toBeLessThan(1)
    }
  })

  it('場が無ければ、遅れたあとでも出さない', () => {
    setRoamDice(() => 0.99)
    scheduleRoam('lively', () => null)
    vi.advanceTimersByTime(ROAM_DELAY_MAX_MS + 1)
    expect(本数()).toBe(0)
  })
})

describe('並べ替え中は撃たない', () => {
  /*
    **並べ替えの最中と滑り終わるまでは、誰も撃たない**（並べ替え設計§15-1）。
    掴んでいる本人は `still` になるが、承認待ちの他のカードは運搬中も跳ね続けて
    ここへ来る——だから門は `data-motion` ではなくストアで要る。
  */
  const 測る = () => 種

  it('印が立っていれば、タイマを1本も積まない', () => {
    // **積む前の門**（設計§9-7）。線が出ないことだけを見るとタイマが回っていても緑になる
    setRoamDice(() => 0.99)
    const 主 = {}
    raiseReordering(主)
    scheduleRoam('lively', 測る)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(ROAM_DELAY_MAX_MS * 2)
    expect(本数()).toBe(0)
  })

  it('積んだあとに印が立ったら、その回は撃たない', () => {
    // 掴む前に積まれたタイマ（遅れは 1.2〜3.6秒）が、掴んでいる最中に発火する
    setRoamDice(() => 0.99)
    scheduleRoam('lively', 測る)
    expect(vi.getTimerCount()).toBe(1)
    const 主 = {}
    raiseReordering(主)
    vi.advanceTimersByTime(ROAM_DELAY_MAX_MS + 1)
    expect(本数(), '並べ替え中に撃った').toBe(0)
    // 降りても撃ち直さない。**見送った回は見送りのまま**
    lowerReordering(主)
    vi.advanceTimersByTime(ROAM_DELAY_MAX_MS + 1)
    expect(本数()).toBe(0)
  })
})

describe('1回の放出で出た3本は、互いに違う向きへ開く', () => {
  /*
    **0.1.43 を実物で見た利用者の指摘「放出時点から2本重なって出てくる」への番人**
    （要件14-3・設計§20-4-1）。

    以前は**1本ずつ独立に籤を引いており、3本は互いを知らなかった**ので、候補が
    少ない場面で2本が同じ点へ着いた。いまは**候補を角度順に並べ、その中で順位を
    割り振る**（`planRoute` の `番` と `組`）。

    **角度そのものは決め打ちにしない。** 候補は通路の上の点だけで、角度で決めると
    通路から外れる——着いた通路の向きが回遊の初手を決めているため。
  */
  it('着地点が3本とも違う', () => {
    emitRoam(種)
    const lines = useRoamStore.getState().lines
    expect(lines).toHaveLength(ROAM_LINES)
    const 着地 = new Set(lines.map((l) => `${l.stops[1].x},${l.stops[1].y}`))
    expect(着地.size).toBe(ROAM_LINES)
  })

  it('候補が枯れる場でも、経路は3本とも作られる', () => {
    /*
      **カードが1枚だけの場を当てる。** 飛散は1区間（56px）しか飛ばないので、そこに
      届く通路は「そのカード自身の縁」しか無い——**候補が0〜2本になる**（`lib/roam.ts`
      の実測）。**そこでの重なりは受け入れる**（扇を 270° へ広げた緩和が受け持つ）が、
      **経路そのものが壊れないこと**は見る。
    */
    const 狭い: RoamField = {
      width: 320,
      height: 200,
      card: { x: 12, y: 12, w: 288, h: 120 },
      rects: [{ x: 12, y: 12, w: 288, h: 120 }],
    }
    emitRoam({ ...種, field: 狭い })
    const lines = useRoamStore.getState().lines
    expect(lines).toHaveLength(ROAM_LINES)
    // **ここでも重ならない。** 候補が足りなければ扇へ逃がすので、3本とも別の点へ着く
    expect(new Set(lines.map((l) => `${l.stops[1].x},${l.stops[1].y}`)).size).toBe(ROAM_LINES)
    for (const line of lines) {
      expect(line.stops.length).toBeGreaterThan(1)
      for (const 点 of line.stops) {
        expect(Number.isFinite(点.x)).toBe(true)
        expect(Number.isFinite(点.y)).toBe(true)
      }
    }
  })
})

describe('上限と寿命が噛み合っている', () => {
  it('1枚が待っているあいだ、線は寿命どおり生きる', () => {
    /*
      **上限が小さいと、書いた寿命どおりに生きない**（要件4）。上限が小さいと
      **古いものから捨てられて、実際の寿命は上限で決まる**——前の版は 10本上限で、
      50秒と書いても 16秒しか生きなかった。

      **見るのは跳ねの周期ではなく、発火の周期である**（2026-08-28）。跳ねは 4.8秒に
      1回のままだが、`ROAM_SKIP` で半分見送るので**撃つのは平均 9.6秒に1回**になった。
      **跳ねの周期のまま置くと、実態より多く見積もって落ちる**（90 ÷ 4.8 × 3 ＝ 54）。

      **上限を下げるか、寿命を伸ばすか、見送る確率を下げると、ここが落ちる。**
    */
    const 跳ねの周期 = 4.8
    // 見送る確率 p のとき、撃つまでの平均試行回数は 1/(1-p)
    const 発火の周期 = 跳ねの周期 / (1 - ROAM_SKIP)
    const 平均本数 = (ROAM_LIFE_MS / 1000 / 発火の周期) * ROAM_LINES

    /*
      **平均に届くだけでは足りない**（2026-08-28）。**乱数で撃つ以上、画面の本数は
      平均の前後に揺れる**ので、上限を平均ぎりぎりに切ると**揺れの山で毎回押し出され、
      寿命が実現しない**。

      **揺れは「1回の放出」単位で起きる**（撃つときは必ず `ROAM_LINES` 本まとめて出る）
      ので、**最低でも1回ぶんの余裕**が要る。29 まで切り詰めるとここが落ちる。
    */
    expect(ROAM_MAX).toBeGreaterThanOrEqual(平均本数 + ROAM_LINES)
  })
})

describe('寿命', () => {
  it('しばらく飛んでから消える', () => {
    emitRoam(種)
    expect(本数()).toBeGreaterThan(0)
    vi.advanceTimersByTime(ROAM_LIFE_MS - 1)
    expect(本数()).toBeGreaterThan(0)
    vi.advanceTimersByTime(2)
    expect(本数()).toBe(0)
  })

  it('捨てた線のタイマは解除される', () => {
    // 解除し忘れると、**捨てたあとにもう一度畳みに来る**。いまは番号で引くので
    // 実害が出にくいが、番号が一巡すれば別の線を巻き添えにする
    const 解除 = vi.spyOn(globalThis, 'clearTimeout')
    while (本数() < ROAM_MAX) {
      emitRoam(種)
    }
    解除.mockClear()
    emitRoam(種)
    expect(解除).toHaveBeenCalled()
    解除.mockRestore()
  })
})

describe('線が持つもの', () => {
  it('カードから渡された色と濃さを、そのまま持つ', () => {
    // **長さを先に見る**（2026-08-28）。空配列だと `for` が0回まわって緑になる
    // **層は DOM を1度も読まない。** `--tile-accent` はインライン style なので
    // 継承せず、層から `getComputedStyle` で拾いに行く形にすると読む相手が増える。
    //
    // **濃さも同じ扱いにした**（フェーズ9）。固定値で塗っていたので、同じ状態
    // なのに輪と線で色が食い違っていた（カード設計§9-7）
    emitRoam({ ...種, accent: '#123456', ink: '42%' })
    const lines = useRoamStore.getState().lines
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.accent).toBe('#123456')
      expect(line.ink).toBe('42%')
    }
  })

  it('形は種から選ぶので、3本が同じにならない', () => {
    // **同じ棒が3本並ぶと手書きに見えない**（設計§9-7-3）
    emitRoam(種)
    const 形 = useRoamStore.getState().lines.map((line) => line.shape)
    expect(new Set(形).size).toBeGreaterThan(1)
  })

  it('線ごとに経路が違う', () => {
    emitRoam(種)
    const [一本目, 二本目] = useRoamStore.getState().lines
    expect(二本目).toBeDefined()
    expect(一本目.stops).not.toEqual(二本目.stops)
  })
})

describe('盤面が変わったら引き直す（入口は1つ）', () => {
  /*
    **入口は `replanRoam` の1つだけ**（設計§20-5-3）。用途は2つ——いま（すぐ引き直す）
    と、次のイシュー（退きながら引き直す）——で、**繋ぎ方を引数に持たせてある**ので
    あちらは引き金と繋ぎ方を足すだけで済む。
  */
  it('いま通過中の区間から手前は、1つも書き換えない', () => {
    // **触ると補間の途中で始点が動いて線が飛ぶ**（設計§20-5-2）。
    // 「引き直した」ことだけを見ると緑のまま通るので、**手前が同じ**ことで見る
    emitRoam(種)
    const 前 = useRoamStore.getState().lines.map((l) => l.stops.slice())
    const 添字 = 20
    const 数 = replanRoam(
      FIELD,
      useRoamStore.getState().lines.map((l) => ({ id: l.id, 添字 })),
    )
    expect(数).toBe(ROAM_LINES)
    useRoamStore.getState().lines.forEach((line, i) => {
      expect(line.stops.slice(0, 添字 + 1)).toEqual(前[i].slice(0, 添字 + 1))
      // **その先は変わっている**（変わっていなければ引き直していない）
      expect(line.stops.slice(添字 + 1)).not.toEqual(前[i].slice(添字 + 1))
      // 長さは変わらない
      expect(line.stops).toHaveLength(前[i].length)
    })
  })

  it('引き直せないときは、寿命を早めて退場させる', () => {
    /*
      **逃げ道**（設計§20-5-5）。引き直さず、その場で退場させて次の放出に任せる。

      **「消える」ことだけを見ると緑になる**——線はいずれ寿命でも消えるため。
      **通常の寿命より早く消えたこと**で見る。
    */
    emitRoam(種)
    expect(本数()).toBe(ROAM_LINES)
    const 潰れた: RoamField = { width: 8, height: 8, card: FIELD.card, rects: [] }
    const 数 = replanRoam(
      潰れた,
      useRoamStore.getState().lines.map((l) => ({ id: l.id, 添字: 20 })),
    )
    expect(数).toBe(0)
    // **寿命（90秒）を待たずに、その場で退場している**
    expect(本数()).toBe(0)
  })

  it('逃げ道の条件に、外から決めた閾値が無い', () => {
    // **枚数のような閾値を入れると、ここが落ちる**——同じ盤面なら、カードが何枚
    // あろうと引き直せる。**`歩く` が要求どおり返せるかどうかだけ**が条件である
    emitRoam(種)
    const 広い: RoamField = {
      ...FIELD,
      rects: [...FIELD.rects, { x: 612, y: 60, w: 288, h: 120 }],
    }
    const 数 = replanRoam(
      広い,
      useRoamStore.getState().lines.map((l) => ({ id: l.id, 添字: 20 })),
    )
    expect(数).toBe(ROAM_LINES)
  })

  it('知らない線は触らない', () => {
    emitRoam(種)
    const 前 = useRoamStore.getState().lines.map((l) => l.stops.slice())
    expect(replanRoam(FIELD, [{ id: 9999, 添字: 20 }])).toBe(0)
    useRoamStore.getState().lines.forEach((line, i) => {
      expect(line.stops).toEqual(前[i])
    })
  })
})

describe('実物の並びで、3本が重ならない', () => {
  /*
    **0.1.43 を実物で見た利用者の指摘「放出時点から2本重なって出てくる」**（要件14-3）。

    **作り物の場では捕まらなかった。** `FIELD` は候補が多く出る並びなので、順位で
    割り振れば必ず散る。**実物の一覧（枠2つ・カード3枚）を写して当てる**と、
    候補が4本しか無く、しかも**同じ座標が二重に入っていた**（横の通路と縦の通路の
    両方から足されるため）——数が足りているように見えて、実は足りていなかった。

    **どのカードから出るかで角が変わる**ので、3枚とも当てる。
  */
  const 実物: RoamField = {
    width: 952,
    height: 430.59,
    card: { x: 13, y: 141, w: 294, h: 97.3 },
    rects: [
      { x: 0, y: 88, w: 952, h: 163.3 },
      { x: 13, y: 141, w: 294, h: 97.3 },
      { x: 319, y: 141, w: 294, h: 97.3 },
      { x: 0, y: 267.3, w: 952, h: 163.3 },
      { x: 13, y: 320.3, w: 294, h: 97.3 },
    ],
  }
  const カードたち = [
    { x: 13, y: 141, w: 294, h: 97.3 },
    { x: 319, y: 141, w: 294, h: 97.3 },
    { x: 13, y: 320.3, w: 294, h: 97.3 },
  ]

  it('どのカードから出ても、1組の3本は別の点へ着く', () => {
    for (const card of カードたち) {
      for (let 基 = 1; 基 < 60; 基 += 3) {
        const 印 = [0, 1, 2].map((番) => {
          const 点 = planRoute({ ...実物, card }, 基 + 番, 番, ROAM_LINES)[1]
          return `${点.x.toFixed(1)},${点.y.toFixed(1)}`
        })
        expect(new Set(印).size, `カード(${card.x},${card.y}) 種${基}: ${印.join(' / ')}`).toBe(
          ROAM_LINES,
        )
      }
    }
  })
})
