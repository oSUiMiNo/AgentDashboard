import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DirEntry, DirListing } from '@/lib/hostfs'
import {
  ancestorsOf,
  branchesToRefresh,
  capExpanded,
  rowScrollFor,
  runLimited,
  toggleExpanded,
  visibleBranches,
  visibleRowCount,
  type Branch,
} from '@/lib/folderTree'

const R = '/home/me/dev/app'

function 一覧(path: string, 行: [string, DirEntry['kind']][]): DirListing {
  return {
    path,
    truncated: false,
    entries: 行.map(([name, kind]) => ({ name, kind, is_project: false })),
  }
}

function 読めた(path: string, 行: [string, DirEntry['kind']][]): Branch {
  return { state: 'ready', listing: 一覧(path, 行) }
}

function 手で解く<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, ng) => {
    resolve = ok
    reject = ng
  })
  return { promise, resolve, reject }
}

describe('lib/folderTree', () => {
  describe('展開を切り替える', () => {
    it('展開していなければ末尾に足し、展開していれば外す', () => {
      const 前 = [`${R}/a`]
      expect(toggleExpanded(前, `${R}/b`, 100, R)).toEqual([`${R}/a`, `${R}/b`])
      expect(前).toEqual([`${R}/a`])

      const 二つ = [`${R}/a`, `${R}/b`]
      expect(toggleExpanded(二つ, `${R}/a`, 100, R)).toEqual([`${R}/b`])
      expect(二つ).toEqual([`${R}/a`, `${R}/b`])
    })

    it('ルートそのものとルートの外は、並びに入らない', () => {
      expect(toggleExpanded([`${R}/a`], R, 100, R)).toEqual([`${R}/a`])
      expect(toggleExpanded([`${R}/a`], '/etc', 100, R)).toEqual([`${R}/a`])
    })
  })

  describe('上限に収める', () => {
    it('上限を超えたら、見えていない枝が古い順に先に落ちる', () => {
      const 前 = [`${R}/a`, `${R}/x/y`, `${R}/b`, `${R}/x/z`, `${R}/c`]
      expect(capExpanded(前, 4, R, [`${R}/c`])).toEqual([
        `${R}/a`,
        `${R}/b`,
        `${R}/x/z`,
        `${R}/c`,
      ])
      expect(前).toEqual([`${R}/a`, `${R}/x/y`, `${R}/b`, `${R}/x/z`, `${R}/c`])
    })

    it('見えていない枝が無ければ、守るもの以外が古い順に落ちる', () => {
      expect(
        capExpanded([`${R}/a`, `${R}/b`, `${R}/c`, `${R}/d`], 3, R, [`${R}/d`]),
      ).toEqual([`${R}/b`, `${R}/c`, `${R}/d`])
    })

    it('いちばん古いのが、いま展開した枝の祖先でも落ちない', () => {
      const 結果 = toggleExpanded([`${R}/a`, `${R}/b`, `${R}/c`], `${R}/a/d`, 3, R)
      expect(結果).toContain(`${R}/a`)
      expect(結果).toEqual([`${R}/a`, `${R}/c`, `${R}/a/d`])
    })

    it('守るものだけで上限を超えても、守るものは落とさない', () => {
      const 守る = [`${R}/a`, `${R}/a/b`, `${R}/a/b/c`]
      expect(capExpanded(守る, 2, R, 守る)).toEqual([`${R}/a`, `${R}/a/b`, `${R}/a/b/c`])
    })

    it('上限の内なら、並びは変わらない', () => {
      expect(capExpanded([`${R}/a`, `${R}/b`], 3, R, [])).toEqual([`${R}/a`, `${R}/b`])
    })
  })

  describe('親を畳んだとき', () => {
    it('親を畳んでも、中で展開していた子は並びに残り、見えている枝には出ない', () => {
      const 後 = toggleExpanded([`${R}/a`, `${R}/a/b`], `${R}/a`, 100, R)
      expect(後).toEqual([`${R}/a/b`])
      const 表 = new Map<string, Branch>([
        [R, 読めた(R, [['a', 'dir']])],
        [`${R}/a`, 読めた(`${R}/a`, [['b', 'dir']])],
      ])
      expect(visibleBranches(R, 後, 表)).toEqual([R])
    })
  })

  describe('見えている枝', () => {
    it('ルートが先で、上の段から順に並ぶ', () => {
      const 表 = new Map<string, Branch>([
        [
          R,
          読めた(R, [
            ['a', 'dir'],
            ['b', 'dir'],
            ['f', 'file'],
          ]),
        ],
        [`${R}/a`, 読めた(`${R}/a`, [['a1', 'dir']])],
        [`${R}/b`, 読めた(`${R}/b`, [['b1', 'dir']])],
      ])
      const 展開 = [`${R}/b`, `${R}/a/a1`, `${R}/a`, `${R}/b/b1`]
      expect(visibleBranches(R, 展開, 表)).toEqual([
        R,
        `${R}/a`,
        `${R}/b`,
        `${R}/a/a1`,
        `${R}/b/b1`,
      ])
      expect(展開).toEqual([`${R}/b`, `${R}/a/a1`, `${R}/a`, `${R}/b/b1`])
    })

    it('親の一覧に子のフォルダとして載っているものだけが出る', () => {
      const 表 = new Map<string, Branch>([
        [
          R,
          読めた(R, [
            ['a', 'dir'],
            ['g', 'file'],
            ['l', 'symlink'],
          ]),
        ],
      ])
      expect(
        visibleBranches(R, [`${R}/a`, `${R}/gone`, `${R}/g`, `${R}/l`], 表),
      ).toEqual([R, `${R}/a`])
    })

    it('親をまだ読んでいない子と、親が読めない子は出ない', () => {
      const 表 = new Map<string, Branch>([
        [
          R,
          読めた(R, [
            ['a', 'dir'],
            ['c', 'dir'],
          ]),
        ],
        [`${R}/c`, { state: 'failed', reason: '読めません' }],
      ])
      expect(
        visibleBranches(R, [`${R}/a`, `${R}/a/b`, `${R}/c`, `${R}/c/d`], 表),
      ).toEqual([R, `${R}/a`, `${R}/c`])
    })

    it('控えのある読み込み中の親は、控えの一覧で子を出す', () => {
      const 表 = new Map<string, Branch>([
        [R, 読めた(R, [['a', 'dir']])],
        [`${R}/a`, { state: 'loading', listing: 一覧(`${R}/a`, [['b', 'dir']]) }],
      ])
      expect(visibleBranches(R, [`${R}/a`, `${R}/a/b`], 表)).toEqual([
        R,
        `${R}/a`,
        `${R}/a/b`,
      ])
    })

    it('ルートが空文字なら、何も出さない', () => {
      const 表 = new Map<string, Branch>([[R, 読めた(R, [['a', 'dir']])]])
      expect(visibleBranches('', [`${R}/a`], 表)).toEqual([])
    })
  })

  describe('読み直す枝', () => {
    it('読めない枝と、読みが飛んでいる枝を外す', () => {
      const 表 = new Map<string, Branch>([
        [R, 読めた(R, [])],
        [`${R}/a`, { state: 'failed', reason: '読めません' }],
        [`${R}/b`, 読めた(`${R}/b`, [])],
        [`${R}/c`, 読めた(`${R}/c`, [])],
      ])
      const 見えている = [R, `${R}/a`, `${R}/b`, `${R}/c`]
      expect(branchesToRefresh(見えている, 表, new Set([`${R}/b`]))).toEqual([
        R,
        `${R}/c`,
      ])
      expect(見えている).toEqual([R, `${R}/a`, `${R}/b`, `${R}/c`])
    })

    it('まだ読んでいない枝と、飛んでいない読み込み中の枝は外さない', () => {
      const 表 = new Map<string, Branch>([
        [R, 読めた(R, [])],
        [`${R}/b`, { state: 'loading', listing: null }],
      ])
      expect(branchesToRefresh([R, `${R}/a`, `${R}/b`], 表, new Set())).toEqual([
        R,
        `${R}/a`,
        `${R}/b`,
      ])
    })
  })

  describe('祖先', () => {
    it('ルートの1つ下からパス自身までを返し、ルートは含まない', () => {
      expect(ancestorsOf(R, `${R}/a/b/c`)).toEqual([`${R}/a`, `${R}/a/b`, `${R}/a/b/c`])
      expect(ancestorsOf(`${R}/`, `${R}/a`)).toEqual([`${R}/a`])
      expect(ancestorsOf('/', '/a/b')).toEqual(['/a', '/a/b'])
    })

    it('ルートそのものとルートの外は空', () => {
      expect(ancestorsOf(R, R)).toEqual([])
      expect(ancestorsOf(R, '/etc/x')).toEqual([])
      expect(ancestorsOf(R, `${R}-old/x`)).toEqual([])
    })
  })

  describe('同時に流す', () => {
    it('同時に N 本を超えず、N 本までは並べて流す', async () => {
      let 飛んでいる = 0
      let 最大 = 0
      const 仕事 = Array.from({ length: 10 }, (_, i) => async () => {
        飛んでいる += 1
        最大 = Math.max(最大, 飛んでいる)
        await new Promise((r) => setTimeout(r, 0))
        飛んでいる -= 1
        return i
      })
      await runLimited(仕事, 4)
      expect(最大).toBe(4)
    })

    it('全部が終わってから返る', async () => {
      const 待ち = [手で解く<number>(), 手で解く<number>(), 手で解く<number>()]
      let 返った = false
      const p = runLimited(
        待ち.map((each) => () => each.promise),
        2,
      ).then(() => {
        返った = true
      })
      待ち[0].resolve(0)
      待ち[1].resolve(1)
      await new Promise((r) => setTimeout(r, 0))
      expect(返った).toBe(false)
      待ち[2].resolve(2)
      await p
      expect(返った).toBe(true)
    })

    it('1本が失敗しても残りは進み、答えは渡した順に並ぶ', async () => {
      let 始まった = 0
      const 仕事: (() => Promise<number>)[] = [
        () => {
          始まった += 1
          return Promise.resolve(0)
        },
        () => {
          始まった += 1
          return Promise.reject(new Error('落ちた'))
        },
        () => {
          始まった += 1
          return Promise.resolve(2)
        },
        () => {
          始まった += 1
          throw new Error('同期に落ちた')
        },
        () => {
          始まった += 1
          return Promise.resolve(4)
        },
      ]
      const 答え = await runLimited(仕事, 2)
      expect(始まった).toBe(5)
      expect(答え.map((each) => each.status)).toEqual([
        'fulfilled',
        'rejected',
        'fulfilled',
        'rejected',
        'fulfilled',
      ])
      expect(答え[0]).toEqual({ status: 'fulfilled', value: 0 })
    })

    it('仕事が無ければ、すぐ空で返る', async () => {
      expect(await runLimited([], 4)).toEqual([])
    })
  })

  describe('見えている行の数', () => {
    it('見えている枝の一覧の行を足した数になる', () => {
      const 表 = new Map<string, Branch>([
        [
          R,
          読めた(R, [
            ['a', 'dir'],
            ['b', 'file'],
            ['c', 'file'],
          ]),
        ],
        [
          `${R}/a`,
          読めた(`${R}/a`, [
            ['x', 'file'],
            ['y', 'file'],
          ]),
        ],
      ])
      expect(visibleRowCount([R, `${R}/a`], 表)).toBe(5)
    })

    it('控えのある読み込み中の枝は数え、読めない枝とまだ読んでいない枝は数えない', () => {
      const 表 = new Map<string, Branch>([
        [R, 読めた(R, [['a', 'dir']])],
        [
          `${R}/a`,
          {
            state: 'loading',
            listing: 一覧(`${R}/a`, [
              ['x', 'file'],
              ['y', 'file'],
            ]),
          },
        ],
        [`${R}/b`, { state: 'failed', reason: '読めません' }],
      ])
      expect(visibleRowCount([R, `${R}/a`, `${R}/b`, `${R}/c`], 表)).toBe(3)
    })
  })

  describe('送り位置', () => {
    it('もう見えていれば、今の位置のまま', () => {
      const 器 = { 高さ: 300, いまの位置: 100 }
      expect(rowScrollFor(器, { 上: 150, 高さ: 28 })).toBe(100)
      expect(rowScrollFor(器, { 上: 100, 高さ: 28 })).toBe(100)
      expect(rowScrollFor(器, { 上: 372, 高さ: 28 })).toBe(100)
    })

    it('上にはみ出していれば、行の上端へ', () => {
      const 器 = { 高さ: 300, いまの位置: 100 }
      expect(rowScrollFor(器, { 上: 40, 高さ: 28 })).toBe(40)
      expect(rowScrollFor(器, { 上: 90, 高さ: 28 })).toBe(90)
    })

    it('下にはみ出していれば、行の下端が器の下端に来る位置へ', () => {
      expect(rowScrollFor({ 高さ: 300, いまの位置: 100 }, { 上: 390, 高さ: 28 })).toBe(118)
    })

    it('行が器より高ければ、行の上端へ', () => {
      expect(rowScrollFor({ 高さ: 20, いまの位置: 0 }, { 上: 50, 高さ: 28 })).toBe(50)
    })
  })

  describe('決める側と測る側を分ける', () => {
    it('window も document も読まない', () => {
      const 中身 = readFileSync(resolve(process.cwd(), 'src', 'lib/folderTree.ts'), 'utf8')
      expect(/\b(window|document)\b/.test(中身)).toBe(false)
    })
  })
})
