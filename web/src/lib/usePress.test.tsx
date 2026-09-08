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

describe('PC で、選択中に別の種類を押す', () => {
  /*
    **2026-09-08 に、前の決定を覆した。** それまで PC はスコープ外で、「PC の振る舞いが
    変わっていない」ことが完了条件だった。**遷移しないぶん見えにくいだけで、押した相手が
    選ばれるという同じ事故が残っていた**——帯の中身が入れ替わり、押そうとしていた
    ボタンが別のボタンになる。

    ここは指の画面を作らない（`matchMedia` を差し替えない）ので PC として走る。
  */

  it('枠を選んだ状態でカードをクリックすると、選ばれず選択だけが解ける', async () => {
    const { 的, 開いた } = 置く({ kind: 'card' })
    act(() => toggleSelect('project', 'p1'))

    await userEvent.click(的)

    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(開いた()).toBe(0)
  })

  it('解けたあと、もう一度クリックすれば選べる', async () => {
    // **選び直したい人は2回押す。** 修飾キーでの近道は作らない
    const { 的 } = 置く({ kind: 'card' })
    act(() => toggleSelect('project', 'p1'))

    await userEvent.click(的)
    await userEvent.click(的)

    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
  })

  it('1つも選んでいなければ、いままでどおり選ばれる', async () => {
    const { 的, 開いた } = 置く({ kind: 'card' })

    await userEvent.click(的)

    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
    expect(開いた()).toBe(0)
  })

  it('同じ種類なら、いままでどおり増える', async () => {
    const { 的 } = 置く({ kind: 'card' })
    act(() => toggleSelect('card', 'b'))

    await userEvent.click(的)

    expect(getSelection()).toEqual({ kind: 'card', ids: ['b', 'a'] })
  })

  it('キーボードの Space も同じ（マウスと食い違わない）', async () => {
    /*
      **Space は `pressMapping` の答えに従う。** ここだけ「別の種類も選ぶ」を続けると、
      同じ PC でマウスとキーボードの結果が食い違う。帯は Tab の通り道でもあるので、
      **向かっていたボタンが別のボタンになる**のはむしろキーボードのほうが当たりやすい。
    */
    const { 的, 開いた } = 置く({ kind: 'card' })
    act(() => toggleSelect('project', 'p1'))

    await userEvent.tab()
    expect(的).toHaveFocus()
    await userEvent.keyboard(' ')

    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(開いた()).toBe(0)
  })

  it('同じ種類なら、Space はいままでどおり増やす', async () => {
    const { 的 } = 置く({ kind: 'card' })
    act(() => toggleSelect('card', 'b'))

    await userEvent.tab()
    expect(的).toHaveFocus()
    await userEvent.keyboard(' ')

    expect(getSelection()).toEqual({ kind: 'card', ids: ['b', 'a'] })
  })

  it('ダブルクリックは開くだけで、選択を持ち込まない', async () => {
    /*
      **`click` → `click` → `dblclick` の間にシングルが2回走る。** 「選ぶ」だけだった
      頃は2回で打ち消し合って元へ戻っていたが、**「解くだけ」が入って打ち消し合わなく
      なった**——1打目で解け、2打目で押した相手が選ばれる。開いた先へ頼んでいない
      選択を持ち込むので、押す前へ戻してから開く。
    */
    const { 的, 開いた } = 置く({ kind: 'card' })
    act(() => toggleSelect('project', 'p1'))

    await userEvent.dblClick(的)

    expect(開いた()).toBe(1)
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
  })

  it('まとめて選んでいたものも、ダブルクリックで失わない', async () => {
    const { 的 } = 置く({ kind: 'card' })
    act(() => {
      toggleSelect('project', 'p1')
      toggleSelect('project', 'p2')
    })

    await userEvent.dblClick(的)

    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1', 'p2'] })
  })

  it('何も選んでいなければ、ダブルクリックのあとも空のまま', async () => {
    const { 的, 開いた } = 置く({ kind: 'card' })

    await userEvent.dblClick(的)

    expect(開いた()).toBe(1)
    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })
})

describe('キーボードとポインタが混ざっても、印を持ち越さない', () => {
  it('Space のあとに指で押しても、その押しは捨てられない', () => {
    /*
      **`preventDefault()` で `click` が来ない回がある。** その回の印（「Space で
      選んだ」）が残っていると、**次の押しが「Space の直後」と誤って捨てられる**。
    */
    指の画面にする()
    const { 的, 開いた } = 置く({ kind: 'card' })

    fireEvent.keyDown(的, { key: ' ' })
    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })

    fireEvent.pointerDown(的, { pointerType: 'touch', clientX: 10, clientY: 10 })
    fireEvent.pointerUp(的)
    fireEvent.click(的, { detail: 1 })

    // 同じ種類を選んでいるので、押せば外れる（＝`click` が届いている）
    expect(getSelection()).toEqual({ kind: null, ids: [] })
    expect(開いた()).toBe(0)
  })

  it('キーを押しても、待っている長押しの計測は止まる', () => {
    /*
      **印を捨てるだけで計測を止めないと、待っているタイマーが次の押しに乗る**
      ——押していない時間で長押しが成立し、掴みまで始まる。
    */
    指の画面にする()
    vi.useFakeTimers()
    const { 的 } = 置く({ kind: 'card' })

    fireEvent.pointerDown(的, { pointerType: 'touch', clientX: 10, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    fireEvent.keyDown(的, { key: 'Escape' })
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })
})
