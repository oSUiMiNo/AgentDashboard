import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { usePress } from './usePress'
import { clearSelectionStore, getSelection, toggleSelect } from '@/stores/selection'

/**
 * 押し分けの配線（並べ替え設計§4・§15-6）。
 *
 * 押し方の割り当てそのものは `press.test.ts`（純関数）が見る。ここで見るのは
 * **キーボード**——Space で選び、Enter で開き、Space の直後の `click` を捨てること。
 */

/*
  **この器だけは英字で名づける。** `oxlint` の `rules-of-hooks` はフックを呼んでよい相手を
  名前の1文字目で判定する（`useGrip.test.tsx` と同じ理由）。
*/
function Harness({
  as = 'button',
  selectable = true,
  onOpen,
}: {
  as?: 'button' | 'section'
  selectable?: boolean
  onOpen: () => void
}) {
  const 押し方 = usePress({ kind: 'card', id: 'a', onOpen, selectable })
  const props = {
    'data-testid': 'target',
    'aria-pressed': 押し方.selected,
    onClick: 押し方.onClick,
    onKeyDown: 押し方.onKeyDown,
    onDoubleClick: 押し方.onDoubleClick,
    onPointerDown: 押し方.onPointerDown,
    onPointerMove: 押し方.onPointerMove,
    onPointerUp: 押し方.onPointerUp,
    onPointerCancel: 押し方.onPointerCancel,
  }
  if (as === 'section') {
    return (
      <section tabIndex={0} {...props}>
        <input data-testid="inner" />
      </section>
    )
  }
  return <button type="button" {...props} />
}

function 置く(options: { as?: 'button' | 'section'; selectable?: boolean } = {}) {
  let 開いた = 0
  render(<Harness {...options} onOpen={() => (開いた += 1)} />)
  return { 的: screen.getByTestId('target'), 開いた: () => 開いた }
}

beforeEach(() => {
  clearSelectionStore()
})

describe('キーボード', () => {
  it('Space は選ぶだけで、開かない', async () => {
    // **直す前は Space も `click`（`detail === 0`）で「開く」に倒れていた**——キーボードでは選べず、帯へ辿り着けない
    const { 的, 開いた } = 置く()
    await userEvent.tab()
    expect(的).toHaveFocus()
    await userEvent.keyboard(' ')
    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
    expect(開いた()).toBe(0)
  })

  it('Enter は開く', async () => {
    const { 開いた } = 置く()
    await userEvent.tab()
    await userEvent.keyboard('{Enter}')
    expect(開いた()).toBe(1)
    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })

  it('Space の直後の Enter でも開く（印を持ち越さない）', async () => {
    const { 開いた } = 置く()
    await userEvent.tab()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{Enter}')
    expect(開いた()).toBe(1)
  })

  it('もう一度 Space を押すと外れる', async () => {
    const { 開いた } = 置く()
    await userEvent.tab()
    await userEvent.keyboard(' ')
    await userEvent.keyboard(' ')
    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(開いた()).toBe(0)
  })

  it('記録を持たない箱では、Space で何も選ばない', async () => {
    const { 開いた } = 置く({ selectable: false })
    await userEvent.tab()
    await userEvent.keyboard(' ')
    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(開いた()).toBe(0)
  })

  it('<section> でも Enter で開き、Space で選ぶ', async () => {
    const { 的, 開いた } = 置く({ as: 'section' })
    await userEvent.tab()
    expect(的).toHaveFocus()
    await userEvent.keyboard(' ')
    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
    await userEvent.keyboard('{Enter}')
    expect(開いた()).toBe(1)
  })

  it('内側の部品から泡立ってきたキーは、この器のものではない', () => {
    const { 開いた } = 置く({ as: 'section' })
    act(() => toggleSelect('card', 'a'))
    const inner = screen.getByTestId('inner')
    fireEvent.keyDown(inner, { key: ' ' })
    fireEvent.keyDown(inner, { key: 'Enter' })
    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
    expect(開いた()).toBe(0)
  })
})
