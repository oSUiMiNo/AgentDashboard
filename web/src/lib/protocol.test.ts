import {
  isEnded,
  isHookSilent,
  PERMISSION_MODES,
  permissionModeInfo,
  permissionModeLabel,
  permissionModeTone,
  reviveReason,
  reviveState,
  selfhealLabel,
  statusAccent,
  statusGlyph,
  statusLabel,
  statusMotion,
  statusTextTone,
  statusTone,
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

  it('連絡係の縮退が Rust と同じ綴りで届く', () => {
    // 綴りが食い違うと、**バナーが出ないだけで繋がっているように見える**——
    // 「片方のブラウザにだけ更新が来ない」という一番読み解きにくい状態が、
    // 理由の分からないまま残る
    const raw =
      '{"t":"bus_status","state":"degraded","detail":"連絡係に繋がりません"}'
    const message = JSON.parse(raw) as ServerMessage
    expect(message.t).toBe('bus_status')
    if (message.t === 'bus_status') {
      expect(message.state).toBe('degraded')
      expect(message.detail).toBe('連絡係に繋がりません')
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

  it('枠の増減は Rust と同じ綴りで往復する', () => {
    // 手書きで二重に定義しているので、ここが唯一のズレ検出手段になる。
    // 綴りは `protocol/src/ws.rs` の「枠の増減は決まった綴りで線に乗る」と対
    const id = '00000000-0000-0000-0000-000000000000'
    const upsert: ServerMessage = {
      t: 'project_upsert',
      project: {
        id,
        host: 'local',
        path: '/home/example/dev/app',
        created_at: 1700000000000,
      },
    }
    expect(JSON.stringify(upsert)).toBe(
      `{"t":"project_upsert","project":{"id":"${id}","host":"local","path":"/home/example/dev/app","created_at":1700000000000}}`,
    )

    const removed: ServerMessage = { t: 'project_removed', project_id: id }
    expect(JSON.stringify(removed)).toBe(
      `{"t":"project_removed","project_id":"${id}"}`,
    )
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

  it('revive_session', () => {
    // 4箇所同期の最後の1つ（復旧設計§4-4）。Rust 側 `client_messageは全種が往復する`
    // が固定している綴りと1文字も違わないこと。**運ぶのはカードIDだけ**——
    // 作業ディレクトリや権限モードを載せると、古い写しで起こし直す経路ができる
    const message: ClientMessage = { t: 'revive_session', card_id: CARD_ID }
    expect(JSON.stringify(message)).toBe(
      `{"t":"revive_session","card_id":"${CARD_ID}"}`,
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
      '"agent_connected":false,"account":"mao","toml_account":null,"session_title":null}'
    const meta = JSON.parse(raw) as SessionMeta
    expect(meta.agent_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(meta.agent_connected).toBe(false)
    expect(meta.account).toBe('mao')
    // 切断していても、最後に知っていた状態はそのまま残る
    expect(meta.status.kind).toBe('working')
  })

  it('ローカルモードでは PC の帰属が null で届く', () => {
    // セッションホストという単位が存在しないので、埋めるべき値が無い。
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

  it('SessionMeta はセッション名を運ぶ', () => {
    // Rust 側 `session_metaはセッション名を運ぶ` と対になる。
    // 名前は CLI が最初のターンのあとに付けるので、**起こした直後は必ず null**。
    const 名前あり =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"model":null,"model_label":null,"model_requested":null,' +
      '"status":{"kind":"idle"},"subagent_active":0,"last_activity_at":1,' +
      '"last_assistant_message":null,"created_at":1,"hooks_seen":true,' +
      '"agent_id":null,"agent_connected":true,"account":null,"toml_account":null,' +
      '"session_title":"TODOを完了に変更し作業内容をまとめる"}'
    expect((JSON.parse(名前あり) as SessionMeta).session_title).toBe(
      'TODOを完了に変更し作業内容をまとめる',
    )

    // **欄ごと無い形も来る**——名前の欄を知らない古い版の PC が名乗ると、
    // サーバはそれをそのまま運ぶ。読む側は `undefined` を受け取るので、
    // 画面は「まだありません」を出す側へ倒す（フェーズ4）。
    //
    // この節の他の JSON リテラルが `session_title` を持たないのは**わざと**で、
    // どれも欄が増える前の名乗りをそのまま残してある。
    const 名前の欄が無い =
      '{"card_id":"' +
      CARD_ID +
      '","project":"/dev/app","claude_session_id":null,' +
      '"permission_mode":null,"model":null,"model_label":null,"model_requested":null,' +
      '"status":{"kind":"idle"},"subagent_active":0,"last_activity_at":1,' +
      '"last_assistant_message":null,"created_at":1,"hooks_seen":true,' +
      '"agent_id":null,"agent_connected":true,"account":null,"toml_account":null}'
    expect((JSON.parse(名前の欄が無い) as SessionMeta).session_title).toBeUndefined()
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
      session_title: null,
    }
    expect(isHookSilent(base)).toBe(true)
    expect(isHookSilent({ ...base, hooks_seen: true })).toBe(false)
    expect(isHookSilent({ ...base, status: { kind: 'working' } })).toBe(false)
  })
})

/**
 * 状態から見た目を決める（カード設計§8）。
 *
 * 見た目そのものはテストで捕まらないが、**状態から何を選んだか**は捕まる。
 * 判断を純関数へ集めてあるのはそのためで、部品はここが返した値を貼るだけにする。
 */
describe('状態から見た目を決める', () => {
  /** 8つの姿。**`ended` は ok で2つに割れる**ので、`kind` の数（7）とは合わない */
  const ALL: SessionStatus[] = [
    { kind: 'working' },
    { kind: 'stalled' },
    { kind: 'waiting_input' },
    { kind: 'waiting_permission' },
    { kind: 'starting' },
    { kind: 'ended', ok: true },
    { kind: 'ended', ok: false },
    { kind: 'unknown' },
  ]

  const accentOf = (status: SessionStatus) =>
    (statusAccent(status) as Record<string, string>)['--tile-accent']
  const dimOf = (status: SessionStatus) =>
    (statusAccent(status) as Record<string, string>)['--tile-dim']
  const floorOf = (status: SessionStatus) =>
    (statusAccent(status) as Record<string, string>)['--tile-floor']

  it('8つの姿それぞれに動きの種類が対応づいている', () => {
    // 作業中＝速く回る／停滞＝遅く回る／入力待ち＝呼吸／承認待ち＝揺れ／残りは動かさない
    expect(statusMotion({ kind: 'working' })).toBe('spin-fast')
    expect(statusMotion({ kind: 'stalled' })).toBe('spin-slow')
    expect(statusMotion({ kind: 'waiting_input' })).toBe('breathe')
    expect(statusMotion({ kind: 'waiting_permission' })).toBe('shake')
    expect(statusMotion({ kind: 'starting' })).toBe('still')
    expect(statusMotion({ kind: 'ended', ok: true })).toBe('still')
    expect(statusMotion({ kind: 'ended', ok: false })).toBe('still')
    expect(statusMotion({ kind: 'unknown' })).toBe('still')
  })

  it('8つの姿それぞれに記号が対応づいている', () => {
    // **色が消える環境でも、動きを止めても残る**のは記号と文字だけ（設計§8-4）。
    // 入力待ちは `DESIGN.md` §14.1「Filled / Solid 主体」へ寄せて `▶`（塗り）にした
    expect(ALL.map(statusGlyph)).toEqual(['⟳', '‖', '▶', '!', '◌', '✓', '✕', '?'])
  })

  it('輪の色が4種類しか現れない', () => {
    // 1つの画面で色符号化に使えるのは6色まで（調査§4-4）。7色から畳んだ。
    // **終了を `neutral` へ移したので、いまは4色**——役割表の Positive は
    // 「操作が成功した合図」で、「もう動いていない」こととは違う（利用者の判断）
    expect(new Set(ALL.map(accentOf)).size).toBe(4)
  })

  it('同じ色を持つ組は、記号で分かれている', () => {
    // 色だけでは見分けられないことを承知で畳んだので、記号が最後の砦になる。
    // **停滞は進行中（Primary）へ移した**（2026-08-26）——作業中の一種なので同じ
    // シアンにし、弱さは太さと濃さで作る。**起動中と終了は同じ灰**にしてある——
    // どちらも「動いていない・対処が要らない」ので、静かな側でまとめている
    const 同色の組: [SessionStatus, SessionStatus][] = [
      [{ kind: 'waiting_input' }, { kind: 'waiting_permission' }],
      [{ kind: 'working' }, { kind: 'stalled' }],
      [{ kind: 'ended', ok: false }, { kind: 'unknown' }],
      [{ kind: 'starting' }, { kind: 'ended', ok: true }],
    ]
    for (const [左, 右] of 同色の組) {
      expect(accentOf(左)).toBe(accentOf(右))
      expect(statusGlyph(左)).not.toBe(statusGlyph(右))
    }
  })

  it('色を伏せても、記号と文言だけで8つの姿を判別できる', () => {
    // ハイコントラストの環境では輪が丸ごと消える（調査§6-4）。そこでも状態が読めること
    const 手掛かり = ALL.map((status) => statusGlyph(status) + statusLabel(status))
    expect(new Set(手掛かり).size).toBe(ALL.length)
  })

  it('輪の薄い側の濃さが、カードの地に対して 3:1 を満たす値になっている', () => {
    // **周期の一部だけ状態が読めなくなる**という壊れ方なので、目で見ても気づけない。
    //
    // **模型は設計§9-2-1 のとおり**——合成の相手はページ地（`#0a0a0a`）、判定の相手は
    // カードの地（`#171717`）。§9-2-1 が公表している旧5色の最小α（琥珀 0.472 /
    // 橙 0.625 / 緑 0.591 / 灰 0.589 / 赤 0.744）を**この模型で再現できることを確かめて
    // から**、いまの5色へ当てた（差 ±0.0004。フェーズ8）。
    //
    // **比の数値を書き添えるときは、この模型で引き直すこと。** 前の版はここに
    // 7.62 / 6.88 / 4.36 / 5.87 / 3.14 と書いてあったが、**どの模型でも再現できない
    // 数値**だった。値そのものは検査が守るが、**コメントの数字は誰も守らない**。
    expect(floorOf({ kind: 'working' })).toBe('50%') // Cyan・最小α 0.479
    expect(floorOf({ kind: 'waiting_input' })).toBe('55%') // Amber・0.522
    expect(floorOf({ kind: 'starting' })).toBe('60%') // Slate・0.584
    expect(floorOf({ kind: 'unknown' })).toBe('70%') // Coral・0.657

    // **静止しているときに塗る濃さは、床より濃くてよい。** 見た目の明るさを揃える
    // ぶんだけ床から上げてある（実物を見た判断・2026-08-26）
    expect(dimOf({ kind: 'working' })).toBe('70%') // Cyan・5.41:1
    expect(dimOf({ kind: 'waiting_permission' })).toBe('75%') // Amber・5.25:1
    // **停滞は作業中と同じシアンなので、濃さで弱さを作る**（2026-08-26）。
    // `primary` の床（50%）は割らない
    expect(dimOf({ kind: 'stalled' })).toBe('55%') // Cyan・作業中の 70% より弱い
    expect(dimOf({ kind: 'unknown' })).toBe('90%') // Coral・4.89:1

    // **起動中だけ床を割っていた**（55% で 2.77:1）。床まで上げた（フェーズ8）
    expect(dimOf({ kind: 'starting' })).toBe('60%') // Slate・3.11:1

    // **終了だけ群より静かにする。** 起動中と同じ灰だが、一覧でいちばん数が多く、
    // 対処が要らない唯一の群である（設計§8-3-1）。
    //
    // **これは床を割る。意図して割る**（設計§9-2-3）——判別は記号と文言が担って
    // おり、輪は補強にすぎない（§8-4。ハイコントラストでは丸ごと消える前提）
    expect(dimOf({ kind: 'ended', ok: true })).toBe('35%') // 1.72:1・床(60%)を割る
  })

  it('どの群にも、床と、床以上の濃さがある', () => {
    // **1つの値に2つの役割を持たせない**（設計§9-2-2）。呼吸の底は `--tile-floor`、
    // 静止時に塗る濃さは `--tile-dim` で、**兼ねると呼吸の幅を広げられない**——
    // 底を下げると、呼吸しない停滞・権限確認待ちまで暗くなる
    const 数 = (v: string) => Number(v.replace('%', ''))
    for (const status of ALL) {
      const 床 = 数(floorOf(status))
      expect(床).toBeGreaterThan(0)
      // 終了だけは意図して割る（上のテスト）。それ以外は床以上であること
      if (status.kind === 'ended' && status.ok) continue
      expect(数(dimOf(status))).toBeGreaterThanOrEqual(床)
    }
  })

  it('文字色は状態ごとに変わり、輪と同じ表から引いている', () => {
    // 表を2つに割ると、同じ状態が場所によって違う色になる（設計§8-3）。
    // **輪と同じ4色**——終了を Neutral へ戻したぶん、こちらも1つ減る
    expect(new Set(ALL.map(statusTextTone)).size).toBe(4)
    expect(statusTextTone({ kind: 'working' })).not.toBe(
      statusTextTone({ kind: 'waiting_permission' }),
    )
  })

  it('セッション画面の●も同じ表から引いている', () => {
    // 一覧は●をやめたが、セッション画面には残る（設計§8-5）。**色は4色へ追随する**
    expect(new Set(ALL.map(statusTone)).size).toBe(4)
    // **起動中と終了は同じ灰**（設計§8-1-2）。どちらも「動いていない・対処が要らない」
    // ので静かな側でまとめてある。分けるのは記号（`◌` / `✓`）の役目
    expect(statusTone({ kind: 'starting' })).toBe(
      statusTone({ kind: 'ended', ok: true }),
    )
    // **停滞は作業中と同じ**（2026-08-26）。入力待ちと同じに見えるのを直した
    expect(statusTone({ kind: 'stalled' })).toBe(statusTone({ kind: 'working' }))
    expect(statusTone({ kind: 'stalled' })).not.toBe(
      statusTone({ kind: 'waiting_input' }),
    )
  })
})

/**
 * 戻せるかの判定（復旧設計§3-1・§3-2）。
 *
 * サーバ側の同じ規則（`SessionMeta::revivable`）と突き合わせる台帳は作らない（§3-3）。
 * ずれても「押せてしまってサーバが断る」に倒れるだけで、危険側にはならない。
 */
describe('戻せるかの判定', () => {
  const AGENT_ID = '99999999-9999-9999-9999-999999999999'

  function card(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return {
      card_id: CARD_ID,
      project: '/dev/app',
      // 戻す先。**製品の経路では必ず埋まる**（起動時に採番して渡すため）が、
      // 記録の形の上では NULL を取りうる
      claude_session_id: '22222222-2222-2222-2222-222222222222',
      permission_mode: 'bypassPermissions',
      model: null,
      model_label: null,
      model_requested: null,
      status: { kind: 'working' },
      subagent_active: 0,
      last_activity_at: 0,
      last_assistant_message: null,
      created_at: 0,
      hooks_seen: true,
      agent_id: null,
      agent_connected: false,
      account: null,
      toml_account: null,
      session_title: null,
      ...overrides,
    }
  }

  it('接続断のカードは戻せる', () => {
    expect(reviveState(card(), null)).toEqual({ kind: 'ready' })
  })

  it('終了したカードも戻せる', () => {
    // 繋がっていても、擬似ターミナルが消えていれば実体は無い（設計§3-1 の B）
    const ended = card({
      agent_connected: true,
      status: { kind: 'ended', ok: true },
    })
    expect(reviveState(ended, null)).toEqual({ kind: 'ready' })
  })

  it('実体があるカードでは、そもそもボタンを出さない', () => {
    const live = card({ agent_connected: true })
    expect(reviveState(live, null)).toEqual({ kind: 'live' })
    // 出さないのはこの1通りだけ。残りは出したうえで押せなくする（設計§3-2）
    expect(reviveReason({ kind: 'live' })).toBeNull()
  })

  it('呼び戻す先が無いカードは、理由を出して押させない', () => {
    const state = reviveState(card({ claude_session_id: null }), null)
    expect(state).toEqual({ kind: 'no-target' })
    expect(reviveReason(state)).toBe('呼び戻す先が記録されていません')
  })

  it('PC が繋がっていなければ、そう言う', () => {
    const remote = card({ agent_id: AGENT_ID })
    // 一覧に居ないときも、居るが切れているときも同じ言い方
    expect(reviveReason(reviveState(remote, null))).toBe(
      'この PC が繋がっていません',
    )
    expect(
      reviveReason(reviveState(remote, { connected: false, supports_revive: true })),
    ).toBe('この PC が繋がっていません')
  })

  it('名乗らない PC は、版が古いと言う', () => {
    const remote = card({ agent_id: AGENT_ID })
    const state = reviveState(remote, { connected: true })
    expect(state).toEqual({ kind: 'pc-old' })
    expect(reviveReason(state)).toBe('この PC の版が古くて対応していません')
  })

  it('在否を先に、能力を後に見る', () => {
    // 逆にすると、**知らない PC が「版が古い」と断られる**（設計§6-2）。
    // 存在しないことと古いことを言い分けられなくなる
    const remote = card({ agent_id: AGENT_ID })
    expect(reviveState(remote, null)).toEqual({ kind: 'pc-offline' })
  })

  it('ローカルモードでは PC の在否を理由にしない', () => {
    // `agents` は常に空なので、素直に引くと全カードが「PC が繋がっていません」になる
    expect(reviveState(card({ agent_id: null }), null)).toEqual({ kind: 'ready' })
  })

  it('名乗っている PC が繋がっていれば戻せる', () => {
    const remote = card({ agent_id: AGENT_ID })
    expect(
      reviveState(remote, { connected: true, supports_revive: true }),
    ).toEqual({ kind: 'ready' })
  })
})
