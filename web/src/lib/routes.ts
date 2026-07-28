/**
 * 画面のURL（設計§10）。
 *
 * プロジェクトIDは作業ディレクトリの絶対パスそのものなので、`/` を含む。URLの一部として
 * 載せるには必ず符号化する。組み立てと読み取りを1箇所にまとめておかないと、
 * 片方だけ直したときに「リンクは作れるのに開けない」という状態になる。
 */

import type { CardId } from '@/lib/protocol'

export const HOME = '/'

/** 単独のセッション専用画面。 */
export function sessionPath(cardId: CardId): string {
  return `/s/${cardId}`
}

/** プロジェクト内の全セッションを横並びにする画面（中身はフェーズ4）。 */
export function projectPath(project: string): string {
  return `/p/${encodeURIComponent(project)}`
}
