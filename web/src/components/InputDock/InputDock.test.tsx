import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { InputDock } from './InputDock'
import type { SessionStatus } from '@/lib/protocol'
import { hasWatcher, setSelecting } from '@/lib/terminalBridge'
import { useWsStore } from '@/stores/ws'

/**
 * 十字ボタンと入力欄の出し入れ（テスト計画フェーズ4「結線」）。
 *
 * # ここが「印とテキストを合わせる」唯一の場所
 *
 * 権限確認はアプリ自身が申告している（`status.kind`）ので、テキストで当てにいかない。
 * 橋が運ぶのは**画面テキストから導いた結論だけ**で、2つはここで初めて合流する。
 * だから「印だけで出る」と「テキストだけで出る」の**両方**を見る必要がある。
 *
 * # `matches` は getter にする
 *
 * プロパティで持たせると `matchMedia()` を呼んだ瞬間の値で固まり、あとから切り替えても
 * 反映されない（調査レポート §11-5）。**この形は `lib/pointer.test.ts` から写した**
 * ——削らずそのまま写している（元が変わったときに気づけるように）。
 */

const COARSE = '(pointer: coarse) and (hover: none)'
const LANDSCAPE = '(orientation: landscape)'
const CARD = '11111111-2222-3333-4444-555555555555'

function stubMedia(initial: Record<string, boolean>) {
  const state: Record<string, boolean> = { ...initial }
  const listeners = new Map<string, Set<() => void>>()

  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return state[query] ?? false
    },
    media: query,
    addEventListener: (_type: string, handler: () => void) => {
      const set = listeners.get(query) ?? new Set()
      set.add(handler)
      listeners.set(query, set)
    },
    removeEventListener: (_type: string, handler: () => void) => {
      listeners.get(query)?.delete(handler)
    },
  }))

  return {
    set(query: string, value: boolean) {
      state[query] = value
      act(() => {
        for (const handler of listeners.get(query) ?? []) {
          handler()
        }
      })
    },
  }
}

type SendInput = (cardId: string, text: string) => boolean

/** 送れたことにする。**送れたかどうかで書きかけを消すかが変わる**ので、既定は成功 */
let sent: Mock<SendInput>

function dock(
  status: SessionStatus = { kind: 'waiting_input' },
  compact = false,
) {
  return render(<InputDock cardId={CARD} status={status} compact={compact} />)
}

const dpad = () => screen.queryByTestId('dpad')
const composer = () => screen.getByTestId('composer-input')

beforeEach(() => {
  localStorage.clear()
  sent = vi.fn<SendInput>(() => true)
  useWsStore.setState({ sendInput: sent })
  stubMedia({ [COARSE]: true, [LANDSCAPE]: false })
})

afterEach(() => {
  setSelecting(CARD, false)
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('十字ボタンを出す条件', () => {
  it('粗いポインタで、選択待ちのときだけ出る', () => {
    dock()
    expect(dpad()).not.toBeInTheDocument()

    act(() => setSelecting(CARD, true))

    expect(dpad()).toBeInTheDocument()
  })

  it('PC では一度も出ない', () => {
    stubMedia({ [COARSE]: false, [LANDSCAPE]: false })
    dock()

    act(() => setSelecting(CARD, true))

    expect(dpad()).not.toBeInTheDocument()
  })

  /*
    **これが「PC の負荷はゼロ」の唯一の証拠になる。** 端末はフレームごとに
    `hasWatcher` を見てから画面を組み立てるので、見ている人が0なら解析も走らない。
  */
  it('PC では端末が画面を組み立てない', () => {
    stubMedia({ [COARSE]: false, [LANDSCAPE]: false })
    dock()

    expect(hasWatcher(CARD)).toBe(false)
  })

  it('粗いポインタのときだけ、端末に見張りが付く', () => {
    dock()

    expect(hasWatcher(CARD)).toBe(true)
  })

  // 宛先が1つに定まらないので、横並びでは方向キーを撃たせない
  it('横並びでは出ない', () => {
    dock({ kind: 'waiting_input' }, true)

    act(() => setSelecting(CARD, true))

    expect(dpad()).not.toBeInTheDocument()
    expect(hasWatcher(CARD)).toBe(false)
  })

  // 宛先が一意で、取り消しは安全側の操作なので、こちらは出す
  it('横並びでも Esc は出る', () => {
    dock({ kind: 'waiting_input' }, true)

    expect(screen.getByTestId('esc-key')).toBeInTheDocument()
  })

  // 印はアプリ自身の申告なので、画面テキストを一度も見ずに出せる
  it('権限確認の印だけで出る', () => {
    dock({ kind: 'waiting_permission' })

    expect(dpad()).toBeInTheDocument()
  })

  it('印とテキストの両方が偽になったときだけ消える', async () => {
    const { rerender } = dock({ kind: 'waiting_permission' })
    act(() => setSelecting(CARD, true))
    expect(dpad()).toBeInTheDocument()

    // テキストだけ偽へ。印が立っているので出たまま
    act(() => setSelecting(CARD, false))
    expect(dpad()).toBeInTheDocument()

    // 印も下りた
    rerender(
      <InputDock cardId={CARD} status={{ kind: 'working' }} compact={false} />,
    )

    await waitFor(() => expect(dpad()).not.toBeInTheDocument())
  })
})

describe('Esc ボタン', () => {
  // 構造化ビューを見ているあいだは端末にフォーカスが無く、物理の Esc も届かない
  it('入力方式によらず常に出る', () => {
    stubMedia({ [COARSE]: false, [LANDSCAPE]: false })
    dock()

    expect(screen.getByTestId('esc-key')).toBeInTheDocument()
  })

  it('終了したセッションでだけ無効になる', () => {
    const { rerender } = dock({ kind: 'waiting_input' })
    expect(screen.getByTestId('esc-key')).toBeEnabled()

    rerender(
      <InputDock
        cardId={CARD}
        status={{ kind: 'ended', ok: true }}
        compact={false}
      />,
    )

    expect(screen.getByTestId('esc-key')).toBeDisabled()
  })

  it('押しても端末からフォーカスを奪わない', () => {
    dock()

    expect(fireEvent.mouseDown(screen.getByTestId('esc-key'))).toBe(false)
  })
})

describe('入力欄の畳み', () => {
  it('十字が出ている間は畳まれ、終わったら戻る', () => {
    dock()
    expect(composer()).toHaveAttribute('data-collapsed', 'false')

    act(() => setSelecting(CARD, true))
    expect(composer()).toHaveAttribute('data-collapsed', 'true')

    act(() => setSelecting(CARD, false))
    expect(composer()).toHaveAttribute('data-collapsed', 'false')
  })

  /*
    **これが偽陽性を安くしている根拠。** 消すと、日本語の変換中の文字は入力欄の
    値としてまだ確定していないので復元経路が無くなる。畳むだけなら、判定が外れて
    余計に出ても失うものが無い——だから「迷ったら出す」側へ倒せる。
  */
  it('畳んでも作り直されず、書きかけが残る', () => {
    dock()
    const before = composer()
    fireEvent.change(before, { target: { value: '書きかけ' } })

    act(() => setSelecting(CARD, true))

    expect(composer()).toBe(before)
    expect(composer()).toHaveValue('書きかけ')
  })

  // 消すと、畳んだ状態から送る手段が無くなる（スマホに `Ctrl+Enter` は無い）
  it('畳んでも送信ボタンが押せる', () => {
    dock()
    fireEvent.change(composer(), { target: { value: '送る' } })
    act(() => setSelecting(CARD, true))

    fireEvent.click(screen.getByRole('button', { name: '送信' }))

    expect(sent).toHaveBeenCalledWith(CARD, '送る')
  })
})

describe('十字ボタンの置き方', () => {
  // 下端に重ねると、選ぼうとしている対象そのものを覆う（選択肢は必ず末尾5行に出る）
  it('縦では端末の下に積む', () => {
    dock()
    act(() => setSelecting(CARD, true))

    const layer = screen.getByTestId('dpad-layer')
    expect(layer).toHaveAttribute('data-place', 'stacked')
    expect(layer.className).not.toContain('absolute')
  })

  it('横では脇へ重ねる。下端には重ねない', () => {
    const media = stubMedia({ [COARSE]: true, [LANDSCAPE]: true })
    dock()
    act(() => setSelecting(CARD, true))

    const layer = screen.getByTestId('dpad-layer')
    expect(layer).toHaveAttribute('data-place', 'overlay')
    expect(layer.className).toContain('absolute')
    // 縦の中ほどへ寄せる。**下端に吸い付ける指定が無いこと**まで見る
    expect(layer.className).toContain('top-1/2')
    expect(layer.className).not.toMatch(/\bbottom-/)

    media.set(LANDSCAPE, false)
    expect(screen.getByTestId('dpad-layer')).toHaveAttribute(
      'data-place',
      'stacked',
    )
  })

  it('重ねる層は素通しで、押せるのはボタンだけ', () => {
    stubMedia({ [COARSE]: true, [LANDSCAPE]: true })
    dock()
    act(() => setSelecting(CARD, true))

    expect(screen.getByTestId('dpad-layer').style.pointerEvents).toBe('none')
    expect(screen.getByTestId('dpad-上').style.pointerEvents).toBe('auto')
  })
})

describe('出入りを支援技術へ伝える', () => {
  // 支援技術は**動的な変化しか読まない**ので、領域ごと後から現れても読まれない
  it('領域は空のまま先に置いてある', () => {
    dock()

    const live = screen.getByTestId('dpad-live')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('')
  })

  it('出たら伝わる', () => {
    dock()

    act(() => setSelecting(CARD, true))

    expect(screen.getByTestId('dpad-live')).toHaveTextContent('方向キー')
  })
})
