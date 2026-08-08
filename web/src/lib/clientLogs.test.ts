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
let ビーコン: string[]

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
  ビーコン = []
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    送信.push({ url, init })
    if (失敗させる) {
      throw new Error('繋がりません')
    }
    return { ok: true, status: 204 } as Response
  })
  vi.stubGlobal('navigator', {
    sendBeacon: (_url: string, body: Blob) => {
      // jsdom には `sendBeacon` が無いので、ここで補う
      ビーコン.push(String((body as unknown as { __text?: string }).__text ?? ''))
      return true
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
