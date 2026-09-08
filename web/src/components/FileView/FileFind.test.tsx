import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
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
        <FileFind bodyRef={bodyRef} contentKey="x" onClose={onClose} />
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
