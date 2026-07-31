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

  it('spawn は起動先の PC を運べる', () => {
    // 複数台が繋がっているときだけ要る。Rust 側は `#[serde(default)]` なので、
    // **キーごと送らない形も受け付ける**（1台構成とローカルモードがそれ）
    const targeted: ClientMessage = {
      t: 'spawn',
      cwd: '/home/example/dev/app',
      permission_mode: null,
      agent_id: '11111111-1111-1111-1111-111111111111',
    }
    expect(JSON.stringify(targeted)).toBe(
      '{"t":"spawn","cwd":"/home/example/dev/app","permission_mode":null,' +
        '"agent_id":"11111111-1111-1111-1111-111111111111"}',
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

  it('set_model', () => {
    const message: ClientMessage = {
      t: 'set_model',
      card_id: CARD_ID,
      // 運ぶのは切り替え先の別名。CLI はフルID（claude-opus-5）を名乗り返すので、
      // 送った値と返る値は一致しない
      model: 'opus',
    }
    expect(JSON.stringify(message)).toBe(
      `{"t":"set_model","card_id":"${CARD_ID}","model":"opus"}`,
    )
  })

  it('SessionMeta はモデルを3つのフィールドで運ぶ', () => {
    // 確定値と要求値を同じ入れ物に潰すと、CLI に拒否されたときに画面が
    // 嘘をつき続ける（設計§5）。Rust 側の
    // `確定したモデルと切替を要求した値は別のフィールドで運ばれる` と対になる
    const raw =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"model":"claude-opus-5","model_label":"Opus 5",' +
      '"model_requested":"sonnet","status":{"kind":"unknown"},"subagent_active":0,' +
      '"last_activity_at":1,"last_assistant_message":null,"created_at":1,"hooks_seen":false,' +
      '"agent_id":null,"agent_connected":true,"account":null,"toml_account":null}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.model).toBe('claude-opus-5')
    expect(meta.model_label).toBe('Opus 5')
    expect(meta.model_requested).toBe('sonnet')
  })

  it('まだ名乗っていないモデルは null で届く', () => {
    // キーごと消えるのではなく null。「モデルが無い」ではなく
    // 「まだ CLI が名乗っていない」を表す
    const raw =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"model":null,"model_label":null,"model_requested":null,' +
      '"status":{"kind":"starting"},"subagent_active":0,' +
      '"last_activity_at":1,"last_assistant_message":null,"created_at":1,"hooks_seen":false,' +
      '"agent_id":null,"agent_connected":true,"account":null,"toml_account":null}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.model).toBeNull()
    expect(meta.model_label).toBeNull()
    expect(meta.model_requested).toBeNull()
  })

  it('SessionMeta は hooks_seen を持つ', () => {
    // Rust 側 `session_metaが往復する` と同じ形。片方だけ足すと
    // 「繋がるのに警告が出ない」状態になる
    const raw =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"status":{"kind":"unknown"},"subagent_active":0,"last_activity_at":1,' +
      '"last_assistant_message":null,"created_at":1,"hooks_seen":false,' +
      '"agent_id":null,"agent_connected":true,"account":null,"toml_account":null}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.hooks_seen).toBe(false)
  })

  it('SessionMeta は PC の帰属と接続の鮮度を運ぶ', () => {
    // Rust 側 `session_metaのPCまわりは省略できない` と対になる。
    // `agent_connected` は `status` を上書きせず、その鮮度だけを表す——
    // 「作業中（接続断）」と見えるのが要件2-3 の充足形
    const raw =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"model":null,"model_label":null,"model_requested":null,' +
      '"status":{"kind":"working"},"subagent_active":0,"last_activity_at":1,' +
      '"last_assistant_message":null,"created_at":1,"hooks_seen":true,' +
      '"agent_id":"11111111-1111-1111-1111-111111111111",' +
      '"agent_connected":false,"account":"mao","toml_account":null}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.agent_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(meta.agent_connected).toBe(false)
    expect(meta.account).toBe('mao')
    // 切断していても、最後に知っていた状態はそのまま残る
    expect(meta.status.kind).toBe('working')
  })

  it('ローカルモードでは PC の帰属が null で届く', () => {
    // エージェントという単位が存在しないので、埋めるべき値が無い。
    // 「1台だけの PC」を表す ID を作って埋めてはいけない（後から本物が繋がったときに
    // 区別できなくなる）
    const raw =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"model":null,"model_label":null,"model_requested":null,' +
      '"status":{"kind":"starting"},"subagent_active":0,"last_activity_at":1,' +
      '"last_assistant_message":null,"created_at":1,"hooks_seen":false,' +
      '"agent_id":null,"agent_connected":true,"account":null,"toml_account":null}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.agent_id).toBeNull()
    expect(meta.account).toBeNull()
    expect(meta.agent_connected).toBe(true)
  })

  it('申告したアカウントと帰属したアカウントは別々に届く', () => {
    // Rust 側 `申告したアカウントと帰属したアカウントは別々に運ばれる` と対になる。
    // toml に他人の名前を書いても帰属（account）は動かない——**見ているのが
    // 申告ではなく接続だから**（設計§8-5）。両方が線を渡ってくるので、
    // 画面は「名乗った名前」と「実際の持ち主」を並べて出せる
    const raw =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"model":null,"model_label":null,"model_requested":null,' +
      '"status":{"kind":"idle"},"subagent_active":0,"last_activity_at":1,' +
      '"last_assistant_message":null,"created_at":1,"hooks_seen":true,' +
      '"agent_id":null,"agent_connected":true,' +
      '"account":"わたし","toml_account":"よその人"}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.account).toBe('わたし')
    expect(meta.toml_account).toBe('よその人')
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
      model: null,
      model_label: null,
      model_requested: null,
      status: { kind: 'unknown' },
      subagent_active: 0,
      last_activity_at: 0,
      last_assistant_message: null,
      created_at: 0,
      hooks_seen: false,
      agent_id: null,
      agent_connected: true,
      account: null,
      toml_account: null,
    }
    expect(isHookSilent(base)).toBe(true)
    expect(isHookSilent({ ...base, hooks_seen: true })).toBe(false)
    expect(isHookSilent({ ...base, status: { kind: 'working' } })).toBe(false)
  })
})
