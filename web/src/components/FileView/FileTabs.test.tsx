import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FileTabs } from '@/components/FileView/FileTabs'

/**
 * タブ帯（`サイドバーで開いたファイルを、タブで並べて切り替える` テスト計画フェーズ3・4）。
 *
 * **ここで守っているのは3つ。** 選ばれている1枚が見て分かること、✕ が親へ伝わらない
 * こと、そして**折り返さないこと**——折り返すとヘッダが2行3行に伸びて中身が下へ
 * 押し出される。
 */
const ROOT = '/home/me/dev/app'

function 置く(
  tabs: string[],
  current = tabs[0] ?? '',
  手: {
    onSelect?: (p: string) => void
    onClose?: (p: string) => void
    onReorder?: (path: string, to: number) => void
    onReorderCommit?: () => void
  } = {},
) {
  const onSelect = vi.fn(手.onSelect)
  const onClose = vi.fn(手.onClose)
  const onReorder = vi.fn(手.onReorder)
  const onReorderCommit = vi.fn(手.onReorderCommit)
  render(
    <FileTabs
      tabs={tabs}
      current={current}
      root={ROOT}
      onSelect={onSelect}
      onClose={onClose}
      onReorder={onReorder}
      onReorderCommit={onReorderCommit}
    />,
  )
  return { onSelect, onClose, onReorder, onReorderCommit }
}

describe('タブ帯', () => {
  it('開いている枚数ぶん出る', () => {
    置く([`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/c.md`])
    expect(screen.getAllByTestId('file-tab')).toHaveLength(3)
  })

  it('選ばれている1枚が、見て分かる印を持つ', () => {
    /*
      **`DESIGN.md` §8 の床。** Primary Accent を**面**で出す場所が1つ以上要る。
      線や字の色だけで示すと、流し見で「どれが出ているか」が読めない。
    */
    置く([`${ROOT}/a.md`, `${ROOT}/b.md`], `${ROOT}/b.md`)
    const タブ = screen.getAllByTestId('file-tab')
    expect(タブ[0]).toHaveAttribute('aria-selected', 'false')
    expect(タブ[1]).toHaveAttribute('aria-selected', 'true')
    // 面で出ていること（`bg-primary` は器の側に付く）
    expect(タブ[1]?.parentElement?.className).toContain('bg-primary')
    expect(タブ[0]?.parentElement?.className).not.toContain('bg-primary')
  })

  it('タブを押すと、選び直しの合図が出る', async () => {
    const { onSelect } = 置く([`${ROOT}/a.md`, `${ROOT}/b.md`])
    await userEvent.click(screen.getAllByTestId('file-tab')[1]!)
    expect(onSelect).toHaveBeenCalledWith(`${ROOT}/b.md`)
  })

  it('✕ を押すと閉じる合図だけが出て、選ぶ合図は出ない', async () => {
    /*
      **親へ伝わらせない。** 伝わると、閉じたのに同じタブを選び直したことになり、
      束ね役の側で並びと選択が食い違う。
    */
    const { onSelect, onClose } = 置く([`${ROOT}/a.md`, `${ROOT}/b.md`])
    await userEvent.click(screen.getAllByTestId('file-tab-close')[1]!)
    expect(onClose).toHaveBeenCalledWith(`${ROOT}/b.md`)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('✕ は常に描かれている（hover を待たない）', () => {
    // **指で触る画面には `:hover` が無い。** 隠すとスマホから1枚も閉じられない
    置く([`${ROOT}/a.md`])
    const 閉じる = screen.getByTestId('file-tab-close')
    expect(閉じる).toBeVisible()
    expect(閉じる.className).not.toContain('group-hover')
    expect(閉じる.className).not.toContain('opacity-0')
  })

  it('タブに絶対パスと基準が title で残る', () => {
    // もとの相対パスの chip から引き継いだもの（要件26・設計§8-6）
    置く([`${ROOT}/MyDocs/計画.md`])
    const title = screen.getByTestId('file-tab').getAttribute('title') ?? ''
    expect(title).toContain(`${ROOT}/MyDocs/計画.md`)
    expect(title).toContain(`${ROOT} からの相対パス`)
  })

  it('ポインタ以外の道が、押す本人から見える', () => {
    /*
      **WCAG 2.5.7。** 並べ替えを掴んで運べるようにしたので、**キーボードだけの人にも
      道が要る**。道が在るだけでは足りず、**見つけられる**必要がある。
    */
    置く([`${ROOT}/a.md`])
    expect(screen.getByTestId('file-tab').getAttribute('title')).toContain(
      'Ctrl+Shift+← →',
    )
  })

  it('名前が衝突したら、親のフォルダが付く', () => {
    // このリポジトリは `要件.md` が何十枚もある（`lib/fileTabs.ts`）
    置く([`${ROOT}/x/要件.md`, `${ROOT}/y/要件.md`])
    const 字 = screen.getAllByTestId('file-tab').map((el) => el.textContent)
    expect(字).toEqual(['x/要件.md', 'y/要件.md'])
  })

  it('折り返さず、自分で横スクロールする', () => {
    /*
      **テスト計画フェーズ4。** `flex-wrap` にすると、タブが増えるたびにヘッダが
      伸びる——3つの要件がどれも「狭い窓で2行にならない」を完了条件に挙げている。
    */
    置く([`${ROOT}/a.md`])
    const 帯 = screen.getByTestId('file-tabs')
    expect(帯.className).not.toContain('flex-wrap')
    expect(帯.className).toContain('overflow-x-auto')
    // 縮めるために要る。無いとタブ帯が右のボタン群を画面の外へ押し出す
    expect(帯.className).toContain('min-w-0')
  })

  it('1枚ずつは縮まない（字が潰れない）', () => {
    置く([`${ROOT}/a.md`, `${ROOT}/b.md`])
    for (const タブ of screen.getAllByTestId('file-tab')) {
      expect(タブ.parentElement?.className).toContain('shrink-0')
    }
  })

  it('← → で行き来でき、端で回る', async () => {
    /*
      **`role="tablist"` を名乗る以上、矢印で移れないと約束と実装が食い違う。**
      読み上げを使う人はその割り当てを前提に押すので、何も起きないと壊れていると
      読まれる。
    */
    const { onSelect } = 置く(
      [`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/c.md`],
      `${ROOT}/a.md`,
    )
    screen.getAllByTestId('file-tab')[0]!.focus()

    await userEvent.keyboard('{ArrowRight}')
    expect(onSelect).toHaveBeenLastCalledWith(`${ROOT}/b.md`)

    // **端で止めずに回す。** 横スクロールするので、端がどこかは目で見えないことがある
    await userEvent.keyboard('{ArrowLeft}')
    expect(onSelect).toHaveBeenLastCalledWith(`${ROOT}/c.md`)
  })

  it('Home と End で両端へ跳ぶ', async () => {
    const { onSelect } = 置く(
      [`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/c.md`],
      `${ROOT}/b.md`,
    )
    screen.getAllByTestId('file-tab')[1]!.focus()

    await userEvent.keyboard('{Home}')
    expect(onSelect).toHaveBeenLastCalledWith(`${ROOT}/a.md`)
    await userEvent.keyboard('{End}')
    expect(onSelect).toHaveBeenLastCalledWith(`${ROOT}/c.md`)
  })

  it('関係の無いキーは奪わない', () => {
    // **既定を止めるのは矢印のときだけ。** 箱の横スクロールと二重に効かせない
    置く([`${ROOT}/a.md`])
    const 帯 = screen.getByTestId('file-tabs')
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
    })
    帯.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('読み上げに、開いているファイルの一覧として出る', () => {
    置く([`${ROOT}/a.md`])
    expect(screen.getByRole('tablist')).toHaveAttribute(
      'aria-label',
      '開いているファイル',
    )
  })
})

/**
 * 並べ替え（利用者の指定・2026-09-08）。
 *
 * **落とし先そのものは `lib/fileTabs.ts` の `dropIndexFor` が数値で確かめている。**
 * jsdom は矩形を固定で返すので、**ここで見るのは配線と押し分け**——閾値・主ボタン・
 * 運んだあとの押下を食わないこと・キーボードの道である。
 */
describe('タブの並べ替え', () => {
  const 三枚 = [`${ROOT}/a.md`, `${ROOT}/b.md`, `${ROOT}/c.md`]

  it('Ctrl+Shift+→ でタブそのものが動く', async () => {
    // **WCAG 2.5.7。** 掴んで運ぶ道だけだと、キーボードの人に道が無い
    const { onReorder } = 置く(三枚, `${ROOT}/a.md`)
    screen.getAllByTestId('file-tab')[0]!.focus()

    await userEvent.keyboard('{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}')

    expect(onReorder).toHaveBeenCalledWith(`${ROOT}/a.md`, 1)
  })

  it('Ctrl+Shift+← でも動く', async () => {
    const { onReorder } = 置く(三枚, `${ROOT}/c.md`)
    screen.getAllByTestId('file-tab')[2]!.focus()

    await userEvent.keyboard('{Control>}{Shift>}{ArrowLeft}{/Shift}{/Control}')

    expect(onReorder).toHaveBeenCalledWith(`${ROOT}/c.md`, 1)
  })

  it('運ぶのは端で止まる（移るのと違って回らない）', async () => {
    // **回すと、右端で1回押しただけで左端へ飛ぶ**
    const { onReorder } = 置く(三枚, `${ROOT}/c.md`)
    screen.getAllByTestId('file-tab')[2]!.focus()

    await userEvent.keyboard('{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}')

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+→ は、選び直しにはならない', async () => {
    const { onReorder, onSelect } = 置く(三枚, `${ROOT}/a.md`)
    screen.getAllByTestId('file-tab')[0]!.focus()

    await userEvent.keyboard('{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}')

    expect(onReorder).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('掴んで運ぶと並びが変わる', () => {
    const { onReorder } = 置く(三枚, `${ROOT}/c.md`)
    const タブ = screen.getAllByTestId('file-tab')[2]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 300 })
    fireEvent.pointerMove(帯, { pointerType: 'mouse', buttons: 1, clientX: 100 })

    expect(onReorder).toHaveBeenCalled()
  })

  it('少し動いただけでは掴まない', () => {
    // **押した指はわずかに動くのが普通。** 越えなければ「選ぶ」のまま
    const { onReorder } = 置く(三枚, `${ROOT}/a.md`)
    const タブ = screen.getAllByTestId('file-tab')[0]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 100 })
    fireEvent.pointerMove(帯, { pointerType: 'mouse', buttons: 1, clientX: 102 })

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('運んだあとの押下は、選び直しにならない', () => {
    /*
      **押した場所と離した場所が違う。** そのまま通すと「運んだ先のタブを選んだ」
      ことになる。
    */
    const { onReorder, onSelect } = 置く(三枚, `${ROOT}/c.md`)
    const タブ = screen.getAllByTestId('file-tab')[2]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 300 })
    fireEvent.pointerMove(帯, { pointerType: 'mouse', buttons: 1, clientX: 100 })
    fireEvent.pointerUp(帯, { pointerType: 'mouse', clientX: 100 })
    fireEvent.click(タブ)

    expect(onReorder).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('掴まずに押したら、いままでどおり選ぶ', () => {
    const { onSelect } = 置く(三枚, `${ROOT}/a.md`)
    const タブ = screen.getAllByTestId('file-tab')[1]!

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 100 })
    fireEvent.pointerUp(screen.getByTestId('file-tabs'), {
      pointerType: 'mouse',
      clientX: 100,
    })
    fireEvent.click(タブ)

    expect(onSelect).toHaveBeenCalledWith(`${ROOT}/b.md`)
  })

  it('ボタンを離したあと、ただ帯の上を通っただけでは並べ替わらない', () => {
    /*
      **レビューで見つかった穴**（2026-09-08）。閾値を越える前に帯の外で離すと、
      キャプチャを取っていないので帯の `pointerup` が来ない——**掴みが残ったまま、
      あとで帯の上を通っただけで並びが変わっていた**。帯は薄い（h-7）ので、
      押してすぐ下へ抜けるのは普通に起きる。
    */
    const { onReorder } = 置く(三枚, `${ROOT}/c.md`)
    const タブ = screen.getAllByTestId('file-tab')[2]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 300 })
    // 帯の外で離した（帯には pointerup が来ない）ので、掴みは残っている
    // そのあと、押していない状態で帯の上を通る
    fireEvent.pointerMove(帯, { pointerType: 'mouse', buttons: 0, clientX: 100 })

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('運んだ印は、帯で押しても落ちる', () => {
    /*
      実ブラウザでは、運んだあとの `click` は**押した相手（タブ）ではなく共通の親
      （帯）へ届く**。タブ側だけで落としていると印が残り、**次にキーボードで選ぼうと
      した1回目が黙って無視される。**
    */
    const { onSelect } = 置く(三枚, `${ROOT}/c.md`)
    const タブ = screen.getAllByTestId('file-tab')[2]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 300 })
    fireEvent.pointerMove(帯, { pointerType: 'mouse', buttons: 1, clientX: 100 })
    fireEvent.pointerUp(帯, { pointerType: 'mouse', clientX: 100 })
    // 実ブラウザと同じく、click は帯へ届く
    fireEvent.click(帯)
    // そのあとのタブの押下は、いままでどおり選ぶ
    fireEvent.click(タブ)

    expect(onSelect).toHaveBeenCalledWith(`${ROOT}/c.md`)
  })

  it('Ctrl+Shift+→ が動かすのは、焦点のあるタブ', () => {
    // **選ばれているタブではない。** 運んだあとは焦点と選択がずれていることがある
    const { onReorder } = 置く(三枚, `${ROOT}/a.md`)
    screen.getAllByTestId('file-tab')[1]!.focus()

    // **焦点のあるタブから撃つ**（帯へは上がってくる）。帯に直接撃つと
    // `event.target` が帯になり、この検査が意味を失う
    fireEvent.keyDown(screen.getAllByTestId('file-tab')[1]!, {
      key: 'ArrowRight',
      ctrlKey: true,
      shiftKey: true,
    })

    expect(onReorder).toHaveBeenCalledWith(`${ROOT}/b.md`, 2)
  })

  it('確定は、運び終わったときだけ知らせる', () => {
    // **運んでいる最中に覚えると、動くたびに `localStorage` を同期で読み書きする**
    const { onReorderCommit } = 置く(三枚, `${ROOT}/c.md`)
    const タブ = screen.getAllByTestId('file-tab')[2]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 300 })
    fireEvent.pointerMove(帯, { pointerType: 'mouse', buttons: 1, clientX: 100 })
    expect(onReorderCommit).not.toHaveBeenCalled()

    fireEvent.pointerUp(帯, { pointerType: 'mouse', clientX: 100 })
    expect(onReorderCommit).toHaveBeenCalledTimes(1)
  })

  it('掴まずに離しただけでは、確定を知らせない', () => {
    const { onReorderCommit } = 置く(三枚, `${ROOT}/a.md`)
    const タブ = screen.getAllByTestId('file-tab')[0]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 0, clientX: 100 })
    fireEvent.pointerUp(帯, { pointerType: 'mouse', clientX: 100 })

    expect(onReorderCommit).not.toHaveBeenCalled()
  })

  it('マウスの主ボタン以外では掴まない', () => {
    /*
      **中クリックで新しいタブに開こうとしただけで並びが変わる**のを防ぐ
      （隣の工事が同じ穴を踏んで直している）。
    */
    const { onReorder } = 置く(三枚, `${ROOT}/c.md`)
    const タブ = screen.getAllByTestId('file-tab')[2]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'mouse', button: 1, clientX: 300 })
    fireEvent.pointerMove(帯, { pointerType: 'mouse', buttons: 1, clientX: 100 })

    expect(onReorder).not.toHaveBeenCalled()
  })

  it('指では、どの押し方でも掴める', () => {
    // `button` はマウスの話。指とペンは今までどおり
    const { onReorder } = 置く(三枚, `${ROOT}/c.md`)
    const タブ = screen.getAllByTestId('file-tab')[2]!
    const 帯 = screen.getByTestId('file-tabs')

    fireEvent.pointerDown(タブ, { pointerType: 'touch', button: 0, clientX: 300 })
    fireEvent.pointerMove(帯, { pointerType: 'touch', buttons: 1, clientX: 100 })

    expect(onReorder).toHaveBeenCalled()
  })
})
