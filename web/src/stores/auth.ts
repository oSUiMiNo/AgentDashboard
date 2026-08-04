/**
 * 入口の鍵の状態（セルフホスト化設計§8-1・§11-1）。
 *
 * # 画面はまず「何を出すべきか」を聞く
 *
 * 出す画面は3通りに分かれる——そのまま一覧・ログイン・最初のセットアップ。どれかは
 * サーバの構成で決まるので、ブラウザ側では判断できない。`GET /api/me` は**鍵の
 * 向こうに置かない**（認証の要否を知るのに認証が要る、という循環を作らないため）。
 *
 * # 401 は「まだ入っていない」であって障害ではない
 *
 * 一覧や設定が 401 で返ってきたら、エラーバナーを出すのではなくログイン画面へ送る。
 * 赤いバナーで「読めません」と言われても、利用者にできることが無い。
 */

import { create } from 'zustand'

/** 入口の鍵のかけ方（設計§8-1）。 */
export type AuthMode = 'open' | 'lan_password' | 'account'

/** `GET /api/me` の応答。 */
export interface AuthView {
  mode: AuthMode
  authenticated: boolean
  /** 通っている相手の名前。ローカルモードでは出さない */
  account: string | null
  is_admin: boolean
  /** `/setup` がまだ開いているか */
  setup_open: boolean
  /** 接続元が 127.0.0.1 か */
  from_loopback: boolean
  /** いま応答しているサーバの版（CICD設計§11）。古いサーバは返さない */
  version?: string
}

interface AuthState {
  auth: AuthView
  /** まだ聞けていない間は true。この間は画面を出さない（ちらつきを避ける） */
  loading: boolean
  lastError: string | null
  /**
   * **画面より新しいサーバが応答している**（CICD設計§11）。
   *
   * 版を切り替えるとサーバごと入れ替わるが、開きっぱなしのタブは古い画面のまま
   * 喋り続ける。壊れ方が「一部が黙って更新されなくなる」なので、気づけるように
   * 印を立てる。**勝手に読み込み直さない**——書きかけの指示が消える。
   */
  serverChanged: boolean
  load: () => Promise<void>
  /** ログインする。`name` が null なら LAN の共有パスワード */
  login: (name: string | null, password: string) => Promise<boolean>
  /** 最初の管理者を作る（セルフホストのみ） */
  setup: (name: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
  /** 401 を受け取った。ログイン画面へ送る */
  markSignedOut: () => void
}

/**
 * 聞けるまでの暫定値。
 *
 * **「通っていない」から始める。** 通っている側から始めると、聞けていない一瞬だけ
 * 一覧が描かれ、直後にログイン画面へ差し替わる（利用者から見ると点滅する）。
 */
const UNKNOWN: AuthView = {
  mode: 'open',
  authenticated: false,
  account: null,
  is_admin: false,
  setup_open: false,
  from_loopback: false,
}

export const useAuthStore = create<AuthState>((set, get) => ({
  auth: UNKNOWN,
  loading: true,
  lastError: null,
  serverChanged: false,

  load: async () => {
    try {
      const response = await fetch('/api/me')
      if (!response.ok) {
        set({ loading: false })
        return
      }
      const auth = (await response.json()) as AuthView
      // **一度でも版を知っていて、それが変わったら**印を立てる。初回は比べる相手が
      // 無いので立たない。版を返さない古いサーバでも立たない（比べようが無い）
      const known = get().auth.version
      const changed =
        known !== undefined &&
        auth.version !== undefined &&
        known !== auth.version
      set({
        auth,
        loading: false,
        serverChanged: get().serverChanged || changed,
      })
    } catch {
      // 繋がらないこと自体は WebSocket 側が画面に出す
      set({ loading: false })
    }
  },

  login: async (name, password) => {
    const body = name === null ? { password } : { name, password }
    return post('/api/login', body, set)
  },

  setup: async (name, password) => post('/api/setup', { name, password }, set),

  logout: async () => {
    try {
      await fetch('/api/logout', { method: 'POST' })
    } catch {
      // 失敗しても手元は降ろす。**入館証はサーバが持っている**ので、
      // 次の要求が 401 になれば結局ログイン画面へ戻る
    }
    set({ auth: { ...get().auth, authenticated: false, account: null } })
    await get().load()
  },

  markSignedOut: () =>
    set((state) => ({
      auth: { ...state.auth, authenticated: false },
    })),
}))

type SetState = (partial: Partial<AuthState>) => void

async function post(
  path: string,
  body: unknown,
  set: SetState,
): Promise<boolean> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      // **理由はサーバの言葉をそのまま出す。** こちらで言い換えると、
      // 「名前かパスワードが違います」を分けて書き直してしまいかねない
      set({ lastError: await response.text() })
      return false
    }
    set({ auth: (await response.json()) as AuthView, lastError: null })
    return true
  } catch (error) {
    set({ lastError: String(error) })
    return false
  }
}

/**
 * 一覧や設定を出してよい状態か。
 *
 * 鍵の無い構成（ローカルの 127.0.0.1）では、聞く前から通っている扱いになる。
 */
export function canEnter(auth: AuthView, loading: boolean): boolean {
  return !loading && auth.authenticated
}
