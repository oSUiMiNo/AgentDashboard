/**
 * エクスプローラ・VSCode で開く口の画面（サイドバーにエクスプローラで開くボタンが欲しい
 * 設計§7・テスト計画フェーズ5）。
 *
 * **描き方を2つに分ける。** 出し分けと押した先はサイドバーの `FolderTree.test.tsx` が
 * `openIn` を直に渡して見る（巡回を混ぜない）。ここに残すのは、開く口を持たない追加シートの
 * 形と、読み直しと止まり方（`useOpenIn` を `renderHook` で見る）。
 *
 * **見た目はここでは確かめていない。** jsdom は CSS を当てないので、置き場所・色・
 * 重なりは実ブラウザで撮って確かめる（フェーズ6）。
 */

import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FolderBrowser } from '@/components/FolderBrowser/FolderBrowser'
import { useOpenIn, 親PCでないときの間引き, 開く口を読み直す間隔 } from '@/components/OpenIn/useOpenIn'
import type { OpenInView } from '@/lib/openIn'

const pushReplyNotice = vi.hoisted(() => vi.fn())
vi.mock('@/stores/appNotices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/appNotices')>()
  return { ...actual, pushReplyNotice }
})

const ROOT = '/home/me/dev/app'

function listing() {
  return {
    path: ROOT,
    entries: [
      { name: 'MyDocs', kind: 'dir' as const, is_project: false },
      { name: '計画.md', kind: 'file' as const, is_project: false },
      { name: 'sub', kind: 'dir' as const, is_project: true },
    ],
    truncated: false,
  }
}

function view(over: Partial<OpenInView> = {}): OpenInView {
  return {
    same_machine: true,
    same_machine_reason: null,
    explorer: { available: true, reason: null },
    vscode: { available: true, reason: null },
    opened: [],
    ...over,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  pushReplyNotice.mockReset()
})

describe('追加シートの形（開く口を渡さない FolderBrowser）', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing()), { status: 200 })),
    )
  })

  function 置く() {
    render(<FolderBrowser host="local" start={ROOT} root={ROOT} />)
  }

  async function 行(name: string) {
    const 行たち = await screen.findAllByTestId('folder-entry')
    const found = 行たち.find((e) => e.getAttribute('data-name') === name)
    if (found === undefined) {
      throw new Error(`行 ${name} が無い`)
    }
    return found
  }

  async function 右クリック(name: string) {
    const 器 = (await 行(name)).closest('li')
    if (器 === null) {
      throw new Error(`行 ${name} の li が無い`)
    }
    await userEvent.pointer({ keys: '[MouseRight]', target: 器 })
    return await screen.findByTestId('folder-menu')
  }

  it('追加シートの形（openIn 無し）には、ボタンも項目も印も無い', async () => {
    置く()
    await 行('計画.md')
    // **testid は完全一致で探す**（`getByTestId` は完全一致。部分一致は空振りする）
    expect(screen.queryByTestId('open-in-buttons')).toBeNull()
    expect(screen.queryByTestId('folder-crumbs-row')).toBeNull()
    expect(screen.queryByTestId('folder-opened-mark')).toBeNull()
    // **外枠を作らない。** パンくずの親は今と同じ `folder-browser` のまま
    expect(screen.getByTestId('folder-crumbs').parentElement).toBe(
      screen.getByTestId('folder-browser'),
    )
    for (const name of ['MyDocs', '計画.md']) {
      const メニュー = await 右クリック(name)
      expect(within(メニュー).getByTestId('folder-menu-copy-abs')).toBeInTheDocument()
      expect(within(メニュー).queryByTestId('folder-menu-open-explorer')).toBeNull()
      expect(within(メニュー).queryByTestId('folder-menu-open-vscode')).toBeNull()
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByTestId('folder-menu')).toBeNull())
    }
  })

  it('開く口が無ければ、PJT の札は今のまま行末へ寄る', async () => {
    置く()
    const 札 = within(await 行('sub')).getByTestId('folder-project-mark')
    expect(札.className).toContain('ml-auto')
    expect(札).toHaveTextContent('PJT')
  })
})

describe('useOpenIn の読み直しと押したとき', () => {
  const 様子 = view({ opened: [] })

  function 順に答える(...answers: Array<() => Response | Promise<Response>>) {
    let at = 0
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        throw new Error('POST はこの偽物では受けない')
      }
      const answer = answers[Math.min(at, answers.length - 1)]
      at += 1
      return await answer()
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function 落ち着かせる() {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve()
      }
    })
  }

  async function 間隔を進める() {
    await act(async () => {
      vi.advanceTimersByTime(開く口を読み直す間隔)
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve()
      }
    })
  }

  const 成功 = (v: OpenInView) => () => new Response(JSON.stringify(v), { status: 200 })

  it('親PC でないと分かったら、読み直しを間引き、親PC に戻ればまた3秒おきに読む', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fetchMock = 順に答える(
        成功(view({ same_machine: false, same_machine_reason: 'LAN' })),
        成功(様子),
      )
      const { result } = renderHook(() => useOpenIn('local'))
      await 落ち着かせる()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // 答えは捨てない（出さないと決めるのは FolderBrowser の側）
      expect(result.current.view?.same_machine).toBe(false)
      for (let i = 0; i < 親PCでないときの間引き - 1; i += 1) {
        await 間隔を進める()
      }
      expect(fetchMock, '親PC でない間は3秒おきに引かないこと').toHaveBeenCalledTimes(1)
      await 間隔を進める()
      expect(fetchMock, '間引いた回数の後には引き直すこと（一時の外れから戻れるように）').toHaveBeenCalledTimes(2)
      expect(result.current.view?.same_machine).toBe(true)
      await 間隔を進める()
      expect(fetchMock, '親PC に戻ったら3秒おきに戻ること').toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('親PC なら読み直しを続ける', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fetchMock = 順に答える(成功(様子))
      renderHook(() => useOpenIn('local'))
      await 落ち着かせる()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await 間隔を進める()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await 間隔を進める()
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('一時的に聞けなくても、前の答えを保って読み直す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fetchMock = 順に答える(
        成功(様子),
        () => {
          throw new TypeError('Failed to fetch')
        },
        成功(様子),
      )
      const { result } = renderHook(() => useOpenIn('local'))
      await 落ち着かせる()
      expect(result.current.view).toEqual(様子)
      await 間隔を進める()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      // **瞬断で消さない**（消すと、そのサイドバーではボタンが二度と出なくなる）
      expect(result.current.view).toEqual(様子)
      await 間隔を進める()
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('口が無い（501・HTML）なら何も出さず、読み直しも止める', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      for (const 答え of [
        () => new Response('', { status: 501 }),
        () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ]) {
        const fetchMock = 順に答える(答え)
        const { result, unmount } = renderHook(() => useOpenIn('local'))
        await 落ち着かせる()
        expect(result.current.view).toBeNull()
        await 間隔を進める()
        await 間隔を進める()
        expect(fetchMock).toHaveBeenCalledTimes(1)
        unmount()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('押した答えをすぐ映し、失敗は知らせる', async () => {
    const 開いた様子 = view({ opened: [{ path: ROOT, real: ROOT, kind: 'dir', since_ms: 5 }] })
    const 断り = 'このブラウザは親PC の上で開かれていないので、窓を開けません。親PC では localhost で開いてください'
    let POSTの答え: () => Response = () =>
      new Response(JSON.stringify({ outcome: 'opened', view: 開いた様子 }), { status: 200 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST' ? POSTの答え() : new Response(JSON.stringify(様子), { status: 200 }),
      ),
    )
    const { result } = renderHook(() => useOpenIn('local'))
    await waitFor(() => expect(result.current.view).toEqual(様子))

    act(() => result.current.open('vscode', ROOT))
    await waitFor(() => expect(result.current.view).toEqual(開いた様子))
    expect(pushReplyNotice).not.toHaveBeenCalled()

    POSTの答え = () => new Response(断り, { status: 403 })
    act(() => result.current.open('vscode', ROOT))
    await waitFor(() => expect(pushReplyNotice).toHaveBeenCalledWith(断り))
    expect(result.current.busy).toBe(false)
  })

  it('遅れて届いた読み直しの答えは、押した直後の答えを上書きしない', async () => {
    const 開いた様子 = view({ opened: [{ path: ROOT, real: ROOT, kind: 'dir', since_ms: 5 }] })
    let GETを解く: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ outcome: 'opened', view: 開いた様子 }), { status: 200 })
        }
        return await new Promise<Response>((resolve) => {
          GETを解く = resolve
        })
      }),
    )
    const { result } = renderHook(() => useOpenIn('local'))
    act(() => result.current.open('vscode', ROOT))
    await 落ち着かせる()
    expect(result.current.view?.opened.map((o) => o.path)).toEqual([ROOT])

    await act(async () => {
      GETを解く(new Response(JSON.stringify(様子), { status: 200 }))
      await Promise.resolve()
    })
    await 落ち着かせる()
    expect(
      result.current.view?.opened.map((o) => o.path),
      '遅い読み直しの答えで、押した直後の印が消えないこと',
    ).toEqual([ROOT])
  })

  it('host が変わったら、前の host の答えは捨てる', async () => {
    const aの様子 = view({ vscode: { available: false, reason: 'a の答え' } })
    const bの様子 = view({ vscode: { available: false, reason: 'b の答え' } })
    let aを解く: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/hosts/a/open')) {
          return await new Promise<Response>((resolve) => {
            aを解く = resolve
          })
        }
        return new Response(JSON.stringify(bの様子), { status: 200 })
      }),
    )
    const { result, rerender } = renderHook(({ host }) => useOpenIn(host), {
      initialProps: { host: 'a' },
    })
    rerender({ host: 'b' })
    await 落ち着かせる()
    expect(result.current.view?.vscode.reason).toBe('b の答え')

    await act(async () => {
      aを解く(new Response(JSON.stringify(aの様子), { status: 200 }))
      await Promise.resolve()
    })
    await 落ち着かせる()
    expect(result.current.view?.vscode.reason, '前の host の遅い答えで、今の host の様子を上書きしないこと').toBe(
      'b の答え',
    )
  })

  it('答えを待つ間は二度押しできない', async () => {
    let 解く: (r: Response) => void = () => {}
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return await new Promise<Response>((resolve) => {
          解く = resolve
        })
      }
      return new Response(JSON.stringify(様子), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useOpenIn('local'))
    await waitFor(() => expect(result.current.view).toEqual(様子))

    act(() => {
      result.current.open('explorer', ROOT)
      result.current.open('explorer', ROOT)
    })
    act(() => result.current.open('explorer', ROOT))
    const POSTの数 = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length
    expect(POSTの数()).toBe(1)
    expect(result.current.busy).toBe(true)

    await act(async () => {
      解く(new Response(JSON.stringify({ outcome: 'launched', view: 様子 }), { status: 200 }))
      await Promise.resolve()
    })
    await waitFor(() => expect(result.current.busy).toBe(false))
  })
})
