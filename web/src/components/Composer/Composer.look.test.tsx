import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Composer } from './Composer'

/**
 * 入力欄まわりの見た目（細かい修正 設計§6-1・要件9。テスト計画フェーズ3「入力欄」）。
 *
 * お手本（LINE・Discord）はどちらも**補助操作に枠を持たず、入力欄だけが器を持つ**。
 * ここで見るのは「枠が無いこと」と「塗るのは送信だけ」の2点。
 */
const CARD = 'aaaaaaaa-0000-0000-0000-000000000001'
const HOST = 'local'
const 動いている = { kind: 'working' } as const

function 置く() {
  render(<Composer cardId={CARD} status={動いている} host={HOST} />)
}

describe('入力欄まわり', () => {
  it('添付から四角い枠が消えている', () => {
    置く()
    const attach = screen.getByTestId('composer-attach')
    /*
      **素の `border` では見分けられない。** `button.tsx` の基底が全 variant へ
      `border border-transparent` を当てているので、`ghost` でも文字列としては在る。
      見えるかどうかを決めているのは**色**のほうなので、そちらを見る。
    */
    expect(attach.className).toContain('border-transparent')
    expect(attach.className, '枠を持つ outline ではない').not.toContain('border-input')
    expect(attach.querySelector('svg'), '線画になっている').not.toBeNull()
    expect(attach.textContent, '文字の ＋ が残っていない').toBe('')
  })

  it('送信が紙飛行機の絵になり、文字が残っていない', () => {
    置く()
    const send = screen.getByTestId('composer-send')
    expect(send.querySelector('svg')).not.toBeNull()
    expect(send.textContent).toBe('')
  })

  it('送信だけが塗られている（DESIGN.md §15.1「主要操作は1つだけ塗る」）', () => {
    置く()
    // Primary Accent。**新しい色は増やしていない**
    expect(screen.getByTestId('composer-send').className).toContain('bg-[#3dd9e6]')
    expect(screen.getByTestId('composer-attach').className).not.toContain('bg-[#3dd9e6]')
  })

  it('絵にした送信の言葉は、読み上げに残っている', () => {
    置く()
    expect(screen.getByTestId('composer-send')).toHaveAttribute('aria-label', '送信')
  })

  it('入力欄そのものの器は残っている', () => {
    // お手本の2つも、入力欄だけは器を持っている
    置く()
    expect(screen.getByTestId('composer-input')).toBeInTheDocument()
  })
})
