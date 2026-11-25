import { useCallback, useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '@/lib/clipboard'

/**
 * コピーの答えを畳むまで（ミリ秒）。
 *
 * **4秒**（利用者の指定・2026-09-08）。**これはトーストではない**ので、
 * `DESIGN.md`「知らせの出し方」がトーストに定めた7秒は当たらない——あちらが
 * 7秒を許すのは**後から読める場所（ベル）がある**からで、ここには無い代わりに
 * **押し直せばいつでも出し直せる**。
 *
 * **長さは「読み切るのにどれだけ要るか」で決める。** ここに出るのは6文字で、
 * しかも**押した本人が見ている最中**に出る——読み終わってなお3秒残ると、
 * 「**まだ写せていないのか**」と読める側に倒れる。
 *
 * **画面ごとに数字が違ってよい。** LAN の住所（`LanAddressButton`）が6秒なのは、
 * あちらの文が2文あり、**開いた先で合言葉を聞かれるという予告がそこにしか
 * 出ない**からである。**揃えるべきは数字ではなく、決め方のほう。**
 *
 * **失敗には張らない**（下記）。
 */
export const コピー表示を畳むまで = 4000

export function useCopyAnswer() {
  /**
   * **コピーの答えは1組しか持たない**（設計§5）。「どの行の、どの値が、どうなったか」
   * を覚え、**別の行を押したら前のぶんは消える**。
   *
   * 複数行ぶんを覚えると、パネルの上に何行も並んで**どれが最後に押したものか
   * 分からなくなる**。最後に押したものだけが答えである。
   *
   * 番号を `useRef` で持つ理由は `asked` と同じ——描画に出ない値なので、
   * `useState` にすると押すたびに関数が作り直される。
   */
  const copyAsked = useRef(0)
  const [copied, setCopied] = useState<{
    path: string
    value: string
    state: "done" | "failed"
    場所: "行" | "パンくず"
  } | null>(null)

  /**
   * 出したものを引っ込めるための2つ（項目5）。
   *
   * **`戻す` は成功のときだけ張る**——失敗は時間で消さない（下の [`copy`] の但し書き）。
   * **`出し直す` は次の描画を1回挟むためのもの**で、押し直しを目に見せる。
   *
   * **どちらも `useRef` で持ち、[`止める`] が両方を落とす。** 止め忘れると、
   * **前のタイマーが新しい表示を消しに来る**。
   */
  const 戻す = useRef<number | null>(null)
  const 出し直す = useRef<number | null>(null)

  const 止める = useCallback(() => {
    if (戻す.current !== null) {
      window.clearTimeout(戻す.current)
      戻す.current = null
    }
    if (出し直す.current !== null) {
      cancelAnimationFrame(出し直す.current)
      出し直す.current = null
    }
  }, [])

  // 畳んだ・離れたときに必ず落とす。**ここが無いと、消えたはずの画面へ向けて
  // タイマーが発火する**
  useEffect(() => 止める, [止める])

  /**
   * **`await` を1つも挟まずに [`copyToClipboard`] を呼ぶ**（設計§3）。ここに
   * 待ちを入れると、古い方法が要求する「押した合図」が切れることがある——
   * 切れるかどうかはブラウザ任せなので、**動いたり動かなかったりする**形になる。
   */
  const copy = useCallback(
    (at: string, value: string, 場所: "行" | "パンくず" = "行") => {
      const mine = ++copyAsked.current
      // 押した瞬間に前の答えを消す。**結果を待たない**——待つと、次の行を押しても
      // 前の行の答えが残って見える
      止める()
      setCopied(null)
      void copyToClipboard(value).then((ok) => {
        // 割り込まれた古い答えは捨てる（`asked` と同じ理由）
        if (mine !== copyAsked.current) {
          return
        }
        /*
          **次の描画を1回挟む**（項目5-b）。上で `null` にしても、`then` は
          マイクロタスクなので **React が同じ描画へまとめてしまい、同じ行を続けて
          押したときに目には何も起きない**。

          `requestAnimationFrame` を選んだのは、**「消えた状態を1度描いてから出し直す」
          という目的そのものが、描画の区切りを1つ挟むことだから**である。
          `setTimeout(0)` でも描画は挟まるが、**挟まる保証が無い**（描画前に走りうる）。
          `flushSync` は逆に描画を強制するが、**イベントの途中で呼ぶと React が警告する**。
        */
        出し直す.current = requestAnimationFrame(() => {
          出し直す.current = null
          if (mine !== copyAsked.current) {
            return
          }
          setCopied({ path: at, value, state: ok ? "done" : "failed", 場所 })
          /*
            **成功だけ時間で消す**（項目5-c）。長さは [`コピー表示を畳むまで`]。

            **失敗には張らない。** あれは値を選んで取るための逃げ道なので、
            **消えると逃げ道として使えなくなる**。消すのは人の手（下の ✕）。
          */
          if (ok) {
            戻す.current = window.setTimeout(() => {
              戻す.current = null
              setCopied(null)
            }, コピー表示を畳むまで)
          }
        })
      })
    },
    [止める],
  )

  const dismiss = useCallback(() => {
    止める()
    setCopied(null)
  }, [止める])

  return { copied, copy, dismiss }
}
