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
 * URL から `card_id` を読む。[`sessionPath`] の逆。
 *
 * **React の外から呼ぶための口**（設計§12-2）。`window.onerror` や WebSocket の
 * ハンドラは `useParams()` を使えないので、いま開いている画面を知る手段がここしか無い。
 * 冒頭が言う「組み立てと読み取りを1箇所にまとめる」の、読み取り側にあたる。
 */
export function cardIdFromPath(pathname: string): CardId | undefined {
  const match = /^\/s\/([^/?#]+)/.exec(pathname)
  if (!match) {
    return undefined
  }
  return decodeURIComponent(match[1]) as CardId
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

/**
 * ✕（閉じる）を押したときの行き先（設計§7）。
 *
 * 意味は1つに決めてある——**「前の画面へ戻る。戻る先が無ければ一覧へ。」**
 *
 * # 履歴の件数で判定してはいけない
 *
 * 別のサイトを見ていたぶんまで `history.length` に入るので、このアプリへ来る前の
 * 履歴があると「戻れる」と誤って答える。素直に1つ戻ると**アプリの外へ出る**——
 * 閉じるつもりでアプリから出る、という一番困る形になる。
 *
 * 実測（フェーズ1・2026-08-31）。**いきなり `/s/:id` を開いた状態でも件数は 2 を返す。**
 *
 * | 状況 | `location.key` | `history.length` |
 * |---|---|---|
 * | 最初のエントリ（戻る先が無い） | `default` | 1 |
 * | アプリの中で移ってきたあと | ランダム | 2 |
 * | **いきなり開いた**（リロード相当） | **`default`** | **2** |
 *
 * # 見るのは「このルータにとって最初のエントリか」
 *
 * react-router は最初のエントリにだけ `default` という鍵を付ける。`window.history.state`
 * の `idx` でも見分けられるが、**あちらは内部の形に依存する**ので使わない。
 *
 * **隣のイシュー `設定とアカウントの画面から前の画面へ戻れない` が、この判定をそのまま
 * 写せるように関数へ切り出してある**（あちらは4箇所を ✕ へ揃える。設計§7）。
 */
export type BackTarget = 'back' | 'home'

/** `useLocation().key` を渡す。 */
export function backTargetFor(locationKey: string): BackTarget {
  return locationKey === 'default' ? 'home' : 'back'
}
