import { describe, expect, it } from 'vitest'

import { splitPathTail } from './path'

/**
 * 設計§3「パスの見せ方（末尾を必ず残す）」の純関数。
 *
 * **壊し方を2通り用意してある。** 1通りの壊し方で全部が落ちるなら、テストは
 * 何本あっても1本ぶんの働きしかしていない（テスト計画フェーズ2）。
 */
describe('パスを前半と末尾2階層に割る', () => {
  it('深いパスは、前半と末尾2階層に割れる', () => {
    expect(splitPathTail('/home/me/dev/app')).toEqual({
      head: '/home/me',
      tail: '/dev/app',
    })
  })

  it('階層が2つしか無いときは、前半が空で末尾が全部になる', () => {
    expect(splitPathTail('/dev/app')).toEqual({ head: '', tail: '/dev/app' })
  })

  it('階層が1つでも落ちない', () => {
    expect(splitPathTail('/app')).toEqual({ head: '', tail: '/app' })
  })

  it('ルートでも落ちない', () => {
    expect(splitPathTail('/')).toEqual({ head: '', tail: '/' })
  })

  it('末尾は必ず2階層である', () => {
    // **壊し方その1**：末尾を1階層にすると、ここだけが落ちる。
    // 1階層だと `…/proj` と `…/proj2` は見分けられるが、`accept/proj` と
    // `reject/proj` が同じに見える——親の名前まで残すのが要件（設計§3）
    const { tail } = splitPathTail('/tmp/claude-1000/accept/proj2')
    expect(tail).toBe('/accept/proj2')
    expect(tail.split('/').filter((name) => name !== '')).toHaveLength(2)
  })

  it('割っても1文字も落とさない（head + tail が元と一致する）', () => {
    // **壊し方その2**：区切りの扱いを間違えると、ここだけが落ちる。
    // 表示のためだけの関数なので、**割った結果が元と違うのは「短くした」ではなく
    // 「嘘を出した」**ことになる
    const paths = [
      '/home/me/dev/app',
      '/home/me/dev/app/',
      '/home//me/dev/app',
      'home/me/dev/app',
      '/a/b/a/b',
      '/dev/app',
      '/app',
      '/',
      '',
    ]
    for (const path of paths) {
      const { head, tail } = splitPathTail(path)
      expect(head + tail, `割ったら元と違った: ${path}`).toBe(path)
    }
  })

  it('同じ名前が何度も出るパスでも、末尾側で割る', () => {
    // 後ろから探していないと `/a/b` のほうで割れてしまう
    expect(splitPathTail('/a/b/a/b')).toEqual({ head: '/a/b', tail: '/a/b' })
  })

  it('末尾に区切りが付いていても、末尾側へ残す', () => {
    expect(splitPathTail('/home/me/dev/app/')).toEqual({
      head: '/home/me',
      tail: '/dev/app/',
    })
  })
})
