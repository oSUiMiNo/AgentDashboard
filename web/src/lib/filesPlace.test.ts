import { MAX_PLACES, putDir, putPicks, readPlace } from '@/lib/filesPlace'

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

    it('掘った位置と開いていたファイルが、同じ行に載る', () => {
      putDir('local', ROOT, `${ROOT}/src`)
      putPicks('local', ROOT, [`${ROOT}/src/main.ts`], `${ROOT}/src/main.ts`)
      expect(readPlace('local', ROOT)).toEqual({
        dir: `${ROOT}/src`,
        pick: `${ROOT}/src/main.ts`,
        picks: [`${ROOT}/src/main.ts`],
      })
    })

    it('片方だけ書いても、もう片方が消えない', () => {
      putDir('local', ROOT, `${ROOT}/src`)
      putPicks('local', ROOT, [`${ROOT}/src/main.ts`], `${ROOT}/src/main.ts`)
      putDir('local', ROOT, `${ROOT}/docs`)
      expect(readPlace('local', ROOT).pick).toBe(`${ROOT}/src/main.ts`)
    })

    it('PC が違えば別の行。PJT が同じでも混ざらない', () => {
      putDir('local', ROOT, `${ROOT}/src`)
      putDir('pc-2', ROOT, `${ROOT}/docs`)
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/src`)
      expect(readPlace('pc-2', ROOT).dir).toBe(`${ROOT}/docs`)
    })

    it('PJT が違えば別の行。PC が同じでも混ざらない', () => {
      putDir('local', ROOT, `${ROOT}/src`)
      putDir('local', OTHER, `${OTHER}/lib`)
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/src`)
      expect(readPlace('local', OTHER).dir).toBe(`${OTHER}/lib`)
    })

    it('PJT を10件書いても、鍵は1つのまま', () => {
      for (let i = 0; i < 10; i++) {
        putDir('local', `/home/me/p${i}`, `/home/me/p${i}/src`)
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
        putDir('local', `/home/me/p${i}`, `/home/me/p${i}/src`)
      }
      putDir('local', '/home/me/新入り', '/home/me/新入り/src')

      expect(readPlace('local', '/home/me/p0').dir).toBeNull()
      expect(readPlace('local', '/home/me/p1').dir).toBe('/home/me/p1/src')
      expect(readPlace('local', '/home/me/新入り').dir).toBe('/home/me/新入り/src')
    })

    it('書き直した行は末尾へ動くので、落ちるのは2番目になる', () => {
      for (let i = 0; i < MAX_PLACES; i++) {
        putDir('local', `/home/me/p${i}`, `/home/me/p${i}/src`)
      }
      // 先頭を書き直して末尾へ送る
      putDir('local', '/home/me/p0', '/home/me/p0/docs')
      putDir('local', '/home/me/新入り', '/home/me/新入り/src')

      expect(readPlace('local', '/home/me/p0').dir).toBe('/home/me/p0/docs')
      expect(readPlace('local', '/home/me/p1').dir).toBeNull()
    })

    it('溢れて落ちた PJT は、覚えが無いのと同じ姿になる', () => {
      for (let i = 0; i <= MAX_PLACES; i++) {
        putDir('local', `/home/me/p${i}`, `/home/me/p${i}/src`)
      }
      // 例外にならず、既定（起点から始まる）へ戻るだけ
      expect(readPlace('local', '/home/me/p0')).toEqual({ dir: null, pick: null, picks: [] })
    })

    it('行の数が上限を超えない', () => {
      for (let i = 0; i < MAX_PLACES + 5; i++) {
        putDir('local', `/home/me/p${i}`, `/home/me/p${i}/src`)
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
      expect(() => putDir('local', ROOT, `${ROOT}/src`)).not.toThrow()
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/src`)
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
      putDir('local', ROOT, ROOT)
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
      putDir('local', ROOT, `${ROOT}/a..b`)
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
      expect(() => putDir('local', ROOT, `${ROOT}/src`)).not.toThrow()
      expect(() => putPicks('local', ROOT, [`${ROOT}/a.md`], `${ROOT}/a.md`)).not.toThrow()
    })
  })

  describe('読み書きの回数', () => {
    it('1回読むのに、表を1回しか取り出さない', () => {
      putDir('local', ROOT, `${ROOT}/src`)
      const 覗く = vi.spyOn(Storage.prototype, 'getItem')
      readPlace('local', ROOT)
      expect(覗く).toHaveBeenCalledTimes(1)
      覗く.mockRestore()
    })

    it('控えるのは解析だけなので、外から書き換えると追随する', () => {
      putDir('local', ROOT, `${ROOT}/src`)
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/src`)
      // `getItem` は毎回するので、生の文字列が変われば気づく
      globalThis.localStorage.setItem(
        PLACE_KEY,
        JSON.stringify({ [行('local', ROOT)]: { dir: `${ROOT}/docs` } }),
      )
      expect(readPlace('local', ROOT).dir).toBe(`${ROOT}/docs`)
    })
  })
})
