/**
 * ダッシュボード自身の版（CICD設計§14・§15）。
 *
 * # なぜ設定のストアと分けるのか
 *
 * 設定は**画面を開いた瞬間に必ず読む**もので、版の一覧は保管庫の走査と3本への
 * 問い合わせを伴う。性質の違うものを1本に混ぜると、片方の遅れがもう片方を引きずる。
 * サーバ側で口を分けてあるのと同じ理由で、こちらも分けてある。
 *
 * # 「選ぶ」と「効かせる」は別の操作
 *
 * 版を選んでもプロセスは落ちない。効くのは次に起こしたときで、落とすのは
 * [`VersionsState.restart`] を押したときだけ——要件が名指しで恐れている
 * 「選んだ瞬間に全部入れ替わる」を、口の分け方で外している。
 *
 * # 確かめられなかったときは同意を求める
 *
 * この機能より前の版は記録の形を答えられないので、門は「確かめられません」を返す。
 * **断るといちばん戻りたい先へ永久に戻れなくなる**ので、理由を見せて同意を取る。
 */

import { create } from 'zustand'
import { useAuthStore } from '@/stores/auth'

/** その版がどこにあるか。 */
export type VersionOrigin = 'installed' | 'stored'

/** 一覧の1行。 */
export interface VersionEntry {
  version: string
  origin: VersionOrigin
  /** 実行ファイルの絶対パス。**同じ版名の行が複数並ぶ**ので見分けに要る */
  path: string
  /** 選べるか（3本揃い＋3本とも同じ版を名乗る） */
  usable: boolean
  running: boolean
  selected: boolean
  size_bytes: number
  /** 選べない理由。選べるときは null */
  reason: string | null
}

/** 取ってくる仕事の段階（設計§15）。 */
export type InstallPhase = 'installing' | 'done' | 'failed'

export interface InstallProgress {
  version: string
  phase: InstallPhase
  reason: string | null
}

/** 前回の乗り換えの結末（設計§11）。 */
export interface VersionOutcome {
  attempted: string | null
  attempted_path: string
  running: string
  failed_reason: string | null
  at: number
}

/** 最後に読めた最新版（設計§8）。 */
export interface LatestVersion {
  version: string
  prerelease: boolean
  has_artifact: boolean
  checked_at: number
}

/** `GET /api/versions` の応答。 */
export interface VersionsView {
  /** 保管庫を持てる構成か。**箱の中なら偽** */
  supported: boolean
  /** いま操作してよいか */
  editable: boolean
  entries: VersionEntry[]
  selected: string | null
  outcome: VersionOutcome | null
  latest: LatestVersion | null
  /** いま入れ替えると抜け殻になるカードの枚数（設計§10） */
  stranded_cards: number
  install: InstallProgress | null
  /** 取ってくる道具が無いときの理由。**`supported` とは別物** */
  install_unavailable: string | null
}

/** 同意を求めている相手。 */
export interface Unverified {
  version: string
  reason: string
}

interface VersionsState {
  versions: VersionsView
  /** まだサーバから読めていない間は true */
  loading: boolean
  /** 押した操作が走っている間は true。**二重に押させない** */
  busy: boolean
  lastError: string | null
  /** 確かめられなかったので同意を待っている（設計§9） */
  unverified: Unverified | null
  load: () => Promise<void>
  select: (version: string, confirmUnverified?: boolean) => Promise<boolean>
  unselect: () => Promise<boolean>
  install: (version: string) => Promise<boolean>
  remove: (version: string) => Promise<boolean>
  restart: () => Promise<boolean>
  dismissUnverified: () => void
}

/**
 * 読めるまでの暫定値。**何もできない側に倒す。**
 *
 * 読めていない間に押せる顔をすると、実際には断られる操作をボタンとして見せることになる。
 */
const FALLBACK: VersionsView = {
  supported: false,
  editable: false,
  entries: [],
  selected: null,
  outcome: null,
  latest: null,
  stranded_cards: 0,
  install: null,
  install_unavailable: null,
}

/** 取ってくる仕事の様子を見に行く間隔。 */
const INSTALL_POLL_MS = 1_000

export const useVersionsStore = create<VersionsState>((set, get) => ({
  versions: FALLBACK,
  loading: true,
  busy: false,
  lastError: null,
  unverified: null,

  load: async () => {
    try {
      const response = await fetch('/api/versions')
      if (response.status === 401) {
        useAuthStore.getState().markSignedOut()
        set({ loading: false })
        return
      }
      if (!response.ok) {
        set({ loading: false })
        return
      }
      set({ versions: (await response.json()) as VersionsView, loading: false })
    } catch {
      // 読めなくても画面は出す。**既定値は何もできない側**なので、押せる顔にはならない
      set({ loading: false })
    }
  },

  select: async (version, confirmUnverified = false) => {
    const body = JSON.stringify({
      version,
      confirm_unverified: confirmUnverified,
    })
    return operate(set, get, async () => {
      const response = await fetch('/api/versions/selected', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      // **428 は「断った」ではない。** 同意すれば進める道が残っている
      if (response.status === 428) {
        set({ unverified: { version, reason: await response.text() } })
        return null
      }
      return response
    })
  },

  unselect: async () =>
    operate(set, get, () =>
      fetch('/api/versions/selected', { method: 'DELETE' }),
    ),

  install: async (version) => {
    const ok = await operate(set, get, () =>
      fetch(`/api/versions/${encodeURIComponent(version)}/install`, {
        method: 'POST',
      }),
    )
    if (ok) {
      // 背景で走るので、終わるまで様子を見に行く（設計§15）
      void watchInstall(get)
    }
    return ok
  },

  remove: async (version) =>
    operate(set, get, () =>
      fetch(`/api/versions/${encodeURIComponent(version)}`, {
        method: 'DELETE',
      }),
    ),

  restart: async () =>
    operate(set, get, () =>
      fetch('/api/versions/restart', { method: 'POST' }),
    ),

  dismissUnverified: () => set({ unverified: null }),
}))

type SetState = (partial: Partial<VersionsState>) => void
type GetState = () => VersionsState

/**
 * 押した操作を1本の道へ通す。
 *
 * 版の操作はどれも**応答が新しい一覧そのもの**なので、成功したら差し替える。
 * 失敗の理由はサーバの言葉をそのまま出す——こちらで言い換えると、「揃っていない」と
 * 「記録の形が合わない」を同じ文言に潰してしまいかねない。
 *
 * `request` が `null` を返したら、**それは失敗ではなく別の答え**（同意待ちなど）。
 */
async function operate(
  set: SetState,
  get: GetState,
  request: () => Promise<Response | null>,
): Promise<boolean> {
  if (get().busy) {
    return false
  }
  set({ busy: true, lastError: null, unverified: null })
  try {
    const response = await request()
    if (response === null) {
      return false
    }
    if (response.status === 401) {
      useAuthStore.getState().markSignedOut()
      return false
    }
    if (!response.ok) {
      set({ lastError: await response.text() })
      return false
    }
    set({ versions: (await response.json()) as VersionsView })
    return true
  } catch (error) {
    set({ lastError: String(error) })
    return false
  } finally {
    set({ busy: false })
  }
}

/** 取ってくる仕事が終わるまで様子を見に行く。 */
async function watchInstall(get: GetState) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, INSTALL_POLL_MS))
    await get().load()
    const phase = get().versions.install?.phase
    if (phase !== 'installing') {
      return
    }
  }
}

/** 取ってくる仕事の段階を日本語にする。 */
export function installLabel(phase: InstallPhase): string {
  switch (phase) {
    case 'installing':
      return '取ってきています'
    case 'done':
      return '取ってきました'
    case 'failed':
      return '取ってこられませんでした'
  }
}

/**
 * 版の大小を比べる（3つ組だけ）。
 *
 * **読めない版は比べない。** サーバ側と同じ扱いで、比べられないことと選べないことは
 * 別（設計§2）。
 */
export function isNewer(candidate: string, current: string): boolean {
  const left = triple(candidate)
  const right = triple(current)
  if (!left || !right) {
    return false
  }
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] > right[i]
    }
  }
  return false
}

function triple(version: string): [number, number, number] | null {
  const parts = version.split('.')
  if (parts.length < 3) {
    return null
  }
  const numbers = parts.slice(0, 3).map((part) => Number.parseInt(part, 10))
  if (numbers.some((value) => !Number.isInteger(value) || value < 0)) {
    return null
  }
  return [numbers[0], numbers[1], numbers[2]]
}
