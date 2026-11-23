/**
 * エクスプローラ・VSCode で開く口の画面（サイドバーにエクスプローラで開くボタンが欲しい
 * 設計§7・テスト計画フェーズ5）。
 *
 * **描き方を2つに分ける。** 出し分けと押した先は `FolderBrowser` に `openIn` を直に
 * 渡して見る（巡回を混ぜない）。読み直しと止まり方は `useOpenIn` を `renderHook` で見る。
 *
 * **見た目はここでは確かめていない。** jsdom は CSS を当てないので、置き場所・色・
 * 重なりは実ブラウザで撮って確かめる（フェーズ6）。
 */

import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FolderBrowser } from '@/components/FolderBrowser/FolderBrowser'
import { useOpenIn, 開く口を読み直す間隔 } from '@/components/OpenIn/useOpenIn'
import type { OpenApp, OpenInView } from '@/lib/openIn'

const pushReplyNotice = vi.hoisted(() => vi.fn())
vi.mock('@/stores/appNotices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/appNotices')>()
  return { ...actual, pushReplyNotice }
})

const ROOT = '/home/me/dev/app'
const FOLDER = `${ROOT}/MyDocs`
const FILE = `${ROOT}/計画.md`
const PJT = `${ROOT}/sub`

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

type OpenInProp = { view: OpenInView; open: (app: OpenApp, path: string) => void; busy: boolean }

afterEach(() => {
  vi.unstubAllGlobals()
  pushReplyNotice.mockReset()
})

describe('サイドバーの出し分けと押した先', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing()), { status: 200 })),
    )
  })

  function 置く(openIn?: OpenInProp) {
    render(
      <FolderBrowser
        host="local"
        start={ROOT}
        root={ROOT}
        onPickFile={vi.fn()}
        openIn={openIn}
      />,
    )
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
    await userEvent.pointer({ keys: '[MouseRight]', target: await 行(name) })
    return await screen.findByTestId('folder-menu')
  }

  it('追加シートの形（openIn 無し）には、ボタンも項目も印も無い', async () => {
    置く(undefined)
    await 行('計画.md')
    // **testid は完全一致で探す**（`getByTestId` は完全一致。部分一致は空振りする）
    expect(screen.queryByTestId('open-in-buttons')).toBeNull()
    expect(screen.queryByTestId('folder-crumbs-row')).toBeNull()
    expect(screen.queryByTestId('folder-opened-mark')).toBeNull()
    // **外枠を作らない。** パンくずの親は今と同じ `folder-browser` のまま
    expect(screen.getByTestId('folder-crumbs').parentElement).toBe(
      screen.getByTestId('folder-browser'),
    )
    const メニュー = await 右クリック('計画.md')
    expect(within(メニュー).queryByTestId('folder-menu-open-explorer')).toBeNull()
    expect(within(メニュー).queryByTestId('folder-menu-open-vscode')).toBeNull()
  })

  it('親PC でないと分かったら、何も出さない', async () => {
    置く({ view: view({ same_machine: false, same_machine_reason: 'LAN の端末' }), open: vi.fn(), busy: false })
    await 行('計画.md')
    expect(screen.queryByTestId('open-in-buttons')).toBeNull()
    expect(screen.queryByTestId('folder-crumbs-row')).toBeNull()
    const メニュー = await 右クリック('計画.md')
    expect(within(メニュー).queryByTestId('folder-menu-open-explorer')).toBeNull()
    expect(within(メニュー).queryByTestId('folder-menu-open-vscode')).toBeNull()
  })

  it('親PC なら、2つのボタンと2つの項目が出る', async () => {
    置く({ view: view(), open: vi.fn(), busy: false })
    await 行('計画.md')
    const 器 = screen.getByTestId('open-in-buttons')
    expect(within(器).getByTestId('open-in-explorer')).toBeEnabled()
    expect(within(器).getByTestId('open-in-vscode')).toBeEnabled()
    // 器はパンくずの行の外枠の中、パンくずの右
    const 外枠 = screen.getByTestId('folder-crumbs-row')
    expect(Array.from(外枠.children).map((e) => e.getAttribute('data-testid'))).toEqual([
      'folder-crumbs',
      'open-in-buttons',
    ])

    for (const name of ['計画.md', 'MyDocs']) {
      const メニュー = await 右クリック(name)
      expect(within(メニュー).getByTestId('folder-menu-open-explorer')).toHaveTextContent(
        'エクスプローラで開く',
      )
      expect(within(メニュー).getByTestId('folder-menu-open-vscode')).toHaveTextContent(
        'VSCode で開く',
      )
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByTestId('folder-menu')).toBeNull())
    }
  })

  it('右クリックの項目は「新しいタブで開く」の後、「絶対パスをコピー」の前に並ぶ', async () => {
    置く({ view: view(), open: vi.fn(), busy: false })
    const メニュー = await 右クリック('計画.md')
    const 並び = Array.from(メニュー.querySelectorAll("[data-testid^='folder-menu-']")).map((e) =>
      e.getAttribute('data-testid'),
    )
    expect(並び).toEqual([
      'folder-menu-open-tab',
      'folder-menu-open-explorer',
      'folder-menu-open-vscode',
      'folder-menu-copy-abs',
    ])
  })

  it('使えない道具は押せず、理由が出る', async () => {
    const エクスプローラの理由 = 'WSL の上で動いていないので、エクスプローラはありません'
    const VSCodeの理由 = 'VSCode が見つかりません（PATH と既定の入れ場所を探しました）'
    置く({
      view: view({
        explorer: { available: false, reason: エクスプローラの理由 },
        vscode: { available: false, reason: VSCodeの理由 },
      }),
      open: vi.fn(),
      busy: false,
    })
    await 行('計画.md')
    const エクスプローラ = screen.getByTestId('open-in-explorer')
    const VSCode = screen.getByTestId('open-in-vscode')
    // **押せないときもボタンの名前を先に残す**——理由だけだと2つが同じ名前になる
    const エクスプローラの説明 = `エクスプローラで開く（使えません：${エクスプローラの理由}）`
    const VSCodeの説明 = `VSCode で開く（使えません：${VSCodeの理由}）`
    expect(エクスプローラ).toBeDisabled()
    expect(エクスプローラ).toHaveAttribute('title', エクスプローラの説明)
    expect(エクスプローラ).toHaveAttribute('aria-label', エクスプローラの説明)
    // **押せないボタンは乗せても title が出ない**ので、外側の span にも同じ文がある
    expect(エクスプローラ.parentElement).toHaveAttribute('title', エクスプローラの説明)
    expect(VSCode).toBeDisabled()
    expect(VSCode).toHaveAttribute('title', VSCodeの説明)
    expect(VSCode).toHaveAttribute('aria-label', VSCodeの説明)
    expect(VSCode.parentElement).toHaveAttribute('title', VSCodeの説明)
    expect(エクスプローラ.getAttribute('aria-label')).not.toBe(VSCode.getAttribute('aria-label'))

    const メニュー = await 右クリック('計画.md')
    const 項目1 = within(メニュー).getByTestId('folder-menu-open-explorer')
    const 項目2 = within(メニュー).getByTestId('folder-menu-open-vscode')
    expect(項目1).toHaveAttribute('data-disabled')
    expect(項目1).toHaveAttribute('title', エクスプローラの理由)
    expect(項目2).toHaveAttribute('data-disabled')
    expect(項目2).toHaveAttribute('title', VSCodeの理由)
    // 押せない項目は radix が pointer-events を切るので、中の span にも理由を置く
    expect(項目1.querySelector('span[title]')).toHaveAttribute('title', エクスプローラの理由)
  })

  it('ボタンは PJT のルートを、項目はその行のパスを開く', async () => {
    const open = vi.fn()
    置く({ view: view(), open, busy: false })
    await 行('計画.md')
    await userEvent.click(screen.getByTestId('open-in-explorer'))
    await userEvent.click(screen.getByTestId('open-in-vscode'))
    expect(open.mock.calls).toEqual([
      ['explorer', ROOT],
      ['vscode', ROOT],
    ])

    let メニュー = await 右クリック('計画.md')
    await userEvent.click(within(メニュー).getByTestId('folder-menu-open-vscode'))
    メニュー = await 右クリック('MyDocs')
    await userEvent.click(within(メニュー).getByTestId('folder-menu-open-explorer'))
    expect(open.mock.calls.slice(2)).toEqual([
      ['vscode', FILE],
      ['explorer', FOLDER],
    ])
  })

  it('VSCode で開いているものには印が付き、文言が変わる', async () => {
    置く({
      view: view({
        opened: [
          { path: ROOT, kind: 'dir', since_ms: 1 },
          { path: FILE, kind: 'file', since_ms: 2 },
        ],
      }),
      open: vi.fn(),
      busy: false,
    })
    const ファイル = await 行('計画.md')
    const VSCode = screen.getByTestId('open-in-vscode')
    expect(VSCode).toHaveAttribute('data-open', 'true')
    expect(VSCode).toHaveAttribute('title', 'VSCode で開いています：app（押すと窓を前に出します）')
    expect(screen.getByTestId('open-in-explorer')).not.toHaveAttribute('data-open')

    const 印たち = screen.getAllByTestId('folder-opened-mark')
    expect(印たち).toHaveLength(1)
    expect(ファイル.contains(印たち[0])).toBe(true)
    expect((await 行('MyDocs')).querySelector("[data-testid='folder-opened-mark']")).toBeNull()

    const メニュー = await 右クリック('計画.md')
    expect(within(メニュー).getByTestId('folder-menu-open-vscode')).toHaveTextContent(
      'VSCode で開いています（前に出す）',
    )
  })

  it('PJT の札と開いている印は、両方とも行末に並ぶ', async () => {
    置く({
      view: view({ opened: [{ path: PJT, kind: 'dir', since_ms: 1 }] }),
      open: vi.fn(),
      busy: false,
    })
    const 行sub = await 行('sub')
    const 印 = within(行sub).getByTestId('folder-opened-mark')
    const 札 = within(行sub).getByTestId('folder-project-mark')
    expect(印.parentElement).toBe(札.parentElement)
    expect(Array.from(印.parentElement?.children ?? [])).toEqual([印, 札])
    // 行末へ寄せるのは入れ物の側
    expect(印.parentElement?.className).toContain('ml-auto')
    expect(札.className).not.toContain('ml-auto')
  })

  it('開く口が無ければ、PJT の札は今のまま行末へ寄る', async () => {
    置く(undefined)
    const 札 = within(await 行('sub')).getByTestId('folder-project-mark')
    expect(札.className).toContain('ml-auto')
    expect(札).toHaveTextContent('PJT')
  })

  it('答えを待つ間のボタンは薄くせず、aria-busy だけ立てる', async () => {
    置く({ view: view(), open: vi.fn(), busy: true })
    await 行('計画.md')
    for (const id of ['open-in-explorer', 'open-in-vscode']) {
      const ボタン = screen.getByTestId(id)
      expect(ボタン).toHaveAttribute('aria-busy', 'true')
      expect(ボタン).toBeEnabled()
    }
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

  it('親PC でないと分かったら、読み直しを止める', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fetchMock = 順に答える(成功(view({ same_machine: false, same_machine_reason: 'LAN' })))
      const { result } = renderHook(() => useOpenIn('local'))
      await 落ち着かせる()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // 答えは捨てない（出さないと決めるのは FolderBrowser の側）
      expect(result.current.view?.same_machine).toBe(false)
      for (let i = 0; i < 3; i += 1) {
        await 間隔を進める()
      }
      expect(fetchMock).toHaveBeenCalledTimes(1)
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
    const 開いた様子 = view({ opened: [{ path: ROOT, kind: 'dir', since_ms: 5 }] })
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
