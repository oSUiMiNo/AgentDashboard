/**
 * 候補の一覧の見た目（テスト計画フェーズ5）。
 *
 * **見た目の主張は素通りしやすい。** フェーズ1で、題材が悪くて壊しても落ちない
 * テストが実際に1本あった。ここでは**肯定と否定を対で置く**——「選ばれている行に
 * 印が在る」だけでは、全部の行に印を付けても通ってしまう。
 */
import { render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SlashCandidate } from '@/lib/slashCandidates'
import { MAX_VISIBLE, SlashMenu } from './SlashMenu'

/** 候補を1件組み立てる。 */
function 候補(name: string, over: Partial<SlashCandidate> = {}): SlashCandidate {
  return {
    name,
    description: `${name} の説明`,
    source: 'user-command',
    ...over,
  }
}

/** 既定の props で描く。 */
function 描く(over: Partial<Parameters<typeof SlashMenu>[0]> = {}) {
  const props = {
    candidates: [候補('rewind'), 候補('clear')],
    selected: 0,
    unreadable: 0,
    truncated: false,
    text: '/r',
    onPick: vi.fn(),
    onHover: vi.fn(),
    ...over,
  }
  render(<SlashMenu {...props} />)
  return props
}

/** 出ている行（`role="option"`）。 */
function 行たち() {
  return screen.queryAllByRole('option')
}

describe('候補の一覧', () => {
  it('候補を名前で出す', () => {
    描く()
    expect(行たち()).toHaveLength(2)
    expect(screen.getByText('/rewind')).toBeInTheDocument()
    expect(screen.getByText('/clear')).toBeInTheDocument()
  })

  it('説明を2行目に出す', () => {
    描く()
    expect(screen.getByText('rewind の説明')).toBeInTheDocument()
  })

  it('説明が空なら2行目を出さない', () => {
    描く({ candidates: [候補('rewind', { description: '' })] })
    expect(within(行たち()[0]).queryByText(/の説明/)).toBeNull()
  })

  it('出どころを添える', () => {
    描く({ candidates: [候補('x', { source: 'builtin' })] })
    expect(screen.getByText('組み込み')).toBeInTheDocument()
  })

  it('`role="option"` と `data-value` を持つ（E2E の pickOption が効く形）', () => {
    描く()
    // ここが外れると E2E から選べなくなる
    expect(行たち()[0]).toHaveAttribute('data-value', 'rewind')
  })
})

describe('選ばれている行の印（DESIGN.md §27.3）', () => {
  it('選ばれている行には、地の色と左の線の両方が付く', () => {
    描く({ selected: 1 })
    const style = 行たち()[1].getAttribute('style') ?? ''
    expect(style, '地を塗る').toMatch(/background:\s*color-mix/)
    expect(行たち()[1].className, '左の線を引く').toMatch(/border-l-2/)
  })

  it('選ばれていない行の地は、地の色そのもの', () => {
    // **否定側。** これが無いと、全部の行を塗っても上の検査は通る
    描く({ selected: 1 })
    const style = 行たち()[0].getAttribute('style') ?? ''
    expect(style).toMatch(/background:\s*transparent/)
    expect(行たち()[0].className).toMatch(/border-l-0/)
  })

  it('印が付いているのは1行だけ', () => {
    描く({ selected: 1 })
    const 塗られた = 行たち().filter((li) =>
      /color-mix/.test(li.getAttribute('style') ?? ''),
    )
    expect(塗られた).toHaveLength(1)
  })

  it('`aria-selected` も1行だけ真', () => {
    描く({ selected: 1 })
    expect(行たち()[0]).toHaveAttribute('aria-selected', 'false')
    expect(行たち()[1]).toHaveAttribute('aria-selected', 'true')
  })
})

describe('行の高さ（DESIGN.md §24.3 の Mobile / Touch）', () => {
  // **指で押す一覧なので、いちばん厳しい段（48〜60px）に合わせる。**
  // jsdom は寸法を持たないので、ここでは**床を宣言していること**だけを見る
  // （実際に何 px になるかは、焼いて測った：説明あり 51px・説明なし 48px）
  it('床を 48px として宣言している', () => {
    描く()
    expect(行たち()[0].className).toMatch(/\bmin-h-12\b/)
  })

  it('説明が無い候補でも、同じ床が効く', () => {
    // 余白で稼ぐと、2行目が無い候補だけ縮んで触れなくなる
    描く({ candidates: [候補('x', { description: '' })] })
    expect(行たち()[0].className).toMatch(/\bmin-h-12\b/)
  })
})

describe('opacity で沈めない（設計§6-2）', () => {
  it('この部品のソースに `opacity` が出てこない', () => {
    // 裏の文字が透ける事故が実際にあった。**`color-mix` で不透明に混ぜる**
    const ここ = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(ここ, 'SlashMenu.tsx'), 'utf8')
    // コメント中の言及（「`opacity` を使わない」）は除いてから見る
    const コード = src
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
    expect(コード).not.toMatch(/opacity/)
  })

  it('地は color-mix で不透明に塗る', () => {
    描く({ selected: 0 })
    expect(行たち()[0].getAttribute('style') ?? '').toMatch(/color-mix\(in oklch/)
  })
})

describe('溢れたぶんを隠さない（DESIGN.md §15.2・設計§5）', () => {
  it(`同時に出すのは ${MAX_VISIBLE} 行まで`, () => {
    描く({
      candidates: Array.from({ length: 20 }, (_, i) => 候補(`cmd${i}`)),
    })
    expect(行たち()).toHaveLength(MAX_VISIBLE)
  })

  it('切ったぶんは件数で言う', () => {
    描く({
      candidates: Array.from({ length: 20 }, (_, i) => 候補(`cmd${i}`)),
    })
    expect(screen.getByTestId('slash-menu-more')).toHaveTextContent('ほか 12 件')
  })

  it('溢れていなければ、その行は出さない', () => {
    描く()
    expect(screen.queryByTestId('slash-menu-more')).toBeNull()
  })

  it('打ち切られたフォルダがあれば言う', () => {
    描く({ truncated: true })
    expect(screen.getByTestId('slash-menu-truncated')).toBeInTheDocument()
  })

  it('打ち切られていなければ、その行は出さない', () => {
    描く({ truncated: false })
    expect(screen.queryByTestId('slash-menu-truncated')).toBeNull()
  })

  it('読めなかったぶんがあれば件数で言う', () => {
    描く({ unreadable: 3 })
    expect(screen.getByTestId('slash-menu-unreadable')).toHaveTextContent('3 件')
  })
})

describe('当たるものが無いとき（設計§6-4）', () => {
  it('黙って消えず、何に当たらなかったのかを言う', () => {
    描く({ candidates: [], text: '/zzz' })
    expect(screen.getByTestId('slash-menu-empty')).toHaveTextContent('/zzz')
  })

  it('そのまま送れることを添える', () => {
    // 打ったものが無効だと読まれると、打ち直しか諦めになる
    描く({ candidates: [], text: '/zzz' })
    expect(screen.getByTestId('slash-menu-empty')).toHaveTextContent(
      'そのまま送れます',
    )
  })

  it('1件も集まらなかったときは、読めなかったことのほうを言う', () => {
    描く({ candidates: [], unreadable: 5, text: '/zzz' })
    expect(screen.getByTestId('slash-menu-empty')).toHaveTextContent(
      '読めませんでした',
    )
  })

  it('引数まで打っていても、当たらなかったのは最初の語だと分かる', () => {
    描く({ candidates: [], text: '/zzz あとの引数' })
    const 断り = screen.getByTestId('slash-menu-empty')
    expect(断り).toHaveTextContent('/zzz')
    expect(断り, '引数まで並べない').not.toHaveTextContent('あとの引数')
  })
})

describe('ここに出ないものを、常に言う（要件の完了条件）', () => {
  it('候補が出ているときも断りを出す', () => {
    描く()
    expect(screen.getByTestId('slash-menu-caveat')).toHaveTextContent('MCP')
  })

  it('0件のときも断りを出す', () => {
    描く({ candidates: [] })
    expect(screen.getByTestId('slash-menu-caveat')).toHaveTextContent('MCP')
  })

  it('組み込みの表がずれうることも言う', () => {
    描く()
    expect(screen.getByTestId('slash-menu-caveat')).toHaveTextContent('ずれる')
  })
})

describe('押したときと、載せたとき', () => {
  it('行を押すと、その候補を返す', async () => {
    const { onPick } = 描く()
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.mouseDown(行たち()[1])
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ name: 'clear' }))
  })

  it('押しても焦点を奪わない（既定を止める）', async () => {
    描く()
    const { fireEvent } = await import('@testing-library/react')
    // `mouseDown` の既定を止めないと、入力欄から焦点が外れて一覧が閉じ、
    // 押したはずの行が消える
    const 止まったか = !fireEvent.mouseDown(行たち()[0])
    expect(止まったか).toBe(true)
  })

  it('マウスを載せると、その番号を返す', async () => {
    const { onHover } = 描く()
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.mouseEnter(行たち()[1])
    expect(onHover).toHaveBeenCalledWith(1)
  })
})

describe('入力欄の器の高さを変えない（設計§6・TUI 再描画の輪）', () => {
  it('絶対配置で、器の外へ重ねる', () => {
    描く()
    const 器 = screen.getByTestId('slash-menu')
    expect(器.className, '絶対配置').toMatch(/\babsolute\b/)
    expect(器.className, '器の上へ出す').toMatch(/\bbottom-full\b/)
  })
})
