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
import { PERMISSION_MODES, type PermissionMode, type RateLimits } from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'

/** 登録済みの PC（セルフホスト化設計§11-1）。 */
export interface AgentInfo {
  id: string
  name: string
  last_seen_at: number | null
  /** いま繋がっているか。DB には持たない値で、応答のたびに被せられる */
  connected: boolean
  /** その PC のセッションホストの版（CICD設計§16）。名乗っていなければ無い */
  version?: string | null
  /**
   * 抜け殻のカードを起こし直せるか（復旧設計§3-6）。
   *
   * 押せない理由の4通りのうち「この PC の版が古い」だけは、これが無いと言えない。
   * **省略可にしてあるのはサーバが古い場合のため**——無い＝名乗っていない＝できない、
   * と読む（`false` と同じ扱いで、判定側が `?? false` する）。
   */
  supports_revive?: boolean
  /**
   * その PC の使用上限（status設計「保管」）。まだ1本も届いていなければ無い。
   *
   * **サーバは DB に持たず、REST のたびに手元の保管からかぶせている**（`connected`
   * と同じ性質）。**この欄が初期スナップショットの唯一の経路**である——カードの
   * 記録ではないので `SessionUpsert` には乗らず、しかもサーバ側の関門が「同じ
   * 表示形なら配らない」ので、**次に値が動くまで便が飛ばない**（5時間窓・7日窓なので
   * 数時間空く）。
   *
   * **省略可にしてあるのはサーバが古い場合のため**（`supports_revive` と同じ理由）。
   * **無い＝まだ届いていない**で、`0%` とは別に描くこと。
   */
  rate_limits?: RateLimits | null
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

/**
 * 一覧のカードの動きを、どこまで静めるか（カード設計§9-5-2）。
 *
 * **3段なのは、一時停止ボタン1つだと「全部止める」しかないため**——止めると
 * 承認待ちまで止まり、いちばん見つけたいものの合図を失う。
 */
export type MotionQuiet = 'lively' | 'calm' | 'still'

/** 静けさの3段。**綴りと並びは Rust 側の `MOTION_QUIET_CHOICES` と揃える。** */
export const MOTION_QUIET_CHOICES: MotionQuiet[] = ['lively', 'calm', 'still']

/** `GET /api/settings` の応答。 */
export interface Settings {
  /**
   * 起動時の権限モードの**既定の選択**を「全承認をスキップ」にするか（選択肢は減らない）。
   *
   * **どの構成でも画面から変えられる**（持ち出し設計§6）。保存先はアカウントごとの
   * 記録なので、別の端末で開いても同じ値になる。
   */
  always_bypass_permissions: boolean
  /**
   * PJT の枠を足したら、続けてセッションを1本起こすか（イシューグループ_2026_0805_0514
   * 設計§12）。
   *
   * 枠を置くことと、そこで作業を始めることは別の意思なので**既定は OFF**。
   * ON にすると、追加したその場で1本立ち上がる。
   */
  project_autostart_session: boolean
  /**
   * 一覧のカードをどこまで静めるか（カード設計§9-5-2）。
   *
   * `lively`（既定・何も止めない）／`calm`（作業中の回転だけ止める）／
   * `still`（すべて止める）。**綴りはカードが出す `data-quiet` と揃えてある**——
   * 賑やかは属性を出さないので、`lively` は DOM に現れない。
   *
   * **OS の「動きを減らす」設定とは別物**で、あちらが立っている間は段の選択に
   * よらず止まる。ここが運ぶのは「利用者が画面から選んだ段」だけ。
   */
  motion_quiet: MotionQuiet
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
  /**
   * メモと画像をどれだけ残すか（メモ設計§11-2・§11-3）。
   *
   * **メモの面が「N か月で消えます」を出すために読む。** 設計§11-3 は
   * **設定で変えた値を反映する**ことを定めている——固定文言にすると、
   * 設定を変えた人に嘘を言うことになる。
   */
  memo_limits: MemoLimits
  /**
   * 書き込みを許可する場所（ファイルビュアにエディタ機能を追加 設計§3-5）。
   *
   * **既定は空。** ただし空でも「開いている PJT の配下」はサーバ側が常に足すので、
   * **空＝どこへも書けない、ではない。**
   *
   * **画面はこれを「保存ボタンを出すか」にしか使わない。弾く責任は持たない**
   * （設計§3-1）。正はサーバ側にあり、画面だけで弾いても REST と CLI を素通りする。
   */
  writable_roots: string[]
  /**
   * 拡張子ごとに、ファイルを開いたときどちらで始めるか（ファイルビュアにエディタ
   * 機能を追加 要件③）。**拡張子（小文字・`.` 無し）→ 見る／編集する。**
   *
   * **既定は空。** 載っていない拡張子は種別から導く——`md` ／ `html` ／ `svg` は
   * 見る、それ以外は編集する。**要件の「設定無しの拡張子はエディタ」がこれに当たる。**
   *
   * ここを埋めるのは、**利用者が既定と違う見せ方を選んだ拡張子だけ**である。
   */
  file_modes: Record<string, 'viewer' | 'editor'>
  /**
   * **この機械**の使用上限（status設計）。まだ1本も届いていなければ無い。
   *
   * # `agents[].rate_limits` とは出し分けで、同時には出ない
   *
   * ローカルモードには **`agents` の行が1つも無い**ので、行に乗せる形だけだと
   * 実機で1つも読めない。**ローカルはこの欄、セルフホストは `agents` の各行**——
   * `agents.length === 0` で分ける（`hasRemote` と同じ判定を使い回す）。
   *
   * **`agents` に1行足す道は採れない。** 「`agents` が空ならローカル」という判定が
   * 画面に2箇所あり（`ProjectAdd` の `isLocal`、`SettingsPage` の `hasRemote`）、
   * 1行入れると**別の PC 向けの設定が実機に現れる**。
   *
   * **省略可にしてあるのはサーバが古い場合のため**（`supports_revive` と同じ理由）。
   * **無い＝まだ届いていない**で、`0%` とは別に描くこと。
   */
  machine_rate_limits?: RateLimits | null
}

/** メモと画像の保持（メモ設計§11-1）。 */
export interface MemoLimits {
  /** 何日残すか。既定は90日 */
  retention_days: number
  /** 画像を含めた合計の上限。既定は 1 GiB */
  max_bytes: number
}

/** 触った項目だけを送る（他のタブの変更を巻き戻さないため）。 */
export type SettingsPatch = Partial<{
  always_bypass_permissions: boolean
  project_autostart_session: boolean
  lan_password: string
  sync_interval_secs: number
  screen_interval_ms: number
  scrollback_lines: number
  motion_quiet: MotionQuiet
  /**
   * メモと画像を何日残すか（要件10）。**上限は365日**（サーバの `check()` が見る）。
   *
   * **「無期限」は作らない**——要件が「これはあくまで作業のための一時的なメモ機能
   * なので無期限と無制限は必要無い」と明記している。
   */
  memo_retention_days: number
  /** メモの画像の合計の上限（要件10）。**上限は 20GB。「無制限」は作らない。** */
  memo_max_bytes: number
  /**
   * 書き込みを許可する場所（設計§3-5）。**一覧ごと差し替える。**
   *
   * **1件ずつ足し引きする形にしない。** 2つのタブを同時に開いていると、
   * **消したはずの場所が相手の送信で戻る**——書ける範囲がそうやって広がるのは、
   * いちばん気づきにくい広がり方である。
   *
   * **絶対パスだけを入れる**（サーバの `check()` が断る）。相対パスは「どこからの
   * 相対か」が決まらない。
   */
  writable_roots: string[]
  /**
   * 拡張子ごとの見せ方（要件③）。**対応ごと差し替える**（上と同じ理由）。
   *
   * **中身はサーバの `check()` が断る**——見せ方は2つの綴りだけ、拡張子は小文字で
   * `.` を含まない。知らない綴りを入れると、画面は既定へ落として描くので
   * **「設定したのに効かない」だけに見える。**
   */
  file_modes: Record<string, 'viewer' | 'editor'>
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
  /**
   * 便で届いた使用上限を、手元へ当てる（status設計「便」）。
   *
   * # 取り直さずに一部だけ当てる
   *
   * `noteModelSeen` は `load()` を呼び直すが、こちらは**便が値そのものを運んでいる**
   * ので取り直さない。3秒周期で届きうる値を REST の往復にすると、**設定画面を
   * 開いているあいだ `/api/settings` を叩き続ける**ことになる。
   *
   * # 宛先で置き場所が分かれる
   *
   * `agentId === null` は**この機械**（ローカルモード）なので `machine_rate_limits`、
   * `agentId` が在れば**その PC の行**。**REST の初期スナップショットと同じ2箇所**で、
   * どちらに当てるかはサーバが決めた帰属をそのまま使う（画面が推測しない）。
   *
   * 知らない `agentId`（一覧に無い PC）は**捨てる**——行が無いので描きようがなく、
   * 次の `load()` で行ごと届く。
   */
  applyRateLimits: (agentId: string | null, limits: RateLimits) => void
}

/**
 * サーバから読めるまでの暫定値。
 *
 * **既定はスキップしない側**（設計§9）。読めていない間に「全承認をスキップ」を
 * 選ばれた状態で出してしまうと、利用者が意図せずそのまま起こす余地を作る。
 */
const FALLBACK: Settings = {
  always_bypass_permissions: false,
  // 読めていない間に「追加したら起こす」で出すと、意図しない claude が1本立ち上がる
  project_autostart_session: false,
  // **既定は賑やか。** 読めるまでの間だけ静かに出すと、読めた瞬間に画が変わる
  motion_quiet: 'lively',
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
  // **サーバの既定と同じ値を書く**（90日・1 GiB）。引く前に面が開いても嘘を言わない
  memo_limits: { retention_days: 90, max_bytes: 1024 * 1024 * 1024 },
  // **読めるまでは空にする。** 推測で埋めると、まだ許可されていない場所に
  // 保存ボタンが出て、押してからサーバに断られることになる
  writable_roots: [],
  // **読めるまでは空。** 空でも困らない——載っていない拡張子は種別から導くので、
  // **既定の見せ方はそのまま出る**（`writable_roots` と違って、倒し方で危なくならない）
  file_modes: {},
}

/** ローカルモードのモデル表のキー（設計§13-4）。 */
export const LOCAL_TABLE_KEY = 'local'

/** 一度取り直しを試した model の ID。無限に聞きに行かないための歯止め */
const asked = new Set<string>()

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: FALLBACK,
  loading: true,
  lastError: null,

  applyRateLimits: (agentId, limits) => {
    set((state) => {
      if (agentId === null) {
        return { settings: { ...state.settings, machine_rate_limits: limits } }
      }
      const agents = state.settings.agents.map((agent) =>
        agent.id === agentId ? { ...agent, rate_limits: limits } : agent,
      )
      return { settings: { ...state.settings, agents } }
    })
  },

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
      // **メモの保持も5つ目として埋める**（レビュー対応5）。`version select` は実在
      // する道なので、**旧版へ巻き戻すとメモの面が丸ごと落ちる**
      settings.memo_limits ??= FALLBACK.memo_limits
      // **旧版のサーバはこのキーを知らない。** undefined のまま持つと、
      // 保存ボタンの判定が例外で落ちる
      settings.writable_roots ??= FALLBACK.writable_roots
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
    if (
      patch.always_bypass_permissions !== undefined ||
      patch.project_autostart_session !== undefined ||
      patch.motion_quiet !== undefined
    ) {
      set({
        settings: {
          ...previous,
          always_bypass_permissions:
            patch.always_bypass_permissions ?? previous.always_bypass_permissions,
          project_autostart_session:
            patch.project_autostart_session ?? previous.project_autostart_session,
          // 静けさは**選んだ瞬間に一覧のカードの動きが変わる**ので、往復を待たせると
          // 「選んだのに効かない」ように見える
          motion_quiet: patch.motion_quiet ?? previous.motion_quiet,
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

/**
 * そのセッションが属する PC（分からなければ `null`）。
 *
 * `null` は2つの意味を兼ねる——**ローカルモード**（`agentId` がそもそも無い）と、
 * **知らない PC**（一覧に居ない）。区別が要るのは呼ぶ側なので、ここでは分けない。
 */
export function agentOf(
  agents: AgentInfo[],
  agentId: string | null,
): AgentInfo | null {
  if (agentId === null) {
    return null
  }
  return agents.find((agent) => agent.id === agentId) ?? null
}

/** そのセッションが属する PC の名前（分からなければ `null`）。 */
export function agentName(
  agents: AgentInfo[],
  agentId: string | null,
): string | null {
  return agentOf(agents, agentId)?.name ?? null
}

/** そのセッションに効くモデル表（設計§13-4）。ローカルは `"local"` を引く。 */
export function modelTableFor(
  tables: Record<string, ModelTable>,
  agentId: string | null,
): ModelTable {
  return tables[agentId ?? LOCAL_TABLE_KEY] ?? {}
}
