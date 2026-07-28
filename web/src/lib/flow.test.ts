import { createFlowController } from './flow'

/**
 * フロー制御の判定（テスト計画フェーズ5「TerminalPane」のフロー制御）。
 *
 * 守るべき約束は3つ。
 * - **上のしきい値を超えたら1回だけ止める**（毎フレーム送らない）
 * - **下のしきい値を下回るまで再開しない**（境目で往復しない）
 * - **バイトは数えるだけで捨てない**（合計が合う）
 */

const HIGH = 256 * 1024
const LOW = 32 * 1024

function controller() {
  const events: string[] = []
  const flow = createFlowController({
    thresholds: () => ({ high: HIGH, low: LOW }),
    onPause: () => events.push('pause'),
    onResume: () => events.push('resume'),
  })
  return { flow, events }
}

describe('フロー制御', () => {
  it('上のしきい値を超えたら止める', () => {
    const { flow, events } = controller()

    flow.begin(HIGH)
    expect(events).toEqual([])
    expect(flow.paused()).toBe(false)

    // 「超えたら」なので、ちょうど同じ値では止めない
    flow.begin(1)
    expect(events).toEqual(['pause'])
    expect(flow.paused()).toBe(true)
    expect(flow.pauseCount()).toBe(1)
  })

  it('止めている間は何度書いても重ねて送らない', () => {
    // 同じ指示を毎フレーム送ると WebSocket が無駄な往復で埋まる
    const { flow, events } = controller()

    flow.begin(HIGH + 1)
    flow.begin(HIGH)
    flow.begin(HIGH)
    expect(events).toEqual(['pause'])
  })

  it('下のしきい値を下回るまで再開しない', () => {
    // 境目のすぐ下で止めると、pause と resume を往復し続けることになる
    const { flow, events } = controller()

    flow.begin(HIGH + 1)
    flow.done(HIGH + 1 - LOW)
    expect(flow.pending()).toBe(LOW)
    // 「下回ったら」なので、境目ちょうどではまだ再開しない
    expect(events).toEqual(['pause'])

    flow.done(1)
    expect(events).toEqual(['pause', 'resume'])
    expect(flow.paused()).toBe(false)
  })

  it('落ち着いたあとに詰まればもう一度止める', () => {
    const { flow, events } = controller()

    flow.begin(HIGH + 1)
    flow.done(HIGH + 1)
    flow.begin(HIGH + 1)

    expect(events).toEqual(['pause', 'resume', 'pause'])
    expect(flow.pauseCount()).toBe(2)
  })

  it('処理待ちは負にならず、書いた総量は数え続ける', () => {
    // 端末側のコールバックが重複しても、負の値で判定が壊れないこと
    const { flow } = controller()

    flow.begin(100)
    flow.done(100)
    flow.done(100)
    expect(flow.pending()).toBe(0)
    expect(flow.totalBytes()).toBe(100)
  })

  it('しきい値はそのつど読み直す', () => {
    // サーバの `hello` で設定が届くまでは暫定値。届いたら次の判定から効く
    let high = 10
    const events: string[] = []
    const flow = createFlowController({
      thresholds: () => ({ high, low: 1 }),
      onPause: () => events.push('pause'),
      onResume: () => events.push('resume'),
    })

    flow.begin(5)
    expect(events).toEqual([])

    high = 1
    flow.begin(1)
    expect(events).toEqual(['pause'])
  })
})
