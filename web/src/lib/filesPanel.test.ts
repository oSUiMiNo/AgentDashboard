import { act, renderHook } from '@testing-library/react'
import {
  readWidths,
  useFilesPanel,
  usePanelWidths,
  writeWidths,
} from './filesPanel'

/**
 * ファイルのパネルの開閉と幅（テスト計画フェーズ2「幅を覚える」）。
 *
 * **このファイル初めての単体テスト。** 開閉のほうは既に E2E が鍵の綴りを直接読んで
 * いるので、ここでは「幅を足しても壊していないこと」を見る役になる。
 *
 * ここで確かめられないもの：**実際に縁を掴んで幅が変わること**。jsdom には配置が
 * 無いので、掴む側は部品のテストで、当たることは E2E でしか言えない。
 */

const OPEN_KEY = 'agentdashboard.project-files-open'
const WIDTH_KEY = 'agentdashboard.project-files-width'

/** 画面幅を決めてから測る。**測る側と決める側を分けてある**ので、ここで注入できる */
function 画面幅を(width: number) {
  Object.defineProperty(globalThis, 'innerWidth', {
    configurable: true,
    value: width,
  })
}

/** 別のタブが書き換えた、という合図。 */
function 別タブが書いた(key: string) {
  act(() => {
    globalThis.dispatchEvent(new StorageEvent('storage', { key }))
  })
}

beforeEach(() => {
  globalThis.localStorage.clear()
  // 広い画面。**画面比の上限が絶対値に届かない側**にしておくと、既定がそのまま出る
  画面幅を(1920)
})

describe('開閉の記憶（幅を足しても壊れていないこと）', () => {
  it('鍵の綴りが変わっていない', () => {
    const { result } = renderHook(() => useFilesPanel())

    act(() => result.current[1]())

    // **E2E がこの綴りを直接読んでいる**ので、変えると向こうが黙って通らなくなる
    expect(globalThis.localStorage.getItem(OPEN_KEY)).toBe('1')
    expect(result.current[0]).toBe(true)
  })

  it('真偽は "1" と "0" のまま', () => {
    globalThis.localStorage.setItem(OPEN_KEY, '1')
    const { result } = renderHook(() => useFilesPanel())
    expect(result.current[0]).toBe(true)

    act(() => result.current[1]())
    expect(globalThis.localStorage.getItem(OPEN_KEY)).toBe('0')
  })
})

describe('幅の読み書き', () => {
  it('1つの鍵に表として入る', () => {
    writeWidths({ folder: 400, file: 800 })

    // 区画ごとに鍵を作らない。**増えるたびに鍵が増え、消す機会が無い**
    expect(globalThis.localStorage.getItem(WIDTH_KEY)).toBe(
      '{"folder":400,"file":800}',
    )
    expect(globalThis.localStorage.length).toBe(1)
  })

  it('覚えが無ければ既定を返す', () => {
    expect(readWidths()).toEqual({ folder: 320, file: 672 })
  })

  it('JSON として読めなければ、表ごと既定へ落ちる', () => {
    globalThis.localStorage.setItem(WIDTH_KEY, '{壊れている')
    expect(readWidths()).toEqual({ folder: 320, file: 672 })
  })

  /*
    **この1本には歯が無い。** `readWidths` の「object でない・null・配列なら表ごと
    既定へ」の1行を消しても、答えは1つも変わらない——配列も数値も文字列も
    `.folder` が `undefined` になって項目ごとの既定へ落ち、`null` は `.folder` で
    投げて `catch` が既定へ落とすため、**どちらの道を通っても同じ表が返る**。

    それでも残すのは、**2枚を同時に剥がしたときに落ちる**から（弾く1行と `catch` の
    両方を消すと `null` が外まで投げる）。確かめられているのは「2枚あること」で、
    **1枚ずつの効き目は確かめていない。**
  */
  it('表でないもの（配列・null・数値）は、表ごと既定へ落ちる', () => {
    for (const 中身 of ['[320,672]', 'null', '42', '"あ"']) {
      globalThis.localStorage.setItem(WIDTH_KEY, 中身)
      expect(readWidths()).toEqual({ folder: 320, file: 672 })
    }
  })

  it('片方だけ壊れていても、もう片方は生きる', () => {
    // **表を丸ごと捨てない**（設計§5）。捨てると、片方を手で壊しただけで
    // もう片方の設定まで消える
    globalThis.localStorage.setItem(WIDTH_KEY, '{"folder":"あ","file":800}')
    expect(readWidths()).toEqual({ folder: 320, file: 800 })
  })

  it('NaN・負・範囲外は、その項目だけ丸める', () => {
    globalThis.localStorage.setItem(WIDTH_KEY, '{"folder":-50,"file":99999}')
    expect(readWidths()).toEqual({ folder: 160, file: 1344 })
  })

  it('知らない鍵が混ざっていても無視する', () => {
    globalThis.localStorage.setItem(
      WIDTH_KEY,
      '{"folder":400,"file":800,"terminal":123}',
    )
    expect(readWidths()).toEqual({ folder: 400, file: 800 })
  })
})

describe('localStorage が使えない環境', () => {
  /** 読むのも書くのも投げる置き場所に差し替える。 */
  function 使えなくする() {
    const 壊れた = {
      getItem() {
        throw new Error('置けない設定')
      },
      setItem() {
        throw new Error('置けない設定')
      },
    }
    vi.spyOn(globalThis, 'localStorage', 'get').mockReturnValue(
      壊れた as unknown as Storage,
    )
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('読みは既定へ落ちる', () => {
    使えなくする()
    expect(readWidths()).toEqual({ folder: 320, file: 672 })
  })

  it('書きは黙って諦め、それでも幅は変えられる', () => {
    使えなくする()

    // 投げないこと自体が主張。**覚えられないだけで、その回の幅は成立する**
    expect(() => writeWidths({ folder: 400, file: 800 })).not.toThrow()

    const { result } = renderHook(() => usePanelWidths())
    act(() => result.current[1].onMove('folder', 400))
    expect(result.current[0].folder).toBe(400)
  })
})

describe('いま当てる幅', () => {
  it('覚えている値が広すぎる画面では、画面比で抑えられる', () => {
    writeWidths({ folder: 600, file: 672 })
    画面幅を(1280)

    const { result } = renderHook(() => usePanelWidths())

    // 1280 × 0.4 = 512
    expect(result.current[0].folder).toBe(512)
  })

  it('覚えている値そのものは書き換わらないので、広い画面へ戻せば戻る', () => {
    writeWidths({ folder: 600, file: 672 })
    画面幅を(1280)
    renderHook(() => usePanelWidths())

    // **抑えた値を覚え直していないこと。** 覚え直すと、窓を戻しても 512 のまま
    expect(readWidths().folder).toBe(600)

    画面幅を(1920)
    const 広い画面 = renderHook(() => usePanelWidths())
    expect(広い画面.result.current[0].folder).toBe(600)
  })
})

describe('別のタブとの食い違い', () => {
  it('掴んでいなければ、別のタブの書き換えに追随する', () => {
    const { result } = renderHook(() => usePanelWidths())
    expect(result.current[0].folder).toBe(320)

    globalThis.localStorage.setItem(WIDTH_KEY, '{"folder":500,"file":672}')
    別タブが書いた(WIDTH_KEY)

    expect(result.current[0].folder).toBe(500)
  })

  it('掴んでいる最中は、別のタブの書き換えで幅が跳ばない', () => {
    const { result } = renderHook(() => usePanelWidths())

    act(() => result.current[1].onGrab())
    act(() => result.current[1].onMove('folder', 400))

    globalThis.localStorage.setItem(WIDTH_KEY, '{"folder":600,"file":672}')
    別タブが書いた(WIDTH_KEY)

    // **指の下で幅が跳ばないこと。** 開閉には無かった競合（設計§5）
    expect(result.current[0].folder).toBe(400)
  })

  it('別の鍵の合図では動かない', () => {
    const { result } = renderHook(() => usePanelWidths())

    globalThis.localStorage.setItem(WIDTH_KEY, '{"folder":500,"file":672}')
    別タブが書いた(OPEN_KEY)

    expect(result.current[0].folder).toBe(320)
  })
})

describe('いつ書くか', () => {
  it('動かしている最中は1回も書かない', () => {
    const { result } = renderHook(() => usePanelWidths())

    act(() => result.current[1].onGrab())
    act(() => result.current[1].onMove('folder', 400))
    act(() => result.current[1].onMove('folder', 420))

    // 毎フレーム書くと `localStorage` を叩き続ける（設計§5）
    expect(globalThis.localStorage.getItem(WIDTH_KEY)).toBeNull()
  })

  it('離した時点の値が正になる', () => {
    const { result } = renderHook(() => usePanelWidths())

    act(() => result.current[1].onGrab())
    act(() => result.current[1].onMove('folder', 400))
    act(() => result.current[1].onMove('folder', 420))
    act(() => result.current[1].onDrop())

    expect(readWidths()).toEqual({ folder: 420, file: 672 })
  })

  it('離したあとは、また別のタブの合図を受け取る', () => {
    const { result } = renderHook(() => usePanelWidths())

    act(() => result.current[1].onGrab())
    act(() => result.current[1].onDrop())

    globalThis.localStorage.setItem(WIDTH_KEY, '{"folder":500,"file":672}')
    別タブが書いた(WIDTH_KEY)

    expect(result.current[0].folder).toBe(500)
  })
})
