/**
 * 機械の触り方を見る（設計§9）。
 *
 * 十字ボタンを出すのは**指で触る端末のときだけ**なので、そこを見分ける口が要る。
 * 置き場所と作りは `lib/sessions.ts` の `useNow` に揃えてある——React の外に持ち、
 * 各自が購読する。親が持って配ると、親ごと再描画されるため。
 *
 * # 画面幅では判定しない
 *
 * タッチ対応 PC・折りたたみ・iPad があるので、幅は入力方式の代わりにならない。
 * `any-pointer` も使わない（マウス付きタブレットで両方立つ）。
 * `navigator.userAgentData.mobile` も使わない（Safari 非対応）。
 *
 * # 途中で変わる
 *
 * 入力方式も向きも、動かしている最中に変わる（Bluetooth キーボードを繋ぐ・端末を回す）。
 * だから一度読んで終わりにせず、`change` を購読する。
 *
 * # 最後の1人が離れたら片付ける
 *
 * `useNow` がタイマーを畳むのと同じ理由で、購読者が居なくなったら問い合わせも捨てる。
 * **副産物として、テストごとに `matchMedia` のスタブを差し替えられる**——次のテストは
 * 新しいスタブで作り直すので、製品コードにテスト専用の口を作らずに済む。
 */

import { useCallback, useSyncExternalStore } from 'react'

/** 指で触る端末か。**粗いポインタで、かつ重ねられない**ことの両方を要求する。 */
const COARSE = '(pointer: coarse) and (hover: none)'

/** 横に持っているか。 */
const LANDSCAPE = '(orientation: landscape)'

interface Entry {
  list: MediaQueryList
  listeners: Set<() => void>
  value: boolean
  onChange: () => void
}

const entries = new Map<string, Entry>()

const noop = () => {}

/** いまの答え。購読していない間も読めるように、その場で問い合わせる。 */
function read(query: string): boolean {
  const entry = entries.get(query)
  if (entry) {
    return entry.value
  }
  try {
    return globalThis.matchMedia?.(query).matches ?? false
  } catch {
    // 問い合わせられない環境（古いブラウザ・テストの素の jsdom）。PC として振る舞う
    return false
  }
}

/**
 * 変化の購読を張る。**張れたかどうか**を返す。
 *
 * 口は2通りあり、古い実装は後者しか持たない（`addListener` は Safari 14 より前）。
 * どちらも無ければ張らない——**そのときも `matches` は読めている**ので、値は正しいまま
 * 追随だけができなくなる。
 */
function subscribeChange(entry: Entry): boolean {
  const list = entry.list as MediaQueryList & {
    addListener?: (listener: () => void) => void
  }
  try {
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', entry.onChange)
      return true
    }
    if (typeof list.addListener === 'function') {
      list.addListener(entry.onChange)
      return true
    }
  } catch {
    // 持っているのに落ちる実装もある。張れなかったものとして扱う
  }
  return false
}

/** 購読を外す。**張った側と同じ口**で外す。 */
function unsubscribeChange(entry: Entry): void {
  const list = entry.list as MediaQueryList & {
    removeListener?: (listener: () => void) => void
  }
  try {
    if (typeof list.removeEventListener === 'function') {
      list.removeEventListener('change', entry.onChange)
      return
    }
    list.removeListener?.(entry.onChange)
  } catch {
    // 外せなくても、こちらの表からは落とす
  }
}

function subscribe(query: string, listener: () => void): () => void {
  let entry = entries.get(query)
  if (!entry) {
    let list: MediaQueryList | undefined
    try {
      list = globalThis.matchMedia?.(query)
    } catch {
      list = undefined
    }
    if (!list) {
      // 問い合わせられないなら、変わることも無い。購読を持たない
      return noop
    }
    const created: Entry = {
      list,
      listeners: new Set(),
      value: list.matches,
      onChange: () => {
        created.value = created.list.matches
        for (const each of created.listeners) {
          each()
        }
      },
    }
    // **読む側と同じだけ守る。** `addEventListener` を持たない実装（古い Safari の
    // `addListener` だけのもの・一部の WebView・部分的なテストスタブ）だと、ここで
    // 例外が飛ぶ。**飛ぶ先は `useSyncExternalStore` の購読の中**なので、
    // セッション画面ごと落ちる——読む側だけ `try` で守っていたので、片側だけが素通しだった
    //
    // **値まで偽らない。** 購読できないことと、いまが粗いポインタかどうかは別の話で、
    // `matches` は古い実装でも読める。ここで「PC ということにする」と、
    // **古い Safari から十字が丸ごと消える**——`addListener` へ落とせば追随もできる
    if (!subscribeChange(created)) {
      // どちらの口も無い。**変化を知る手段が無いだけ**で、いまの値は読めている
      return noop
    }
    entries.set(query, created)
    entry = created
  }
  const found = entry
  found.listeners.add(listener)
  return () => {
    found.listeners.delete(listener)
    if (found.listeners.size === 0) {
      unsubscribeChange(found)
      entries.delete(query)
    }
  }
}

function useMediaQuery(query: string): boolean {
  const on = useCallback(
    (listener: () => void) => subscribe(query, listener),
    [query],
  )
  const get = useCallback(() => read(query), [query])
  return useSyncExternalStore(on, get, () => false)
}

/** 指で触る端末か（設計§9）。**十字ボタンを出す条件の1つ目。** */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE)
}

/** 横に持っているか（設計§10）。置き方を変えるのに使う。 */
export function useLandscape(): boolean {
  return useMediaQuery(LANDSCAPE)
}
