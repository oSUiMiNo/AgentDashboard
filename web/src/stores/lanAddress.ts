/**
 * LAN の別端末から開けるアドレスの候補を、**押される前に持っておく**（設計§1・§2）。
 *
 * # なぜ「押されてから聞く」ではいけないのか
 *
 * 通信は必ず `await` を跨ぐ。ところが平文 HTTP で開いている端末には
 * `navigator.clipboard` が**そもそも居ない**ので、使えるのは `document.execCommand`
 * だけ——あれは「利用者が押した合図がまだ生きていること」を要求する
 * （`lib/clipboard.ts` の注釈）。**押してから聞きに行くと、答えが返る頃には合図が
 * 切れていて、LAN の端末では入らない。**
 *
 * これは用心ではない。**先に取らないと入らない**という話である。
 *
 * # ここが「アドレスを組み立てる側」である
 *
 * 見せる側（`components/LanAddress/`）は**先頭を写すだけ**にする。URL の形を決めるのも、
 * `self` を先頭へ置くのもここ——置き場所を動かしたい日に、`App.tsx` の1行とあの部品
 * だけで済ませるためである（設計§1・要件の完了条件8）。
 *
 * **サーバにはパスも scheme も持たせていない**（設計§3）。あちらが返すのは番号と
 * ラベルだけなので、「いま見ている画面の URL も選べるようにする」を後から足すときに
 * 触るのはこのファイルで閉じる。
 */

import { create } from 'zustand'
import { useAuthStore } from '@/stores/auth'

/** どこから来た番号か（設計§5・§4-6）。 */
export type LanSource = 'windows' | 'linux' | 'self'

/** サーバが返す候補1件。**Rust 側の `server_core::lan_address::Candidate` と同じ綴り。** */
export interface ServerCandidate {
  addr: string
  label: string
  /** **サーバからは `self` が来ない。** あれは画面が足す側の材料である（設計§4-6） */
  source: 'windows' | 'linux'
}

/** `GET /api/lan-address` の応答。**`server_core::lan_address::LanAddressView` と同じ綴り。** */
export interface LanAddressView {
  port: number
  bind_addr: string
  reachable: boolean
  candidates: ServerCandidate[]
  /** 候補が空のときの理由。人が読む文 */
  note: string | null
}

/** 画面が実際に配る1件。**URL まで組み立て終えている。** */
export interface LanCandidate {
  addr: string
  label: string
  source: LanSource
  /** そのまま貼れる形（設計§3）。`http://` から始まり、末尾に `/` が付く */
  url: string
}

/** いま開いているアドレスの名乗り（設計§4-6）。 */
export const SELF_LABEL = 'いま開いているアドレス'

/**
 * ループバックか。**host 名だけで見て、ポートは見ない**（設計§4-6）。
 *
 * PC で開いている画面の origin を配っても、**相手の手元を指すだけ**で意味が無い。
 */
export function isLoopbackHost(hostname: string): boolean {
  const 素 = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return 素 === 'localhost' || 素 === '::1' || /^127\./.test(素)
}

/**
 * 候補を並べる（設計§4-6）。**実測を先頭に、推定を後ろへ。**
 *
 * # 食い違っても、どちらも消さない
 *
 * 番号が変わった直後には必ず食い違う。**そのときどちらが正しいかは、渡した先で
 * 開いてみるまで分からない**ので、片方を消すと外れたときに手が無くなる。冗長性の
 * ために足した機能で選択肢を1本に減らすのは、目的に反する。
 *
 * # `self` の scheme は書き換えない
 *
 * `http` 固定が掛かるのは**こちらが組み立てる候補**（`linux` ／ `windows`）だけである
 * （設計§3）。`location.origin` は**現に繋がっている先**なので、前段越しで `https`
 * だったとしてもそのまま使う——`http` へ直したら、届くと分かっている唯一の候補を
 * 届かないものへ変えてしまう。
 */
export function buildCandidates(
  view: LanAddressView | null,
  origin: string,
  hostname: string,
): LanCandidate[] {
  const 並び: LanCandidate[] = []

  // **サーバの答えが未着でも、この1本だけは常に手元にある**（同期で読めるため）
  if (origin !== '' && !isLoopbackHost(hostname)) {
    並び.push({
      addr: hostname,
      label: SELF_LABEL,
      source: 'self',
      // `origin` は末尾に `/` を持たないので、ここで入口にする
      url: `${origin}/`,
    })
  }

  for (const 候補 of view?.candidates ?? []) {
    並び.push({
      addr: 候補.addr,
      label: 候補.label,
      source: 候補.source,
      url: `http://${候補.addr}:${view?.port ?? 0}/`,
    })
  }

  return 並び
}

interface LanAddressState {
  view: LanAddressView | null
  /** 一度でも聞き終えたか。**「まだ」と「聞いたが空だった」を見分ける** */
  loaded: boolean
  load: () => Promise<void>
}

export const useLanAddressStore = create<LanAddressState>((set) => ({
  view: null,
  loaded: false,

  /**
   * 背景で1回取る。**押してからでは遅い**（上の注釈）。
   *
   * WSL では Windows 側へ問い合わせるので**数秒かかる**（設計§4-3）。押してから
   * 待たせると「効かないボタン」に見えるので、認証を通った直後に取っておく。
   */
  async load() {
    try {
      const response = await fetch('/api/lan-address')
      if (response.status === 401) {
        // 他の取得口（`settings` ／ `versions` ／ `ws`）と揃える
        useAuthStore.getState().markSignedOut()
        return
      }
      if (!response.ok) {
        // **投げない。** ここが落ちてもボタン以外は動く——`self` だけで押せる形に
        // してあるので、聞けなかったことを理由に画面を止める必要が無い
        set({ loaded: true })
        return
      }
      set({ view: (await response.json()) as LanAddressView, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
}))

/** いま配れる候補。**組み立てはここで閉じている。** */
export function useLanCandidates(): LanCandidate[] {
  const view = useLanAddressStore((state) => state.view)
  return buildCandidates(view, window.location.origin, window.location.hostname)
}
