import { isEnded, statusLabel } from './protocol'
import type {
  ClientMessage,
  Node,
  ServerMessage,
  SessionStatus,
  TreeNode,
} from './protocol'

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

/**
 * 構造化ビューのノード（設計§3）。Rust 側 `crates/protocol/src/lib.rs` の
 * `nodeは全バリアントが往復する` と同じ形を、こちら側でも固定しておく。
 */
describe('構造化ビューのノード', () => {
  it('全種別が kind 付きの形で解釈できる', () => {
    const raws: string[] = [
      '{"kind":"user_message","text":"テストを流して"}',
      '{"kind":"assistant_text","text":"了解しました"}',
      '{"kind":"thinking","text":"まず失敗を確認する"}',
      '{"kind":"tool_call","name":"Edit","input":{"old_string":"a"},"result":null,"status":"pending","subagent":null}',
      '{"kind":"subagent","agent_type":"Explore","spawn_depth":1}',
      '{"kind":"unknown","record_type":"queue-operation","raw":{"type":"queue-operation"}}',
    ]
    const kinds = raws.map((raw) => (JSON.parse(raw) as Node).kind)
    expect(kinds).toEqual([
      'user_message',
      'assistant_text',
      'thinking',
      'tool_call',
      'subagent',
      'unknown',
    ])
  })

  it('サブエージェント付きのツールコールを解釈できる', () => {
    const raw =
      '{"id":"11111111-2222-3333-4444-555555555555","parent":null,' +
      '"node":{"kind":"tool_call","name":"Agent","input":{"prompt":"調査して"},' +
      '"result":null,"status":"pending","subagent":' +
      '{"agent_type":"Explore","transcript_path":"subagents/agent-001.jsonl","spawn_depth":1}},' +
      '"ts":1700000000123}'
    const node = JSON.parse(raw) as TreeNode
    expect(node.parent).toBeNull()
    expect(node.node.kind).toBe('tool_call')
    if (node.node.kind === 'tool_call') {
      // サブエージェント起動ツールの実名は v2.1.220 の実データでは `Agent`
      expect(node.node.name).toBe('Agent')
      expect(node.node.subagent?.spawn_depth).toBe(1)
    }
  })

  it('transcript_append は TreeNode の配列で届く', () => {
    const raw =
      '{"t":"transcript_append","card_id":"' +
      CARD_ID +
      '","nodes":[{"id":"n1","parent":null,"node":{"kind":"thinking","text":"考え中"},"ts":1}]}'
    const message = JSON.parse(raw) as ServerMessage
    expect(message.t).toBe('transcript_append')
    if (message.t === 'transcript_append') {
      expect(message.nodes[0].node.kind).toBe('thinking')
    }
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
