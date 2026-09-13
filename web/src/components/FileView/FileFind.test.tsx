import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FileFind } from '@/components/FileView/FileFind'

/**
 * 探す窓（`ファイルビュアの中を Ctrl+F で探せるようにする` テスト計画フェーズ3）。
 *
 * **印そのものは見られない**（jsdom に `CSS.highlights` が無い）。ここで確かめるのは
 * **件数・送り・閉じ方**で、印が実際に描かれるかは実機で見る（フェーズ5-1）。
 */
function 置く(本文 = '<p>あか あお あか みどり あか</p>', onClose = vi.fn()) {
  function Harness() {
    const bodyRef = useRef<HTMLDivElement>(null)
    return (
      <div>
        <div
          ref={bodyRef}
          data-testid="body"
          dangerouslySetInnerHTML={{ __html: 本文 }}
        />
        <FileFind bodyRef={bodyRef} contentKey="x" 合図={1} onClose={onClose} />
      </div>
    )
  }
  render(<Harness />)
  return { onClose }
}

/** 件数の字。**待つのは打鍵から探すまでの間**（150ms） */
async function 件数(期待: string) {
  await waitFor(() => {
    expect(screen.getByTestId('file-find-count')).toHaveTextContent(期待)
  })
}

describe('探す窓', () => {
  it('開いた時点で、すぐ打てる', () => {
    置く()
    expect(screen.getByTestId('file-find-input')).toHaveFocus()
  })

  it('語を打つと、いま何番目か／いくつ当たったかが出る', async () => {
    置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あか')
    await 件数('1 / 3')
  })

  it('当たりが0のときは「見つかりません」と出る', async () => {
    // **黙って何も起きないようにしない**（要件）
    置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'むらさき')
    await 件数('見つかりません')
  })

  it('打つ前は、件数も断りも出さない', async () => {
    置く()
    expect(screen.getByTestId('file-find-count')).toHaveTextContent('')
  })

  it('「次へ」で進み、末尾の次は先頭へ回る', async () => {
    置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あか')
    await 件数('1 / 3')

    await userEvent.click(screen.getByTestId('file-find-next'))
    await 件数('2 / 3')
    await userEvent.click(screen.getByTestId('file-find-next'))
    await 件数('3 / 3')
    // **端で止めずに回す。** 探す操作の慣例どおり
    await userEvent.click(screen.getByTestId('file-find-next'))
    await 件数('1 / 3')
  })

  it('「前へ」で戻り、先頭の前は末尾へ回る', async () => {
    置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あか')
    await 件数('1 / 3')

    await userEvent.click(screen.getByTestId('file-find-prev'))
    await 件数('3 / 3')
  })

  it('当たりが無いあいだは、送りが押せない', async () => {
    // **押せるのに何も起きないものは、壊れているのと見分けが付かない**
    置く()
    expect(screen.getByTestId('file-find-next')).toBeDisabled()
    expect(screen.getByTestId('file-find-prev')).toBeDisabled()
  })

  it('Enter で次へ、Shift+Enter で前へ', async () => {
    // **窓の中の Enter は「次へ」であって、指示の送信ではない**
    置く()
    const 入力 = screen.getByTestId('file-find-input')
    await userEvent.type(入力, 'あか')
    await 件数('1 / 3')

    await userEvent.type(入力, '{Enter}')
    await 件数('2 / 3')
    await userEvent.type(入力, '{Shift>}{Enter}{/Shift}')
    await 件数('1 / 3')
  })

  it('Esc で閉じる', async () => {
    const { onClose } = 置く()
    await userEvent.type(screen.getByTestId('file-find-input'), '{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('✕ でも閉じる', async () => {
    const { onClose } = 置く()
    await userEvent.click(screen.getByTestId('file-find-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('要素をまたいだ語にも当たる', async () => {
    // 整形すると `**太**字` のように語が割れる（`lib/fileSearch.ts`）
    置く('<p><b>太</b>字である</p>')
    await userEvent.type(screen.getByTestId('file-find-input'), '太字')
    await 件数('1 / 1')
  })
})

/**
 * 打つ層（`<textarea>`）の中を探す（`ファイルビュアにエディタ機能を追加` 設計§5-4）。
 *
 * **ここが撤回された判断へ戻らないための担保である。** いちど「エディタでは探すを
 * 出さない」と決めかけたが、`text` は表に無い拡張子すべての落ちどころで、**今日その場で
 * 探せている**——消すと最も探したい相手から探す機能が消える。
 */
function 打つ層に置く(値 = 'あか\nあお\nあか') {
  function Harness() {
    const bodyRef = useRef<HTMLDivElement>(null)
    const editorRef = useRef<HTMLTextAreaElement>(null)
    const [本文, set本文] = useState(値)
    return (
      <div>
        {/* **3層をそのまま置く。** 遡ると番号と色の層に当たってしまう相手 */}
        <div ref={bodyRef} data-testid="body">
          <div data-testid="gutter">
            {['1', '2', '3'].map((n) => (
              <div key={n}>{n}</div>
            ))}
          </div>
          <pre data-testid="paint">{本文}</pre>
          <textarea
            ref={editorRef}
            data-testid="ta"
            value={本文}
            onChange={(e) => set本文(e.target.value)}
          />
        </div>
        <FileFind
          bodyRef={bodyRef}
          editorRef={editorRef}
          本文={本文}
          contentKey="x"
          合図={1}
          onClose={vi.fn()}
        />
      </div>
    )
  }
  render(<Harness />)
  return {
    打つ層: () => screen.getByTestId('ta') as HTMLTextAreaElement,
  }
}

describe('探す窓（打つ層）', () => {
  it('値の中を探して、件数を出す', async () => {
    打つ層に置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あか')
    await 件数('1 / 2')
  })

  /**
   * **これが「DOM を遡っていない」ことの証拠である。**
   *
   * 番号の層には `1` が在るので、遡る道なら当たってしまう。**値には `1` が無い**ので、
   * 値を見ているなら0件になる。
   */
  it('行番号や色の層には当たらない', async () => {
    打つ層に置く()
    await userEvent.type(screen.getByTestId('file-find-input'), '1')
    await 件数('見つかりません')
  })

  it('当たりを選択で示す', async () => {
    const { 打つ層 } = 打つ層に置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あお')
    await waitFor(() => {
      expect(打つ層().selectionStart).toBe(3)
    })
    expect(打つ層().selectionEnd).toBe(5)
  })

  it('次へで、次の当たりへ選択が移る', async () => {
    const { 打つ層 } = 打つ層に置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あか')
    await 件数('1 / 2')
    await userEvent.click(screen.getByTestId('file-find-next'))
    await waitFor(() => {
      expect(打つ層().selectionStart).toBe(6)
    })
  })

  it('末尾の次は先頭へ回る', async () => {
    const { 打つ層 } = 打つ層に置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あか')
    await 件数('1 / 2')
    await userEvent.click(screen.getByTestId('file-find-next'))
    await 件数('2 / 2')
    await userEvent.click(screen.getByTestId('file-find-next'))
    await waitFor(() => {
      expect(打つ層().selectionStart).toBe(0)
    })
    // **終わりまで見る。** 既定の選択位置も 0 なので、始まりだけでは
    // 「選択が壊れている」と「先頭へ回った」を見分けられない
    expect(打つ層().selectionEnd).toBe(2)
  })

  /**
   * **打っている間は件数が古くてよい**（テスト計画 7-3）。
   *
   * **デバウンスを外すとこの検査が落ちる**——落ちることを確かめたうえで戻してある。
   * 外すと長い文書で打鍵のたびに全文を走査することになる。
   */
  it('打った直後は数え直さず、止まってから落ち着く', async () => {
    const { 打つ層 } = 打つ層に置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あか')
    await 件数('1 / 2')
    // **同期で書き換える。** ここで時間を進めないのが要点
    fireEvent.change(打つ層(), { target: { value: 'あか\nあお\nあか\nあか' } })
    expect(screen.getByTestId('file-find-count')).toHaveTextContent('1 / 2')
    await 件数('1 / 3')
  })

  /**
   * **色付けが何度走っても当たりが消えない**——`setSelectionRange` を選んだ理由その
   * ものである。**落ちたら方式の前提が崩れている。**
   */
  it('色の層が描き直されても、選択は残る', async () => {
    const { 打つ層 } = 打つ層に置く()
    await userEvent.type(screen.getByTestId('file-find-input'), 'あお')
    await waitFor(() => {
      expect(打つ層().selectionStart).toBe(3)
    })
    // **文字節点を作り直す。** 色付けのたびに実際に起きていること——
    // `Range` を張る道なら、ここで当たりが無効になる
    const 色の層 = screen.getByTestId('paint')
    色の層.replaceChildren(document.createTextNode(色の層.textContent ?? ''))
    expect(打つ層().selectionStart).toBe(3)
    expect(打つ層().selectionEnd).toBe(5)
  })
})
