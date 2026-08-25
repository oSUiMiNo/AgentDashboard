/**
 * 画面を回遊する効果線の在庫（カード設計§9-7）。
 *
 * # なぜ zustand なのか
 *
 * 更新は**最悪でも 12枚 × 1/4.8秒 ≒ 2.5回/秒**で、購読者は層1つ（葉）しかない。
 * `stores/sessions.ts` が `useSyncExternalStore` を選んでいるのは「毎秒何度も来る更新で
 * 一覧全体が作り直されるのを避ける」ためで、**ここはその条件に当たらない**。
 *
 * # 門が2枚あるのはなぜか
 *
 * ここ（JavaScript）で止めるのは**仕事を作らないため**——止まっていれば DOM も
 * タイマも1つも生えない。`roam.css` にも同じ止め方を書いてあるのは、**こちらが
 * 壊れても見えないため**である。E2E は本数（＝この門）を、CSS の台帳は打ち消し
 * （＝あちらの門）を、それぞれ別に見ている。
 */

import { create } from 'zustand'
import type { MotionQuiet } from '@/stores/settings'
import { type RoamStop, planRoute } from '@/lib/roam'

/** 画面に同時に居てよい線の数。**「控えめ」という利用者の指定の実体がこれ** */
export const ROAM_MAX = 10

/** 1本が飛んでいる時間。`roam.css` へは層が渡すので、秒数の出どころはここだけ */
export const ROAM_LIFE_MS = 15_000

/** 1回の跳ねで飛ばす本数。2と3を交互に出して、揃いすぎないようにする */
function 本数(seed: number): number {
  return 2 + (seed % 2)
}

export interface RoamLine {
  id: number
  /** 線の色。カードの `--tile-accent` をそのまま受け取る（層は DOM を読まない） */
  accent: string
  stops: RoamStop[]
}

interface RoamState {
  lines: RoamLine[]
}

export const useRoamStore = create<RoamState>(() => ({ lines: [] }))

let 次のID = 1
const 寿命 = new Map<number, ReturnType<typeof setTimeout>>()

function 畳む(id: number): void {
  const タイマ = 寿命.get(id)
  if (タイマ !== undefined) {
    clearTimeout(タイマ)
    寿命.delete(id)
  }
  useRoamStore.setState((state) => ({
    lines: state.lines.filter((line) => line.id !== id),
  }))
}

/** OS が「動きを減らす」と言っているか。**言っていれば1本も出さない** */
function 減らす(): boolean {
  // jsdom には `matchMedia` が無いことがある。**無いことを「減らせ」と読まない**
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface RoamSeed {
  rect: { left: number; top: number; width: number }
  accent: string
  quiet: MotionQuiet
}

/**
 * 跳ねたカードから線を放つ。
 *
 * **「控えめ」でも飛ばさない**（利用者の指定・2026-08-26）。「控えめ」は仕様上
 * 作業中の回転だけを止める段で、承認待ちの跳ねは残る——つまりカードは跳ね続けるが、
 * **画面を横切る線だけが止まる**。画面じゅうを飛び回る動きは、いちばん静めたいものに
 * あたるため。
 *
 * 「静止」と OS 設定では、そもそも跳ねが止まっていて**この関数が呼ばれない**（呼び元が
 * CSS アニメーションの折り返しなので、`animation: none` だと鳴らない）。ここで見るのは
 * 保険である。
 */
export function emitRoam(seed: RoamSeed): void {
  if (seed.quiet !== 'lively') return
  if (減らす()) return

  const 空き = ROAM_MAX - useRoamStore.getState().lines.length
  const 欲しい = 本数(次のID)

  // **空きに応じて減らす。** 満杯のときだけ最古を1本落として1本だけ出す——
  // 新しいほうを捨てると「このカードだけ線が出ない」と読めてしまい、跳ねと線の
  // 対応が崩れて不具合に見える
  const 出す = 空き >= 欲しい ? 欲しい : Math.max(1, 空き)
  const 落とす = Math.max(0, 出す - 空き)
  for (let i = 0; i < 落とす; i += 1) {
    const 最古 = useRoamStore.getState().lines[0]
    if (最古 === undefined) break
    畳む(最古.id)
  }

  const viewport = {
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  }

  const 足す: RoamLine[] = []
  for (let i = 0; i < 出す; i += 1) {
    const id = 次のID
    次のID += 1
    足す.push({ id, accent: seed.accent, stops: planRoute(seed.rect, viewport, id) })
    寿命.set(
      id,
      setTimeout(() => 畳む(id), ROAM_LIFE_MS),
    )
  }

  useRoamStore.setState((state) => ({ lines: [...state.lines, ...足す] }))
}

/** テストが状態を持ち越さないようにする。**製品コードからは呼ばない** */
export function resetRoam(): void {
  for (const タイマ of 寿命.values()) {
    clearTimeout(タイマ)
  }
  寿命.clear()
  次のID = 1
  useRoamStore.setState({ lines: [] })
}
