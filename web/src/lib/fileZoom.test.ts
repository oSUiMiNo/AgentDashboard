import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readZoom,
  stepZoom,
  useFileZoom,
  ZOOM_DEFAULT,
  ZOOM_STEPS,
} from '@/lib/fileZoom'

/**
 * ファイルビュアの文字の大きさ
 * （`ファイルビュアの文字を小さめに始め、その場で大きさを変えられるようにする` 要件）。
 *
 * **落ちるのは端と、覚えていない／壊れているときである。**
 */
const KEY = 'agentdashboard.file-zoom'

beforeEach(() => {
  globalThis.localStorage.clear()
})

afterEach(() => {
  globalThis.localStorage.clear()
})

describe('lib/fileZoom', () => {
  describe('段の表', () => {
    it('既定は 100', () => {
      expect(ZOOM_DEFAULT).toBe(100)
      expect(readZoom()).toBe(100)
    })

    it('1押しで1段動く', () => {
      expect(stepZoom(100, 1)).toBe(110)
      expect(stepZoom(100, -1)).toBe(90)
    })

    it('上限で止まる', () => {
      expect(stepZoom(200, 1)).toBe(200)
    })

    it('下限で止まる', () => {
      expect(stepZoom(80, -1)).toBe(80)
    })

    it('押し戻すと、必ず元の値へ戻る', () => {
      /*
        **これが固定の段を採った理由そのもの。**「毎回 1.1 倍」にすると掛け算の誤差が
        溜まり、同じ回数押し戻しても元へ戻らない。**端は除く**——あちらは止まるのが正しい。
      */
      for (const 段 of ZOOM_STEPS.slice(0, -1)) {
        expect(stepZoom(stepZoom(段, 1), -1)).toBe(段)
      }
      for (const 段 of ZOOM_STEPS.slice(1)) {
        expect(stepZoom(stepZoom(段, -1), 1)).toBe(段)
      }
    })

    it('等比になっている（どの段でも1押しの手応えが同じ）', () => {
      // 等差（毎回 +1px）だと、小さいところでは大きく変わり、大きいところでは効かない
      for (let i = 0; i + 1 < ZOOM_STEPS.length; i += 1) {
        const 比 = ZOOM_STEPS[i + 1]! / ZOOM_STEPS[i]!
        expect(比).toBeGreaterThanOrEqual(1.1)
        expect(比).toBeLessThanOrEqual(1.25)
      }
    })
  })

  describe('覚え方', () => {
    it('覚えた値が次に読んだときに戻る', () => {
      globalThis.localStorage.setItem(KEY, '125')
      expect(readZoom()).toBe(125)
    })

    it('段の表に無い値は、既定へ落ちる', () => {
      // **近い段へ丸めない。** 丸めると、手で書き換えた値が生き残って
      // 「覚えている値は段のどれか」が崩れる
      globalThis.localStorage.setItem(KEY, '137')
      expect(readZoom()).toBe(100)
    })

    it('数でない値・空でも、例外を出さずに既定へ', () => {
      for (const 変 of ['あ', '', '{}', 'NaN', '-100']) {
        globalThis.localStorage.setItem(KEY, 変)
        expect(readZoom()).toBe(100)
      }
    })

    it('置けないブラウザでも既定へ落ちる', () => {
      const 元 = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('置けません')
        },
      })
      expect(() => readZoom()).not.toThrow()
      expect(readZoom()).toBe(100)
      if (元 !== undefined) {
        Object.defineProperty(globalThis, 'localStorage', 元)
      }
    })
  })

  describe('手', () => {
    it('大きく・小さく・戻すが効き、覚える', () => {
      const { result } = renderHook(() => useFileZoom())

      act(() => result.current[1].大きく())
      expect(result.current[0]).toBe(110)
      expect(globalThis.localStorage.getItem(KEY)).toBe('110')

      act(() => result.current[1].小さく())
      expect(result.current[0]).toBe(100)

      act(() => result.current[1].大きく())
      act(() => result.current[1].大きく())
      expect(result.current[0]).toBe(125)
      act(() => result.current[1].戻す())
      expect(result.current[0]).toBe(100)
    })

    it('別のタブの合図を拾って揃う', () => {
      // **幅と開閉と同じ族**（`lib/filesPanel.ts`）。倍率は「その人の目と画面」の都合
      const { result } = renderHook(() => useFileZoom())
      globalThis.localStorage.setItem(KEY, '150')
      act(() => {
        globalThis.dispatchEvent(
          new StorageEvent('storage', { key: KEY, newValue: '150' }),
        )
      })
      expect(result.current[0]).toBe(150)
    })
  })
})
