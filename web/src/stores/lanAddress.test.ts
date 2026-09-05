/**
 * 候補の組み立て（設計§4-6・§3）。
 *
 * **ここは純関数だけを見る。** 押したときの振る舞いは
 * `components/LanAddress/LanAddressButton.test.tsx` が受け持つ。
 */

import { describe, expect, it } from 'vitest'
import {
  SELF_LABEL,
  buildCandidates,
  isLoopbackHost,
  type LanAddressView,
} from '@/stores/lanAddress'

/** サーバが返した推定1件ぶんの雛形。 */
function view(取り込み: Partial<LanAddressView> = {}): LanAddressView {
  return {
    port: 8787,
    bind_addr: '0.0.0.0',
    reachable: true,
    candidates: [{ addr: '10.106.135.80', label: 'Wi-Fi', source: 'windows' }],
    note: null,
    ...取り込み,
  }
}

describe('ループバックの見分け', () => {
  it('host 名だけで見て、ポートは見ない', () => {
    // **ポートが付いていても host は host。** 設計§4-6 が名指しで「ポートは見ない」
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  it('127.0.0.0/8 は全部ループバック', () => {
    expect(isLoopbackHost('127.0.0.2')).toBe(true)
    expect(isLoopbackHost('127.1.2.3')).toBe(true)
  })

  it('LAN の番号はループバックではない', () => {
    expect(isLoopbackHost('192.168.0.12')).toBe(false)
    expect(isLoopbackHost('10.106.135.80')).toBe(false)
  })
})

describe('候補の並び', () => {
  it('いま開いているアドレスが先頭に来る（実測は推定に勝つ）', () => {
    const 並び = buildCandidates(
      view(),
      'http://192.168.0.12:8787',
      '192.168.0.12',
    )

    expect(並び[0]?.source).toBe('self')
    expect(並び[0]?.url).toBe('http://192.168.0.12:8787/')
  })

  it('サーバの推定と食い違っても、両方が出る（どちらも消さない）', () => {
    // 番号が変わった直後に必ず起きる形。**片方を消すと、残したほうが外れだった
    // ときに手が無くなる**
    const 並び = buildCandidates(
      view(),
      'http://192.168.0.12:8787',
      '192.168.0.12',
    )

    expect(並び).toHaveLength(2)
    expect(並び.map((c) => c.url)).toEqual([
      'http://192.168.0.12:8787/',
      'http://10.106.135.80:8787/',
    ])
  })

  it('ループバックで開いているときは、それを候補にしない', () => {
    // 配っても**相手の手元を指すだけ**で意味が無い
    const 並び = buildCandidates(view(), 'http://localhost:8787', 'localhost')

    expect(並び.every((c) => c.source !== 'self')).toBe(true)
    expect(並び).toHaveLength(1)
  })

  it('いま開いているアドレスの名乗りは「LAN のアドレス」ではない', () => {
    // 前段（トンネル等）を通していれば LAN の番号ではないので、LAN と名乗ると嘘になる
    const 並び = buildCandidates(null, 'http://192.168.0.12:8787', '192.168.0.12')

    expect(並び[0]?.label).toBe(SELF_LABEL)
    expect(並び[0]?.label).not.toContain('LAN')
  })

  it('サーバの答えが未着でも、いま開いているアドレスだけで押せる', () => {
    // `location.origin` は**同期で読める**ので、§2 の制約に対してむしろ有利に働く
    const 並び = buildCandidates(null, 'http://192.168.0.12:8787', '192.168.0.12')

    expect(並び).toHaveLength(1)
    expect(並び[0]?.url).toBe('http://192.168.0.12:8787/')
  })
})

describe('URL の形（設計§3）', () => {
  it('サーバ由来の候補は http:// から始まり、末尾が / で終わる', () => {
    const 並び = buildCandidates(view(), 'http://localhost:8787', 'localhost')

    expect(並び[0]?.url).toBe('http://10.106.135.80:8787/')
    expect(並び[0]?.url.startsWith('http://')).toBe(true)
    expect(並び[0]?.url.endsWith('/')).toBe(true)
  })

  it('self の scheme は書き換えない（https のまま出す）', () => {
    // **`http` 固定が掛かるのは linux ／ windows 由来の候補だけ**（設計§3 の例外）。
    // origin を書き換えたら、届くと分かっている唯一の候補を届かないものへ変えてしまう
    const 並び = buildCandidates(
      view(),
      'https://dash.example.com',
      'dash.example.com',
    )

    expect(並び[0]?.source).toBe('self')
    expect(並び[0]?.url).toBe('https://dash.example.com/')
  })

  it('ポートはサーバが答えた値を使う', () => {
    const 並び = buildCandidates(
      view({ port: 9000 }),
      'http://localhost:8787',
      'localhost',
    )

    expect(並び[0]?.url).toBe('http://10.106.135.80:9000/')
  })

  it('日本語のラベルもそのまま運ぶ', () => {
    const 並び = buildCandidates(
      view({
        candidates: [
          { addr: '192.168.0.12', label: 'イーサネット', source: 'windows' },
        ],
      }),
      'http://localhost:8787',
      'localhost',
    )

    expect(並び[0]?.label).toBe('イーサネット')
  })

  it('候補が空なら空のまま返す', () => {
    const 並び = buildCandidates(
      view({ candidates: [], note: 'Windows へ聞けませんでした' }),
      'http://localhost:8787',
      'localhost',
    )

    expect(並び).toEqual([])
  })
})
