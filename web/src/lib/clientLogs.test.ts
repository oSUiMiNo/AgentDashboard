import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flush,
  flushOnLeave,
  installClientLogs,
  reactErrorHandlers,
  report,
  resetClientLogs,
} from '@/lib/clientLogs'

interface 送った {
  url: string
  init?: RequestInit
}

let 送信: 送った[]
let 失敗させる: boolean
/** サーバが**受け取らない**（4xx/5xx）。`fetch` は reject しないので `ok` にしか出ない */
let 断らせる: boolean
let ビーコン: string[]
/** `sendBeacon` の戻り値。キュー一杯・64 KiB 超・実装無しを作る */
let ビーコンを通す: boolean

function 本文(at = 0): { entries: Record<string, unknown>[]; dropped: number } {
  return JSON.parse(String(送信[at].init?.body)) as {
    entries: Record<string, unknown>[]
    dropped: number
  }
}

beforeEach(() => {
  resetClientLogs()
  送信 = []
  失敗させる = false
  断らせる = false
  ビーコン = []
  ビーコンを通す = true
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    送信.push({ url, init })
    if (失敗させる) {
      throw new Error('繋がりません')
    }
    if (断らせる) {
      return { ok: false, status: 413 } as Response
    }
    return { ok: true, status: 204 } as Response
  })
  vi.stubGlobal('navigator', {
    sendBeacon: (_url: string, body: Blob) => {
      // jsdom には `sendBeacon` が無いので、ここで補う
      ビーコン.push(String((body as unknown as { __text?: string }).__text ?? ''))
      return ビーコンを通す
    },
  })
  // `Blob.text()` は非同期なので、同期に読める印を持たせておく
  vi.stubGlobal(
    'Blob',
    class {
      __text: string
      constructor(parts: string[]) {
        this.__text = parts.join('')
      }
    },
  )
})

afterEach(() => {
  resetClientLogs()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('まとめて送る', () => {
  it('1秒ぶんを1回にまとめる', async () => {
    report('unhandled', 'ERROR', '1件目')
    report('unhandled', 'ERROR', '2件目')
    expect(送信).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(送信).toHaveLength(1)
    expect(送信[0].url).toBe('/api/client-logs')
    expect(本文().entries.map((entry) => entry.msg)).toEqual(['1件目', '2件目'])
  })

  it('タブが閉じかけていても送り切る指定を付ける', async () => {
    report('unhandled', 'ERROR', 'keepalive の検査')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(送信[0].init?.keepalive).toBe(true)
  })

  it('溜まっていなければ何も送らない', async () => {
    await vi.advanceTimersByTimeAsync(5_000)
    expect(送信).toHaveLength(0)
  })
})

describe('送れなかったとき', () => {
  it('失敗そのものはログにせず、次に成功したとき一緒に送る', async () => {
    失敗させる = true
    report('unhandled', 'ERROR', '落ちた便')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(送信).toHaveLength(1)

    // **送信の失敗を拾って送信する輪ができていないこと。**
    // 失敗のたびに1件積むなら、次の便は2件になる
    失敗させる = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(送信).toHaveLength(2)
    expect(本文(1).entries.map((entry) => entry.msg)).toEqual(['落ちた便'])
  })

  it('サーバが断ったら、成功扱いにせず積み直す', async () => {
    // `fetch` はネットワーク障害でしか reject しない。413 や 400 は `ok` にしか
    // 出ないので、見なければ**行も `dropped` も黙って消える**
    断らせる = true
    report('unhandled', 'ERROR', '断られた便')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(送信).toHaveLength(1)

    断らせる = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(送信).toHaveLength(2)
    expect(本文(1).entries.map((entry) => entry.msg)).toEqual(['断られた便'])
  })

  it('リングが溢れたら捨てた件数が残る', async () => {
    // 溜められるのは64件。65件目で1件こぼれる
    for (let index = 0; index < 70; index += 1) {
      report('unhandled', 'ERROR', `件 ${index}`)
    }
    await vi.advanceTimersByTimeAsync(1_000)

    expect(本文().dropped).toBe(6)
    // 残ったのは新しい側
    expect(本文().entries[0].msg).toBe('件 6')
  })
})

describe('上限', () => {
  it('1リクエストの件数を超えたぶんは次の便へ回る', async () => {
    for (let index = 0; index < 40; index += 1) {
      report('unhandled', 'ERROR', `件 ${index}`)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(本文().entries).toHaveLength(32)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(本文(1).entries).toHaveLength(8)
  })

  it('大きすぎる1件は切って、切ったことを欄に残す', async () => {
    report('unhandled', 'ERROR', '本文', { stack: 'x'.repeat(100_000) })
    await vi.advanceTimersByTimeAsync(1_000)

    const entry = 本文().entries[0]
    expect(entry.truncated).toBe(true)
    expect(entry.msg).toBe('本文')
    expect(String(entry.stack).length).toBeLessThan(8 * 1024)
  })
})

describe('測り方', () => {
  it('サーバと同じ UTF-8 のバイトで測る', async () => {
    // `.length` は UTF-16 の符号単位を数える。日本語は1文字が UTF-16 で1、
    // UTF-8 で3なので、手元で通してサーバの上限を超える行ができていた
    const 日本語 = 'あ'.repeat(4_000) // UTF-16 で 4,000 ／ UTF-8 で 12,000
    report('unhandled', 'ERROR', 日本語)
    await vi.advanceTimersByTimeAsync(1_000)

    const entry = 本文().entries[0]
    expect(entry.truncated).toBe(true)
    const バイト数 = new TextEncoder().encode(String(entry.msg)).length
    expect(バイト数).toBeLessThanOrEqual(8 * 1024)
  })

  it('サロゲートペアを割らない', async () => {
    // 割れた片割れは単独では正しい文字ではなく、サーバの JSON 解釈が拒む
    // **予算は奇数バイトになる**（1件の上限から、本文以外のぶんを引いた残り）。
    // UTF-16 の単位で同じ数だけ切ると、対の途中に落ちる
    const 絵文字 = '🐈'.repeat(8_000)
    report('unhandled', 'ERROR', 絵文字)
    await vi.advanceTimersByTimeAsync(1_000)

    const msg = String(本文().entries[0].msg)
    expect(msg).not.toMatch(/[\uD800-\uDFFF]/u)
    expect([...msg].every((ch) => ch === '🐈')).toBe(true)
  })
})

describe('拾うもの', () => {
  it('未捕捉のエラーと未処理の拒否を拾う', async () => {
    installClientLogs()

    window.dispatchEvent(
      new ErrorEvent('error', { message: '未捕捉です', error: new Error('未捕捉です') }),
    )
    // jsdom は `PromiseRejectionEvent` を持たないので、素の Event に理由を載せる
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown }
    rejection.reason = new Error('拒否されました')
    window.dispatchEvent(rejection)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(本文().entries.map((entry) => entry.kind)).toEqual(['unhandled', 'rejection'])
    expect(本文().entries[1].msg).toBe('拒否されました')
  })

  it('React の3つを拾う', async () => {
    const handlers = reactErrorHandlers()
    handlers.onUncaughtError(new Error('未捕捉'))
    handlers.onCaughtError(new Error('捕捉済み'))
    handlers.onRecoverableError(new Error('回復可能'))

    await vi.advanceTimersByTimeAsync(1_000)

    expect(本文().entries.map((entry) => entry.kind)).toEqual([
      'react_uncaught',
      'react_caught',
      'react_recoverable',
    ])
    // **未捕捉だけが ERROR。** 全部 ERROR にすると、本当に困っている行が埋もれる
    expect(本文().entries.map((entry) => entry.level)).toEqual(['ERROR', 'WARN', 'WARN'])
  })

  it('console を拾わない', async () => {
    installClientLogs()
    // 拾っていたら、これだけで1件積まれる（そして送信の失敗を拾う輪ができる）。
    // **ここは `console` を書くことが検査の中身**なので、この1行だけ規則を外す
    // oxlint-disable-next-line no-console
    console.error('これは拾わない')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(送信).toHaveLength(0)

    // **肯定側の裏取り。** 「何も送られない」だけだと、拾う口が据わっていなくても通る。
    // 同じ据え付けで本物のエラーは拾えることまで見て、初めて「console だけ拾っていない」
    // と言える
    window.dispatchEvent(new ErrorEvent('error', { message: 'こちらは拾う' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(本文().entries.map((entry) => entry.msg)).toEqual(['こちらは拾う'])
  })
})

describe('画面を離れるとき', () => {
  it('ビーコンへ切り替える', () => {
    report('unhandled', 'ERROR', '離脱の検査')
    flushOnLeave()

    expect(送信).toHaveLength(0)
    expect(ビーコン).toHaveLength(1)
    expect(JSON.parse(ビーコン[0]).entries[0].msg).toBe('離脱の検査')
  })

  it('持ち出せなかったぶんも件数として伝える', () => {
    // 1回で持ち出せるのは32件。**次が無いので、残りをここで数えなければ
    // どこにも残らない**
    for (let index = 0; index < 50; index += 1) {
      report('unhandled', 'ERROR', `件 ${index}`)
    }
    flushOnLeave()

    const 本体 = JSON.parse(ビーコン[0]) as { entries: unknown[]; dropped: number }
    expect(本体.entries).toHaveLength(32)
    expect(本体.dropped).toBe(50 - 32)
  })

  it('送れていないなら消費しない', async () => {
    // `sendBeacon` はキュー一杯・64 KiB 超で `false` を返し、そもそも実装が無い
    // 環境もある。`pagehide` は bfcache から戻ることがあるので、戻れたときに
    // 次の便へ載せられる形で残す
    ビーコンを通す = false
    report('unhandled', 'ERROR', '戻ってきたら送る')
    flushOnLeave()
    expect(ビーコン).toHaveLength(1)

    // 戻ってきた体で、次の便を流す
    await flush()
    expect(送信).toHaveLength(1)
    expect(本文().entries.map((entry) => entry.msg)).toEqual(['戻ってきたら送る'])
  })
})

describe('いま開いている画面', () => {
  it('セッション画面なら card_id が載る', async () => {
    window.history.pushState({}, '', '/s/075b83fa-0000-0000-0000-000000000000')
    report('ws_close', 'WARN', '切れました')
    await flush()

    expect(本文().entries[0].card_id).toBe('075b83fa-0000-0000-0000-000000000000')
    expect(本文().entries[0].url).toBe('/s/075b83fa-0000-0000-0000-000000000000')
  })

  it('一覧なら card_id は載らない', async () => {
    window.history.pushState({}, '', '/')
    report('ws_error', 'ERROR', '繋がりません')
    await flush()

    expect(本文().entries[0].card_id).toBeUndefined()
  })
})
