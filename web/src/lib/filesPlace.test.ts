import { MAX_PLACES, putExpanded, putPicks, readExpanded, readPlace } from '@/lib/filesPlace'
import { MAX_EXPANDED } from '@/lib/folderTree'

/*
  鍵の綴りは**こちらでも直書きする**。実装から import すると、綴りを変えたときに
  両方が一緒に動いて通ってしまう。**E2E も同じ綴りを直接読む**ので、変えたら
  向こうが黙って通らなくなる（`lib/filesPanel.test.ts` と同じ判断）
*/
const PLACE_KEY = 'agentdashboard.project-files-place'

const ROOT = '/home/me/dev/app'
const OTHER = '/home/me/dev/other'

/** 行の鍵。実装と同じ組み立てを、こちらでも書く */
function 行(host: string, project: string): string {
  return JSON.stringify([host, project])
}

function 置いてある(): Record<string, unknown> {
  return JSON.parse(globalThis.localStorage.getItem(PLACE_KEY) ?? '{}') as Record<
    string,
    unknown
  >
}

function 前の版の行を置く(host: string, project: string, 欄: Record<string, unknown>): void {
  globalThis.localStorage.setItem(
    PLACE_KEY,
    JSON.stringify({ ...置いてある(), [行(host, project)]: 欄 }),
  )
}

describe('lib/filesPlace', () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('鍵と表の形', () => {
    it('覚えが無ければ、どちらも空', () => {
      expect(readPlace('local', ROOT)).toEqual({ dir: null, pick: null, picks: [] })
    })

    it('展開の覚えと開いていたファイルが、同じ行に載る', () => {
      putExpanded('local', ROOT, [`${ROOT}/src`])
      putPicks('local', ROOT, [`${ROOT}/src/main.ts`], `${ROOT}/src/main.ts`)
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/src`])
      expect(readPlace('local', ROOT)).toEqual({
        dir: null,
        pick: `${ROOT}/src/main.ts`,
        picks: [`${ROOT}/src/main.ts`],
      })
      expect(globalThis.localStorage.length).toBe(1)
      expect(Object.keys(置いてある())).toEqual([行('local', ROOT)])
    })

    it('片方だけ書いても、もう片方が消えない', () => {
      putExpanded('local', ROOT, [`${ROOT}/src`])
      putPicks('local', ROOT, [`${ROOT}/src/main.ts`], `${ROOT}/src/main.ts`)
      putExpanded('local', ROOT, [`${ROOT}/docs`])
      expect(readPlace('local', ROOT).pick).toBe(`${ROOT}/src/main.ts`)
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/docs`])
    })

    it('PC が違えば別の行。PJT が同じでも混ざらない', () => {
      putPicks('local', ROOT, [`${ROOT}/src/a.md`], `${ROOT}/src/a.md`)
      putPicks('pc-2', ROOT, [`${ROOT}/docs/b.md`], `${ROOT}/docs/b.md`)
      expect(readPlace('local', ROOT).picks).toEqual([`${ROOT}/src/a.md`])
      expect(readPlace('pc-2', ROOT).picks).toEqual([`${ROOT}/docs/b.md`])
    })

    it('PJT が違えば別の行。PC が同じでも混ざらない', () => {
      putPicks('local', ROOT, [`${ROOT}/src/a.md`], `${ROOT}/src/a.md`)
      putPicks('local', OTHER, [`${OTHER}/lib/b.md`], `${OTHER}/lib/b.md`)
      expect(readPlace('local', ROOT).picks).toEqual([`${ROOT}/src/a.md`])
      expect(readPlace('local', OTHER).picks).toEqual([`${OTHER}/lib/b.md`])
    })

    it('PJT を10件書いても、鍵は1つのまま', () => {
      for (let i = 0; i < 10; i++) {
        putExpanded('local', `/home/me/p${i}`, [`/home/me/p${i}/src`])
      }
      // **区画ごとに鍵を作らない**ことの担保
      expect(globalThis.localStorage.length).toBe(1)
    })

    it('忘れるときは `null` を渡す', () => {
      putPicks('local', ROOT, [`${ROOT}/a.md`], `${ROOT}/a.md`)
      putPicks('local', ROOT, [], null)
      expect(readPlace('local', ROOT).pick).toBeNull()
    })
  })

  /**
   * タブの並び（`サイドバーで開いたファイルを、タブで並べて切り替える` テスト計画
   * フェーズ1）。
   *
   * **落ちるのは境目である。** 前の版が書いた行・並びの外を指す選択・門を通らない要素。
   */
  describe('タブの並び', () => {
    it('並びを書いて読むと、順序ごと戻る', () => {
      const 並び = [`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/c.md`]
      putPicks('local', ROOT, 並び, `${ROOT}/b.md`)
      const place = readPlace('local', ROOT)
      expect(place.picks).toEqual(並び)
      expect(place.pick).toBe(`${ROOT}/b.md`)
    })

    it('前の版が書いた行（`pick` だけ）は、1枚のタブになる', () => {
      /*
        **この PJT は版の切り替えを日常的に行う**ので、古い版が書いた行を新しい版が
        読む場面が実際に起きる。**行ごと捨てると、開いていたものが黙って消える。**
      */
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({ [行('local', ROOT)]: { pick: `${ROOT}/a.md` } }),
      )
      const place = readPlace('local', ROOT)
      expect(place.picks).toEqual([`${ROOT}/a.md`])
      expect(place.pick).toBe(`${ROOT}/a.md`)
    })

    it('古い版のために `pick` も一緒に書く', () => {
      // **前方互換は読む側だけでは足りない。** 書く側も1枚ぶんを残す
      putPicks('local', ROOT, [`${ROOT}/a.md`, `${ROOT}/b.md`], `${ROOT}/b.md`)
      const raw = JSON.parse(
        globalThis.localStorage.getItem(PLACE_KEY) ?? '{}',
      ) as Record<string, { pick?: unknown; picks?: unknown }>
      expect(raw[行('local', ROOT)]?.pick).toBe(`${ROOT}/b.md`)
    })

    it('起点の外が混ざっていると、その要素だけ落ちる', () => {
      // **行ごと捨てない。** 片方が壊れていても、もう片方は生かす
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: {
            picks: [`${ROOT}/a.md`, '/etc/passwd', `${ROOT}/b.md`],
            pick: `${ROOT}/b.md`,
          },
        }),
      )
      expect(readPlace('local', ROOT).picks).toEqual([
        `${ROOT}/a.md`,
        `${ROOT}/b.md`,
      ])
    })

    it('`..` を含む段が混ざっていると、その要素だけ落ちる', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: {
            picks: [`${ROOT}/a.md`, `${ROOT}/../外.md`],
            pick: `${ROOT}/a.md`,
          },
        }),
      )
      expect(readPlace('local', ROOT).picks).toEqual([`${ROOT}/a.md`])
    })

    it('選択が並びの外を指していたら、末尾へ足して選ぶ', () => {
      /*
        **レビューで見つかった穴**（2026-09-08）。捨てて先頭を選んでいたので、
        **版を戻していた間に開いたファイルが黙って消え、代わりに古い1枚が開いて**
        いた——利用者から見ると「開いていたものが勝手に別のものに変わった」になる。

        この形は**版をまたいだときに実際に作られる**（`picks` を知らない版は `pick`
        だけを書き換え、`picks` は前のまま残る）。
      */
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: {
            picks: [`${ROOT}/a.md`, `${ROOT}/b.md`],
            pick: `${ROOT}/古い版で開いた.md`,
          },
        }),
      )
      const place = readPlace('local', ROOT)
      expect(place.picks).toEqual([
        `${ROOT}/a.md`,
        `${ROOT}/b.md`,
        `${ROOT}/古い版で開いた.md`,
      ])
      expect(place.pick).toBe(`${ROOT}/古い版で開いた.md`)
    })

    it('選択が門を通らなければ、並びの先頭を選ぶ', () => {
      // 足すのは**通った1枚だけ**。起点の外はここでも入れない
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: {
            picks: [`${ROOT}/a.md`, `${ROOT}/b.md`],
            pick: '/etc/passwd',
          },
        }),
      )
      const place = readPlace('local', ROOT)
      expect(place.picks).toEqual([`${ROOT}/a.md`, `${ROOT}/b.md`])
      expect(place.pick).toBe(`${ROOT}/a.md`)
    })

    it('同じパスが二重に入っていたら、先に出たほうを残す', () => {
      // タブは1枚のファイルに1つ。重複はそのまま描くと `key` が衝突する
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: {
            picks: [`${ROOT}/a.md`, `${ROOT}/a.md`],
            pick: `${ROOT}/a.md`,
          },
        }),
      )
      expect(readPlace('local', ROOT).picks).toEqual([`${ROOT}/a.md`])
    })

    it('`picks` が配列でなければ、前の版の行として読む', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: { picks: '壊れている', pick: `${ROOT}/a.md` },
        }),
      )
      expect(readPlace('local', ROOT).picks).toEqual([`${ROOT}/a.md`])
    })

    it('空の並びを書くと忘れる', () => {
      putPicks('local', ROOT, [`${ROOT}/a.md`], `${ROOT}/a.md`)
      putPicks('local', ROOT, [], null)
      expect(readPlace('local', ROOT)).toEqual({
        dir: null,
        pick: null,
        picks: [],
      })
    })
  })

  describe('増え続けない', () => {
    it('上限を超えたら、最後に触ってから最も古い行が落ちる', () => {
      for (let i = 0; i < MAX_PLACES; i++) {
        putExpanded('local', `/home/me/p${i}`, [`/home/me/p${i}/src`])
      }
      putExpanded('local', '/home/me/新入り', ['/home/me/新入り/src'])

      expect(Object.keys(置いてある())).not.toContain(行('local', '/home/me/p0'))
      expect(readExpanded('local', '/home/me/p0')).toEqual([])
      expect(readExpanded('local', '/home/me/p1')).toEqual(['/home/me/p1/src'])
      expect(readExpanded('local', '/home/me/新入り')).toEqual(['/home/me/新入り/src'])
    })

    it('書き直した行は末尾へ動くので、落ちるのは2番目になる', () => {
      for (let i = 0; i < MAX_PLACES; i++) {
        putExpanded('local', `/home/me/p${i}`, [`/home/me/p${i}/src`])
      }
      // 先頭を書き直して末尾へ送る
      putExpanded('local', '/home/me/p0', ['/home/me/p0/docs'])
      putExpanded('local', '/home/me/新入り', ['/home/me/新入り/src'])

      expect(readExpanded('local', '/home/me/p0')).toEqual(['/home/me/p0/docs'])
      expect(Object.keys(置いてある())).not.toContain(行('local', '/home/me/p1'))
      expect(readExpanded('local', '/home/me/p1')).toEqual([])
    })

    it('溢れて落ちた PJT は、覚えが無いのと同じ姿になる', () => {
      for (let i = 0; i <= MAX_PLACES; i++) {
        putExpanded('local', `/home/me/p${i}`, [`/home/me/p${i}/src`])
      }
      // 例外にならず、既定（起点から始まる）へ戻るだけ
      expect(readPlace('local', '/home/me/p0')).toEqual({ dir: null, pick: null, picks: [] })
      expect(readExpanded('local', '/home/me/p0')).toEqual([])
    })

    it('行の数が上限を超えない', () => {
      for (let i = 0; i < MAX_PLACES + 5; i++) {
        putExpanded('local', `/home/me/p${i}`, [`/home/me/p${i}/src`])
      }
      expect(Object.keys(置いてある()).length).toBe(MAX_PLACES)
    })
  })

  describe('壊れた値', () => {
    it('JSON にならなければ、表ごと既定へ', () => {
      globalThis.localStorage.setItem(PLACE_KEY, '{壊れている')
      expect(readPlace('local', ROOT)).toEqual({ dir: null, pick: null, picks: [] })
    })

    it('表でないものが置かれていたら、表ごと既定へ', () => {
      for (const 変 of ['[1,2]', 'null', '42', '"あ"']) {
        globalThis.localStorage.setItem(PLACE_KEY, 変)
        expect(readPlace('local', ROOT)).toEqual({ dir: null, pick: null, picks: [] })
      }
    })

    it('行が表でなければ、その行だけ既定へ', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({ [行('local', ROOT)]: '文字列' }),
      )
      expect(readPlace('local', ROOT)).toEqual({ dir: null, pick: null, picks: [] })
    })

    it('`dir` が文字列でなくても、`pick` は生き残る', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: { dir: 42, pick: `${ROOT}/a.md` },
        }),
      )
      // **表を丸ごと捨てない**
      expect(readPlace('local', ROOT)).toEqual({
        dir: null,
        pick: `${ROOT}/a.md`,
        picks: [`${ROOT}/a.md`],
      })
    })

    it('知らない鍵が行に混ざっていても無視する', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: { dir: `${ROOT}/src`, 知らない: 1 },
        }),
      )
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/src`)
    })

    it('壊れた表へ書いても投げない', () => {
      globalThis.localStorage.setItem(PLACE_KEY, '{壊れている')
      expect(() => putExpanded('local', ROOT, [`${ROOT}/src`])).not.toThrow()
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/src`])
    })
  })

  describe('起点の外は、読んだ時点で弾く', () => {
    it('起点の外を指す値は、その項目だけ落ちる', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: { dir: '/etc', pick: `${ROOT}/a.md` },
        }),
      )
      // 外を復元するとパンくずが全段 disabled になり、上へ戻れなくなる
      expect(readPlace('local', ROOT)).toEqual({
        dir: null,
        pick: `${ROOT}/a.md`,
        picks: [`${ROOT}/a.md`],
      })
    })

    it('名前の頭が同じだけの兄弟は、内側ではない', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({ [行('local', ROOT)]: { dir: `${ROOT}-old/src` } }),
      )
      expect(readPlace('local', ROOT).dir).toBeNull()
    })

    it('起点そのものは内側として通る', () => {
      前の版の行を置く('local', ROOT, { dir: ROOT })
      expect(readPlace('local', ROOT).dir).toBe(ROOT)
    })

    it('`..` を含む段は落ちる', () => {
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({
          [行('local', ROOT)]: { dir: `${ROOT}/src/../../etc` },
        }),
      )
      // `isUnder` は入力を正規化しないので、こちらで塞ぐ
      expect(readPlace('local', ROOT).dir).toBeNull()
    })

    it('名前に `..` を含むだけのフォルダは落とさない', () => {
      前の版の行を置く('local', ROOT, { dir: `${ROOT}/a..b` })
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/a..b`)
    })
  })

  describe('置けないブラウザ', () => {
    function 使えなくする(): void {
      const 壊れた = {
        getItem() {
          throw new Error('置けません')
        },
        setItem() {
          throw new Error('置けません')
        },
        length: 0,
      }
      vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(
        壊れた as unknown as Storage,
      )
    }

    it('読みが既定を返す', () => {
      使えなくする()
      expect(readPlace('local', ROOT)).toEqual({ dir: null, pick: null, picks: [] })
    })

    it('書きが投げない', () => {
      使えなくする()
      // **投げないこと自体が主張。** 覚えられないだけで、その回の移動は成立する
      expect(() => putExpanded('local', ROOT, [`${ROOT}/src`])).not.toThrow()
      expect(() => putPicks('local', ROOT, [`${ROOT}/a.md`], `${ROOT}/a.md`)).not.toThrow()
    })
  })

  describe('読み書きの回数', () => {
    it('1回読むのに、表を1回しか取り出さない', () => {
      前の版の行を置く('local', ROOT, { dir: `${ROOT}/src` })
      const 覗く = vi.spyOn(Storage.prototype, 'getItem')
      readPlace('local', ROOT)
      expect(覗く).toHaveBeenCalledTimes(1)
      覗く.mockRestore()
    })

    it('控えるのは解析だけなので、外から書き換えると追随する', () => {
      前の版の行を置く('local', ROOT, { dir: `${ROOT}/src` })
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/src`)
      // `getItem` は毎回するので、生の文字列が変われば気づく
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({ [行('local', ROOT)]: { dir: `${ROOT}/docs` } }),
      )
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/docs`)
    })
  })

  describe('展開の覚え', () => {
    function 置く(row: Record<string, unknown>, host = 'local', project = ROOT): void {
      globalThis.localStorage.setItem(PLACE_KEY, JSON.stringify({ [行(host, project)]: row }))
    }

    function 前の版が掘る(host: string, project: string, dir: string): void {
      const 表 = 置いてある() as Record<string, Record<string, unknown>>
      表[行(host, project)] = { ...(表[行(host, project)] ?? {}), dir }
      globalThis.localStorage.setItem(PLACE_KEY, JSON.stringify(表))
    }

    function D(n: number): string {
      return `${ROOT}/d${n}`
    }

    function 行の展開(host = 'local', project = ROOT): unknown {
      const 行の中身 = 置いてある()[行(host, project)] as { expanded?: unknown }
      return 行の中身.expanded
    }

    it('展開を書いて読むと、順序ごと戻る', () => {
      putExpanded('local', ROOT, [`${ROOT}/b`, `${ROOT}/a`, `${ROOT}/a/c`])
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/b`, `${ROOT}/a`, `${ROOT}/a/c`])
    })

    it('空の並びを書いたら、前の版の掘った位置から作り直さずに「何も展開していない」と読む', () => {
      置く({ dir: `${ROOT}/a/b` })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`, `${ROOT}/a/b`])
      putExpanded('local', ROOT, [])
      expect(readExpanded('local', ROOT)).toEqual([])
    })

    it('前の版が書いた行（`expanded` が無い）は、`dir` の祖先を展開として読む', () => {
      置く({ dir: `${ROOT}/a/b`, pick: `${ROOT}/a/b/x.md` })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`, `${ROOT}/a/b`])
    })

    it('前の版が書いた行で `dir` も無ければ、展開は空', () => {
      置く({ pick: `${ROOT}/x.md` })
      expect(readExpanded('local', ROOT)).toEqual([])
      置く({ dir: ROOT })
      expect(readExpanded('local', ROOT)).toEqual([])
      置く({ dir: '/etc' })
      expect(readExpanded('local', ROOT)).toEqual([])
    })

    it('ルートが `/` で始まらない形でも、前の版の `dir` から祖先を展開として読む', () => {
      const ウィンドウズ = 'C:\\Users\\me\\proj'
      置く({ dir: `${ウィンドウズ}/src/a` }, 'local', ウィンドウズ)
      expect(readExpanded('local', ウィンドウズ)).toEqual([`${ウィンドウズ}/src`, `${ウィンドウズ}/src/a`])
    })

    it('`expanded` が配列でなければ、前の版の行として読む', () => {
      置く({ dir: `${ROOT}/a/b`, expanded: '壊れている' })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`, `${ROOT}/a/b`])
    })

    it('`dirSeen` と今の `dir` が違えば、`dir` の祖先のうち入っていないものを末尾に足す', () => {
      置く({
        dir: `${ROOT}/a/b/c`,
        dirSeen: `${ROOT}/old`,
        expanded: [`${ROOT}/x`, `${ROOT}/a`],
      })
      expect(readExpanded('local', ROOT)).toEqual([
        `${ROOT}/x`,
        `${ROOT}/a`,
        `${ROOT}/a/b`,
        `${ROOT}/a/b/c`,
      ])
    })

    it('`dirSeen` と今の `dir` が同じなら、何も足さない', () => {
      置く({ dir: `${ROOT}/a/b/c`, dirSeen: `${ROOT}/a/b/c`, expanded: [`${ROOT}/x`] })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/x`])
    })

    it('新しい版で書いた後に前の版で掘っても、次に新しい版で読むと掘った先まで展開している', () => {
      置く({ dir: `${ROOT}/a` })
      putExpanded('local', ROOT, [`${ROOT}/a`])
      前の版が掘る('local', ROOT, `${ROOT}/q/r`)
      const 読んだ = readExpanded('local', ROOT)
      expect(読んだ).toEqual([`${ROOT}/a`, `${ROOT}/q`, `${ROOT}/q/r`])
      putExpanded('local', ROOT, 読んだ)
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`, `${ROOT}/q`, `${ROOT}/q/r`])
      putExpanded('local', ROOT, [`${ROOT}/a`, `${ROOT}/q/r`])
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`, `${ROOT}/q/r`])
    })

    it('`putExpanded` は `expanded` と `dirSeen` だけを書き、`dir`・`pick`・`picks` を書き換えない', () => {
      置く({ dir: `${ROOT}/a`, pick: `${ROOT}/a/x.md`, picks: [`${ROOT}/a/x.md`] })
      putExpanded('local', ROOT, [`${ROOT}/a`, `${ROOT}/b`])
      expect(置いてある()[行('local', ROOT)]).toEqual({
        dir: `${ROOT}/a`,
        pick: `${ROOT}/a/x.md`,
        picks: [`${ROOT}/a/x.md`],
        expanded: [`${ROOT}/a`, `${ROOT}/b`],
        dirSeen: `${ROOT}/a`,
      })
      expect(readPlace('local', ROOT)).toEqual({
        dir: `${ROOT}/a`,
        pick: `${ROOT}/a/x.md`,
        picks: [`${ROOT}/a/x.md`],
      })
    })

    it('行に `dir` が無いときは、`dirSeen` に null を書く', () => {
      putExpanded('local', ROOT, [`${ROOT}/a`])
      expect(置いてある()[行('local', ROOT)]).toEqual({
        expanded: [`${ROOT}/a`],
        dirSeen: null,
      })
    })

    it('起点の外と `..` を含む要素だけを捨て、行ごとは捨てない', () => {
      置く({
        expanded: [`${ROOT}/a`, '/etc', 42, `${ROOT}/../外`, `${ROOT}-old/x`, `${ROOT}/b`],
      })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`, `${ROOT}/b`])
    })

    it('ルートそのものは、展開の並びに入れない', () => {
      置く({ expanded: [ROOT, `${ROOT}/a`] })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`])
    })

    it('展開の並びに同じパスが二重に入っていたら、先に出たほうを残す', () => {
      置く({ expanded: [`${ROOT}/a`, `${ROOT}/b`, `${ROOT}/a`] })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`, `${ROOT}/b`])
    })

    it('読んだ並びが上限を超えていたら、見えていない枝から古い順に落として上限に収める', () => {
      const 並び = Array.from({ length: MAX_EXPANDED }, (_, n) => D(n))
      並び.splice(Math.floor(MAX_EXPANDED / 2), 0, `${ROOT}/h/inner`)
      expect(並び).toHaveLength(MAX_EXPANDED + 1)
      置く({ expanded: 並び })
      const 読んだ = readExpanded('local', ROOT)
      expect(読んだ).toHaveLength(MAX_EXPANDED)
      expect(読んだ).not.toContain(`${ROOT}/h/inner`)
      expect(読んだ).toContain(D(0))
    })

    it('`dir` の祖先を足して上限を超えても、`dir` の祖先は落ちない', () => {
      const 並び = [`${ROOT}/p`, ...Array.from({ length: MAX_EXPANDED - 1 }, (_, n) => D(n + 1))]
      expect(並び).toHaveLength(MAX_EXPANDED)
      置く({ dir: `${ROOT}/p/q/r`, dirSeen: `${ROOT}/old`, expanded: 並び })
      const 読んだ = readExpanded('local', ROOT)
      expect(読んだ).toHaveLength(MAX_EXPANDED)
      expect(読んだ).toContain(`${ROOT}/p`)
      expect(読んだ).toContain(`${ROOT}/p/q`)
      expect(読んだ).toContain(`${ROOT}/p/q/r`)
      expect(読んだ).not.toContain(D(1))
      expect(読んだ).not.toContain(D(2))
      expect(読んだ).toContain(D(3))
    })

    it('`putExpanded` は受け取った並びを落とさずに、そのまま書く', () => {
      const 並び = Array.from({ length: MAX_EXPANDED + 50 }, (_, n) => D(n))
      putExpanded('local', ROOT, 並び)
      expect(行の展開()).toEqual(並び)
    })

    it('展開の覚えも、PC が違えば別の行', () => {
      putExpanded('local', ROOT, [`${ROOT}/a`])
      putExpanded('pc-2', ROOT, [`${ROOT}/b`])
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`])
      expect(readExpanded('pc-2', ROOT)).toEqual([`${ROOT}/b`])
    })

    it('展開の覚えも、PJT が違えば別の行', () => {
      putExpanded('local', ROOT, [`${ROOT}/a`])
      putExpanded('local', OTHER, [`${OTHER}/lib`])
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/a`])
      expect(readExpanded('local', OTHER)).toEqual([`${OTHER}/lib`])
    })

    it('展開を読んでも覚えの行は書き換えず、後で別の欄を書いても `expanded` は元のまま', () => {
      置く({ dir: `${ROOT}/a/b`, dirSeen: `${ROOT}/old`, expanded: [`${ROOT}/x`] })
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/x`, `${ROOT}/a`, `${ROOT}/a/b`])
      expect(readExpanded('local', ROOT)).toEqual([`${ROOT}/x`, `${ROOT}/a`, `${ROOT}/a/b`])
      putPicks('local', ROOT, [`${ROOT}/m.md`], `${ROOT}/m.md`)
      expect(行の展開()).toEqual([`${ROOT}/x`])
    })
  })
})
