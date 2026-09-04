import { describe, expect, it } from 'vitest'

import { buttonVariants } from '@/components/ui/button'

/**
 * ボタンの大きさの階段（細かい修正 設計§2-3）。
 *
 * **階段は1箇所に持つ。** 個別の `className` で1回だけ上書きすると、次に同じ大きさが
 * 要るときにまた書くことになり、**どれが正なのか分からなくなる**。
 */
describe('大きさの階段', () => {
  const 段 = (size: Parameters<typeof buttonVariants>[0] extends undefined
    ? never
    : NonNullable<Parameters<typeof buttonVariants>[0]>['size']) =>
    buttonVariants({ size })

  it('既存の4段が変わっていない', () => {
    // ここを動かすと、いま置いてあるボタンが全部ずれる
    expect(段('icon-xs')).toContain('size-6')
    expect(段('icon-sm')).toContain('size-7')
    expect(段('icon')).toContain('size-8')
    expect(段('icon-lg')).toContain('size-9')
  })

  it('icon-xl が 48px で、中の絵が 24px', () => {
    // サイドバーの開閉ボタンを 1.5倍にするために足した段（要件8）。
    // **器と絵の比を `icon`（32/16）と揃える**——既定の `size-4` のままだと器の中で泳ぐ
    const xl = 段('icon-xl')
    expect(xl).toContain('size-12')
    expect(xl).toContain("[&_svg:not([class*='size-'])]:size-6")
  })

  it('絵の大きさは、呼ぶ側が上書きできる', () => {
    // `:not([class*='size-'])` のガードが要る。無いと呼ぶ側の指定が当たらない
    expect(段('icon-xl')).toContain(":not([class*='size-'])")
  })
})
