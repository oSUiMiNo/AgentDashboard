/**
 * LAN のアドレスを写すボタン（テスト計画フェーズ3）。
 *
 * # jsdom は `document.execCommand` を持っていない
 *
 * だから**この環境では必ず「写せなかった」側へ落ちる**。それは都合が悪いのではなく
 * **逃げ道を確かめる唯一の場所**である（設計§8-4）——実機で逃げ道を出すには、
 * まず新しい口も古い口も塞がった端末を用意しなければならない。
 *
 * 写せた側を見たいときは `navigator.clipboard.writeText` を差し替える。
 */

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LanAddressButton } from './LanAddressButton'
import { useLanAddressStore, type LanAddressView } from '@/stores/lanAddress'

function view(取り込み: Partial<LanAddressView> = {}): LanAddressView {
  return {
    port: 8787,
    bind_addr: '0.0.0.0',
    reachable: true,
    candidates: [{ addr: '192.168.0.12', label: 'Wi-Fi', source: 'windows' }],
    note: null,
    ...取り込み,
  }
}

/** その端末がどこを開いているか。**既定はループバックにしない**——LAN の端末が主役 */
function 開いている(origin: string, hostname: string) {
  vi.stubGlobal('location', { ...window.location, origin, hostname })
}

/** 写せる端末にする（既定の jsdom は写せない）。 */
function 写せる() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { ...window.navigator, clipboard: { writeText } })
  return writeText
}

beforeEach(() => {
  useLanAddressStore.setState({ view: null, loaded: false })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => view() }))
  開いている('http://192.168.0.12:8787', '192.168.0.12')
})

afterEach(() => {
  vi.unstubAllGlobals()
  useLanAddressStore.setState({ view: null, loaded: false })
})

describe('押せる／押せない', () => {
  it('候補が届くまで、押せない見た目になっている', () => {
    // ループバックで開いていて、サーバの答えもまだ——**押せるのに何も起きない、を作らない**
    開いている('http://localhost:8787', 'localhost')
    render(<LanAddressButton />)

    expect(screen.getByTestId('lan-address-copy')).toBeDisabled()
  })

  it('サーバの答えが未着でも、いま開いているアドレスだけで押せる', () => {
    // `location.origin` は同期で読めるので、§2 の制約に対してむしろ有利に働く
    render(<LanAddressButton />)

    expect(screen.getByTestId('lan-address-copy')).toBeEnabled()
  })
})

describe('押したとき', () => {
  it('http:// から始まり / で終わる形が入る', async () => {
    const writeText = 写せる()
    useLanAddressStore.setState({ view: view(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-copy'))

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const 写した = writeText.mock.calls[0]?.[0] as string
    // **裸の `192.168.0.12:8787` にしない**——Discord がリンクとして認識しない（設計§3）
    expect(写した.startsWith('http://')).toBe(true)
    expect(写した.endsWith('/')).toBe(true)
  })

  it('いま開いているアドレスが先に写る（実測は推定に勝つ）', async () => {
    const writeText = 写せる()
    useLanAddressStore.setState({ view: view(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-copy'))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('http://192.168.0.12:8787/'),
    )
  })

  it('成功の知らせに「開いた先で合言葉を聞かれます」が入る', async () => {
    写せる()
    useLanAddressStore.setState({ view: view(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-copy'))

    await waitFor(() =>
      expect(screen.getByTestId('lan-address-state')).toHaveTextContent(
        '開いた先で合言葉を聞かれます',
      ),
    )
  })

  it('`await` を跨がずに写しに行く（古い口の経路を通る）', async () => {
    // **jsdom は `execCommand` を持たない**ので、跨がずに着けば「写せなかった」が返る。
    // 跨いでいると平文 HTTP の端末で入らなくなる（設計§2）——ここが唯一の見張り
    useLanAddressStore.setState({ view: view(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-copy'))

    await waitFor(() =>
      expect(screen.getByTestId('lan-address-failed')).toBeInTheDocument(),
    )
  })
})

describe('写せなかったとき（逃げ道）', () => {
  it('値が選べる形で画面に出る', async () => {
    useLanAddressStore.setState({ view: view(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-copy'))

    await waitFor(() =>
      expect(screen.getByTestId('lan-address-failed')).toHaveTextContent(
        'コピーできません',
      ),
    )
    // **押して入る値と、逃げ道から取る値は同じでなければ意味が無い**
    expect(screen.getByTestId('lan-address-fallback')).toHaveTextContent(
      'http://192.168.0.12:8787/',
    )
  })

  it('値は選べる形で、折り返して最後まで見える', async () => {
    // **字で「選べます」と書くのではなく、指定そのものを見る**（`FolderBrowser` と同じ形）。
    // URL は途中で切れても文字列として成立して見えるので、`break-all` が要る
    useLanAddressStore.setState({ view: view(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-copy'))

    await waitFor(() => {
      const 値 = screen.getByTestId('lan-address-fallback')
      expect(値).toHaveClass('select-all')
      expect(値).toHaveClass('break-all')
    })
  })
})

describe('候補が複数のとき', () => {
  /** サーバが2件返した形。**いま開いている番号＋もう1件**になる */
  function 二件() {
    return view({
      candidates: [
        { addr: '192.168.0.12', label: 'Wi-Fi', source: 'windows' },
        { addr: '10.106.135.80', label: 'イーサネット', source: 'windows' },
      ],
    })
  }

  it('他の候補を選べる', async () => {
    useLanAddressStore.setState({ view: 二件(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-more'))

    // **食い違っても両方出す**（設計§4-6）。どちらが正しいかは渡した先で開くまで分からない
    const 選択肢 = await screen.findAllByTestId('lan-address-choice')
    expect(選択肢).toHaveLength(2)
    expect(選択肢[0]).toHaveTextContent('http://192.168.0.12:8787/')
    expect(選択肢[1]).toHaveTextContent('http://10.106.135.80:8787/')
  })

  it('選んだ候補が写る', async () => {
    const writeText = 写せる()
    useLanAddressStore.setState({ view: 二件(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-more'))
    const 選択肢 = await screen.findAllByTestId('lan-address-choice')
    await userEvent.click(選択肢[1] as HTMLElement)

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('http://10.106.135.80:8787/'),
    )
  })

  it('写した行にだけ、写したことが出る', async () => {
    // **上の1行は文が同じ**なので、2つ目を押しても変化が読めない。
    // どれを写したかは、その行で言う
    写せる()
    // **写したあとは取り直しが走る**（設計§2）。雛形を揃えておかないと、
    // 取り直しで候補が1件へ戻って面ごと消える
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => 二件() }),
    )
    useLanAddressStore.setState({ view: 二件(), loaded: true })
    render(<LanAddressButton />)

    await userEvent.click(screen.getByTestId('lan-address-more'))
    const 選択肢 = await screen.findAllByTestId('lan-address-choice')
    await userEvent.click(選択肢[1] as HTMLElement)

    await waitFor(() =>
      expect(
        screen.getAllByTestId('lan-address-choice-copied'),
      ).toHaveLength(1),
    )
    expect(選択肢[1]).toContainElement(
      screen.getByTestId('lan-address-choice-copied'),
    )
  })

  it('候補が1つなら「他の候補」を出さない', () => {
    // 押しても空の面が開くだけのものを置かない
    開いている('http://localhost:8787', 'localhost')
    useLanAddressStore.setState({ view: view(), loaded: true })
    render(<LanAddressButton />)

    expect(screen.queryByTestId('lan-address-more')).toBeNull()
  })
})

describe('二度目が押せる（成功の知らせを畳む）', () => {
  /**
   * **出しっぱなしにすると「もう一度写した」が読めない。**
   *
   * 利用者の指摘（2026-09-05）：「コピーボタンがいつまで経っても『コピーしました』
   * 状態から戻らずに再コピーできない」。**入っていたかどうかではなく、
   * 入ったことが読めるかどうか**の問題である。
   */
  it('しばらくすると、成功の知らせが畳まれる', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      写せる()
      useLanAddressStore.setState({ view: view(), loaded: true })
      render(<LanAddressButton />)

      await userEvent.click(screen.getByTestId('lan-address-copy'))
      await waitFor(() =>
        expect(screen.getByTestId('lan-address-state')).toBeInTheDocument(),
      )

      await act(async () => {
        vi.advanceTimersByTime(6000)
      })

      expect(screen.queryByTestId('lan-address-state')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('畳まれたあと、もう一度押すと知らせが出直す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const writeText = 写せる()
      useLanAddressStore.setState({ view: view(), loaded: true })
      render(<LanAddressButton />)

      await userEvent.click(screen.getByTestId('lan-address-copy'))
      await waitFor(() =>
        expect(screen.getByTestId('lan-address-state')).toBeInTheDocument(),
      )
      await act(async () => {
        vi.advanceTimersByTime(6000)
      })

      await userEvent.click(screen.getByTestId('lan-address-copy'))

      await waitFor(() =>
        expect(screen.getByTestId('lan-address-state')).toBeInTheDocument(),
      )
      // **二度目もちゃんと写している**（知らせだけ戻っても意味が無い）
      expect(writeText).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('押し直すと、畳むまでの時間も数え直す', async () => {
    // **前の予約を外さないと、二度目の知らせが1秒で消える。**
    // 一度目（t=0）の予約は t=6000 に効くので、t=5000 に押し直しても
    // t=6000 で畳まれてしまう
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      写せる()
      useLanAddressStore.setState({ view: view(), loaded: true })
      render(<LanAddressButton />)

      await userEvent.click(screen.getByTestId('lan-address-copy'))
      await waitFor(() =>
        expect(screen.getByTestId('lan-address-state')).toBeInTheDocument(),
      )
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })

      await userEvent.click(screen.getByTestId('lan-address-copy'))
      await waitFor(() =>
        expect(screen.getByTestId('lan-address-state')).toBeInTheDocument(),
      )
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })

      // 二度目から数えてまだ2秒。**残っていなければならない**
      expect(screen.getByTestId('lan-address-state')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('写せなかったときの逃げ道は畳まない（読んでいる最中に消さない）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      // jsdom は `execCommand` を持たないので、既定で失敗の側へ落ちる
      useLanAddressStore.setState({ view: view(), loaded: true })
      render(<LanAddressButton />)

      await userEvent.click(screen.getByTestId('lan-address-copy'))
      await waitFor(() =>
        expect(screen.getByTestId('lan-address-failed')).toBeInTheDocument(),
      )

      await act(async () => {
        vi.advanceTimersByTime(60000)
      })

      // **値を選んで取ってもらう逃げ道なので、消すと取りようが無くなる**
      expect(screen.getByTestId('lan-address-fallback')).toHaveTextContent(
        'http://192.168.0.12:8787/',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('広げていないとき', () => {
  it('コピーのボタンが出ず、広げ方の案内が出る', () => {
    // **押しても死んだアドレスしか渡らないボタンを置かない**（設計§8-3）
    useLanAddressStore.setState({
      view: view({ reachable: false, bind_addr: '127.0.0.1', candidates: [] }),
      loaded: true,
    })
    render(<LanAddressButton />)

    expect(screen.queryByTestId('lan-address-copy')).toBeNull()
    const 案内 = screen.getByTestId('lan-address-unreachable')
    // **何を触ればよいか**が名指しされていること
    expect(案内).toHaveTextContent('bind_addr')
    // **どこを読めばよいか**（手順書への導線・設計§8-3）
    expect(案内.querySelector('a')).toHaveAttribute(
      'href',
      expect.stringContaining('docs/setup/local.md'),
    )
  })
})

describe('候補が0個のとき', () => {
  it('理由が読める', () => {
    開いている('http://localhost:8787', 'localhost')
    useLanAddressStore.setState({
      view: view({ candidates: [], note: 'Windows へ聞けませんでした' }),
      loaded: true,
    })
    render(<LanAddressButton />)

    expect(screen.getByTestId('lan-address-note')).toHaveTextContent(
      'Windows へ聞けませんでした',
    )
  })
})

describe('置き場所を知らない（要件の完了条件8）', () => {
  it('自分で幅・余白・位置を持たない', () => {
    // **親から与えられる**（設計§8-1）。動かす日に触るのが `App.tsx` の1行と
    // この部品だけで済むようにするため
    useLanAddressStore.setState({ view: view(), loaded: true })
    const { container } = render(<LanAddressButton />)

    const 根 = container.firstElementChild as HTMLElement
    const 指定 = 根.className
    expect(指定).not.toMatch(/\b(ml-|mr-|mt-|mb-|m-)\d/)
    expect(指定).not.toMatch(/\bw-\d|\bmin-w-|\bmax-w-/)
    expect(指定).not.toMatch(/\b(absolute|fixed|sticky)\b/)
  })
})
