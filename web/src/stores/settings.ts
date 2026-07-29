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
import { PERMISSION_MODES, type PermissionMode } from '@/lib/protocol'

/** `GET /api/settings` の応答。 */
export interface Settings {
  /** 起動ボタンを「全承認をスキップ」の1つだけにするか */
  always_bypass_permissions: boolean
  /** その CLI が受け付けるモード（正規値）。起動時に `claude --help` から読んだもの */
  available_modes: PermissionMode[]
}

interface SettingsState {
  settings: Settings
  /** まだサーバから読めていない間は true。トグルを触らせないために使う */
  loading: boolean
  lastError: string | null
  load: () => Promise<void>
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
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: FALLBACK,
  loading: true,
  lastError: null,

  load: async () => {
    try {
      const response = await fetch('/api/settings')
      if (!response.ok) {
        set({ loading: false })
        return
      }
      set({ settings: (await response.json()) as Settings, loading: false })
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
