import { describe, expect, it } from 'vitest'

import { projectDisplayName, splitPathTail } from './path'

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

describe('帯に出す PJT の名前', () => {
  const 枠 = (path: string, created_at: number) => ({ path, created_at })

  it('同じ名前が1つだけなら、番号を付けない', () => {
    expect(
      projectDisplayName('/home/me/dev/app', [枠('/home/me/dev/app', 1)]),
    ).toBe('app')
  })

  it('同じ名前が複数なら、全部に番号が付く', () => {
    // **片方だけに付けない。** 番号の無いほうが何番なのか分からなくなる
    const 一覧 = [枠('/a/app', 1), 枠('/b/app', 2)]
    expect(projectDisplayName('/a/app', 一覧)).toBe('app (1)')
    expect(projectDisplayName('/b/app', 一覧)).toBe('app (2)')
  })

  it('番号は枠が作られた順（一覧の並びと同じ根拠）', () => {
    // 押した瞬間に番号が入れ替わらないこと
    const 一覧 = [枠('/後/app', 20), 枠('/先/app', 10)]
    expect(projectDisplayName('/先/app', 一覧)).toBe('app (1)')
    expect(projectDisplayName('/後/app', 一覧)).toBe('app (2)')
  })

  it('名前が違えば、番号は付かない', () => {
    const 一覧 = [枠('/a/app', 1), 枠('/b/other', 2)]
    expect(projectDisplayName('/a/app', 一覧)).toBe('app')
    expect(projectDisplayName('/b/other', 一覧)).toBe('other')
  })

  it('記録に無いパスでも落ちない（名前だけ出す）', () => {
    expect(projectDisplayName('/a/app', [])).toBe('app')
    expect(projectDisplayName('/', [])).toBe('/')
  })

  it('壊し方：衝突していないものにも番号を付けると、最初の主張だけが落ちる', () => {
    // **1通りの壊し方で全部が落ちるなら、テストが1本ぶんの働きしかしていない**
    const 壊れた = (path: string, all: { path: string }[]) =>
      `${path.split('/').filter(Boolean).pop()} (${all.findIndex((p) => p.path === path) + 1})`
    expect(壊れた('/home/me/dev/app', [{ path: '/home/me/dev/app' }])).toBe(
      'app (1)',
    )
    expect(
      projectDisplayName('/home/me/dev/app', [枠('/home/me/dev/app', 1)]),
    ).toBe('app')
  })
})
