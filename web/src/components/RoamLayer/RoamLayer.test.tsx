import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoamLayer } from '@/components/RoamLayer/RoamLayer'
import { ROAM_KOMA } from '@/lib/roam'
import {
  ROAM_BIRTH_MS,
  ROAM_EXIT_DELAY_MS,
  ROAM_EXIT_MS,
  ROAM_FLIP_MS,
  ROAM_LIFE_MS,
  ROAM_MAX,
  emitRoam,
  resetRoam,
} from '@/stores/roam'
import { useSettingsStore } from '@/stores/settings'
import {
  clearReorderingStore,
  lowerReordering,
  raiseReordering,
} from '@/stores/reordering'

/**
 * 回遊の層（`components/RoamLayer`）。
 *
 * **ここが見るのは「並べ方」だけ。** 飛ぶかどうかは在庫（`stores/roam.ts`）が、
 * 止まるかどうかは CSS（`web/src/roam.test.ts`）が、それぞれ別に見ている。
 */

const 種 = {
  // 跳ねた瞬間に測った場の様子。**手で組み立てる**（jsdom の矩形は全部 0）
  field: {
    width: 1200,
    height: 900,
    card: { x: 12, y: 60, w: 288, h: 120 },
    rects: [
      { x: 0, y: 40, w: 900, h: 300 },
      { x: 12, y: 60, w: 288, h: 120 },
      { x: 312, y: 60, w: 288, h: 120 },
    ],
  },
  accent: '#f5a623',
  ink: '75%',
  quiet: 'lively' as const,
}

function 静けさ(値: 'lively' | 'calm' | 'still'): void {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, motion_quiet: 値 },
  }))
}

beforeEach(() => {
  resetRoam()
  静けさ('lively')
})

afterEach(() => {
  resetRoam()
  静けさ('lively')
})

describe('回遊の層', () => {
  it('線が無ければ何も描かない', () => {
    render(<RoamLayer />)
    // 器の SVG は1枚だけ居る（線を入れる袋）。**線は1本も居ない**
    expect(screen.queryAllByTestId('roam-line')).toHaveLength(0)
    expect(screen.queryAllByTestId('roam-paper')).toHaveLength(0)
  })

  it('読み上げの対象にしない', () => {
    // 状態は色・記号・文字が持っている。線は**飾り**なので読み上げさせない
    render(<RoamLayer />)
    expect(screen.getByTestId('roam-layer')).toHaveAttribute('aria-hidden', 'true')
  })

  it('在庫の線を1本ずつ並べる', () => {
    emitRoam(種)
    render(<RoamLayer />)
    const 本数 = screen.getAllByTestId('roam-line').length
    expect(本数).toBeGreaterThanOrEqual(2)
    // 線は SVG の直下に並ぶ（層 > svg > g）
    const svg = screen.getByTestId('roam-layer').querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.children).toHaveLength(本数)
  })

  it('線には経路（d）と色と濃さと節目が載る', () => {
    // **層は DOM を1度も読まない。** 値は在庫から来る
    emitRoam({ ...種, accent: '#123456', ink: '42%' })
    render(<RoamLayer />)
    const 線 = screen.getAllByTestId('roam-line')[0]
    expect(線.getAttribute('style')).toContain('--roam-accent: #123456')
    // **濃さもカードから配られる**（カード設計§9-7）。固定値で塗ると、同じ状態
    // なのに輪と線で色が食い違う
    expect(線.getAttribute('style')).toContain('--roam-ink: 42%')
    /*
      **経路は変数ではなく `d` に入っている**（フェーズ18。`d` は CSS 変数を
      読めない）。変数で渡るのは窓の動きの節目と、窓の長さの3態だけ。
    */
    for (const 変数 of [
      '--roam-s1:',
      '--roam-s2:',
      '--roam-s3:',
      '--roam-dash-closed:',
      '--roam-dash-open:',
      '--roam-dash-puff:',
    ]) {
      expect(線.getAttribute('style')).toContain(変数)
    }
    expect(線.getAttribute('style')).not.toContain('--roam-x0:')
    const 紙 = 線.querySelector('[data-testid="roam-paper"]')
    expect(紙?.getAttribute('d')).toMatch(/^M-?[\d.]+ -?[\d.]+L/)
  })

  it('線の中に紙片（コマ）が4枚入り、秒数と遅れが4本ぶん揃う', () => {
    /*
      **1本の線 ＝ path 4枚**（フェーズ18・設計§23-5）。4枚は波の位相を 90° ずつ
      送ったコマで、`opacity` の `steps(1)` が1枚ずつ見せる。

      **秒数はここでも層が渡す**（出どころを1つに保つ）。並びは `roam.css` の
      `animation-name`（発生・コマ・移動・退場）と1対1——**1本でも数が食い違うと
      CSS はリストを先頭から繰り返して別の秒数を食う**。エラーにならず、画面も
      動き続けるので、この検査でしか気づけない。
    */
    emitRoam(種)
    render(<RoamLayer />)
    const 線 = screen.getAllByTestId('roam-line')
    const 紙 = screen.getAllByTestId('roam-paper')
    expect(紙).toHaveLength(線.length * ROAM_KOMA)
    for (const [i, 一枚] of 紙.entries()) {
      expect(一枚.parentElement).toBe(線[Math.floor(i / ROAM_KOMA)])
      expect(一枚).toHaveAttribute('data-shape')
      // コマの番号がクラスで付く（`animation-name` は CSS 側の `.roam-koma-N` が持つ。
      // **インラインに書くと `animation: none` の打ち消しに勝ってしまう**）
      expect(一枚.getAttribute('class')).toContain(`roam-koma-${i % ROAM_KOMA}`)
      expect((一枚 as unknown as SVGPathElement).style.animationDuration).toBe(
        `${ROAM_BIRTH_MS}ms, ${ROAM_FLIP_MS}ms, ${ROAM_LIFE_MS}ms, ${ROAM_EXIT_MS}ms`,
      )
      /*
        **退場は寿命の終わりへ寄せる。** 遅れが明けるまで窓は開いたまま
        （`--roam-dash-open`）なので、飛んでいるあいだの見た目に退場は混ざらない。
        **線ごとに散らしてはいけない**——散らすと寿命の終わりと畳み終わりがずれる
      */
      expect((一枚 as unknown as SVGPathElement).style.animationDelay).toBe(
        `0ms, 0ms, 0ms, ${ROAM_EXIT_DELAY_MS}ms`,
      )
    }
  })

  it('コマ4枚は波の位相だけが違う＝同じ d が2枚無い', () => {
    // 「うねった道を通るだけ」に見えない仕掛け（設計§23-5）。同じ d が並んだら
    // コマを切り替えても絵が変わらない
    emitRoam(種)
    render(<RoamLayer />)
    const 線 = screen.getAllByTestId('roam-line')[0]
    const d = [...線.querySelectorAll('[data-testid="roam-paper"]')].map((p) =>
      p.getAttribute('d'),
    )
    expect(d).toHaveLength(ROAM_KOMA)
    expect(new Set(d).size).toBe(ROAM_KOMA)
  })

  it('捨てられた線（exiting）は、退場の遅れが 0 になる', () => {
    /*
      **上限で捨てられる線も退場を踏む**（要件15-4・フェーズ18）。店が `exiting` の
      印を付け、層が退場の遅れを 0 に差し替える——差し替えを忘れると、捨てられた
      線は**遅れが明けるまで見た目が何も変わらないまま**、店の除去で唐突に消える。
    */
    for (let i = 0; i < Math.ceil((ROAM_MAX + 1) / 3) + 1; i += 1) {
      emitRoam(種)
    }
    render(<RoamLayer />)
    const 退場中 = [...document.querySelectorAll('[data-testid="roam-paper"]')].filter((p) =>
      ((p as unknown as SVGPathElement).style.animationDelay ?? '').endsWith(', 0ms'),
    )
    expect(退場中.length).toBeGreaterThan(0)
    expect(退場中.length % ROAM_KOMA).toBe(0)
  })
})

describe('静けさの印', () => {
  it('賑やかのときは属性を出さない', () => {
    // カードの器と同じ作法（設計§9-5-3）。出さないことが「何も止めない」を表す
    静けさ('lively')
    render(<RoamLayer />)
    expect(screen.getByTestId('roam-layer')).not.toHaveAttribute('data-quiet')
  })

  it('控えめ・静止のときは段を印として出す', () => {
    // **止める分岐は CSS 側に置く。** ここで線を消すと、CSS の打ち消しが空振りしても
    // 気づけなくなる（二枚重ねの意味が消える）
    for (const 段 of ['calm', 'still'] as const) {
      静けさ(段)
      const { unmount } = render(<RoamLayer />)
      expect(screen.getByTestId('roam-layer')).toHaveAttribute('data-quiet', 段)
      unmount()
    }
  })
})

describe('盤面が変わったら引き直す（引き金）', () => {
  /*
    **見張りも「仕事を作らない」門の内側に置く**（設計§20-5-7）。
    `stores/roam.ts` は「止まっていれば DOM もタイマも1つも生えない」を守っており、
    **見張りだけが例外になってはいけない。**

    **線が出ないことだけを見ると、見張りが回っていても緑になる**ので、
    **繋いだ数**を数える。
  */
  let 繋いだ = 0
  /**
   * 見張りへ渡した受け口。
   *
   * **記録を受け取れる形にしてある。** `MutationObserver` の受け口は
   * **どの節点が動いたか**を引数で受け取り、`RoamLayer` はそれを見て
   * 「効果線そのものの出入りか」を判じている。引数なしの型にすると、
   * **その判じ方を試験できない**（型検査で弾かれる）
   */
  let 合図: ((記録?: { target: Node }[]) => void)[] = []
  let 元Mutation: typeof MutationObserver
  let 元Resize: typeof ResizeObserver

  beforeEach(() => {
    繋いだ = 0
    合図 = []
    元Mutation = globalThis.MutationObserver
    元Resize = globalThis.ResizeObserver
    class 数える見張り {
      constructor(受ける: (記録?: { target: Node }[]) => void) {
        合図.push(受ける)
      }
      observe() {
        繋いだ += 1
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return []
      }
    }
    globalThis.MutationObserver = 数える見張り as unknown as typeof MutationObserver
    globalThis.ResizeObserver = 数える見張り as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    globalThis.MutationObserver = 元Mutation
    globalThis.ResizeObserver = 元Resize
    vi.useRealTimers()
    clearReorderingStore()
  })

  function 場ごと描く(): void {
    render(
      <div data-roam-field>
        <RoamLayer />
      </div>,
    )
  }

  it('賑やかなら、場を見張る', () => {
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'lively' },
    }))
    場ごと描く()
    expect(繋いだ).toBeGreaterThan(0)
  })

  it('「控えめ」「静止」では、見張りを1つも繋がない', () => {
    for (const quiet of ['calm', 'still'] as const) {
      繋いだ = 0
      cleanup()
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, motion_quiet: quiet },
      }))
      場ごと描く()
      expect(繋いだ).toBe(0)
    }
  })

  it('OS が「動きを減らす」と言っていれば、見張りを1つも繋がない', () => {
    const 元 = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    try {
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, motion_quiet: 'lively' },
      }))
      場ごと描く()
      expect(繋いだ).toBe(0)
    } finally {
      window.matchMedia = 元
    }
  })

  it('連続した変化は、まとめて1回になる', () => {
    /*
      **窓を掴んで動かしている間は毎フレーム変わる**（設計§20-5-4）。
      **少し待ってから1回だけ**引き直し、待つ間は古い道のまま泳がせる。

      **線の見た目だけを見ると、毎フレーム引き直していても同じに見えて緑になる**
      （テスト計画の壊し方）。**待ちの数**を数える。

      **`toFake` を絞る**——既定の偽装は `requestAnimationFrame` も差し替える
      （`SessionTile.test.tsx` の前例と同じ理由）。
    */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'lively' },
    }))
    場ごと描く()
    expect(合図.length).toBeGreaterThan(0)

    // 掴んで動かしている最中のつもりで、立て続けに知らせる
    for (let i = 0; i < 20; i += 1) 合図[0]()

    // **待ちは1本だけ。** 変化のたびに引き直す形なら 0 本（もう走ってしまっている）、
    // 待ちを積み増す形なら 20 本になる
    expect(vi.getTimerCount()).toBe(1)
  })

  it('並べ替えの印が立っている間は記録を捨て、降りたら1回だけ引き直す', () => {
    /*
      **並べ替え中の引き直しが「たまにカクつく」の主犯だった**（並べ替え設計§15-1。
      同じ操作が線の有無だけで 7.7倍、単発 805ms）。待ち直しでは束ねられない——
      指を止めた瞬間に 250ms 経って走る。**立っている間は捨て、降りたときに1回**。

      「線が出ない」では見分けられない。**待ちの本数**を数える。
    */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'lively' },
    }))
    場ごと描く()
    const 主 = {}
    raiseReordering(主)

    // 運んでいる最中のつもりで、盤面の変化を立て続けに知らせる
    for (let i = 0; i < 20; i += 1) 合図[0]()
    expect(vi.getTimerCount(), '並べ替え中に引き直そうとしている').toBe(0)

    // 降りたら1回だけ
    lowerReordering(主)
    expect(vi.getTimerCount(), '降りたのに引き直していない').toBe(1)
  })

  it('印が立った瞬間に、積んであった待ちを捨てる', () => {
    // 掴む直前の記録で走ろうとしているものは、掴んでいる最中に発火する。**それも止める**
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'lively' },
    }))
    場ごと描く()
    合図[0]()
    expect(vi.getTimerCount()).toBe(1)

    const 主 = {}
    raiseReordering(主)
    expect(vi.getTimerCount(), '立ったのに待ちが残っている').toBe(0)
    lowerReordering(主)
  })

  it('外れたあとは、印が上がり下がりしても何も積まない', () => {
    // 購読を残すと、消えた層のために引き直そうとする
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'lively' },
    }))
    場ごと描く()
    cleanup()
    const 主 = {}
    raiseReordering(主)
    lowerReordering(主)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('効果線そのものの出入りでは、引き直さない', () => {
    /*
      **層は場の中に居る**（設計§9-7-5）ので、場の部分木をそのまま見張ると
      **線が1本生まれるたびに `childList` が動く**。それを盤面の変化と数えると、
      **生まれたばかりの線を添字0で引き直す**ことになり、引き直しは巻きを持たない
      普通の歩きを返すので**巻きが丸ごと消える**。

      **実測（8790・32本）では、巻きの区間が 11.7px であるべきところ全部 55px で、
      1本も巻きが残っていなかった**（2026-08-28・フェーズ15）。経路が変わるだけなので
      絵としては破綻せず、**線が真っ直ぐな棒だったフェーズ14 までは気づけなかった。**

      **「線が出ない」では見分けられない**（引き直しても線は出る）。**待ちが積まれるか**を数える。
    */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'lively' },
    }))
    場ごと描く()

    const 層 = screen.getByTestId('roam-layer')
    const 線 = document.createElement('i')
    線.setAttribute('data-testid', 'roam-line')
    層.appendChild(線)

    // 層の中だけが動いた——**盤面は動いていない**
    合図[0]([{ target: 線 }, { target: 層 }])
    expect(vi.getTimerCount(), '線の出入りで引き直そうとしている').toBe(0)

    // カードが増えた——**こちらは引き直す**
    const カード = document.createElement('div')
    カード.setAttribute('data-testid', 'tile-shell')
    層.parentElement?.appendChild(カード)
    合図[0]([{ target: カード }])
    expect(vi.getTimerCount(), '盤面が動いたのに引き直していない').toBe(1)
  })
})
