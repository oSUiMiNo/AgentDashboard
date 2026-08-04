/**
 * サーバが持つ設定を読み書きするストア（設計§7・§8・セルフホスト化設計§11-2）。
 *
 * # なぜブラウザに保存しないのか
 *
 * `localStorage` に置くと**ブラウザごとに食い違う**。トグルの意味は「このダッシュボードが
 * どう振る舞うか」なので、置き場所はサーバが正しい。おかげで別のタブで開いても同じ値に
 * なり、アプリを開き直しても残る。
 *
 * # 更新頻度が低いので zustand に置いてよい
 *
 * 一覧の状態や履歴と違って、設定は人が触ったときしか変わらない。React の再レンダリングを
 * 通しても問題にならないので、`useSyncExternalStore` の仕組みは要らない。
 *
 * # 起動時に読む口はここ1つ
 *
 * PC の名前（バッジの引き先）も、モデルの表も、間隔も、同じ応答で届く。分けると
 * 一覧の描画が2つの応答の到着順に依存する。
 */

import { create } from 'zustand'
import type { ModelAliasSeen, ModelCatalogEntry } from '@/lib/models'
import { PERMISSION_MODES, type PermissionMode } from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'

/** 登録済みの PC（セルフホスト化設計§11-1）。 */
export interface AgentInfo {
  id: string
  name: string
  last_seen_at: number | null
  /** いま繋がっているか。DB には持たない値で、応答のたびに被せられる */
  connected: boolean
  /** その PC のエージェントの版（CICD設計§16）。名乗っていなければ無い */
  version?: string | null
}

/** 1台の PC が名乗ったモデルの表（設計§13-4）。 */
export interface ModelTable {
  cli_version?: string
  catalog?: ModelCatalogEntry[]
  aliases?: ModelAliasSeen[]
}

/** 画面から変えられる間隔（設計§13-3）。 */
export interface Intervals {
  sync_interval_secs: number
  screen_interval_ms: number
  scrollback_lines: number
}

/** LAN 開放パスワードの状態（設計§8-3）。 */
export interface LanPassword {
  /** そもそもこの構成にあるか（ローカルモードだけ） */
  supported: boolean
  /** 登録済みか。**値そのものは返ってこない** */
  configured: boolean
  /** いま変えられるか（127.0.0.1 からだけ） */
  editable: boolean
}

/** `GET /api/settings` の応答。 */
export interface Settings {
  /** 起動時の権限モードの**既定の選択**を「全承認をスキップ」にするか（選択肢は減らない） */
  always_bypass_permissions: boolean
  /**
   * トグルを画面から変えられるか。
   *
   * セルフホストでは false。持ち主は PC 側の `agent.toml` で、サーバから書き戻す口が
   * まだ無い。触れないことを画面に出さないと「押しても戻る」ように見える。
   */
  always_bypass_editable: boolean
  /** その CLI が受け付けるモード（正規値）。繋がっている PC ぶんを合併したもの */
  available_modes: PermissionMode[]
  /**
   * PC ごとのモデル表（設計§13-4）。キーは `agent_id`、ローカルは `"local"`。
   *
   * CLI の版は PC ごとに違うので、ModelPicker は**セッションが属する PC の表**を見る。
   */
  model_tables: Record<string, ModelTable>
  /** 登録済みの PC。**PC 名バッジの引き先** */
  agents: AgentInfo[]
  intervals: Intervals
  lan_password: LanPassword
}

/** 触った項目だけを送る（他のタブの変更を巻き戻さないため）。 */
export type SettingsPatch = Partial<{
  always_bypass_permissions: boolean
  lan_password: string
  sync_interval_secs: number
  screen_interval_ms: number
  scrollback_lines: number
}>

interface SettingsState {
  settings: Settings
  /** まだサーバから読めていない間は true。トグルを触らせないために使う */
  loading: boolean
  lastError: string | null
  load: () => Promise<void>
  /**
   * セッションが名乗ったモデルを見て、必要なら設定を取り直す（設計§12）。
   *
   * 別名の実測はサーバが覚えるので、**切り替えた直後は画面の手元が古い**。
   * 取り直さないとリロードするまで選択肢の名前が更新されない（実際にそうなっていた）。
   *
   * 同じ値で何度も取りに行かないよう、一度試した ID は覚えておく。サーバが結局
   * 覚えなかった値（利用者が端末でフルIDを直に打った等）でも、聞くのは1回きり。
   */
  noteModelSeen: (model: string | null) => void
  /** 触った項目だけを保存する。 */
  update: (patch: SettingsPatch) => Promise<boolean>
}

/**
 * サーバから読めるまでの暫定値。
 *
 * **既定はスキップしない側**（設計§9）。読めていない間に「全承認をスキップ」を
 * 選ばれた状態で出してしまうと、利用者が意図せずそのまま起こす余地を作る。
 */
const FALLBACK: Settings = {
  always_bypass_permissions: false,
  always_bypass_editable: false,
  available_modes: PERMISSION_MODES.map((mode) => mode.value),
  // 実測が無い状態が正しい初期値。推測で埋めると、選択肢に嘘の版番号が出る
  model_tables: {},
  agents: [],
  intervals: {
    sync_interval_secs: 20,
    screen_interval_ms: 20000,
    scrollback_lines: 1000,
  },
  lan_password: { supported: false, configured: false, editable: false },
}

/** ローカルモードのモデル表のキー（設計§13-4）。 */
export const LOCAL_TABLE_KEY = 'local'

/** 一度取り直しを試した model の ID。無限に聞きに行かないための歯止め */
const asked = new Set<string>()

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: FALLBACK,
  loading: true,
  lastError: null,

  noteModelSeen: (model) => {
    if (model === null || asked.has(model)) {
      return
    }
    const tables = Object.values(get().settings.model_tables)
    if (
      tables.some((table) =>
        (table.aliases ?? []).some((entry) => entry.id === model),
      )
    ) {
      return
    }
    asked.add(model)
    void get().load()
  },

  load: async () => {
    try {
      const response = await fetch('/api/settings')
      if (response.status === 401) {
        useAuthStore.getState().markSignedOut()
        set({ loading: false })
        return
      }
      if (!response.ok) {
        set({ loading: false })
        return
      }
      const settings = (await response.json()) as Settings
      // 古いサーバはこれらのキーを返さない。undefined のまま持つと画面が落ちる
      settings.model_tables ??= {}
      settings.agents ??= []
      settings.intervals ??= FALLBACK.intervals
      settings.lan_password ??= FALLBACK.lan_password
      set({ settings, loading: false })
    } catch {
      // 読めなくても画面は出す。既定値のまま（＝スキップしない側）で動く
      set({ loading: false })
    }
  },

  update: async (patch) => {
    const previous = get().settings
    // **押した瞬間に反映する。** サーバの応答を待つと、制御されたチェックボックスが
    // 一度元の値へ描き直され、利用者からは「押したのに戻った」ように見える。
    // 送っただけで確定していないもの（パスワード）は手元へ映さない
    if (patch.always_bypass_permissions !== undefined) {
      set({
        settings: {
          ...previous,
          always_bypass_permissions: patch.always_bypass_permissions,
        },
        lastError: null,
      })
    }

    const fail = (reason: string) => {
      // 黙って戻ると「変えたのに効かない」という追いにくい状態になる。
      // 見た目も本当の値（サーバ側）へ戻す
      set({
        settings: previous,
        lastError: `設定を保存できませんでした: ${reason}`,
      })
    }

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) {
        fail(await response.text())
        return false
      }
      set({ settings: (await response.json()) as Settings, lastError: null })
      return true
    } catch (error) {
      fail(String(error))
      return false
    }
  },
}))

/** そのセッションが属する PC の名前（分からなければ `null`）。 */
export function agentName(
  agents: AgentInfo[],
  agentId: string | null,
): string | null {
  if (agentId === null) {
    return null
  }
  return agents.find((agent) => agent.id === agentId)?.name ?? null
}

/** そのセッションに効くモデル表（設計§13-4）。ローカルは `"local"` を引く。 */
export function modelTableFor(
  tables: Record<string, ModelTable>,
  agentId: string | null,
): ModelTable {
  return tables[agentId ?? LOCAL_TABLE_KEY] ?? {}
}
