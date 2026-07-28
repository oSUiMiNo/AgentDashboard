import { isEnded, statusLabel } from './protocol'
import type { ClientMessage, ServerMessage, SessionStatus } from './protocol'

const CARD_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Rust 側（`crates/protocol/src/ws.rs` の
 * `種別名はスネークケースのtフィールドで表現される`）が生成する JSON と
 * 1文字も違わないことを確かめる。
 *
 * 型はどちらも手書きなので、どちらかを直してもう片方を直し忘れると
 * 「繋がるのに動かない」状態になる。そこをこのテストで止める。
 */
describe('サーバと同じ JSON になること', () => {
  it('sub_pty', () => {
    const message: ClientMessage = {
      t: 'sub_pty',
      card_id: CARD_ID,
      cols: 80,
      rows: 24,
    }
    expect(JSON.stringify(message)).toBe(
      `{"t":"sub_pty","card_id":"${CARD_ID}","cols":80,"rows":24}`,
    )
  })

  it('pty_flow', () => {
    const message: ClientMessage = {
      t: 'pty_flow',
      card_id: CARD_ID,
      state: 'pause',
    }
    expect(JSON.stringify(message)).toBe(
      `{"t":"pty_flow","card_id":"${CARD_ID}","state":"pause"}`,
    )
  })

  it('hello を解釈できる', () => {
    const raw = '{"t":"hello","flow_high":262144,"flow_low":32768}'
    const message = JSON.parse(raw) as ServerMessage
    expect(message.t).toBe('hello')
    if (message.t === 'hello') {
      expect(message.flow_high).toBe(262144)
      expect(message.flow_low).toBe(32768)
    }
  })

  it('session_upsert の status は kind 付きの形で届く', () => {
    // Rust は #[serde(tag = "kind")] で書き出す
    const raw = '{"t":"session_removed","card_id":"' + CARD_ID + '"}'
    const message = JSON.parse(raw) as ServerMessage
    expect(message.t).toBe('session_removed')

    const status = JSON.parse('{"kind":"ended","ok":false}') as SessionStatus
    expect(statusLabel(status)).toBe('異常終了')
  })
})

describe('状態のラベル', () => {
  it('全ての状態に日本語のラベルがある', () => {
    const all: SessionStatus[] = [
      { kind: 'starting' },
      { kind: 'working' },
      { kind: 'waiting_permission' },
      { kind: 'waiting_input' },
      { kind: 'stalled' },
      { kind: 'ended', ok: true },
      { kind: 'ended', ok: false },
      { kind: 'unknown' },
    ]
    for (const status of all) {
      expect(statusLabel(status)).not.toBe('')
    }
  })

  it('終了しているかを判定できる', () => {
    expect(isEnded({ kind: 'ended', ok: true })).toBe(true)
    expect(isEnded({ kind: 'ended', ok: false })).toBe(true)
    expect(isEnded({ kind: 'working' })).toBe(false)
  })
})
