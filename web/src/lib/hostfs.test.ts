/**
 * パスの組み立てと、内側かどうかの判定（イシューグループ_2026_0805_0514 設計§15・§29）。
 *
 * **区切りの扱いは1箇所に閉じてある**（`childOf` / `relativeOf` / `isUnder`）ので、
 * ここが崩れると、貼られた相対パスが別の場所を指したり、起点の外へ抜ける段が
 * 押せるようになったりする。画面越しでは気づきにくいので、直接固定する。
 */

import { describe, expect, it } from 'vitest'
import { childOf, crumbsOf, isUnder, relativeOf } from '@/lib/hostfs'

describe('内側かどうか', () => {
  it('自分自身と、その下は内側', () => {
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app')).toBe(true)
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app/src')).toBe(true)
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app/src/main.rs')).toBe(true)
  })

  it('名前の頭が同じだけの兄弟は内側ではない', () => {
    // **これが素の前方一致で通ってしまう。** 押せる段が1つずれ、起点の外へ抜ける
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app-old')).toBe(false)
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app2')).toBe(false)
  })

  it('上の階層も外側', () => {
    expect(isUnder('/home/me/dev/app', '/home/me/dev')).toBe(false)
    expect(isUnder('/home/me/dev/app', '/')).toBe(false)
  })

  it('起点の末尾に区切りが付いていても同じ答えになる', () => {
    expect(isUnder('/home/me/dev/app/', '/home/me/dev/app/src')).toBe(true)
    expect(isUnder('/home/me/dev/app/', '/home/me/dev/app-old')).toBe(false)
    // ルート自身は落とさない（`//src` を作らない）
    expect(isUnder('/', '/home')).toBe(true)
  })
})

describe('相対パス', () => {
  it('起点そのものは `.`', () => {
    expect(relativeOf('/home/me/dev/app', '/home/me/dev/app')).toBe('.')
    expect(relativeOf('/home/me/dev/app/', '/home/me/dev/app')).toBe('.')
  })

  it('内側は起点からの道のりになる', () => {
    expect(relativeOf('/home/me/dev/app', '/home/me/dev/app/MyDocs/計画.md')).toBe(
      'MyDocs/計画.md',
    )
  })

  it('外側は絶対パスのまま返す', () => {
    // 相対にできないものを `../` で表すと、貼られた側が別の場所を指す
    expect(relativeOf('/home/me/dev/app', '/home/me/dev/app-old/計画.md')).toBe(
      '/home/me/dev/app-old/計画.md',
    )
    expect(relativeOf('/home/me/dev/app', '/etc/hosts')).toBe('/etc/hosts')
  })
})

describe('子のパスとパンくず', () => {
  it('区切りが重ならない', () => {
    expect(childOf('/home/me', 'dev')).toBe('/home/me/dev')
    expect(childOf('/', 'home')).toBe('/home')
  })

  it('パンくずはルートから順に積み上がる', () => {
    expect(crumbsOf('/home/me/dev')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'me', path: '/home/me' },
      { label: 'dev', path: '/home/me/dev' },
    ])
  })
})
