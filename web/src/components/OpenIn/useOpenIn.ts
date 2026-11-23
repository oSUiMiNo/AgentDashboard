import { useCallback, useEffect, useRef, useState } from 'react'

import {
  FAILED,
  SIGNED_OUT,
  fetchOpenIn,
  postOpenIn,
  type OpenApp,
  type OpenInView,
} from '@/lib/openIn'
import { usePoll } from '@/lib/poll'
import { pushReplyNotice } from '@/stores/appNotices'

/**
 * 読み直しの間隔（サイドバーにエクスプローラで開くボタンが欲しい 設計§7-6。仮置き）。
 *
 * フォルダの一覧（10秒）より短いのは、VSCode の窓を閉じたら印が戻るのを、利用者が
 * その場で見るため。
 */
export const 開く口を読み直す間隔 = 3_000

/**
 * 親PC でない（`same_machine: false`）と分かった後は、読み直しをこの回数に1回へ間引く（30秒おき）。
 *
 * **止めはしない。** サーバの判定は一時的に外れることがある（WSL の網を読めなかった結果を
 * 60 秒覚える）ので、止めると親PC でもサイドバーを開き直すまでボタンが戻らない。スマホで開いて
 * いる間に 3 秒おきに引き続けないよう、間引くだけにする。
 */
export const 親PCでないときの間引き = 10

export interface OpenInHandle {
  /** 読めた答え。`null` は「まだ読めていない・口が無い・ログインが切れた」 */
  view: OpenInView | null
  open: (app: OpenApp, path: string) => void
  /** POST の答えを待っている間 */
  busy: boolean
}

/**
 * エクスプローラ・VSCode で開く口を読み、押す（設計§7-6）。
 *
 * **サイドバーの中で呼ぶ。** サイドバーは畳むと木から消えるので、開いている間だけ
 * 問い合わせることになる（`usePoll` が消えたら止まる）。
 *
 * **親PC でない（`same_machine: false`）と分かっても答えは捨てない**——出さないと決めるのは
 * `FolderBrowser` の側で、ここで `null` にすると「読めない」「口が無い」と区別できなくなる。
 * 読み直しは止めずに間引く（[`親PCでないときの間引き`]）。口が無い（`null`）かログインが切れたら
 * 止める。一時的に聞けなかった（`FAILED`）なら前の答えを保って続ける。
 */
export function useOpenIn(host: string): OpenInHandle {
  const [view, setView] = useState<OpenInView | null>(null)
  const [busy, setBusy] = useState(false)
  const 止めた = useRef(false)
  const 読み飛ばす残り = useRef(0)
  // **state だけだと同じ描画の中の二度押しを止められない**ので、印を ref でも持つ
  const 押している = useRef(false)
  const 生きている = useRef(true)
  // 押した直後の答えを、その前に出ていた遅い読み直しが上書きしないよう、通し番号で古い答えを捨てる
  const 世代 = useRef(0)

  useEffect(() => {
    生きている.current = true
    return () => {
      生きている.current = false
    }
  }, [])

  const 引く = useCallback(async () => {
    if (止めた.current) {
      return
    }
    if (読み飛ばす残り.current > 0) {
      読み飛ばす残り.current -= 1
      return
    }
    const 出した世代 = 世代.current
    const answer = await fetchOpenIn(host)
    if (!生きている.current || 世代.current !== 出した世代 || answer === FAILED) {
      return
    }
    if (answer === SIGNED_OUT || answer === null) {
      止めた.current = true
      setView(null)
      return
    }
    setView(answer)
    読み飛ばす残り.current = answer.same_machine ? 0 : 親PCでないときの間引き - 1
  }, [host])

  // **最初の1回は自分で引く。** `usePoll` は最初の1回を間隔の後に打つので、任せると
  // サイドバーを開いてから3秒間ボタンが出ない。host が変わったら止めた印と間引きを解いて引き直す
  useEffect(() => {
    世代.current += 1
    止めた.current = false
    読み飛ばす残り.current = 0
    void 引く()
  }, [引く])

  usePoll(引く, 開く口を読み直す間隔)

  const open = useCallback(
    (app: OpenApp, path: string) => {
      if (押している.current) {
        return
      }
      押している.current = true
      setBusy(true)
      const 出した世代 = 世代.current
      void postOpenIn(host, app, path)
        .then((attempt) => {
          if (!生きている.current) {
            return
          }
          // **返ってきた様子ですぐ差し替える。** 印が次の読み直しを待たずに出る
          if (attempt.ok) {
            if (世代.current !== 出した世代) {
              return
            }
            世代.current += 1
            setView(attempt.result.view)
          } else {
            pushReplyNotice(attempt.message)
          }
        })
        .finally(() => {
          押している.current = false
          if (生きている.current) {
            setBusy(false)
          }
        })
    },
    [host],
  )

  return { view, open, busy }
}
