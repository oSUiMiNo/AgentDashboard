import {
  isEnded,
  isHookSilent,
  PERMISSION_MODES,
  permissionModeInfo,
  permissionModeLabel,
  permissionModeTone,
  selfhealLabel,
  statusLabel,
} from './protocol'
import type {
  ClientMessage,
  Node,
  ServerMessage,
  SessionMeta,
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

  it('selfheal の段階が Rust と同じ綴りで届く', () => {
    // Rust 側は rolled_back のようにスネークケースで書き出す。ここが食い違うと
    // 進行が画面に出ないだけで、繋がっているように見えてしまう
    const raw = '{"t":"selfheal","phase":"rolled_back","detail":null}'
    const message = JSON.parse(raw) as ServerMessage
    expect(message.t).toBe('selfheal')
    if (message.t === 'selfheal') {
      expect(message.phase).toBe('rolled_back')
      expect(selfhealLabel(message.phase)).toBe(
        '悪化したため前のパーサへ戻しました',
      )
    }
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

  it('send_input', () => {
    const message: ClientMessage = {
      t: 'send_input',
      card_id: CARD_ID,
      text: '/rewind',
    }
    expect(JSON.stringify(message)).toBe(
      `{"t":"send_input","card_id":"${CARD_ID}","text":"/rewind"}`,
    )
  })

  it('spawn は権限モードを一緒に運ぶ', () => {
    // 指定なしは null。空文字や "manual" を送るのとは意味が違い、
    // 「CLI に何も渡さない＝利用者の既定を尊重する」という意思表示になる
    const none: ClientMessage = {
      t: 'spawn',
      cwd: '/home/example/dev/app',
      permission_mode: null,
    }
    expect(JSON.stringify(none)).toBe(
      '{"t":"spawn","cwd":"/home/example/dev/app","permission_mode":null}',
    )

    const bypass: ClientMessage = {
      t: 'spawn',
      cwd: '/home/example/dev/app',
      permission_mode: 'bypassPermissions',
    }
    expect(JSON.stringify(bypass)).toBe(
      '{"t":"spawn","cwd":"/home/example/dev/app","permission_mode":"bypassPermissions"}',
    )
  })

  it('set_permission_mode', () => {
    const message: ClientMessage = {
      t: 'set_permission_mode',
      card_id: CARD_ID,
      // 運ぶのは正規値。CLI の別名 manual に寄せるのはサーバ側の仕事
      mode: 'default',
    }
    expect(JSON.stringify(message)).toBe(
      `{"t":"set_permission_mode","card_id":"${CARD_ID}","mode":"default"}`,
    )
  })

  it('SessionMeta は hooks_seen を持つ', () => {
    // Rust 側 `session_metaが往復する` と同じ形。片方だけ足すと
    // 「繋がるのに警告が出ない」状態になる
    const raw =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"status":{"kind":"unknown"},"subagent_active":0,"last_activity_at":1,' +
      '"last_assistant_message":null,"created_at":1,"hooks_seen":false}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.hooks_seen).toBe(false)
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

  it('権限モードの表から表示名と危険度を引ける', () => {
    expect(permissionModeLabel('default')).toBe('手動確認')
    expect(permissionModeLabel('bypassPermissions')).toBe('全承認をスキップ')
    // まだ分からない状態を「不明」と出せること（空欄にしない）
    expect(permissionModeLabel(null)).toBe('不明')

    // 危険なモードほど目立つ見た目になる
    expect(permissionModeTone('bypassPermissions')).not.toBe(
      permissionModeTone('default'),
    )
    expect(permissionModeTone('dontAsk')).toBe(
      permissionModeTone('bypassPermissions'),
    )
  })

  it('表に無いモードでも落ちずにそのまま表示する', () => {
    // CLI がモードを増やしても画面が壊れないこと（union 型にしない理由そのもの）
    const info = permissionModeInfo('まだ知らないモード')
    expect(info.label).toBe('まだ知らないモード')
    expect(permissionModeLabel('まだ知らないモード')).toBe('まだ知らないモード')
    expect(permissionModeTone('まだ知らないモード')).not.toBe('')
  })

  it('切替で到達できないモードが表に印として入っている', () => {
    // Shift+Tab の巡回は起動条件とアカウントで変わる（設計§11 の実測）。
    // 押す前に分かることは押す前に出す
    const reach = (value: string) =>
      PERMISSION_MODES.find((mode) => mode.value === value)?.reach
    expect(reach('default')).toBe('cycle')
    expect(reach('acceptEdits')).toBe('cycle')
    expect(reach('plan')).toBe('cycle')
    expect(reach('auto')).toBe('conditional')
    expect(reach('dontAsk')).toBe('launch-only')
    expect(reach('bypassPermissions')).toBe('launch-required')
  })

  it('フック未受信による不明だけを見分けられる', () => {
    // ただの「不明」と出すと利用者は打つ手が分からない。原因を名指しできるときはする
    const base: SessionMeta = {
      card_id: CARD_ID,
      project: '/dev/app',
      claude_session_id: null,
      permission_mode: null,
      status: { kind: 'unknown' },
      subagent_active: 0,
      last_activity_at: 0,
      last_assistant_message: null,
      created_at: 0,
      hooks_seen: false,
    }
    expect(isHookSilent(base)).toBe(true)
    expect(isHookSilent({ ...base, hooks_seen: true })).toBe(false)
    expect(isHookSilent({ ...base, status: { kind: 'working' } })).toBe(false)
  })
})
