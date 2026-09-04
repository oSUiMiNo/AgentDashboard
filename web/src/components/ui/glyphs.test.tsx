import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  BellGlyph,
  ChevronGlyph,
  CloseGlyph,
  CopyGlyph,
  GearGlyph,
  PencilGlyph,
  PlusGlyph,
  PowerGlyph,
  SendGlyph,
  TrashGlyph,
} from '@/components/ui/glyphs'

/**
 * 印の作法を数で固定する（細かい修正 設計§2-2）。
 *
 * **1つでも作法から外れると、同じ画面に2つの流儀が並ぶ。** 線の太さと `viewBox` を
 * 自分で握っているのは `DESIGN.md` の寸法と揃えるためなので、揃っていないものが
 * 混ざった時点でその理由が消える。
 */
const 印 = {
  PowerGlyph: <PowerGlyph />,
  TrashGlyph: <TrashGlyph />,
  PencilGlyph: <PencilGlyph />,
  ChevronGlyph: <ChevronGlyph direction="up" />,
  CloseGlyph: <CloseGlyph />,
  GearGlyph: <GearGlyph />,
  SendGlyph: <SendGlyph />,
  CopyGlyph: <CopyGlyph />,
  BellGlyph: <BellGlyph />,
  PlusGlyph: <PlusGlyph />,
}

describe('印の作法', () => {
  it('10 そろっている', () => {
    // 既存4つ＋フェーズ1の5つ＋フェーズ2の `PlusGlyph`。**編集と上向き矢印は
    // 足していない**——`PencilGlyph` と `ChevronGlyph({direction:'up'})` が既にある。
    // `PlusGlyph` は `SessionAdd` に手描きで在ったものを、✕ と同じ理由で寄せた
    expect(Object.keys(印)).toHaveLength(10)
  })

  it.each(Object.entries(印))('%s が作法どおりに描かれている', (_name, node) => {
    const { container } = render(node)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // 24 のグリッド。ここが揃っていないと、同じ大きさで並べても線の太さが揃わない
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    // 色は継承させる（塗らない）
    expect(svg?.getAttribute('fill')).toBe('none')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    // `DESIGN.md` §18.2 の下限。小さく置いても消えない太さ
    expect(svg?.getAttribute('stroke-width')).toBe('2')
    expect(svg?.getAttribute('stroke-linecap')).toBe('round')
    expect(svg?.getAttribute('stroke-linejoin')).toBe('round')
    // 大きさは外から当てる。ここで固定すると器の中で泳ぐ
    expect(svg?.getAttribute('width')).toBeNull()
    expect(svg?.getAttribute('height')).toBeNull()
    // 言葉は呼ぶ側の `aria-label` と `title` に残す
    expect(svg?.getAttribute('aria-hidden')).not.toBeNull()
  })

  it('大きさは className でしか変わらない', () => {
    const { container } = render(<CopyGlyph className="size-3.5" />)
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('size-3.5')
  })

  it('山形は4方向とも、同じ絵を回して作る', () => {
    // 向きごとに別の `path` を書くと、片方だけ直されて形が割れる
    const d = new Set<string>()
    const rotate: string[] = []
    for (const direction of ['up', 'right', 'down', 'left'] as const) {
      const { container } = render(<ChevronGlyph direction={direction} />)
      const path = container.querySelector('path')
      d.add(path?.getAttribute('d') ?? '')
      rotate.push(path?.getAttribute('transform') ?? '')
    }
    expect(d.size, '4方向で d が1種類であること').toBe(1)
    expect(rotate).toEqual([
      'rotate(0 12 12)',
      'rotate(90 12 12)',
      'rotate(180 12 12)',
      'rotate(270 12 12)',
    ])
  })

  it('✕ の手描きは、この1箇所しか無い', async () => {
    // **`GroupView` と `SessionView` に1文字違わず写されていた。** 片方だけ直されて
    // 同じ意味の印が2つの形になる前に寄せた（設計§2-2）
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const 見つけた: string[] = []
    const 歩く = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          歩く(p)
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          if (readFileSync(p, 'utf8').includes('M18 6 6 18')) {
            見つけた.push(p)
          }
        }
      }
    }
    歩く(resolve(process.cwd(), 'src'))
    expect(見つけた).toHaveLength(1)
    expect(見つけた[0]).toMatch(/ui[/\\]glyphs\.tsx$/)
  })
})
