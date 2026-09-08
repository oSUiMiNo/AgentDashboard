import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { usePress } from './usePress'
import {
  clearSelectionStore,
  getSelection,
  toggleSelect,
  type SelectionKind,
} from '@/stores/selection'

/**
 * 押し分けの配線（並べ替え設計§4・§15-6）。
 *
 * 押し方の割り当てそのものは `press.test.ts`（純関数）が見る。ここで見るのは
 * **キーボード**——Space で選び、Enter で開き、Space の直後の `click` を捨てること——と、
 * **`'clear'` が実際に選択を解くところまで繋がっているか**。組み合わせの総当たりは
 * 純関数の側に置く（両方で同じ表を作ると、片方が黙って古くなる）。
 */

/*
  **この器だけは英字で名づける。** `oxlint` の `rules-of-hooks` はフックを呼んでよい相手を
  名前の1文字目で判定する（`useGrip.test.tsx` と同じ理由）。
*/
function Harness({
  as = 'button',
  selectable = true,
  kind = 'card',
  onOpen,
}: {
  as?: 'button' | 'section'
  selectable?: boolean
  kind?: SelectionKind
  onOpen: () => void
}) {
  const 押し方 = usePress({ kind, id: 'a', onOpen, selectable })
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

function 置く(
  options: { as?: 'button' | 'section'; selectable?: boolean; kind?: SelectionKind } = {},
) {
  let 開いた = 0
  render(<Harness {...options} onOpen={() => (開いた += 1)} />)
  return { 的: screen.getByTestId('target'), 開いた: () => 開いた }
}

/** 指で触る端末の見分け方（`lib/pointer.ts` と同じ文字列）。 */
const COARSE = '(pointer: coarse) and (hover: none)'

/**
 * 指の画面を作る。**`matches` は getter にする**——プロパティで持たせると
 * `matchMedia()` を呼んだ瞬間の値で固まる。
 */
function 指の画面にする() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === COARSE
    },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => {
  clearSelectionStore()
})

afterEach(() => {
  /*
    **偽の時計は、必ずここで戻す。** テストの本文で戻していると、途中で落ちた回に
    偽のまま次のテストへ持ち越され、**あとのテストが無関係な症状（固まる・時間切れ）で
    落ちて**本当の失敗が隠れる。

    **選択の巻き戻しはここでやらない。** `clearSelectionStore()` は購読者の一覧ごと
    捨てるので、まだ外れていない部品が黙って更新を受け取らなくなる。巻き戻しは
    `beforeEach` の1回で足りる。
  */
  vi.useRealTimers()
  vi.unstubAllGlobals()
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

describe('触る画面で、選択中に別のものを押す', () => {
  it('枠を選んだ状態でカードを押すと、遷移せず選択だけが解ける', async () => {
    /*
      **直す前はここで `onOpen()` が走り、セッション専用画面へ飛んでいた。**
      選択を解こうとして押した場所が遷移の的になっていた（2026-09-07・利用者の申告）。
    */
    指の画面にする()
    const { 的, 開いた } = 置く({ kind: 'card' })
    act(() => toggleSelect('project', 'p1'))

    await userEvent.click(的)

    expect(開いた()).toBe(0)
    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })

  it('カードを選んだ状態で、記録を持たない箱を押しても解けるだけ', async () => {
    // 選べる箱と選べない箱は見分けが付かないので、振る舞いを揃える（決めたこと1）
    指の画面にする()
    const { 的, 開いた } = 置く({ kind: 'project', selectable: false })
    act(() => toggleSelect('card', 'a'))

    await userEvent.click(的)

    expect(開いた()).toBe(0)
    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })

  it('解いた次のタップでは開く（猶予を置かない）', async () => {
    指の画面にする()
    const { 的, 開いた } = 置く({ kind: 'card' })
    act(() => toggleSelect('project', 'p1'))

    await userEvent.click(的)
    await userEvent.click(的)

    expect(開いた()).toBe(1)
  })

  it('1つも選んでいなければ、いままでどおり開く', async () => {
    指の画面にする()
    const { 的, 開いた } = 置く({ kind: 'card' })

    await userEvent.click(的)

    expect(開いた()).toBe(1)
  })

  it('同じ種類を選んでいれば、いままでどおり選ぶ', async () => {
    指の画面にする()
    const { 的 } = 置く({ kind: 'card' })
    act(() => toggleSelect('card', 'b'))

    await userEvent.click(的)

    expect(getSelection()).toEqual({ kind: 'card', ids: ['b', 'a'] })
  })

  it('選択中でも、キーボードの Enter は開く', async () => {
    /*
      **キーボードに「解くだけ」を持ち込まない。** 抜ける道は Esc が既に持っており、
      ここまで解くにすると**キーボードでは二度と開けなくなる**（`detail === 0` は
      Space と Enter を区別できない）。
    */
    指の画面にする()
    const { 開いた } = 置く({ kind: 'card' })
    act(() => toggleSelect('project', 'p1'))

    await userEvent.tab()
    await userEvent.keyboard('{Enter}')

    expect(開いた()).toBe(1)
  })

  it('長押しで選んだ直後の click では、解けも開きもしない', () => {
    // 長押しで選ぶ道が壊れていないことの担保（完了条件8）
    指の画面にする()
    vi.useFakeTimers()
    const { 的, 開いた } = 置く({ kind: 'card' })

    fireEvent.pointerDown(的, { pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    fireEvent.pointerUp(的)
    fireEvent.click(的, { detail: 1 })

    expect(開いた()).toBe(0)
    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
  })
})

describe('掴んで運んだあと、印を持ち越さない', () => {
  /*
    **長押しが成立した印を降ろすのは `onClick` だけだった。** ところが掴んで運ぶと
    `useGrip` が `onClickCapture` で `click` を握り潰すので `onClick` が走らず、
    印が次の押しへ持ち越される。持ち越されたぶん、**次の起動が「長押しの直後」と
    誤って捨てられて開かなくなる**。
  */
  function 長押しして運ぶ(的: HTMLElement) {
    fireEvent.pointerDown(的, { pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // 掴んだあとの `click` は `useGrip` が握り潰す＝ここでは発火させない
    fireEvent.pointerUp(的)
  }

  it('運んだあとでも、キーボードの Enter で開く', () => {
    指の画面にする()
    vi.useFakeTimers()
    const { 的, 開いた } = 置く({ kind: 'card' })

    長押しして運ぶ(的)
    fireEvent.keyDown(的, { key: 'Enter' })
    fireEvent.click(的, { detail: 0 })

    expect(開いた()).toBe(1)
  })

  it('運んだあとでも、マウスの押しは捨てられない', () => {
    指の画面にする()
    vi.useFakeTimers()
    const { 的 } = 置く({ kind: 'card' })

    長押しして運ぶ(的)
    // マウスは長押しの計測に入らないが、**印は捨てる**（捨てないと次の click が死ぬ）
    fireEvent.pointerDown(的, { pointerType: 'mouse', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(的)
    fireEvent.click(的, { detail: 1 })

    // カードは既に選ばれているので、もう一度押すと外れる（＝`click` が届いている）
    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })
})
