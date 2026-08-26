import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoamField } from '@/lib/roam'
import {
  ROAM_LIFE_MS,
  ROAM_LINES,
  ROAM_MAX,
  emitRoam,
  resetRoam,
  useRoamStore,
} from '@/stores/roam'

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

  it('画面の上限を超えない', () => {
    for (let i = 0; i < 20; i += 1) {
      emitRoam(種)
    }
    expect(本数()).toBeLessThanOrEqual(ROAM_MAX)
  })

  it('満杯のときは、いちばん古い線から捨てる', () => {
    // **新しいほうを捨てない。** 捨てると「このカードだけ線が出ない」と読めてしまい、
    // 跳ねと線の対応が崩れて不具合に見える
    while (本数() < ROAM_MAX) {
      emitRoam(種)
    }
    const 最古 = useRoamStore.getState().lines[0].id
    emitRoam(種)
    const 残り = useRoamStore.getState().lines.map((line) => line.id)
    expect(残り).not.toContain(最古)
    expect(残り.length).toBeLessThanOrEqual(ROAM_MAX)
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
    // **層は DOM を1度も読まない。** `--tile-accent` はインライン style なので
    // 継承せず、層から `getComputedStyle` で拾いに行く形にすると読む相手が増える。
    //
    // **濃さも同じ扱いにした**（フェーズ9）。固定値で塗っていたので、同じ状態
    // なのに輪と線で色が食い違っていた（カード設計§9-7）
    emitRoam({ ...種, accent: '#123456', ink: '42%' })
    for (const line of useRoamStore.getState().lines) {
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
