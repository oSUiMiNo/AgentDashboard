/**
 * LAN の別端末から開けるアドレスを、**押すだけで手に入れる**（設計§8）。
 *
 * # この部品は自分がどこに居るかを知らない
 *
 * 幅も余白も位置も持たず、親から与えられる（設計§8-1）。置き場所は暫定なので、
 * 動かす日に触るのが `App.tsx` の1行とここだけで済むようにしてある——
 * **アドレスを組み立てる側（`stores/lanAddress.ts`）には手が要らない。**
 *
 * # 押した合図の中で写す
 *
 * 候補は[`useLanCandidates`]が**既に持っている**ので、押してから通信しない。
 * ここで `await` を跨ぐと、平文 HTTP の端末では古い口が使えなくなり**入らなくなる**
 * （設計§2）。**この1点がこの機能の成否を決める。**
 *
 * # 逃げ道は保険のまま
 *
 * 平文でも入るのが既定である。**先回りで逃げ道だけ出す作りにしない**——まず試して、
 * 駄目だったときに出す（設計§8-4）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CopyGlyph } from '@/components/ui/glyphs'
import { copyToClipboard } from '@/lib/clipboard'
import {
  useLanAddressStore,
  useLanCandidates,
  type LanCandidate,
} from '@/stores/lanAddress'

/** 押した結果。**成功と失敗で別の文を出す**——黙って何も起きないのが最悪である。 */
interface Copied {
  value: string
  state: 'done' | 'failed'
}

/**
 * 開いた先で何が起きるかまで言う。**着いてから戸惑わせない。**
 *
 * **何本入ったかを言う。** 複数入っているのに1本のつもりで貼ると、
 * 相手には見慣れない行が並んで見える。
 */
function 成功の文(件数: number): string {
  const 頭 =
    件数 > 1 ? `${件数}件ぜんぶコピーしました（改行区切り）` : 'コピーしました'
  return `${頭}。開いた先で合言葉を聞かれます`
}

/**
 * 成功の知らせを畳むまで（ミリ秒）。
 *
 * **出しっぱなしにしない。** 消えないと「**もう一度写した**」が画面に出ず、
 * 二度目を押しても何も起きていないように見える（2026-09-05・利用者の指摘）。
 * 一度畳んでから出し直すので、**同じ文でも「いま押した」ことが伝わる。**
 *
 * 読み切れる長さは要る——文は2文あり、**開いた先で合言葉を聞かれる**という
 * 予告がここにしか出ない。
 */
const 成功を畳むまで = 6000

export function LanAddressButton() {
  const 候補たち = useLanCandidates()
  const view = useLanAddressStore((state) => state.view)
  const loaded = useLanAddressStore((state) => state.loaded)
  const 取り直す = useLanAddressStore((state) => state.load)
  const [copied, setCopied] = useState<Copied | null>(null)
  /** 畳む予約。**張りっぱなしにしない**ので、次の押下と後始末の両方で外す */
  const 畳む札 = useRef<number | null>(null)

  const 畳むのをやめる = useCallback(() => {
    if (畳む札.current !== null) {
      window.clearTimeout(畳む札.current)
      畳む札.current = null
    }
  }, [])

  // **畳まれたあとに走らせない。** 予約を残したまま消えると、消えた部品へ
  // 書き込もうとする（`useReorder` と同じ作法で、後始末は必ず書く）
  useEffect(() => 畳むのをやめる, [畳むのをやめる])

  /**
   * **`await` を1つも挟まずに [`copyToClipboard`] を呼ぶ**（設計§2）。
   *
   * `FolderBrowser` の `copy` と同じ形——待ちを入れると、古い方法が要求する
   * 「押した合図」が切れることがあり、**同じコードが同じブラウザで動いたり
   * 動かなかったりする**。
   */
  const 写す = useCallback(
    (候補たち: LanCandidate[]) => {
      // **前の知らせを先に畳む。** 残したまま次を出すと、二度目が出たのか
      // 消え損ねているのかが見分けられない
      畳むのをやめる()
      setCopied(null)
      /*
        **候補は全部まとめて写す**（2026-09-05・利用者の指定）。

        かつては先頭だけを写し、残りは「他の候補」から1本ずつ選ばせていた。
        やめた理由は2つある。

        1. **確実な1本が選べない。** 現に繋がっている `self` はスマホでしか出ず、
           PC で押すと推定しか残らない——そこを1本に絞ると**外れたときに手が無くなる**
        2. **選ばせる相手を間違えていた。** どれが届くかは**貼った先で開くまで
           分からない**ので、選ぶべきなのは押す人ではなく**受け取る人**である

        改行で繋ぐと、貼った先では**各行がそれぞれリンクになる**ので、
        受け取った側が上から試せる。
      */
      const 値 = 候補たち.map((候補) => 候補.url).join('\n')
      void copyToClipboard(値).then((ok) => {
        setCopied({ value: 値, state: ok ? 'done' : 'failed' })
        if (ok) {
          // **取り直しは押したあと**（設計§2）。番号が変わるのは Wi-Fi を移ったとき
          // であって、秒ごとではない
          void 取り直す()
          // **成功だけ畳む。** 失敗の側は値を選んで取ってもらう逃げ道なので、
          // 読んでいる最中に消すと**取りようが無くなる**（設計§8-4）
          畳む札.current = window.setTimeout(() => {
            畳む札.current = null
            setCopied(null)
          }, 成功を畳むまで)
        }
      })
    },
    [取り直す, 畳むのをやめる],
  )

  // **押しても死んだアドレスしか渡らないボタンを置かない**（設計§8-3）。
  // 代わりに1行だけ出す——何をすれば使えるようになるかが分かればよい
  if (loaded && view?.reachable === false) {
    return (
      <span
        data-testid="lan-address-unreachable"
        className="text-muted-foreground text-xs"
      >
        {/* **短く保つ。** 上部は3者で取り合っている場所なので、ここが伸びると
            隣が折り返す。**何を触ればよいか**（`bind_addr`）と**どこを読めばよいか**
            の2つが分かれば足りる */}
        LAN から開くには <code className="font-mono">bind_addr</code> の設定が要ります（
        <a
          href="https://github.com/oSUiMiNo/AgentDashboard/blob/main/docs/setup/local.md"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          開き方
        </a>
        ）
      </span>
    )
  }

  return (
    // **`relative` は位置を持つことにならない。** 浮かせる知らせの基準点であって、
    // この部品が帯のどこに置かれるかは親が決めたまま（設計§8-1）
    <span className="relative flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="lan-address-copy"
        // **押せるのに何も起きない、を作らない**（設計§8-2）
        disabled={候補たち.length === 0}
        aria-label="LAN のアドレスをコピー"
        // **何が入るかを、押す前に読めるようにする。** 複数あるなら全部並べる
        title={
          候補たち.length === 0
            ? '開けるアドレスがまだ分かりません'
            : 候補たち.map((候補) => `${候補.url}（${候補.label}）`).join('\n')
        }
        onClick={() => {
          if (候補たち.length > 0) {
            写す(候補たち)
          }
        }}
      >
        <CopyGlyph />
      </Button>

      {/*
        **「他の候補」は無くした**（2026-09-05・利用者の指定）。
        全部まとめて写すので選ばせる相手が居ない——**帯は3者で取り合う場所**なので、
        要らなくなったものは残さない。何が入るかはボタンの説明に出る。
      */}

      {/* 候補が1つも無いなら、**なぜ無いのか**を出す（設計§4-5） */}
      {loaded && 候補たち.length === 0 && view?.note != null && (
        <span
          data-testid="lan-address-note"
          className="text-muted-foreground text-xs"
        >
          {view.note}
        </span>
      )}

      {/*
        **押した結果は、帯の中に置かず浮かせる**（2026-09-05・利用者の実機で判明）。

        ここは上部の帯で、狭い画面では3者が横幅を取り合う。流れの中に文を置くと
        **押し出されて幅が1文字ぶんまで縮み、縦に1文字ずつ改行された**
        （スマホの実機。文が読めないどころか、帯そのものが崩れた）。

        `absolute` なら**幅を自分で決められる**——`w-max` で文の長さなり、
        `max-w` で画面からはみ出さない。**帯のレイアウトには一切効かない。**

        **トーストへは出さない。** あちらは琥珀の枠を持つ**警告の器**なので、
        成功をあそこへ出すと「何か起きた」に見える。見た目は `PopoverContent` に揃える
        ——同じ「押した先に浮くもの」なので、別の見た目を作らない。
      */}
      {copied !== null && (
        <span
          data-testid="lan-address-result"
          className="bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-1 w-max max-w-[min(22rem,90vw)] rounded-md border p-2 shadow-md"
        >
          {copied.state === 'done' ? (
            <span
              data-testid="lan-address-state"
              className="text-muted-foreground text-xs"
            >
              {成功の文(候補たち.length)}
            </span>
          ) : (
            /* **写せなかったときの逃げ道**（設計§8-4）。`FolderBrowser` と同じ形——
               文言と値を別の目印に分けてあるのは、確かめたいことが2つあるからである */
            <span
              data-testid="lan-address-failed"
              className="block text-xs text-amber-300"
            >
              コピーできません。この値を選んで取ってください：{' '}
              <code
                data-testid="lan-address-fallback"
                /* **`break-all` で折り返す。** URL は途中で切れても文字列として成立して
                   見えるので、はみ出して切れると**短い別物を持っていったことに気づけない** */
                className="bg-muted/60 block rounded px-1 py-0.5 font-mono break-all whitespace-pre-line select-all"
              >
                {copied.value}
              </code>
            </span>
          )}
        </span>
      )}
    </span>
  )
}
