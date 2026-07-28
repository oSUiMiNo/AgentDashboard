/**
 * サーバ（Rust）とやり取りする JSON メッセージの型（設計§4）。
 *
 * Rust 側の `crates/protocol/src/ws.rs` と手で対応させている。ズレると実行するまで
 * 気づけないので、両側に「同じ JSON 文字列になること」を確かめるテストを置いてある
 * （web は `protocol.test.ts`、Rust は `ws.rs` の `種別名はスネークケースのtフィールドで表現される`）。
 */

/** ダッシュボード内で不変のセッションカードID（UUID の文字列表現）。 */
export type CardId = string

/** 一覧の小窓に出す状態（設計§5）。 */
export type SessionStatus =
  | { kind: 'starting' }
  | { kind: 'working' }
  | { kind: 'waiting_permission' }
  | { kind: 'waiting_input' }
  | { kind: 'stalled' }
  | { kind: 'ended'; ok: boolean }
  | { kind: 'unknown' }

/** 一覧の小窓1枚分の情報。 */
export interface SessionMeta {
  card_id: CardId
  /** 作業ディレクトリの絶対パス。一覧のグループ化キーになる */
  project: string
  claude_session_id: string | null
  status: SessionStatus
  subagent_active: number
  last_activity_at: number
  last_assistant_message: string | null
  created_at: number
}

/** JSONL レコードの `uuid` に対応するノードID。 */
export type NodeId = string

/** ツールコールの完了状態。 */
export type ToolStatus = 'pending' | 'ok' | 'error'

/** 親のツールコールにぶら下がるサブエージェントの参照情報。 */
export interface SubagentRef {
  agent_type: string
  /** `<セッションID>/subagents/agent-*.jsonl` へのパス */
  transcript_path: string
  spawn_depth: number
}

/**
 * 構造化ビューの1ノード（設計§3）。
 *
 * Rust 側 `crates/protocol/src/lib.rs` の `Node` と対応する。`#[serde(tag = "kind")]`
 * なので、状態（`SessionStatus`）と同じ判別共用体の形で届く。
 */
export type Node =
  | { kind: 'user_message'; text: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_call'
      name: string
      input: unknown
      result: unknown | null
      status: ToolStatus
      subagent: SubagentRef | null
    }
  | { kind: 'subagent'; agent_type: string; spawn_depth: number }
  /** 寛容パースの受け皿。知らない構造でも情報を落とさずに運ばれてくる */
  | { kind: 'unknown'; record_type: string; raw: unknown }

/** スレッディング層が組み立てるツリーの1ノード。 */
export interface TreeNode {
  id: NodeId
  parent: NodeId | null
  node: Node
  ts: number
}

/** ターミナルのフロー制御の指示（設計§10）。 */
export type FlowState = 'pause' | 'resume'

/** ブラウザ → サーバ。 */
export type ClientMessage =
  | { t: 'sub_pty'; card_id: CardId; cols: number; rows: number }
  | { t: 'unsub_pty'; card_id: CardId }
  | { t: 'spawn'; cwd: string }
  | { t: 'resize'; card_id: CardId; cols: number; rows: number }
  | { t: 'pty_flow'; card_id: CardId; state: FlowState }
  | { t: 'kill'; card_id: CardId }
  | { t: 'archive'; card_id: CardId }
  // 以下はサーバ側の実装がフェーズ3〜4。型だけ先に揃えてある
  | { t: 'sub_transcript'; card_id: CardId }
  | { t: 'unsub_transcript'; card_id: CardId }
  | { t: 'send_input'; card_id: CardId; text: string }

/** サーバ → ブラウザ。 */
export type ServerMessage =
  /** 接続直後の1通目。フロー制御のしきい値はサーバ設定なので受け取ってから使う */
  | { t: 'hello'; flow_high: number; flow_low: number }
  | { t: 'session_upsert'; session: SessionMeta }
  | { t: 'session_removed'; card_id: CardId }
  | { t: 'error'; card_id: CardId | null; message: string }
  // 以下はサーバ側の実装がフェーズ2〜5。届いても落ちないように型は持っておく
  | {
      t: 'status'
      card_id: CardId
      status: SessionStatus
      subagent_active: number
      last_activity_at: number
    }
  | { t: 'transcript_append'; card_id: CardId; nodes: TreeNode[] }
  | { t: 'transcript_reset'; card_id: CardId }
  | { t: 'parser_status'; state: 'ok' | 'degraded'; detail: string | null }
  | { t: 'selfheal'; phase: string; detail: string | null }

/** 状態を日本語のラベルにする。 */
export function statusLabel(status: SessionStatus): string {
  switch (status.kind) {
    case 'starting':
      // 起動はしたが SessionStart フックがまだ届いていない、ごく短い期間
      return '起動中'
    case 'working':
      return '作業中'
    case 'waiting_permission':
      return '権限確認待ち'
    case 'waiting_input':
      return '入力待ち'
    case 'stalled':
      return '停滞'
    case 'ended':
      return status.ok ? '終了' : '異常終了'
    case 'unknown':
      return '不明'
  }
}

/**
 * 状態インジケータの色。
 *
 * 一覧の主役は「AIが止まらずちゃんと働いているか」を一瞥で確かめることなので、
 * **人の対処が要る状態（権限確認待ち・停滞・異常終了）を目立たせる**配色にしている。
 * 順調に動いているものが騒がしいと、本当に見るべきものが埋もれる。
 */
export function statusTone(status: SessionStatus): string {
  switch (status.kind) {
    case 'working':
      return 'bg-emerald-500'
    case 'waiting_permission':
      // 人が対処しないと先に進まない。一番強く出す
      return 'bg-amber-400'
    case 'stalled':
      return 'bg-orange-500'
    case 'waiting_input':
      return 'bg-sky-500'
    case 'starting':
      return 'bg-slate-400'
    case 'ended':
      return status.ok ? 'bg-slate-500' : 'bg-red-500'
    case 'unknown':
      return 'bg-red-500'
  }
}

/** 人の対処を待っている状態か（一覧で目立たせるかの判定）。 */
export function needsAttention(status: SessionStatus): boolean {
  return (
    status.kind === 'waiting_permission' ||
    status.kind === 'stalled' ||
    status.kind === 'unknown' ||
    (status.kind === 'ended' && !status.ok)
  )
}

/** 終了しているか（archive してよいか）の判定。 */
export function isEnded(status: SessionStatus): boolean {
  return status.kind === 'ended'
}
