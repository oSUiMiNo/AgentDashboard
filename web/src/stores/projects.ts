/**
 * 追加した PJT 枠のストア（イシューグループ_2026_0805_0514 設計§11・§13）。
 *
 * # なぜカードと分けるのか
 *
 * 枠は**めったに変わらない**（足す・消すの2回だけ）のに対し、カードの状態は毎秒何度も
 * 動く。同じストアに置くと、状態の更新のたびに一覧の箱まで作り直しの判定に入る。
 * [`@/stores/sessions`] が構造とカードを分けているのと同じ理由で、ここも分ける。
 *
 * # 真実はサーバにある
 *
 * 画面は `GET /api/projects` で全体を取り、以後は WebSocket の増減だけを見る。
 * 押した瞬間に手元へ足す（楽観更新）ことはしない——**書けてから配られる**（設計§11）
 * ので、待てば必ず届く。先に足すと、断られたときに消す処理が要る。
 */

import { useSyncExternalStore } from 'react'
import type { ProjectView } from '@/lib/protocol'

/** 利用者が並べた順（`position`）のまま持つ（並べ替え設計§2-3）。 */
let projects: ProjectView[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) {
    listener()
  }
}

/** `GET /api/projects` の結果を取り込む（接続時・再接続時の作り直し）。 */
export function applyProjectSnapshot(list: ProjectView[]) {
  // 並びの正は `position`。同着は `id` で崩す——崩さないとサーバと並びが食い違う
  projects = [...list].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  notify()
}

/**
 * `project_upsert` を取り込む。
 *
 * 同じ ID が既にあれば置き換える。**並びは動かさない**——足したときに末尾へ、
 * 直したときはその場で、という形にしておかないと、一覧の箱が押した拍子に動く。
 */
export function upsertProject(project: ProjectView) {
  const at = projects.findIndex((entry) => entry.id === project.id)
  if (at < 0) {
    projects = [...projects, project]
  } else {
    projects = projects.map((entry) => (entry.id === project.id ? project : entry))
  }
  notify()
}

/** `project_removed` を取り込む。 */
export function removeProject(projectId: string) {
  const next = projects.filter((entry) => entry.id !== projectId)
  if (next.length === projects.length) {
    return
  }
  projects = next
  notify()
}

/** テストの後始末用。ストアがモジュール単位で生き残るので、明示的に畳む。 */
export function clearProjects() {
  projects = []
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 枠が増減したことを知りたい相手のための口。
 *
 * 一覧の箱は**枠とカードの両方**から組み立てるので（設計§13）、片方が変わったときに
 * もう片方の側で組み直す必要がある。取り込みは `sessions` → `projects` の一方通行に
 * してあるので、輪にはならない。
 */
export const subscribeProjects = subscribe

/** いまの枠（作成順）。 */
export function useProjects(): ProjectView[] {
  return useSyncExternalStore(
    subscribe,
    () => projects,
    () => projects,
  )
}

/** 購読しない読み取り。 */
export function getProjects(): ProjectView[] {
  return projects
}

/**
 * その（PC, パス）に枠があるか。
 *
 * **追加の画面が「追加済み」を出すのに使う。** 二重に足しても記録は1行のままだが
 * （ユニーク索引）、押した手応えが無いのは不親切なので先に示す（設計§13）。
 */
export function hasProject(host: string, path: string): boolean {
  return projects.some((entry) => entry.host === host && entry.path === path)
}

/** サーバから枠の一覧を取り直す。 */
export async function loadProjects(): Promise<void> {
  try {
    const response = await fetch('/api/projects')
    if (!response.ok) {
      return
    }
    applyProjectSnapshot((await response.json()) as ProjectView[])
  } catch {
    // 読めなくても画面は出す。枠が無い状態＝カードから逆算した箱だけが並ぶ
  }
}

/**
 * 並べ替えた結果をサーバへ送る（並べ替え設計§9-1）。
 *
 * **丸ごと送る。** 差分ではなく確定した並び全部を送るので、送り手と受け手で番号の
 * 解釈が食い違ってもずれが溜まらない。
 *
 * **手元は先に書き換えない。** 書けてから配られる `project_upsert` で戻ってくる
 * （設計§11）ので、ここで先回りすると**断られたときに画面だけが動いたまま残る**。
 * 運んでいる最中の見た目は掴んでいる側が持っており、離した時点で手元の並びへ戻る
 * ——サーバが受けていれば、そのすぐ後に新しい並びが届いて上書きされる。
 *
 * 戻り値は断られた理由。通れば `null`。
 */
export async function saveProjectOrder(ids: readonly string[]): Promise<string | null> {
  try {
    const response = await fetch('/api/projects/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    if (!response.ok) {
      return (await response.text()).trim() || '並べ替えを保存できませんでした'
    }
    return null
  } catch {
    return '並べ替えを保存できませんでした'
  }
}
