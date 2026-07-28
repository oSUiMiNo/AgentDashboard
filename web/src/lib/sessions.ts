/**
 * 一覧のためのセッションの並べ替えと、経過時間の時計。
 *
 * コンポーネントから切り離してあるのは、並べ方の規則だけを単体テストで確かめられるように
 * するため（画面を描かずに済む）。
 */

import { useEffect, useState } from 'react'
import type { SessionMeta } from '@/lib/protocol'

export interface ProjectGrouping {
  project: string
  sessions: SessionMeta[]
}

/**
 * 作業ディレクトリごとにまとめる（要件「同一プロジェクト内の並列セッション」）。
 *
 * 並び順は最初に現れた順で安定させる。一覧は常に見ているものなので、更新のたびに
 * 箱の位置が入れ替わると、目で追えなくなる。
 */
export function groupByProject(sessions: SessionMeta[]): ProjectGrouping[] {
  const groups: ProjectGrouping[] = []
  for (const session of sessions) {
    const found = groups.find((group) => group.project === session.project)
    if (found) {
      found.sessions.push(session)
    } else {
      groups.push({ project: session.project, sessions: [session] })
    }
  }
  return groups
}

/**
 * 1秒ごとに進む現在時刻。
 *
 * 小窓ごとにタイマーを持たせると、セッションが増えるほどタイマーが増えて更新が散らばる。
 * 一覧の親が1つだけ持ち、全部の小窓へ配る形にしている。
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}
