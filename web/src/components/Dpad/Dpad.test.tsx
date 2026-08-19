import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DPAD_CELL_PX, DPAD_CONFIRM_PX, Dpad, DPAD_SIZE_PX } from './Dpad'

/**
 * 十字ボタンの押し方・触り方・名前（テスト計画フェーズ4「結線」）。
 *
 * # `user-event` は使わない
 *
 * `vi.useFakeTimers()` の下では `user-event` の全 API が固まる（Vitest には `jest`
 * グローバルが無く、`@testing-library` が偽のタイマーを進められない。調査レポート §11-4）。
 * `fireEvent.pointerDown` / `pointerUp` / `pointerCancel` で書けば、この問題自体が起きない。
 *
 * # 連射そのものの判断は `lib/repeat.test.ts` が持つ
 *
 * ここで見るのは**繋がっているか**だけ。止める契機を `Dpad` 側で書き直していないことは、
 * 「離すと止まる」が通ることで間接的に確かめられる。
 */

function keys() {
  const onKey = vi.fn()
  render(<Dpad onKey={onKey} />)
  return onKey
}

const up = () => screen.getByTestId('dpad-上')
const down = () => screen.getByTestId('dpad-下')
const confirm = () => screen.getByTestId('dpad-決定')

describe('Dpad の押し方', () => {
  it('方向は押した瞬間に発火する', () => {
    const onKey = keys()

    fireEvent.pointerDown(up())

    expect(onKey).toHaveBeenCalledWith('up')
  })

  // 決定の誤爆は権限承認やメニュー確定が走って**取り消せない**ので、方向とは
  // 逆に「離した瞬間」にする（調査レポート §3-5）
  it('中央は離した瞬間に発火する', () => {
    const onKey = keys()

    fireEvent.pointerDown(confirm())
    expect(onKey).not.toHaveBeenCalled()

    fireEvent.pointerUp(confirm())
    expect(onKey).toHaveBeenCalledWith('enter')
  })

  it('中央を押してから指をずらして離すと発火しない', () => {
    const onKey = keys()

    fireEvent.pointerDown(confirm())
    // 指が別のボタンの上で離れた
    fireEvent.pointerUp(down())

    expect(onKey).not.toHaveBeenCalledWith('enter')
  })

  /*
    ここから3本は**キャプチャを解いた代償**を見る。

    解いた結果 `pointerup` は指の下の要素へ行くので、**別の場所で押し始めて ⏎ の上まで
    運んで離す**と、こちらへ `pointerup` だけが届く。素直に発火させると
    **押し始めていない決定が通る**——権限確認の場面で踏むと承認が勝手に走る。
  */
  it('中央の外で押し始めて中央で離しても発火しない', () => {
    const onKey = keys()

    // 端末など、別の場所で押し始めた（ここでは下ボタンで代用する）
    fireEvent.pointerDown(down(), { pointerId: 3 })
    onKey.mockClear()
    // 指を ⏎ の上まで運んで離した
    fireEvent.pointerUp(confirm(), { pointerId: 3 })

    expect(onKey).not.toHaveBeenCalled()
  })

  it('中央で押し始めて外で離すと、押した見た目が残らない', () => {
    keys()

    fireEvent.pointerDown(confirm(), { pointerId: 4 })
    expect(confirm()).toHaveAttribute('data-pressed', 'true')

    // ボタンの外で離れた。**キャプチャを解いてあるので、この合図はこちらへ届かない**
    fireEvent.pointerUp(document.body, { pointerId: 4 })

    expect(confirm()).toHaveAttribute('data-pressed', 'false')
  })

  it('指が攫われたら印も落ち、そのあと離しても発火しない', () => {
    const onKey = keys()

    fireEvent.pointerDown(confirm(), { pointerId: 5 })
    fireEvent.pointerCancel(confirm(), { pointerId: 5 })
    expect(confirm()).toHaveAttribute('data-pressed', 'false')

    fireEvent.pointerUp(confirm(), { pointerId: 5 })

    expect(onKey).not.toHaveBeenCalledWith('enter')
  })

  /*
    上の「ずらして離す」が実際のブラウザでも成立するには、**暗黙のポインタ
    キャプチャを解いておく**必要がある。タッチは `pointerdown` の時点で捕まえて
    いるので、放っておくと**ずらしても元のボタンへ `pointerup` が届く**。

    jsdom には暗黙のキャプチャが無いので、上のテストは解かなくても通る。
    **解いていることそのものを見る。**
  */
  it('中央は押した瞬間に暗黙のキャプチャを解く', () => {
    keys()
    const release = vi.fn()
    const button = confirm()
    Object.defineProperty(button, 'releasePointerCapture', { value: release })

    fireEvent.pointerDown(button, { pointerId: 7 })

    expect(release).toHaveBeenCalledWith(7)
  })

  it('押しっぱなしで連射し、離すと止まる', () => {
    vi.useFakeTimers()
    try {
      const onKey = keys()

      fireEvent.pointerDown(up())
      expect(onKey).toHaveBeenCalledTimes(1)

      // 初期遅延（400ms）の手前では増えない
      act(() => void vi.advanceTimersByTime(390))
      expect(onKey).toHaveBeenCalledTimes(1)

      act(() => void vi.advanceTimersByTime(20))
      expect(onKey).toHaveBeenCalledTimes(2)

      fireEvent.pointerUp(up())
      const stopped = onKey.mock.calls.length
      act(() => void vi.advanceTimersByTime(1000))
      expect(onKey).toHaveBeenCalledTimes(stopped)
    } finally {
      vi.useRealTimers()
    }
  })

  it('キャプチャを失っても、押した見た目が残らない', () => {
    // **止める契機と、見た目を戻す契機を同じ集合にする。** 連射は3つ
    // （`pointerup` / `pointercancel` / `lostpointercapture`）で止まるのに、
    // 見た目は前2つでしか戻していなかった——3つ目で止まったとき、
    // **押しっぱなしの見た目だけが残る**
    keys()

    fireEvent.pointerDown(up())
    expect(up()).toHaveAttribute('data-pressed', 'true')

    fireEvent.lostPointerCapture(up())

    expect(up()).toHaveAttribute('data-pressed', 'false')
  })

  it('キャプチャを失ったら、連射も止まる', () => {
    // 見た目だけ戻して連射が残ると、逆向きの取り残しになる。**両方**を見る
    vi.useFakeTimers()
    try {
      const onKey = keys()

      fireEvent.pointerDown(up())
      fireEvent.lostPointerCapture(up())
      const stopped = onKey.mock.calls.length

      act(() => void vi.advanceTimersByTime(1000))

      expect(onKey).toHaveBeenCalledTimes(stopped)
    } finally {
      vi.useRealTimers()
    }
  })

  it('上下は行をまるごと占め、隙間が生まれない', () => {
    keys()

    expect(up().style.gridColumn).toBe('1 / -1')
    expect(down().style.gridColumn).toBe('1 / -1')
  })

  // 余った縁はどのボタンにも属さないので、押しても何も起きない。
  // これが「決定は見た目より狭く」の実体
  it('中央はマスより小さく、周囲に不活性の縁がある', () => {
    keys()

    expect(confirm().style.width).toBe(`${DPAD_CONFIRM_PX}px`)
    expect(DPAD_CONFIRM_PX).toBeLessThan(DPAD_CELL_PX)
  })

  // Select のメニューでは効かないが、`/model` のピッカーとタブ切替では効く。
  // 効かない画面があることは受け入れる（設計§7）
  it('左右も出す', () => {
    keys()

    expect(screen.getByTestId('dpad-左')).toBeInTheDocument()
    expect(screen.getByTestId('dpad-右')).toBeInTheDocument()
  })
})

describe('Dpad の触り方の指定', () => {
  it('`touch-action: none` がボタン自身に当たっている', () => {
    keys()

    for (const label of ['上', '下', '左', '右', '決定']) {
      expect(screen.getByTestId(`dpad-${label}`).style.touchAction).toBe('none')
    }
  })

  // コンテナや body に当てると**ページ全体のピンチズームが死ぬ**（MDN も警告）
  it('`touch-action` をコンテナや body には当てない', () => {
    keys()

    expect(screen.getByTestId('dpad').style.touchAction).toBe('')
    expect(document.body.style.touchAction).toBe('')
  })

  // iOS では `:active` が発火しないので、CSS の擬似クラスに頼れない
  it('押下でクラスが付き、離すと外れる', () => {
    keys()

    fireEvent.pointerDown(up())
    expect(up().className).toContain('dpad-pressed')

    fireEvent.pointerUp(up())
    expect(up().className).not.toContain('dpad-pressed')
  })

  it('指が攫われたときも押下の見た目が戻る', () => {
    keys()

    fireEvent.pointerDown(up())
    fireEvent.pointerCancel(up())

    expect(up().className).not.toContain('dpad-pressed')
  })

  // `<a>` にするとリンクプレビューの発生源そのものが生まれる
  it('要素は `<button type="button">` である', () => {
    keys()

    for (const label of ['上', '下', '左', '右', '決定']) {
      const button = screen.getByTestId(`dpad-${label}`)
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
    }
  })
})

describe('Dpad のアクセシビリティ', () => {
  it('5つとも素のボタンで、名前が機能名である', () => {
    keys()

    // 「上向き三角」ではなく「上」。伝えるべきは見た目ではなく**起きること**
    for (const label of ['上', '下', '左', '右', '決定']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getAllByRole('button')).toHaveLength(5)
  })

  /*
    `role="toolbar"` は**矢印キーでフォーカスを移す慣習**を持ち、名前が矢印キー
    そのものである本件と正面衝突する。`aria-keyshortcuts` は「そのキーを押すと
    起動できる」という意味で**方向が逆**——書くと、支援技術の案内どおりに
    ArrowUp を押した人へ、実際に ArrowUp が送られる。
  */
  it('紛らわしい ARIA を付けない', () => {
    keys()

    expect(screen.getByTestId('dpad')).not.toHaveAttribute('role', 'toolbar')
    for (const label of ['上', '下', '左', '右', '決定']) {
      const button = screen.getByTestId(`dpad-${label}`)
      expect(button).not.toHaveAttribute('aria-keyshortcuts')
      // 音声操作や画面拡大の利用者は、見えている十字キーを操作しようとする
      expect(button).not.toHaveAttribute('aria-hidden')
    }
  })

  // 物理キーの矢印の代わりなので、Tab の順に4つ割り込ませる意味が無い
  it('Tab の順に割り込まない', () => {
    keys()

    for (const label of ['上', '下', '左', '右', '決定']) {
      expect(screen.getByTestId(`dpad-${label}`)).toHaveAttribute('tabindex', '-1')
    }
  })

  // `term.input()` はフォーカスと無関係に届くので、奪わないだけでよい
  it('押しても端末からフォーカスを奪わない', () => {
    keys()

    // `fireEvent` は `preventDefault()` が呼ばれると false を返す
    expect(fireEvent.mouseDown(up())).toBe(false)
    expect(fireEvent.mouseDown(confirm())).toBe(false)
  })
})

describe('Dpad の手応え', () => {
  const vibrate = vi.fn()

  beforeEach(() => {
    vibrate.mockClear()
    Object.defineProperty(navigator, 'vibrate', {
      value: vibrate,
      configurable: true,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'vibrate')
  })

  // iOS は Vibration API 非対応なので `?.()` で呼ぶ。ここで見るのは Android 側
  it('押すと短く鳴る', () => {
    keys()

    fireEvent.pointerDown(up())

    expect(vibrate).toHaveBeenCalled()
  })
})

describe('丸い外形と、不活性の縁', () => {
  it('外形が円に切り抜かれていること', () => {
    // 角を落とすぶん、同じ面積で1マスを大きく取れる（利用者の要望・2026-08-16）
    keys()
    const pad = screen.getByTestId('dpad')

    expect(pad.className).toContain('rounded-full')
    expect(pad.className).toContain('overflow-hidden')
    expect(pad.style.width).toBe(`${DPAD_SIZE_PX}px`)
    expect(pad.style.height).toBe(`${DPAD_SIZE_PX}px`)
  })

  it('中央の縁を押しても、何も送らない', () => {
    // 「決定は見た目より狭く」の実体。押し損ねが承認に化けない
    const onKey = keys()
    const 縁 = screen.getByTestId('dpad-確定の縁')

    fireEvent.pointerDown(縁)
    fireEvent.pointerUp(縁)

    expect(onKey).not.toHaveBeenCalled()
  })

  it('中央の縁と容れ物が、指を受け止めること', () => {
    // **素通しにすると、押し損ねた指が背後の端末へ届く**（利用者の指摘・2026-08-16）。
    // 何も起きないことと、通り抜けないことは別の性質なので、別々に見る
    keys()

    expect(screen.getByTestId('dpad').style.pointerEvents).toBe('auto')
    expect(screen.getByTestId('dpad-確定の縁').style.pointerEvents).toBe('auto')
  })

  it('上下は左右より広いままであること', () => {
    // 円にしても、いちばん押す上下がいちばん広い（利用者の指定）
    keys()

    expect(screen.getByTestId('dpad-上').style.gridColumn).toBe('1 / -1')
    expect(screen.getByTestId('dpad-下').style.gridColumn).toBe('1 / -1')
    expect(screen.getByTestId('dpad-左').style.gridColumn).toBe('')
    expect(screen.getByTestId('dpad-右').style.gridColumn).toBe('')
  })
})
