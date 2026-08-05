/**
 * ファイルの左パネルの開閉（イシューグループ_2026_0805_0514 設計§14・§28）。
 *
 * # なぜ切り出したのか
 *
 * この開閉は **PJT 専用画面とセッション専用画面の両方**が持つ。同じ意味の状態を
 * 2箇所で別々に持つと、片方で開いてもう片方が畳んだまま、という食い違いが出る。
 * **1つの癖を1つの場所に置く。**
 *
 * # ブラウザ側に持つ
 *
 * サーバへ置くと他の端末の開閉まで揃ってしまい、手元では畳んでおきたいのに
 * スマホで開いた状態が飛んでくる。**枠ごとでもセッションごとでもなく1つ**なのは、
 * これが「ファイルを見ながら作業する人かどうか」という利用者の癖に属するため。
 */

import { useCallback, useEffect, useState } from 'react'

const PANEL_KEY = 'agentdashboard.project-files-open'

function read(): boolean {
  try {
    return globalThis.localStorage?.getItem(PANEL_KEY) === '1'
  } catch {
    // 置けない設定のブラウザでも画面は動くべきなので、既定（畳む）へ落とす
    return false
  }
}

function write(open: boolean) {
  try {
    globalThis.localStorage?.setItem(PANEL_KEY, open ? '1' : '0')
  } catch {
    // 覚えられないだけで、この回の開閉は成立している
  }
}

/** 開いているかと、切り替える手。**別のタブでの切り替えも拾う。** */
export function useFilesPanel(): [boolean, () => void] {
  const [open, setOpen] = useState(read)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === PANEL_KEY) {
        setOpen(event.newValue === '1')
      }
    }
    globalThis.addEventListener('storage', onStorage)
    return () => globalThis.removeEventListener('storage', onStorage)
  }, [])

  const toggle = useCallback(() => {
    setOpen((now) => {
      write(!now)
      return !now
    })
  }, [])

  return [open, toggle]
}
