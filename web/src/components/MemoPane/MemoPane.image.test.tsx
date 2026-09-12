import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
const 渡ってきた: { onUploadImage?: unknown; on抱える?: (v: boolean) => void }[] = []
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
  it('**保存先を渡さなければ、口を開けない**（全体メモがこれ）', () => {
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" />)

    /*
      **ここが落ちたら、どの PC へ置くかが決まらないまま画像を受けている。**
      全体メモはどのカードにも属さないので、既定の PC へ黙って置くと
      **別の機械から読めない画像**が残る（設計§10-1 の【未解決】）。
    */
    expect(渡ってきた[0]?.onUploadImage).toBeUndefined()
  })

  it('保存先を渡すと口が開く（セッションメモ）', () => {
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ host: 'local', cardId: 'card-1' }}
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
        保存先={{ host: 'local', cardId: 'card-1' }}
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
        保存先={{ host: 'local', cardId: 'card-1' }}
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
    render(<MemoPane target={sessionTarget('s-1')} label="このセッションのメモ" />)

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
    render(<MemoPane target={sessionTarget('s-1')} label="このセッションのメモ" />)

    expect(screen.getByTestId('memo-retention-note').textContent).toContain('3か月')
  })
})

describe('版切替の門（設計§8-2）', () => {
  it('運んでいる間は札が上がり、終わると下りる', () => {
    render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ host: 'local', cardId: 'card-1' }}
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

  it('面が消えるときに札を残さない（残すと以後どの版切替も止まる）', () => {
    const { unmount } = render(
      <MemoPane
        target={sessionTarget('s-1')}
        label="このセッションのメモ"
        保存先={{ host: 'local', cardId: 'card-1' }}
      />,
    )
    渡ってきた[0]!.on抱える!(true)
    expect(anyComposerBusy()).toBe(true)

    unmount()

    expect(anyComposerBusy()).toBe(false)
  })
})
