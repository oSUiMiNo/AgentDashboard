/**
 * サーバ（Rust）とやり取りする JSON メッセージの型（設計§4）。
 *
 * Rust 側の `crates/protocol/src/ws.rs` と手で対応させている。ズレると実行するまで
 * 気づけないので、両側に「同じ JSON 文字列になること」を確かめるテストを置いてある
 * （web は `protocol.test.ts`、Rust は `ws.rs` の `種別名はスネークケースのtフィールドで表現される`）。
 */

import type { CSSProperties } from 'react'

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

/**
 * セッションの権限モード（`--permission-mode` の値）。
 *
 * Rust 側 `PermissionMode` と同じく**ただの文字列**。CLI がモードを増やしても
 * 古い画面が落ちないよう、union 型にはしない。知らない値はそのまま表示する。
 *
 * 運ばれてくるのは常に**正規値**（「毎回確認する」モードは `manual` ではなく
 * `default`）。寄せるのはサーバ側の仕事なので、ここでは変換しない。
 */
export type PermissionMode = string

/**
 * セッションが使っている LLM モデル。
 *
 * Rust 側 `ModelId` と同じく**ただの文字列**。理由は `PermissionMode` と同じだが、
 * モデルは権限モードよりずっと頻繁に増えるので、union 型にしない判断はより強く効く。
 *
 * # 2つの顔があることに注意
 *
 * | 出どころ | 例 | どこで使うか |
 * |---|---|---|
 * | 切り替え先として選ぶ**別名** | `opus` / `sonnet` / `default` | `set_model` で送る |
 * | CLI が名乗る**フルID** | `claude-opus-5` | いま動いているモデルとして受け取る |
 *
 * 別名を送ってもフルIDが返るので、**送った値と返る値は一致しない**。
 * 「いま何で動いているか」の正は常に CLI 側にある。
 */
export type ModelId = string

/** 一覧の小窓1枚分の情報。 */
export interface SessionMeta {
  card_id: CardId
  /** 作業ディレクトリの絶対パス。一覧のグループ化キーになる */
  project: string
  claude_session_id: string | null
  /**
   * いまの権限モード。`null` は「まだ分からない」。
   *
   * 空欄にせず「不明」と出せるようにするための `null`（`hooks_seen` と同じ理由）。
   */
  permission_mode: PermissionMode | null
  /**
   * CLI が名乗った、いま動いているモデルのフルID。`null` は「まだ名乗っていない」。
   *
   * 「モデルが無い」ではない点に注意。注入した `statusLine` が最初の値を送ってくる
   * までは必ずここから始まる。
   */
  model: ModelId | null
  /**
   * 画面に出すモデルの名前（`Opus 5` など）。
   *
   * `model` と2つ持つのは、**版番号をこちらで管理しないため**。別名がどの版に解決
   * されるかはプロバイダによって違うので、こちらの表には書けない。CLI がくれる
   * `display_name` をそのまま出す。
   */
  model_label: string | null
  /**
   * 切替を要求したが、まだ CLI が名乗り直していない値（楽観更新）。
   *
   * `statusLine` はモデル変更では走らないので、送った直後は確定値が古いままになる。
   * その間の「押した手応え」を返すための推測値なので、**確定値とは別に持ち、画面でも
   * 見分けが付くようにする**。
   */
  model_requested: ModelId | null
  status: SessionStatus
  subagent_active: number
  last_activity_at: number
  last_assistant_message: string | null
  created_at: number
  /**
   * フックを1件でも受け取ったか（設計§11 の「フック未受信」警告）。
   *
   * `unknown` には「フックが来ない」以外の理由もありうるので、*なぜ* 判断できないのかを
   * 画面に出すにはこの印が要る。
   */
  hooks_seen: boolean
  /**
   * どの PC のセッションか。**ローカルモードは `null`**。
   *
   * 一覧に PC 名バッジを出すための材料。名前ではなく ID を運ぶのは、PC の名前が
   * 後から変わりうるため。
   */
  agent_id: string | null
  /**
   * その PC といま繋がっているか。
   *
   * `status` を上書きするのではなく、**その鮮度**を表す。切断中は最後に知っていた
   * 状態のまま「接続断」を重ねて出す（「作業中（接続断）」と見える）。
   *
   * ローカルモードでも `false` になることがある。DB が真実になったので、
   * **再起動前のカードが記録として戻ってくる**（PTY は道連れで死んでいる）。
   */
  agent_connected: boolean
  /** 帰属アカウント名（表示用）。ローカルモードは `null` */
  account: string | null
  /**
   * `.agent-dashboard.toml` がこのセッションについて名乗ったアカウント名（設計§8-5）。
   *
   * `account`（サーバが決めた帰属）とは別物で、こちらは**セッションホストの申告**。
   * セルフホストでは食い違っても帰属は動かない（持っていない権限は名乗れない）。
   * ローカルモードには認証が無いので、一覧の絞り込みとしてだけ使う。
   */
  toml_account: string | null
  /**
   * CLI が付けたセッションの名前（`--resume` の一覧に出るもの）。
   *
   * `null` は「まだ付いていない」。名前は**最初のターンのあとに付く**ので、
   * 起こした直後は必ずここから始まる。長さの上限は運ぶ側では置いていないので、
   * **切るのは画面の仕事**。
   */
  session_title: string | null
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
  /**
   * 何本目の会話の枝に属するか（0 始まり）。
   *
   * `/rewind` は JSONL を物理的に巻き戻さず、同じファイルの末尾に2つ目の根として
   * 追記する（設計§16）。巻き戻して捨てたはずのやりとりを畳むための番号。
   */
  branch: number
}

/** ターミナルのフロー制御の指示（設計§10）。 */
export type FlowState = 'pause' | 'resume'

/** ブラウザ → サーバ。 */
export type ClientMessage =
  | { t: 'sub_pty'; card_id: CardId; cols: number; rows: number }
  | { t: 'unsub_pty'; card_id: CardId }
  /**
   * `permission_mode` が null のときは CLI に何も渡さない（利用者の既定を尊重する）。
   *
   * `agent_id` はどの PC で起こすか。**ローカルモードと、繋がっているのが1台のときは
   * `null`**（選ぶ余地が無いので画面にも出さない）。複数台が繋がっているのに null で
   * 送ると、サーバは黙って1台目へ送らずに断る。
   */
  | {
      t: 'spawn'
      cwd: string
      permission_mode: PermissionMode | null
      agent_id?: string | null
    }
  | { t: 'set_permission_mode'; card_id: CardId; mode: PermissionMode }
  /** 運ぶのは切り替え先の**別名**（`opus` など）。CLI が名乗り返すフルIDとは別物 */
  | { t: 'set_model'; card_id: CardId; model: ModelId }
  | { t: 'resize'; card_id: CardId; cols: number; rows: number }
  | { t: 'pty_flow'; card_id: CardId; state: FlowState }
  /**
   * 抜け殻のカードを、元の CLI セッションで起こし直す（復旧）。
   *
   * **運ぶのはカードIDだけ。** 作業ディレクトリ・権限モード・呼び戻し先はサーバ側の
   * 記録が持っている。ここに材料を載せると、画面が抱えている古い写しで起こし直す
   * 経路ができる。
   */
  | { t: 'revive_session'; card_id: CardId }
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
  | { t: 'bus_status'; state: 'ok' | 'degraded'; detail: string | null }
  | { t: 'selfheal'; phase: SelfhealPhase; detail: string | null }
  | { t: 'project_upsert'; project: ProjectView }
  | { t: 'project_removed'; project_id: string }

/**
 * 追加した PJT 枠1枚（イシューグループ_2026_0805_0514 設計§11）。
 *
 * **セッションが何本居るかは持たない。** カードから毎回数える——ここへ持たせると、
 * カードの増減と枠の配信が食い違ったときに画面が嘘をつく。
 *
 * `host` は `agent_id` の文字列か、ローカルを表す `'local'`。REST のパス
 * （`/api/hosts/{host}/dir`）と同じ綴りで、**サーバの記録の中の番兵とは別物**。
 */
export interface ProjectView {
  id: string
  host: string
  path: string
  created_at: number
}

/**
 * 自己修復の進み具合（設計§9）。
 *
 * Rust 側の `SelfhealPhase` と同じ綴りでなければならない。文字列のままにすると
 * 綴り違いが型検査を通り、「進行が画面に出ない」という追いにくい形でしか表に出ない。
 */
export type SelfhealPhase =
  | 'detected'
  | 'canary'
  | 'testing'
  | 'repairing'
  | 'verifying'
  | 'passed'
  | 'swapped'
  | 'rolled_back'
  | 'failed'
  | 'cooldown'

/** 自己修復の段階を日本語のラベルにする。 */
export function selfhealLabel(phase: SelfhealPhase): string {
  switch (phase) {
    case 'detected':
      return '履歴の異常を検知しました'
    case 'canary':
      return '新しい版のサンプルを採っています'
    case 'testing':
      return 'サンプルでパーサを検証しています'
    case 'repairing':
      return '修復セッションが作業しています'
    case 'verifying':
      return '修復の結果を検証しています'
    case 'passed':
      return '対応済みでした（修復は不要）'
    case 'swapped':
      return 'パーサを差し替えました'
    case 'rolled_back':
      return '悪化したため前のパーサへ戻しました'
    case 'failed':
      return '自動修復に失敗しました'
    case 'cooldown':
      return '同じ版への再挑戦を控えています'
  }
}

/** 権限モードの危険度。表示の強さを決めるのに使う。 */
export type PermissionDanger = 'low' | 'medium' | 'high'

/**
 * セッション画面から Shift+Tab で**そのモードへ行けるか**。
 *
 * CLI の巡回は `default → acceptEdits → plan` が基本で、`bypassPermissions` は
 * 起動時に有効化した場合だけ、`auto` はアカウントの条件を満たす場合だけ加わる。
 * `dontAsk` は**巡回に一切入らない**（起動時にしか選べない）。押す前に分かることは
 * 押す前に出す、という判断のための印。
 */
export type PermissionReach =
  /** いつでも巡回に入っている */
  | 'cycle'
  /** アカウントの条件次第で巡回に入る */
  | 'conditional'
  /** 起動時に選んだセッションでだけ巡回に入る */
  | 'launch-required'
  /** 巡回に入らない。起動時にしか選べない */
  | 'launch-only'

export interface PermissionModeInfo {
  value: PermissionMode
  label: string
  description: string
  danger: PermissionDanger
  reach: PermissionReach
}

/**
 * Claude Code の権限モード表（`claude --help` の choices と公式ドキュメント）。
 *
 * **サービスごとの表**という形にしてある。codex 等を後から対象に足すときは、
 * 同じ形の表をもう1つ持てばよい（今回は Claude Code の分だけを埋める）。
 *
 * 値は**正規値**で持つ。「毎回確認する」モードは CLI では `manual` と綴るが、
 * フックと設定では `default` になる（サーバ側が寄せてから届く）。
 */
export const PERMISSION_MODES: PermissionModeInfo[] = [
  {
    value: 'default',
    label: '手動確認',
    description: 'ツールごとに確認を出す（既定）',
    danger: 'low',
    reach: 'cycle',
  },
  {
    value: 'acceptEdits',
    label: '編集を自動承認',
    description: 'ファイル編集だけ確認を飛ばす',
    danger: 'medium',
    reach: 'cycle',
  },
  {
    value: 'plan',
    label: 'プラン',
    description: '計画を立てるだけで変更しない',
    danger: 'low',
    reach: 'cycle',
  },
  {
    value: 'auto',
    label: '自動',
    description: '分類器の判断で自動実行する',
    danger: 'medium',
    reach: 'conditional',
  },
  {
    value: 'dontAsk',
    label: '確認しない',
    description: '事前に許可したツールだけを実行する',
    danger: 'high',
    reach: 'launch-only',
  },
  {
    value: 'bypassPermissions',
    label: '全承認をスキップ',
    description: '権限確認そのものを行わない',
    danger: 'high',
    reach: 'launch-required',
  },
]

/**
 * モードの情報を引く。**表に無い値でも落ちない。**
 *
 * CLI がモードを増やしたときに画面が壊れないことを優先する。知らない値は
 * 受け取った文字列をそのまま表示名にし、危険度は判断できないので中間に置く。
 */
export function permissionModeInfo(mode: PermissionMode): PermissionModeInfo {
  const known = PERMISSION_MODES.find((entry) => entry.value === mode)
  if (known) {
    return known
  }
  return {
    value: mode,
    label: mode,
    description: 'このダッシュボードが知らないモードです',
    danger: 'medium',
    reach: 'conditional',
  }
}

/** モードの表示名。まだ分からない場合は「不明」。 */
export function permissionModeLabel(mode: PermissionMode | null): string {
  return mode === null ? '不明' : permissionModeInfo(mode).label
}

/**
 * モードのバッジの見た目。
 *
 * **危険なモードほど目立たせ、既定のモードは静かに出す。** 一覧の目的は
 * 「見るべきものが埋もれないこと」なので、全承認をスキップしているセッションが
 * 並んでいるのに気づかない、という状態を作らない。逆に全部を目立たせると
 * 何も目立たなくなる。
 */
export function permissionModeTone(mode: PermissionMode | null): string {
  if (mode === null) {
    return 'border-border text-muted-foreground'
  }
  switch (permissionModeInfo(mode).danger) {
    case 'high':
      return 'border-red-500/60 bg-red-500/15 text-red-300'
    case 'medium':
      return 'border-amber-500/50 bg-amber-500/10 text-amber-300'
    case 'low':
      return 'border-border text-muted-foreground'
  }
}

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
 * 状態を5つの群のどれかへ写す（カード設計§8-1）。
 *
 * **8つの姿に7色を割り当てていたのをやめ、5色へ畳んだ。** 1つの画面で色符号化に
 * 使えるのは6色までで、規範はさらに「赤・黄・琥珀を警報以外へ広く使うと、警報の
 * 注意喚起力が落ちる」と明記している（調査§4-4）。畳んだぶんは**記号**で分ける
 * （[`statusGlyph`]）ので、「あなたの番かどうか」を色が答え、「どちらの番か」を
 * 記号が答える形になる。
 *
 * **群の名前は色ではなく役割で持つ。** `DESIGN.md` §11.2 が「アクセントカラーは
 * 役割で固定する」と定めており、色名で持つと**次に色を差し替えたときに名前が嘘になる**。
 *
 * | 群 | 役割（`DESIGN.md` §11.2） | 状態 |
 * |---|---|---|
 * | `primary` | 進行中 | 作業中 |
 * | `secondary` | 注意・保留 | 停滞・入力待ち・権限確認待ち |
 * | `neutral` | — | **起動中・終了** |
 * | `negative` | エラー | 異常終了・不明 |
 *
 * **`secondary` が3状態を抱えるのが、役割表へ寄せた代償である。** 色で読めるのは
 * 「進行中／注意／エラー」の3段までになり、**その中のどれかは記号が答える**
 * （利用者の判断・2026-08-26）。
 *
 * **終了は `positive` へ写さない**（利用者の判断・2026-08-26）。役割表の Positive は
 * 「完了・同期済み」——**操作が成功した合図**であって、**もう動いていない**こととは違う。
 * 3つの理由で `neutral` に置く。
 *
 * 1. **比率が壊れる。** `DESIGN.md` §11.3 は Neutral 75〜85% を目安にしているが、
 *    実機は **16枚中7枚（43%）が終了**だった。あそこへアクセントを当てると、
 *    いちばん数の多い状態が画面を染める
 * 2. **合図の強さが対処の必要性と逆になる。** 終了は**対処がまったく要らない**唯一の
 *    状態群である（調査§4-3）。4つしかないアクセントを、いちばん何もしなくてよいものへ
 *    渡すことになる
 * 3. **区別は失われない。** 異常終了とは記号（`✓` / `✕`）と色（`negative`）で分かれ、
 *    起動中とは記号（`◌` / `✓`）で分かれる
 *
 * **したがって Positive/Lime は、いまどの状態にも使っていない。** 役割表から外したの
 * ではなく、**このカードには当てはまる状態が無い**という形である——「完了・同期済み」を
 * 出す場面が来たら、そのときに使う。
 *
 * **8→5 の写像はここ1箇所しかない。** 群から先の見た目（輪の色・濃さ・●の色・
 * 文字色）は [`STATUS_TONES`] が1つの表で持つ。
 */
export type StatusGroup =
  | 'primary'
  | 'secondary'
  | 'neutral'
  | 'positive'
  | 'negative'

export function statusGroup(status: SessionStatus): StatusGroup {
  switch (status.kind) {
    case 'working':
      // 進行中。放っておいてよい
      return 'primary'
    case 'stalled':
      // 注意——進んでいないかもしれない
      return 'secondary'
    case 'waiting_permission':
    case 'waiting_input':
      // 保留——**あなたが答えないと進まない。** どちらの番かは記号で分ける
      return 'secondary'
    case 'starting':
      return 'neutral'
    case 'ended':
      // **終わったものは静かにする。** 対処が要らない唯一の状態群で、しかも実機では
      // いちばん数が多い（16枚中7枚）。起動中と同じ灰にし、記号（`◌` / `✓`）で分ける
      return status.ok ? 'neutral' : 'negative'
    case 'unknown':
      return 'negative'
  }
}

/**
 * 群ごとの見た目。**色の対応表はこの1つだけ。**
 *
 * 輪の色（`accent`）と●の色（`dot`）と文字色（`text`）を別々の表に書くと、
 * 片方だけ直したときに**同じ状態が場所によって違う色になる**。
 *
 * **実値は `DESIGN.md` §11.2 の役割表から取っている。** あそこは「候補を並べる
 * だけでは決まらない。画面ごとに違う色が選ばれて統一が壊れる」として役割ごとに
 * 1色を固定しており、**変えるときは表ごと差し替える**と決めてある。だからここも
 * 表ごと差し替えた——1色だけ入れ替えると、役割表との対応がその1行で切れる。
 *
 * `dim` は**輪がいちばん薄くなるときの濃さ**。状態を示す部品には非テキストの
 * コントラスト 3:1 が要るので（調査§6-5）、カードの地（`--card` = `#171717`）に
 * 対して 3:1 を満たす最小値を 0.05 刻みで切り上げてある。**色を差し替えたら
 * 引き直すこと**——旧5色の値をそのまま持ち越すと、割る色が出る（実測で 4色が割った）。
 *
 * **`negative` がいちばん高いのは偶然ではない**——赤系は輝度の 71.52% を担う緑成分を
 * ほとんど持たないので、濃くしても明るくならない。
 *
 * 文字は輪より1段明るい（§8-3）。細い文字に濃い色を当てると、いちばん読ませたい
 * ラベルがいちばん読みにくくなる。
 */
const STATUS_TONES: Record<
  StatusGroup,
  { accent: string; dim: string; dot: string; text: string }
> = {
  // 進行中（`DESIGN.md` §11.2 Primary Accent）
  primary: {
    accent: '#3dd9e6',
    dim: '45%',
    dot: 'bg-cyan-400',
    text: 'text-cyan-300',
  },
  // 注意・保留（同 Secondary Accent）
  secondary: {
    accent: '#f5a623',
    dim: '50%',
    dot: 'bg-amber-400',
    text: 'text-amber-300',
  },
  // 役割を持たない静止。**地の色ではなく、文字の副色から取る**（同 §11.1 Text Secondary）
  neutral: {
    accent: '#9aa4b2',
    dim: '55%',
    dot: 'bg-slate-400',
    text: 'text-slate-300',
  },
  // 完了（同 Positive）
  // 完了・同期済み（同 Positive）。
  //
  // **いまどの状態にも当たっていない。** 終了は `neutral` へ置いた（[`statusGroup`]）
  // ——役割表の Positive は「操作が成功した合図」で、「もう動いていない」こととは違う。
  //
  // **消さずに残す。** 役割表（`DESIGN.md` §11.2）は4色で1組なので、1行だけ抜くと
  // 対応がそこで切れる。「完了・同期済み」を出す場面が来たら、この行を使う。
  positive: {
    accent: '#8fd14f',
    dim: '50%',
    dot: 'bg-lime-400',
    text: 'text-lime-300',
  },
  // エラー（同 Negative）
  negative: {
    accent: '#ff5a5f',
    dim: '65%',
    dot: 'bg-rose-400',
    text: 'text-rose-300',
  },
}

/**
 * 状態インジケータの色（セッション画面の●）。
 *
 * 一覧の主役は「AIが止まらずちゃんと働いているか」を一瞥で確かめることなので、
 * **人の対処が要る状態（権限確認待ち・停滞・異常終了）を目立たせる**配色にしている。
 * 順調に動いているものが騒がしいと、本当に見るべきものが埋もれる。
 *
 * **一覧のカードは●をやめた**（カード設計§8）が、セッション画面の●は残してある。
 * ここが同じ表から引いているので、**畳んだ5色が両方の画面へ同時に効く**（§8-5）。
 */
export function statusTone(status: SessionStatus): string {
  return STATUS_TONES[statusGroup(status)].dot
}

/**
 * 状態ラベルの文字色（カード設計§8-3）。
 *
 * ラベルそのものを状態の色で出す。輪が消える環境（`forced-colors`）でも、
 * 動きを止めたあとでも、**色と文字だけは残る**。
 */
export function statusTextTone(status: SessionStatus): string {
  return STATUS_TONES[statusGroup(status)].text
}

/**
 * 輪の色と、いちばん薄いときの濃さ（カード設計§8・§9-2-1）。
 *
 * CSS 側は変数を読むだけにしてある——**対応表を2箇所に分けないため**。
 *
 * `React.CSSProperties` はカスタムプロパティを受け付けないので、キャストが要る
 * （付けないと `tsc -b` が落ちる）。
 */
export function statusAccent(status: SessionStatus): CSSProperties {
  const tone = STATUS_TONES[statusGroup(status)]
  return {
    '--tile-accent': tone.accent,
    '--tile-dim': tone.dim,
  } as CSSProperties
}

/**
 * 輪の色だけを取り出す（カード設計§9-7）。
 *
 * 上の `statusAccent` は CSS 変数を載せた `CSSProperties` を返すので、**型の上では
 * `--tile-accent` を読めない**。回遊する線は色を値として持ち回る（層は DOM を1度も
 * 読まない）ので、こちらから取る。**対応表は割らない**——どちらも同じ表を引く。
 */
export function statusAccentColor(status: SessionStatus): string {
  return STATUS_TONES[statusGroup(status)].accent
}

/**
 * カードの動きの種類（カード設計§8-2）。
 *
 * **合図の強さを対処の必要性に比例させたい**が、いまは作業中がいちばん強く回る。
 * 代償（承認待ちのポップアウトが弱まる）を承知のうえで「艦隊が動いている画」を
 * 採った利用者の判断で、**逃げ道は設定画面の「控えめ」**（§9-5-2・§18-2）。
 */
export type StatusMotion =
  | 'spin-fast'
  | 'spin-slow'
  | 'breathe'
  | 'shake'
  | 'still'

export function statusMotion(status: SessionStatus): StatusMotion {
  switch (status.kind) {
    case 'working':
      return 'spin-fast'
    case 'stalled':
      // 同じ形の3倍遅い回転。「動いてはいるが、進んでいない」を速さで読ませる
      return 'spin-slow'
    case 'waiting_input':
      return 'breathe'
    case 'waiting_permission':
      // **人が答えないと先に進まない唯一の状態。** ここだけ位置を動かしてよい
      return 'shake'
    case 'starting':
    case 'ended':
    case 'unknown':
      // 終わったカードが並ぶ画面がいちばんうるさくなる。回す意味も無い
      return 'still'
  }
}

/**
 * 状態の記号（カード設計§8-2）。
 *
 * **●の復活ではない。** ●は色だけを運ぶ点で、色が消えれば何も残らなかった。
 * 記号は形そのものが意味を持つので、**輪が消える環境でも、動きを止めても残る**
 * （§8-4）。ラベルの直前に、同じ色・同じ大きさで置く。
 *
 * **5つ（`⟳ ▶ ◌ ✓ ✕`）は同梱フォントの外へ落ちる**ことが実測で分かっている
 * （§8-2-1）。落ちること自体は避けられないので、落ちる先を `.tile-glyph` の
 * フォント指定で名指ししてある。
 *
 * **入力待ちだけを `▷` から `▶`（塗り）へ寄せた**（`DESIGN.md` §14.1「Filled /
 * Solid / Duotone 主体を基本とする。Thin Outline だけの体系を主役にしない」）。
 * **残りは据え置く。** あの5つは落ちた先の字形で出ており、字を差し替えると
 * **実機で崩れるかどうかを実物で見るまで分からない**——`▶` は落ちた先でも塗りの
 * 三角として出ることを確かめてから入れている。**据え置きは §35.1 の「違反を残すと
 * 決めたときは理由を書く」に当たる。**
 */
export function statusGlyph(status: SessionStatus): string {
  switch (status.kind) {
    case 'working':
      return '⟳'
    case 'stalled':
      return '‖'
    case 'waiting_input':
      return '▶'
    case 'waiting_permission':
      return '!'
    case 'starting':
      return '◌'
    case 'ended':
      return status.ok ? '✓' : '✕'
    case 'unknown':
      return '?'
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

/**
 * フックが1件も届いていないことによる「不明」か（設計§11）。
 *
 * PTY からは出力があるのにフックが0件、という状況をサーバが `unknown` に落としてくる。
 * ただの「不明」と出すと利用者は打つ手が分からないので、**原因を名指しできるときは
 * 名指しする**。フックが届かないのは設定の注入漏れやポートの塞がりが典型で、
 * どちらも利用者が直せる。
 */
export function isHookSilent(session: SessionMeta): boolean {
  return session.status.kind === 'unknown' && !session.hooks_seen
}

/**
 * そのカードを起こし直せるか（復旧設計§3-1・§3-2）。
 *
 * `live` だけが「**ボタンを出さない**」で、残りは**出したうえで押せなくする**。
 * 出さないと「なぜこのカードにだけ無いのか」を利用者が推測することになる。
 */
export type ReviveState =
  /** 実体がある。復旧は要らない */
  | { kind: 'live' }
  | { kind: 'ready' }
  /** 呼び戻す先（CLI のセッションID）が記録に無い */
  | { kind: 'no-target' }
  /** そのカードの PC が、どのインスタンスにも繋がっていない */
  | { kind: 'pc-offline' }
  /** PC は居るが、起こし直しを名乗っていない（版が古い） */
  | { kind: 'pc-old' }

/**
 * そのカードの PC のうち、判定に要る2つだけ。
 *
 * [`AgentInfo`](../stores/settings.ts) をそのまま渡せる形にしてある。**型の名前で
 * 受けない**のは、`lib/` から `stores/` を import すると輪になるため
 * （`stores/settings.ts` はこのファイルを読んでいる）。
 */
export interface ReviveAgent {
  connected: boolean
  supports_revive?: boolean
}

/**
 * 戻せるかを1つの規則で決める（設計§3-1）。
 *
 * サーバ側の同じ規則は `SessionMeta::revivable`（§3-4）にあるが、**突き合わせる台帳は
 * 作らない**（§3-3）。ずれても「押せてしまってサーバが断る」に倒れるだけで、危険側には
 * ならない——サーバのほうが材料が多いので、こちらが甘いことはあっても逆は無い。
 *
 * 見る順は **実体 → 戻す先 → 在否 → 能力**。在否より先に能力を見ると、**知らない PC が
 * 「版が古い」と断られ**、存在しないことと古いことを言い分けてしまう（§6-2）。
 */
export function reviveState(
  session: SessionMeta,
  agent: ReviveAgent | null,
): ReviveState {
  // 実体が無いのは2通り（設計§3-1）。接続断は「PC が居ない」と「PC は居るがこの
  // カードを失った」の両方を含む——後者がセルフホストでの復旧対象そのもの
  if (session.agent_connected && !isEnded(session.status)) {
    return { kind: 'live' }
  }
  if (session.claude_session_id === null) {
    return { kind: 'no-target' }
  }
  // ローカルモードは PC という単位が無い（`agents` は常に空）。ここで在否を見ると
  // **全カードが「PC が繋がっていません」になる**
  if (session.agent_id === null) {
    return { kind: 'ready' }
  }
  if (agent === null || !agent.connected) {
    return { kind: 'pc-offline' }
  }
  if (agent.supports_revive !== true) {
    return { kind: 'pc-old' }
  }
  return { kind: 'ready' }
}

/** 押せない理由の言葉（押せるとき・出さないときは `null`）。 */
export function reviveReason(state: ReviveState): string | null {
  switch (state.kind) {
    case 'no-target':
      return '呼び戻す先が記録されていません'
    case 'pc-offline':
      return 'この PC が繋がっていません'
    case 'pc-old':
      return 'この PC の版が古くて対応していません'
    case 'live':
    case 'ready':
      return null
  }
}
