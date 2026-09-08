/**
 * ファイルビュアの中身の**文字の大きさ**を覚える
 * （`ファイルビュアの文字を小さめに始め、その場で大きさを変えられるようにする` 要件）。
 *
 * # `lib/filesPanel.ts` と同じ族に置く
 *
 * このアプリには記憶の線が2本ある。**倍率は「その人の目と画面」の都合**であって、
 * どの PJT を見ているかで変わらない——サイドバーの幅と同じ性質なので、
 * **PJT をまたいで1つ・`storage` で他のタブとも揃う**側に置く。
 *
 * 掘っていた場所（`lib/filesPlace.ts`）は「その窓でいま何をしているか」なので別の族。
 * ここへ混ぜると、**別のタブで文字を大きくしたら見ている場所まで飛ぶ**ことになる。
 *
 * # 固定の段を持つ。掛け算にしない
 *
 * 段は Chrome と Firefox が実際に使っている拡大率である。**利用者は既に体で知っている**
 * ので、1押しでどれくらい変わるかを覚え直さなくてよい。
 *
 * **「毎回 1.1 倍する」形にしない。** 掛け算の誤差が溜まり、**同じ回数押し戻しても
 * 元の値へ戻らない**。固定の段なら、押し戻せば必ず元へ戻る。
 *
 * # 下限を 80% で止める理由
 *
 * 既定の生テキスト（10.2px）の 80% は 8.2px で、`DESIGN.md` §13.2 のいちばん小さい帯
 * （Badge 10〜12px）すら下回る。**長文を読ませる面なので、これ以上は下げない。**
 * 上限 200% は、画面から離れて読む用途に足りる幅として置く。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const ZOOM_KEY = 'agentdashboard.file-zoom'

/**
 * 段。**等比（およそ 1.1〜1.25 倍）なので、どの段に居ても1押しの手応えが同じ**になる。
 * 等差（毎回 +1px）にすると、小さいところでは大きく変わり、大きいところでは効かない。
 */
export const ZOOM_STEPS = [80, 90, 100, 110, 125, 150, 175, 200] as const

/** 何も覚えていないときの倍率。**この値を 100% と呼ぶ**（＝いままでの 0.85 倍）。 */
export const ZOOM_DEFAULT = 100

/**
 * 段の表に無い値・数でない値は、すべてここで既定へ落ちる。
 *
 * **文字列と数値の両方を受け取る。** 覚えている値（文字列）と、いま画面に出ている値
 * （数値）が同じ門を通る——**片方だけ通す形にすると、`stepZoom` に数値を渡した瞬間に
 * 既定へ落ちて段が動かなくなる**（実際に踏んだ）。
 */
function 通す(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN
  // **段の表に無い値は受け取らない。** 近い段へ丸めると、手で書き換えた
  // `137` が `125` として生き残り、「覚えている値は段のどれか」が崩れる
  return ZOOM_STEPS.includes(n as (typeof ZOOM_STEPS)[number]) ? n : ZOOM_DEFAULT
}

/** 覚えている倍率。**壊れていても落ちない**——読めなければ既定。 */
export function readZoom(): number {
  try {
    return 通す(globalThis.localStorage?.getItem(ZOOM_KEY) ?? null)
  } catch {
    // 置けない設定のブラウザでも画面は動くべきなので、既定へ落とす
    return ZOOM_DEFAULT
  }
}

function writeZoom(zoom: number): void {
  try {
    globalThis.localStorage?.setItem(ZOOM_KEY, String(zoom))
  } catch {
    // 覚えられないだけで、その回の拡縮は成立している
  }
}

/**
 * 段の表の中を1つ動く。**端では動かない**（押しても同じ値が返る）。
 *
 * @param 向き `1` で大きく、`-1` で小さく
 */
export function stepZoom(zoom: number, 向き: 1 | -1): number {
  const i = ZOOM_STEPS.indexOf(通す(zoom) as (typeof ZOOM_STEPS)[number])
  return ZOOM_STEPS[i + 向き] ?? ZOOM_STEPS[i] ?? ZOOM_DEFAULT
}

/** 手。**名前を押しボタンの意味と揃えてある。** */
export interface ZoomHandle {
  大きく: () => void
  小さく: () => void
  /** 既定（100%）へ戻す。**倍率の表示そのものが押せる**（ボタンを1つ増やさない） */
  戻す: () => void
}

/**
 * いまの倍率と、変える手。**別のタブでの書き換えも拾う**（[`useFilesPanel`] と同じ作り）。
 *
 * 上限・下限に居るかは呼ぶ側が [`ZOOM_STEPS`] と比べて決める——**押せるのに何も
 * 起きないボタンを出さない**ため、そこで `disabled` にする。
 */
export function useFileZoom(): [number, ZoomHandle] {
  const [zoom, setZoom] = useState(readZoom)
  /*
    **`setZoom` の更新関数の中で `localStorage` を書かない。** 更新関数は純粋である
    ことが求められており、開発時の二重呼び出しでそのまま二重に書くことになる。
    控えを1つ置いて、**決めるのを外側で済ませる**（`usePanelWidths` の `latest` と
    同じ作り）。
  */
  const 最新 = useRef(zoom)
  最新.current = zoom

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === ZOOM_KEY) {
        // **`newValue` ではなく読み直す。** 壊れた値の落とし方を読む口の1箇所に集める
        setZoom(readZoom())
      }
    }
    globalThis.addEventListener('storage', onStorage)
    return () => globalThis.removeEventListener('storage', onStorage)
  }, [])

  const 動かす = useCallback((次: (now: number) => number) => {
    const 先 = 次(最新.current)
    setZoom(先)
    writeZoom(先)
  }, [])

  const 大きく = useCallback(() => {
    動かす((now) => stepZoom(now, 1))
  }, [動かす])
  const 小さく = useCallback(() => {
    動かす((now) => stepZoom(now, -1))
  }, [動かす])
  const 戻す = useCallback(() => {
    動かす(() => ZOOM_DEFAULT)
  }, [動かす])

  return [zoom, { 大きく, 小さく, 戻す }]
}
