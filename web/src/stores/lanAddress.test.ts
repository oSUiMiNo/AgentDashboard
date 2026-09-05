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
  isPrivateIpv4,
  type LanAddressView,
} from '@/stores/lanAddress'

/** サーバが返した推定1件ぶんの雛形。 */
function view(取り込み: Partial<LanAddressView> = {}): LanAddressView {
  return {
    port: 8787,
    bind_addr: '0.0.0.0',
    reachable: true,
    candidates: [{ addr: '192.168.0.12', label: 'Wi-Fi', source: 'windows' }],
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

describe('家の中の IPv4 の見分け', () => {
  it('3つの帯を私用とみなす', () => {
    expect(isPrivateIpv4('10.0.0.1')).toBe(true)
    expect(isPrivateIpv4('192.168.144.1')).toBe(true)
    expect(isPrivateIpv4('172.16.0.1')).toBe(true)
    expect(isPrivateIpv4('172.31.255.254')).toBe(true)
  })

  it('`172.` の外側は私用ではない（前方一致で判定しない）', () => {
    // **`172.` で始まるだけでは私用ではない。** ここを前方一致で書くと、
    // 公開アドレスをサーバの管轄と誤認して候補から落とす
    expect(isPrivateIpv4('172.15.0.1')).toBe(false)
    expect(isPrivateIpv4('172.32.0.1')).toBe(false)
  })

  it('番号でないものは私用ではない（名前はサーバの管轄外）', () => {
    expect(isPrivateIpv4('dash.example.com')).toBe(false)
    expect(isPrivateIpv4('192.168.0')).toBe(false)
    expect(isPrivateIpv4('999.1.1.1')).toBe(false)
  })

  it('トンネル由来の帯（CGNAT）は私用ではない', () => {
    expect(isPrivateIpv4('100.101.2.3')).toBe(false)
  })
})

describe('候補の並び', () => {
  it('裏が取れた「いま開いているアドレス」が先頭に来る', () => {
    // **裏が取れる＝サーバも同じ番号を数え上げている**こと。scheme を保つため
    // `self` 側を採る（前段越しの `https` を `http` へ落とさない）
    const 並び = buildCandidates(
      view(),
      'http://192.168.0.12:8787',
      '192.168.0.12',
    )

    expect(並び[0]?.source).toBe('self')
    expect(並び[0]?.url).toBe('http://192.168.0.12:8787/')
  })

  it('裏が取れたとき、同じ番号を二度出さない', () => {
    const 並び = buildCandidates(
      view(),
      'http://192.168.0.12:8787',
      '192.168.0.12',
    )

    expect(並び).toHaveLength(1)
  })

  it('サーバが数え上げていない私用 IPv4 は、いま開いていても出さない', () => {
    // **これがこの機能で最初に踏んだ穴である**（2026-09-05・利用者の実機）。
    // WSL の仮想スイッチ `192.168.144.1` で画面を開いていたため、**PC からしか
    // 届かない番号**が「いま開いているアドレス」として筆頭に出ていた。
    // サーバは規則5で正しく捨てていたのに、画面が後から足して濾過を迂回していた
    const 並び = buildCandidates(
      view(),
      'http://192.168.144.1:8787',
      '192.168.144.1',
    )

    expect(並び.every((c) => c.source !== 'self')).toBe(true)
    expect(並び.map((c) => c.url)).toEqual(['http://192.168.0.12:8787/'])
  })

  it('名前で開いているときは、載っていなくても落とさない', () => {
    // **サーバの管轄外**（あちらが数えるのは私用 IPv4 だけ）。前段越しの `https` は
    // ここに来るので、落とすと**外から届く唯一の候補**を消すことになる
    const 並び = buildCandidates(
      view(),
      'https://dash.example.com',
      'dash.example.com',
    )

    expect(並び[0]?.source).toBe('self')
    expect(並び[0]?.url).toBe('https://dash.example.com/')
  })

  it('私用ではない番号（トンネル等）も落とさない', () => {
    // `100.64/10` は CGNAT で私用ではない。**私用 IPv4 だけがサーバの管轄**である
    const 並び = buildCandidates(view(), 'http://100.101.2.3:8787', '100.101.2.3')

    expect(並び[0]?.source).toBe('self')
  })

  it('サーバがまだ答えていなければ、否定する材料が無いので落とさない', () => {
    // **否定されたことと、否定する材料が無いことは違う**
    const 並び = buildCandidates(null, 'http://192.168.144.1:8787', '192.168.144.1')

    expect(並び[0]?.source).toBe('self')
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

    expect(並び[0]?.url).toBe('http://192.168.0.12:8787/')
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

    expect(並び[0]?.url).toBe('http://192.168.0.12:9000/')
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
