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

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  normalizeWidth,
  PANEL_RANGE,
  resolveWidth,
  type PanelEdge,
} from '@/lib/panelWidth'

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

/**
 * 幅の置き場所（設計§5）。**1つの鍵に表として持つ**（`lib/drafts.ts` と同じ流儀）。
 *
 * 区画ごとに鍵を作ると、区画が増えるたびに鍵が増える。利用者から見えない場所なので
 * 消す機会も無い。粒度は**アプリ全体で1つ**——PJT ごと・セッションごとには持たない
 * （開閉と同じ族。`イシューグループ_2026-0813-1804` が掘った位置を別の族として
 * 扱っているのは「同じパスが別の PC にもありうる」ためで、幅にはその事情が無い）。
 */
const WIDTH_KEY = 'agentdashboard.project-files-width'

/** 覚えている幅（px）。 */
export interface PanelWidths {
  folder: number
  file: number
}

/** どこにも覚えが無いときの表。 */
function 既定の表(): PanelWidths {
  return { folder: PANEL_RANGE.folder.default, file: PANEL_RANGE.file.default }
}

/**
 * 覚えている幅を読む。**壊れていても落ちない。**
 *
 * # 数値を置くのは、このリポジトリで初めて
 *
 * 既存の2つは真偽値（この上の [`read`]）と文字列の表（`lib/drafts.ts`）で、数値は
 * 前例が無い。したがって守り方を明示する（設計§5）。
 *
 * 1. `JSON.parse` に失敗したら**表ごと**既定へ
 * 2. object でない・`null`・配列なら**表ごと**既定へ
 * 3. 値が数値でない・`NaN`・負・範囲外なら、**その項目だけ**既定か clamp
 *    （**表を丸ごと捨てない**）
 * 4. 知らない鍵が混ざっていても無視する（`folder` と `file` しか見ない）
 *
 * **控えは持たない。** `lib/drafts.ts` が生の文字列で控えているのは打鍵のたびに
 * 読まれるからで、幅は画面を開いたときと別のタブの合図のときにしか読まない。
 */
export function readWidths(): PanelWidths {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(WIDTH_KEY) ?? null
  } catch {
    // 置けない設定のブラウザでも画面は動くべきなので、既定へ落とす
    return 既定の表()
  }
  if (raw === null) {
    return 既定の表()
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 既定の表()
    }
    const table = parsed as Record<string, unknown>
    // **1件ずつ確かめる。** 片方が壊れていても、もう片方は生かす
    return {
      folder: normalizeWidth('folder', table.folder),
      file: normalizeWidth('file', table.file),
    }
  } catch {
    // 誰かが手で壊した／別の版が別の形で書いた。既定へ落とす
    return 既定の表()
  }
}

/** 覚える。**離したときだけ呼ばれる**（設計§5）。 */
export function writeWidths(widths: PanelWidths): void {
  try {
    globalThis.localStorage?.setItem(WIDTH_KEY, JSON.stringify(widths))
  } catch {
    // 置けない設定のブラウザ。**覚えられないだけで、その回の幅は成立している**
  }
}

/** 縁から呼ばれる手。**名前を縁の props と揃えてある**（そのまま渡せる）。 */
export interface PanelWidthHandle {
  /** 掴んだ。**ここから離すまで別のタブの合図を無視する** */
  onGrab: () => void
  /** 動かしている最中。**画面だけ変える。書かない** */
  onMove: (edge: PanelEdge, width: number) => void
  /** 離した。**ここでだけ書く** */
  onDrop: () => void
}

/**
 * いま当てる幅を、覚えている値と画面幅から出す。
 *
 * **覚えている値そのものは書き換えない**（設計§4）。窓を狭めた状態で clamp した値を
 * 覚えると、窓を戻したときに元の幅へ戻れない。ここは読むだけで、書くのは
 * [`PanelWidthHandle.onDrop`] だけ。
 */
function いま当てる幅(): PanelWidths {
  const stored = readWidths()
  const 画面幅 = globalThis.innerWidth
  return {
    folder: resolveWidth('folder', stored.folder, 画面幅),
    file: resolveWidth('file', stored.file, 画面幅),
  }
}

/**
 * 幅と、変える手。**別のタブでの書き換えも拾う**（[`useFilesPanel`] と同じ作り）。
 *
 * # ドラッグ中は合図を受け取らない
 *
 * `storage` の合図は開閉には無かった競合を生む——**掴んでいる最中に他のタブが幅を
 * 書き換えると、指の下で幅が跳ぶ**（設計§5）。掴んでいるかどうかは `useRef` で持つ
 * ——`useState` だと、速い操作で合図の側が1つ前の描画の値を見る余地が残る
 * （`Dpad.tsx` の `armed` と同じ判断）。
 *
 * # 「掴んでいる」を2つ持つ理由
 *
 * `useRef` は**合図を無視するため**、`useState` は**描画へ出すため**。両方が要る。
 *
 * 合図の側を `useState` にすると、速い操作で1つ前の描画の値を見る余地が残る
 * （`Dpad.tsx` の `armed` と同じ判断）。かといって `useRef` だけにすると、
 * **掴んでいることを画面の側が知れない**——サイドバーの場所取りは、掴んでいる間だけ
 * 動きを消さないと、幅が毎フレーム変わるたびに tween が挟まって指から遅れる
 * （`ProjectFiles/Sidebar.tsx`）。**同じ場所で同時に更新するので、ずれようがない。**
 *
 * # 窓の大きさを実行中に変えても追随しない
 *
 * 画面幅を見るのは**マウント時と別のタブの合図のときだけ**で、`resize` は購読しない。
 * 購読して clamp すると、**その後の「離した」が clamp 後の値を書く**——設計§4 が
 * 名指しで警告している「窓を狭めた状態で clamp した値を覚える」に、いちばん近い経路を
 * 自分で作ることになる。実害があるかは実機で見る。
 */
export function usePanelWidths(): [PanelWidths, PanelWidthHandle, boolean] {
  const [widths, setWidths] = useState<PanelWidths>(いま当てる幅)
  /** 離した時点で書くために、いつも最新を控える */
  const latest = useRef(widths)
  latest.current = widths
  /** 掴んでいるか。`true` のあいだ `storage` を無視する */
  const 掴んでいる = useRef(false)
  /** 同じことを描画へ出すための控え。**用途が違うだけで、値は同じ** */
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== WIDTH_KEY) {
        return
      }
      if (掴んでいる.current) {
        return
      }
      // **`newValue` ではなく読み直す。** 表の一部だけが壊れている場合の落とし方を、
      // 読む口の1箇所に集めておく
      setWidths(いま当てる幅())
    }
    globalThis.addEventListener('storage', onStorage)
    return () => globalThis.removeEventListener('storage', onStorage)
  }, [])

  const onGrab = useCallback(() => {
    掴んでいる.current = true
    setDragging(true)
  }, [])

  const onMove = useCallback((edge: PanelEdge, width: number) => {
    // **書かない。** 毎フレーム書くと `localStorage` を叩き続ける（設計§5）
    setWidths((now) => ({ ...now, [edge]: width }))
  }, [])

  const onDrop = useCallback(() => {
    掴んでいる.current = false
    setDragging(false)
    // **離した時点の値が正**（設計§5）
    writeWidths(latest.current)
  }, [])

  return [widths, { onGrab, onMove, onDrop }, dragging]
}
