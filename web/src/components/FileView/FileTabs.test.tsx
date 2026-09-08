import { render, screen } from '@testing-library/react'
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
  手: { onSelect?: (p: string) => void; onClose?: (p: string) => void } = {},
) {
  const onSelect = vi.fn(手.onSelect)
  const onClose = vi.fn(手.onClose)
  render(
    <FileTabs
      tabs={tabs}
      current={current}
      root={ROOT}
      onSelect={onSelect}
      onClose={onClose}
    />,
  )
  return { onSelect, onClose }
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
    expect(screen.getByTestId('file-tab')).toHaveAttribute(
      'title',
      `${ROOT}/MyDocs/計画.md（${ROOT} からの相対パス）`,
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
