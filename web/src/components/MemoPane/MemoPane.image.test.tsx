import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GLOBAL_TARGET, sessionTarget } from '@/lib/annotationTarget'
import { anyComposerBusy } from '@/lib/composerBusy'
import { clearMemos } from '@/stores/memos'
import { useWsStore } from '@/stores/ws'

/*
  **エディタを差し替えて、渡ってきた props を見る。**

  BlockNote を本物のまま立てても、jsdom では**画像を貼る操作が再現できない**ので、
  「口が開いているか」を確かめられない。ここで見たいのは**面がエディタへ何を渡すか**
  だけなので、エディタの中身は要らない。

  **本物を立てる筋は `MemoPane.test.tsx` に在る**（Ctrl+Enter の押し分けなど）。
  こちらは別ファイルにして、あちらのモックを汚さない。
*/
const 渡ってきた: {
  onUploadImage?: (file: File) => Promise<string>
  on抱える?: (v: boolean) => void
}[] = []
vi.mock('./MemoEditor', () => ({
  MemoEditor: (props: Record<string, unknown>) => {
    渡ってきた.push(props as never)
    return <div data-testid={props['data-testid'] as string} />
  },
}))

const { MemoPane } = await import('./MemoPane')

beforeEach(() => {
  渡ってきた.length = 0
  clearMemos()
  useWsStore.setState({
    memoList: vi.fn(),
    memoAdd: vi.fn(),
    memoEdit: vi.fn(),
    memoCheck: vi.fn(),
    memoRemove: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  clearMemos()
})

describe('画像の口を開ける条件', () => {
  it('保存先を渡さなければ、口を開けない', () => {
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    // **置き場所が決まっていないものを黙って既定へ倒さない**
    expect(渡ってきた[0]?.onUploadImage).toBeUndefined()
  })

  it('全体メモにも口が開く（保管はサーバの記録）', () => {
    /*
      **帰属と保管を揃える**（設計§10-1 の【決着】）。全体メモはアカウントに属する
      ので、本文と同じ記録へ置く——**要件9（同じ部品・同じ口）は保たれており、
      割れるのは保管先だけ**である。
    */
    render(
      <MemoPane
        target={GLOBAL_TARGET}
        label="全体のメモ"
        保存先={{ where: 'account' }}
      />,
    )

    expect(渡ってきた[0]?.onUploadImage).toBeTypeOf('function')
  })

  it('保存先を渡すと口が開く（セッションメモ）', () => {
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )

    expect(渡ってきた[0]?.onUploadImage).toBeTypeOf('function')
  })

  it('読むだけの面には入力欄そのものが出ない（抜け殻のカード）', () => {
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        readOnly
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )

    expect(screen.queryByTestId('memo-compose')).toBeNull()
  })
})

describe('直すときにも貼れる（要件2）', () => {
  it('鉛筆から開いたエディタにも、同じ口が渡る', async () => {
    const { replaceMemos } = await import('@/stores/memos')
    const target = sessionTarget('s-1')
    replaceMemos(target, [
      { id: 'm-1', body: { blocks: [], markdown: 'あ' }, noted_at: 1_700_000_000_000 },
    ])

    render(
      <MemoPane
        target={target}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )
    渡ってきた.length = 0
    fireEvent.mouseDown(screen.getByTestId('memo-edit'))

    /*
      **要件2 は「後から編集する際に添付画像の追加と削除も可能」と書いている。**
      書くときだけ口を開けて直すときに閉じると、**貼った絵を剥がせないメモ**ができる。

      口はエディタが持っているので、**渡し忘れても画面は動く**——だから
      機械が捕まえない側であり、ここで固定する。
    */
    expect(渡ってきた[0]?.onUploadImage).toBeTypeOf('function')
  })
})

describe('いつ消えるかの表示（要件10・設計§11-3）', () => {
  it('**設定で変えた値が文言に出る。** 固定文言に戻すと落ちる', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { settingsFixture } = await import('@/test/fixtures')

    useSettingsStore.setState({
      settings: settingsFixture({
        memo_limits: { retention_days: 30, max_bytes: 1024 * 1024 * 1024 },
      }),
    })
    render(<MemoPane target={sessionTarget('s-1')} label="このセッションのメモ"
        保存先={null}
      />)

    /*
      **90日のまま「3か月」と書いてあると、30日へ縮めた人には3倍の嘘になる**
      （設計§11-3 が名指しで禁じている形）。文言を固定へ戻しても画面は動くので、
      **機械は何も言わない**——ここで固定する。
    */
    const note = screen.getByTestId('memo-retention-note')
    expect(note.textContent).toContain('1か月')
    expect(note.textContent).not.toContain('3か月')
  })

  it('既定（90日）なら3か月と出る', async () => {
    const { useSettingsStore } = await import('@/stores/settings')
    const { settingsFixture } = await import('@/test/fixtures')

    useSettingsStore.setState({ settings: settingsFixture() })
    render(<MemoPane target={sessionTarget('s-1')} label="このセッションのメモ"
        保存先={null}
      />)

    expect(screen.getByTestId('memo-retention-note').textContent).toContain('3か月')
  })
})

describe('溢れたときの同意（要件10・設計§10-2）', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function 下見(over: boolean) {
    return {
      ok: true,
      json: async () => ({
        total: 2_000_000_000,
        expiring: 0,
        expiring_bytes: 0,
        over_budget: over,
        removed: 3,
        freed: 200_000_000,
        applied: false,
      }),
    }
  }

  it('**溢れるまで同意を求めない。** 収まっているのに確認が出ると、毎回押させることになる', async () => {
    fetchMock.mockResolvedValue(下見(false))
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )

    /*
      **`act` で包む。** 包まないと状態が落ち着く前に見ることになり、
      **「溢れていても出さない」実装でも通る**——検査の形は正しいのに何も
      守らない（実際に、包まずに書いたら壊しても落ちなかった）。
    */
    await act(async () => {
      await 渡ってきた[0]!.onUploadImage!(new File([new Uint8Array(4)], 'x.png', {
        type: 'image/png',
      }))
    })

    expect(screen.queryByTestId('memo-sweep-consent')).toBeNull()
    // **数えには行っている**（行かずに出さないのとは別物）
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/attachments/sweep')),
    ).not.toHaveLength(0)
  })

  it('溢れたら同意を求める。**押すまで1バイトも消さない**', async () => {
    fetchMock.mockResolvedValue(下見(true))
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )

    await act(async () => {
      await 渡ってきた[0]!.onUploadImage!(new File([new Uint8Array(4)], 'x.png', {
        type: 'image/png',
      }))
    })

    expect(screen.getByTestId('memo-sweep-consent')).toBeTruthy()
    /*
      **数えるだけの呼び出しはすべて `apply=false` であること。**
      ここが `true` になると、**確認を出す前に消えている**——同意ダイアログが
      「消しました」の事後報告になり、要件10 を満たさなくなる。
    */
    const 掃除の呼び出し = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/attachments/sweep'),
    )
    expect(掃除の呼び出し.length).toBeGreaterThan(0)
    for (const [url] of 掃除の呼び出し) {
      expect(url).toContain('apply=false')
    }
  })

  it('「消す」を押して初めて本番になる', async () => {
    fetchMock.mockResolvedValue(下見(true))
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )
    await act(async () => {
      await 渡ってきた[0]!.onUploadImage!(new File([new Uint8Array(4)], 'x.png', {
        type: 'image/png',
      }))
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('memo-sweep-apply'))
    })

    const 本番 = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('apply=true'),
    )
    expect(本番).toHaveLength(1)
    expect(screen.queryByTestId('memo-sweep-consent')).toBeNull()
  })

  it('「そのままにする」を押しても消えない（既存の振る舞いへ戻るだけ）', async () => {
    fetchMock.mockResolvedValue(下見(true))
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )
    await act(async () => {
      await 渡ってきた[0]!.onUploadImage!(new File([new Uint8Array(4)], 'x.png', {
        type: 'image/png',
      }))
    })

    fireEvent.click(screen.getByTestId('memo-sweep-dismiss'))

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('apply=true')),
    ).toHaveLength(0)
    expect(screen.queryByTestId('memo-sweep-consent')).toBeNull()
  })
})

describe('版切替の門（設計§8-2）', () => {
  it('運んでいる間は札が上がり、終わると下りる', () => {
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )
    const 抱える = 渡ってきた[0]?.on抱える
    expect(抱える).toBeTypeOf('function')

    expect(anyComposerBusy()).toBe(false)
    抱える!(true)
    /*
      **ここが落ちたら、運んでいる最中に版が切り替わってタブが読み直し、
      8 MiB を運びかけた画像が黙って消える**（設計§8-2）。
    */
    expect(anyComposerBusy()).toBe(true)
    抱える!(false)
    expect(anyComposerBusy()).toBe(false)
  })

  /*
    **2人が同時に抱えている間は、片方が終わっても下りない**（レビュー対応6）。

    以前は `??=` で1枚だけ取っていたので、**2人目は自分の札を取らず、先に終わった
    側が下ろしていた**。その窓で版が切り替わると、**まだ運んでいる側の画像が黙って
    消える**——この札が防ぐはずだった事故そのものである。

    面は複数のエディタを抱えうる（本体の入力欄と、直している吹き出し）。
  */
  it('2人が抱えている間は、片方が終わっても札が下りない', () => {
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )
    const 抱える = 渡ってきた[0]!.on抱える!

    抱える(true)
    抱える(true)
    expect(anyComposerBusy()).toBe(true)

    // 1人目が終わった。**もう1人がまだ運んでいるので下ろしてはいけない**
    抱える(false)
    expect(anyComposerBusy()).toBe(true)

    // 2人目も終わって、初めて下りる
    抱える(false)
    expect(anyComposerBusy()).toBe(false)
  })

  it('面が消えるときに札を残さない（残すと以後どの版切替も止まる）', () => {
    const { unmount } = render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ where: 'card', host: 'local', cardId: 'card-1' }}
      />,
    )
    渡ってきた[0]!.on抱える!(true)
    expect(anyComposerBusy()).toBe(true)

    unmount()

    expect(anyComposerBusy()).toBe(false)
  })
})
