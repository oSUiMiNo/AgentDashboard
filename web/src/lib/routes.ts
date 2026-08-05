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

/**
 * ローカルモードの `{host}`（イシューグループ_2026_0805_0514 設計§10）。
 *
 * REST のパス（`/api/hosts/{host}/dir`）と URL の両方で同じ綴りを使う。
 * **サーバの記録の中の番兵（nil UUID）とは別物。**
 */
export const LOCAL_HOST = 'local'

/**
 * プロジェクト内の全セッションを横並びにする画面。
 *
 * **鍵に PC が入る**（イシューグループ_2026_0805_0514 設計§16）。パスだけでは
 * 別の PC の同名 PJT を指し分けられない——どの PC にも `/home/me/dev/app` は在りうる。
 */
export function projectPath(host: string, project: string): string {
  return `/p/${encodeURIComponent(host)}/${encodeURIComponent(project)}`
}

/** 設定画面。一覧と同じ階層に置く（一覧の主役を埋もれさせないため） */
export const SETTINGS = '/settings'

/**
 * アカウント画面（セルフホスト化設計§11-1）。
 *
 * **ローカルモードには出さない。** 繋いでくる PC が存在しないので、鍵を配る相手も
 * ログアウトする相手も居ない。
 */
export const ACCOUNT = '/account'
