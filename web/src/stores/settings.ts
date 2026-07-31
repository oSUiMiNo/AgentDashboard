/**
 * サーバが持つ設定を読み書きするストア（設計§7・§8）。
 *
 * # なぜブラウザに保存しないのか
 *
 * `localStorage` に置くと**ブラウザごとに食い違う**。トグルの意味は「このダッシュボードが
 * どう振る舞うか」なので、置き場所はサーバ（`config.toml`）が正しい。おかげで別のタブで
 * 開いても同じ値になり、アプリを開き直しても残る。
 *
 * # 更新頻度が低いので zustand に置いてよい
 *
 * 一覧の状態や履歴と違って、設定は人が触ったときしか変わらない。React の再レンダリングを
 * 通しても問題にならないので、`useSyncExternalStore` の仕組みは要らない。
 */

import { create } from 'zustand'
import type { ModelAliasSeen, ModelCatalogEntry } from '@/lib/models'
import { PERMISSION_MODES, type PermissionMode } from '@/lib/protocol'

/** `GET /api/settings` の応答。 */
export interface Settings {
  /** 起動ボタンを「全承認をスキップ」の1つだけにするか */
  always_bypass_permissions: boolean
  /** その CLI が受け付けるモード（正規値）。起動時に `claude --help` から読んだもの */
  available_modes: PermissionMode[]
  /**
   * 別名がこの環境で何に解決されたかの実測（設計§12）。
   *
   * モデルの選択肢へ版番号を併記するために使う。一度も選んでいない別名は入っていない。
   */
  model_aliases: ModelAliasSeen[]
  /**
   * CLI 自身から取り出した、正式名と通称の対応表（設計§13）。
   *
   * **まだ一度も選んでいない別名にも版番号を出す**ための材料。取れなければ空で、
   * そのときは別名のラベルが出るだけ。
   */
  model_catalog: ModelCatalogEntry[]
  /**
   * いま効いている画面の更新間隔（ミリ秒。セルフホスト化設計§11-3）。
   *
   * **ローカルモードでは返ってこない**（画面配信そのものが動かず、生バイトを直に配るため）。
   * 別の PC のセッションを開いているときだけヘッダに小さく出して、画面が止まっているのか
   * 間引かれているのかを利用者が区別できるようにする。
   */
  screen_interval_ms?: number | null
}

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
  setAlwaysBypassPermissions: (value: boolean) => Promise<void>
}

/**
 * サーバから読めるまでの暫定値。
 *
 * **既定はスキップしない側**（設計§9）。読めていない間に「全承認をスキップ」の
 * ボタンだけを出してしまうと、利用者が意図せず選ぶ余地を作る。
 */
const FALLBACK: Settings = {
  always_bypass_permissions: false,
  available_modes: PERMISSION_MODES.map((mode) => mode.value),
  // 実測が無い状態が正しい初期値。推測で埋めると、選択肢に嘘の版番号が出る
  model_aliases: [],
  model_catalog: [],
  // ローカルモードと同じ扱いにしておく（読めるまで更新間隔の表示を出さない）
  screen_interval_ms: null,
}

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
    if (get().settings.model_aliases.some((entry) => entry.id === model)) {
      return
    }
    asked.add(model)
    void get().load()
  },

  load: async () => {
    try {
      const response = await fetch('/api/settings')
      if (!response.ok) {
        set({ loading: false })
        return
      }
      const settings = (await response.json()) as Settings
      // 古いサーバはこのキーを返さない。undefined のまま持つと画面が落ちる
      settings.model_aliases ??= []
      settings.model_catalog ??= []
      set({ settings, loading: false })
    } catch {
      // 読めなくても画面は出す。既定値のまま（＝スキップしない側）で動く
      set({ loading: false })
    }
  },

  setAlwaysBypassPermissions: async (value) => {
    const previous = get().settings
    // **押した瞬間に反映する。** サーバの応答を待つと、制御されたチェックボックスが
    // 一度元の値へ描き直され、利用者からは「押したのに戻った」ように見える
    set({
      settings: { ...previous, always_bypass_permissions: value },
      lastError: null,
    })

    const fail = (reason: string) => {
      // 黙って戻ると「変えたのに効かない」という追いにくい状態になる。
      // 見た目も本当の値（サーバ側）へ戻す
      set({ settings: previous, lastError: `設定を保存できませんでした: ${reason}` })
    }

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ always_bypass_permissions: value }),
      })
      if (!response.ok) {
        fail(await response.text())
        return
      }
      set({ settings: (await response.json()) as Settings, lastError: null })
    } catch (error) {
      fail(String(error))
    }
  },
}))
