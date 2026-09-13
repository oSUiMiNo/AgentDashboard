import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GLOBAL_TARGET, sessionTarget } from '@/lib/annotationTarget'
import type { AnnotationTarget, MemoView } from '@/lib/protocol'
import { clearMemos, replaceMemos } from '@/stores/memos'
import { useWsStore } from '@/stores/ws'
import { MemoPane, 下段に出す数 } from './MemoPane'

/*
  **この面は、全体メモとセッションメモの両方が使う同じ部品である**（要件9・利用者の指定）。

  だから**宛先違いを同じ部品へ渡して両方通す**。別々の部品を並べたテストにすると、
  **割れていても緑になる**——それでは要件9 の担保にならない。
*/

function memo(id: string, over: Partial<MemoView> = {}): MemoView {
  return {
    id,
    body: { blocks: [], markdown: id },
    noted_at: 1_700_000_000_000,
    ...over,
  }
}

/** 宛先違いで同じことを通すための一覧。**この配列がテストの芯である。** */
const 宛先たち: [string, AnnotationTarget][] = [
  ['全体', GLOBAL_TARGET],
  ['セッション', sessionTarget('s-1')],
]

beforeEach(() => {
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

describe.each(宛先たち)('メモの面（%s宛て）', (名, target) => {
  it('開いたら一覧を引く。**宛先を引数で渡している**', () => {
    const memoList = vi.fn()
    useWsStore.setState({ memoList })

    render(<MemoPane target={target} label={`${名}のメモ`}
        保存先={null}
      />)

    // **宛先ごとに別の口を叩いていない**こと。口は1つで、宛先は引数
    expect(memoList).toHaveBeenCalledWith(target)
  })

  it('届いた順のまま出す（並べ直さない）', () => {
    /*
      **時刻をわざと逆に積む。**

      同じ時刻の2件で見ていると、手元で並べ直す実装を入れても順が変わらず、
      **この検査は何も守らないまま緑になる**（実際に一度そうなっていた）。
      サーバの順と時刻の順が**食い違う**材料でなければ、並べ直しは捕まらない。
    */
    replaceMemos(target, [
      memo('先', { noted_at: 2_000 }),
      memo('後', { noted_at: 1_000 }),
    ])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    const 出た = screen.getAllByTestId('memo-bubble')
    expect(出た).toHaveLength(2)
    // **サーバの順のまま。** 手元で時刻から並べ直していない
    expect(出た[0]).toHaveTextContent('先')
    expect(出た[1]).toHaveTextContent('後')
  })

  it('チェック済みは上段へ分かれ、既定では畳まれている', () => {
    replaceMemos(target, [
      memo('未', {}),
      memo('済', { checked_at: 1_700_000_001_000 }),
    ])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    // 畳まれているので、上段の中身は出ていない
    expect(screen.queryByTestId('memo-checked')).toBeNull()
    expect(screen.getByTestId('memo-checked-toggle')).toHaveTextContent('1 件')
    // 下段には未チェックだけ
    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('memo-checked-toggle'))
    expect(screen.getByTestId('memo-checked')).toBeInTheDocument()
    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(2)
  })

  it('3つのボタンは onMouseDown で押す（onClick では効かない）', () => {
    const memoCheck = vi.fn()
    useWsStore.setState({ memoCheck })
    replaceMemos(target, [memo('あ')])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    const 片付ける = screen.getByTestId('memo-check')

    /*
      **`onClick` で押しても何も起きないことを、先に見る。**

      これが「`onMouseDown` で拾っている」ことの担保である。`onClick` に直すと
      **この行が落ちる**——重ねた面では、押す前に焦点が外れて面が閉じ、
      押したはずのボタンが消えるため（`SlashMenu` の先例）。
    */
    fireEvent.click(片付ける)
    expect(memoCheck).not.toHaveBeenCalled()

    fireEvent.mouseDown(片付ける)
    expect(memoCheck).toHaveBeenCalledWith('あ', true)
  })

  it('チェック済みを押すと、外す側で送る', () => {
    const memoCheck = vi.fn()
    useWsStore.setState({ memoCheck })
    replaceMemos(target, [memo('済', { checked_at: 1_700_000_001_000 })])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    fireEvent.click(screen.getByTestId('memo-checked-toggle'))
    fireEvent.mouseDown(screen.getByTestId('memo-check'))
    expect(memoCheck).toHaveBeenCalledWith('済', false)
  })

  it('溜まったら畳み、押すと伸びる', () => {
    const 多い = Array.from({ length: 下段に出す数 + 3 }, (_, i) => memo(`m${i}`))
    replaceMemos(target, 多い)
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(下段に出す数)
    expect(screen.getByTestId('memo-more')).toHaveTextContent('ほか 3 件')

    fireEvent.click(screen.getByTestId('memo-more'))
    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(下段に出す数 + 3)
  })

  it('畳むときに残すのは新しいほう（末尾）である', () => {
    const 多い = Array.from({ length: 下段に出す数 + 1 }, (_, i) =>
      memo(`m${i}`, { noted_at: 1_000 + i }),
    )
    replaceMemos(target, 多い)
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    // **いちばん下が最新**なので、隠すのは先頭側
    expect(screen.queryByText('m0')).toBeNull()
    expect(screen.getByText(`m${下段に出す数}`)).toBeInTheDocument()
  })
})

/*
  **抜け殻・終了したカード**（設計§6-9）。読めるが書けない。
*/
describe('抜け殻のカード', () => {
  it('入力欄が出ず、直す・片付けるも出ない', () => {
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} readOnly label="終わったセッションのメモ"
        保存先={null}
      />)

    expect(screen.queryByTestId('memo-compose')).toBeNull()
    expect(screen.getByTestId('memo-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('memo-edit')).toBeNull()
    expect(screen.queryByTestId('memo-check')).toBeNull()
  })

  it('コピーはできる（読むためだけに開く面なので、持ち出す道は残す）', () => {
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} readOnly label="終わったセッションのメモ"
        保存先={null}
      />)

    expect(screen.getByTestId('memo-copy')).toBeInTheDocument()
  })

  it('読めることは必須である（目的1）', () => {
    replaceMemos(GLOBAL_TARGET, [memo('復旧のときに読む')])
    render(<MemoPane target={GLOBAL_TARGET} readOnly label="終わったセッションのメモ"
        保存先={null}
      />)

    expect(screen.getByText('復旧のときに読む')).toBeInTheDocument()
  })
})

/*
  **コピーの逃げ道**（設計§6-7）。

  要件の確かめ方が「**安全なオリジンでない環境でも、値を取れる形になっている**こと」を
  求めている。`copyToClipboard` が偽を返したとき、**値を選ばせる形が出る**かを見る。
*/
describe('コピー', () => {
  it('写せなかったら、値を選ばせる形が出る', async () => {
    // `navigator.clipboard` がそもそも無く、古い方法も失敗する環境を作る
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    replaceMemos(GLOBAL_TARGET, [memo('取り出したい字')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.mouseDown(screen.getByTestId('memo-copy'))

    const 逃げ道 = await screen.findByTestId('memo-copy-fallback')
    expect(逃げ道).toHaveTextContent('取り出したい字')

    vi.unstubAllGlobals()
  })

  it('写せたら、逃げ道は出ない', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.mouseDown(screen.getByTestId('memo-copy'))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.queryByTestId('memo-copy-fallback')).toBeNull()

    vi.unstubAllGlobals()
  })
})

/*
  **消す道は編集の中にある**（設計§7-8）。

  吹き出しのボタンは3つのまま（要件3 が数を決めている）で、消すのは鉛筆を開いた先。
  **確認を1回挟む。**
*/
describe('消す道', () => {
  it('吹き出しのボタンは3つのまま（消すは並ばない）', () => {
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    const 並び = screen.getByTestId('memo-ops')
    expect(並び.querySelectorAll('button')).toHaveLength(3)
    expect(screen.queryByTestId('memo-remove')).toBeNull()
  })

  it('確認を1回挟んでから消す', () => {
    const memoRemove = vi.fn()
    useWsStore.setState({ memoRemove })
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.mouseDown(screen.getByTestId('memo-edit'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove'))
    // **1回押しただけでは消えない**
    expect(memoRemove).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByTestId('memo-remove-confirm'))
    expect(memoRemove).toHaveBeenCalledWith('あ')
  })
})

/*
  **書いて送る道**（要件1・要件4）。

  面の中でいちばん使われる動きなので、**確定が口まで届くこと**をここで固定する。
  Ctrl+Enter は入力欄・ターミナルと同じ述語（`isComposerSubmit`）を通っている。
*/
describe('書いて送る', () => {
  it('空のまま Ctrl+Enter を押しても送らない', () => {
    const memoAdd = vi.fn()
    useWsStore.setState({ memoAdd })
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.keyDown(screen.getByTestId('memo-compose'), {
      key: 'Enter',
      ctrlKey: true,
    })
    // **空を積まない。** 押し間違いで空の吹き出しが増えない
    expect(memoAdd).not.toHaveBeenCalled()
  })

  it('Ctrl を伴わない Enter では送らない（ブロックを割る側）', () => {
    const memoAdd = vi.fn()
    useWsStore.setState({ memoAdd })
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.keyDown(screen.getByTestId('memo-compose'), { key: 'Enter' })
    expect(memoAdd).not.toHaveBeenCalled()
  })

  it('変換中の Ctrl+Enter では送らない（IME の確定と取り違えない）', () => {
    const memoAdd = vi.fn()
    useWsStore.setState({ memoAdd })
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.keyDown(screen.getByTestId('memo-compose'), {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
    })
    expect(memoAdd).not.toHaveBeenCalled()
  })
})
