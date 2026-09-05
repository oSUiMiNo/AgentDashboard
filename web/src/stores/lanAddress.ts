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
 * 家の中の IPv4 か（`10/8` ／ `172.16/12` ／ `192.168/16`）。
 *
 * **サーバがどこまで口を出せるかの線引きに使う。** `lan_address.rs` が数え上げるのは
 * **この機械の私用 IPv4** だけなので、その種類の値については**サーバが唯一の権威**で
 * ある。名前（`dash.example.com`）や公開アドレスはあちらの管轄外なので、
 * 載っていないことを否定と読んではいけない（[`buildCandidates`] の注釈）。
 *
 * **見た目の前方一致で判定しない。** `172.` で始まるだけでは私用とは限らない
 * （`172.15.` は公開）ので、第2オクテットまで見る。
 */
export function isPrivateIpv4(host: string): boolean {
  const 素 = host.replace(/^\[|\]$/g, '')
  const 組 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(素)
  if (組 === null) {
    return false
  }
  const 数 = [組[1], 組[2], 組[3], 組[4]].map(Number)
  if (数.some((n) => n > 255)) {
    return false
  }
  const [a, b] = 数
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * 候補を並べる（設計§4-6・§4-7）。**外から届くと言える根拠があるものだけを出す。**
 *
 * # `self` は「届くと分かっている候補」ではない
 *
 * **これがこの機能で最初に踏んだ穴である。** `location.hostname` は
 * **いま見ているブラウザから届く**というだけで、**渡す相手から届くことを1ミリも
 * 意味しない。** ところがこの機能の目的は「**別の端末**で開くアドレスを渡すこと」
 * なので、そこを取り違えると**原理的に開けない番号を筆頭に勧める**ことになる。
 *
 * 実際に起きた（2026-09-05・利用者の実機）。WSL の仮想スイッチ
 * （`vEthernet (WSL …)` の `192.168.144.1`）で画面を開いていたため、それが
 * 「いま開いているアドレス」として先頭に出た。**サーバは規則5で正しく捨てていた**
 * のに、画面が後から足して**濾過を迂回していた。**
 *
 * # 線引きは「サーバの管轄かどうか」で引く
 *
 * `lan_address.rs` が数え上げるのは**この機械の私用 IPv4** である。だから
 *
 * | `self` の正体 | 扱い | なぜ |
 * |---|---|---|
 * | **私用 IPv4 で、サーバの一覧に**居ない | **捨てる** | サーバが**届かないと判定した**番号。仮想スイッチや古い番号がここに落ちる |
 * | 私用 IPv4 で、一覧に居る | **残す**（重複は出さない） | 裏が取れている。scheme を保つため `self` 側を採る |
 * | 名前や公開アドレス（`dash.example.com` など） | **残す** | **サーバの管轄外**なので、載っていないことを否定と読めない。前段越しの `https` はここ |
 * | サーバがまだ答えていない | **残す** | 他に手が無い。**否定する材料が無いことと、否定されたことは違う** |
 *
 * **「載っていない＝駄目」と一律にしない**のが要点である。そうするとリバースプロキシ
 * 越しの唯一まともな候補まで消える。
 *
 * # 食い違っても、どちらも消さない
 *
 * 番号が変わった直後には必ず食い違う。**そのときどちらが正しいかは、渡した先で
 * 開いてみるまで分からない**ので、片方を消すと外れたときに手が無くなる。冗長性の
 * ために足した機能で選択肢を1本に減らすのは、目的に反する。
 *
 * **上の「捨てる」はこれと矛盾しない。** あちらは*食い違い*ではなく、
 * **サーバが名指しで否定した**ものだけを落としている。
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
  const サーバ候補 = view?.candidates ?? []
  const 裏が取れた = サーバ候補.some((候補) => 候補.addr === hostname)
  // **サーバが名指しで否定したときだけ落とす**（上の表）。答えが未着（`view === null`）
  // なら否定する材料が無いので落とさない
  const サーバが否定した = view !== null && isPrivateIpv4(hostname) && !裏が取れた
  const 自分を出せる =
    origin !== '' && !isLoopbackHost(hostname) && !サーバが否定した

  if (自分を出せる) {
    並び.push({
      addr: hostname,
      label: SELF_LABEL,
      source: 'self',
      // `origin` は末尾に `/` を持たないので、ここで入口にする
      url: `${origin}/`,
    })
  }

  for (const 候補 of サーバ候補) {
    // **同じ番号を二度出さない。** 裏が取れているときは `self` 側を採ってあるので、
    // ここで重ねると同じ行が2つ並ぶ（設計§4-7）
    if (自分を出せる && 候補.addr === hostname) {
      continue
    }
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
