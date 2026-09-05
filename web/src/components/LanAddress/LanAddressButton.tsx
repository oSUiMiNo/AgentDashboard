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

import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CopyGlyph } from '@/components/ui/glyphs'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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

/** 開いた先で何が起きるかまで言う。**着いてから戸惑わせない。** */
const 成功の文 = 'コピーしました。開いた先で合言葉を聞かれます'

export function LanAddressButton() {
  const 候補たち = useLanCandidates()
  const view = useLanAddressStore((state) => state.view)
  const loaded = useLanAddressStore((state) => state.loaded)
  const 取り直す = useLanAddressStore((state) => state.load)
  const [copied, setCopied] = useState<Copied | null>(null)

  /**
   * **`await` を1つも挟まずに [`copyToClipboard`] を呼ぶ**（設計§2）。
   *
   * `FolderBrowser` の `copy` と同じ形——待ちを入れると、古い方法が要求する
   * 「押した合図」が切れることがあり、**同じコードが同じブラウザで動いたり
   * 動かなかったりする**。
   */
  const 写す = useCallback(
    (候補: LanCandidate) => {
      setCopied(null)
      void copyToClipboard(候補.url).then((ok) => {
        setCopied({ value: 候補.url, state: ok ? 'done' : 'failed' })
        // **取り直しは押したあと**（設計§2）。番号が変わるのは Wi-Fi を移ったとき
        // であって、秒ごとではない
        if (ok) {
          void 取り直す()
        }
      })
    },
    [取り直す],
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

  const 先頭 = 候補たち[0]
  const 他 = 候補たち.slice(1)

  return (
    <span className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="lan-address-copy"
        // **押せるのに何も起きない、を作らない**（設計§8-2）
        disabled={先頭 === undefined}
        aria-label="LAN のアドレスをコピー"
        title={
          先頭 === undefined
            ? '開けるアドレスがまだ分かりません'
            : `${先頭.url} をコピー（${先頭.label}）`
        }
        onClick={() => {
          if (先頭 !== undefined) {
            写す(先頭)
          }
        }}
      >
        <CopyGlyph />
      </Button>

      {/* **候補が2つ以上のときだけ出す**（設計§4-5）。1本しか無いのに「他の候補」が
          あると、押しても空の面が開く */}
      {他.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-testid="lan-address-more"
              className="text-muted-foreground text-xs"
            >
              他の候補 {他.length}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto max-w-xs space-y-1 p-2">
            {/* **食い違っても消さない**（設計§4-6）。どちらが正しいかは、渡した先で
                開いてみるまで分からない */}
            {候補たち.map((候補) => (
              <button
                key={`${候補.source}:${候補.addr}`}
                type="button"
                data-testid="lan-address-choice"
                className="hover:bg-muted/60 block w-full rounded px-2 py-1 text-left text-xs"
                onClick={() => 写す(候補)}
              >
                <span className="font-mono break-all">{候補.url}</span>
                <span className="text-muted-foreground block">{候補.label}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}

      {/* 候補が1つも無いなら、**なぜ無いのか**を出す（設計§4-5） */}
      {loaded && 候補たち.length === 0 && view?.note != null && (
        <span
          data-testid="lan-address-note"
          className="text-muted-foreground text-xs"
        >
          {view.note}
        </span>
      )}

      {copied?.state === 'done' && (
        <span
          data-testid="lan-address-state"
          className="text-muted-foreground text-xs"
        >
          {成功の文}
        </span>
      )}

      {/* **写せなかったときの逃げ道**（設計§8-4）。`FolderBrowser` と同じ形——
          文言と値を別の目印に分けてあるのは、確かめたいことが2つあるからである */}
      {copied?.state === 'failed' && (
        <span data-testid="lan-address-failed" className="text-xs text-amber-300">
          コピーできません。この値を選んで取ってください：{' '}
          <code
            data-testid="lan-address-fallback"
            /* **`break-all` で折り返す。** URL は途中で切れても文字列として成立して
               見えるので、はみ出して切れると**短い別物を持っていったことに気づけない** */
            className="bg-muted/60 rounded px-1 py-0.5 font-mono break-all select-all"
          >
            {copied.value}
          </code>
        </span>
      )}
    </span>
  )
}
