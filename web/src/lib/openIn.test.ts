/**
 * エクスプローラ・VSCode で開く口の取得口（サイドバーにエクスプローラで開くボタンが欲しい
 * 設計§7-6・テスト計画フェーズ5）。
 *
 * **「口が無い（null）」と「一時的に聞けなかった（failed）」を分けて見る。** 混ぜると、
 * 一度の瞬断でそのサイドバーではボタンが二度と出なくなる。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FAILED,
  SIGNED_OUT,
  fetchOpenIn,
  postOpenIn,
  type OpenInView,
} from '@/lib/openIn'
import { useAuthStore } from '@/stores/auth'

const VIEW: OpenInView = {
  same_machine: true,
  same_machine_reason: null,
  explorer: { available: true, reason: null },
  vscode: { available: true, reason: null },
  opened: [{ path: '/home/me/dev/app', kind: 'dir', since_ms: 1 }],
}

function 答える(response: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async () => await response())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fetchOpenIn', () => {
  it('401 なら signed-out を返し、ログイン切れを知らせる', async () => {
    const markSignedOut = vi.fn()
    vi.spyOn(useAuthStore, 'getState').mockReturnValue({
      ...useAuthStore.getState(),
      markSignedOut,
    })
    答える(() => new Response('', { status: 401 }))
    expect(await fetchOpenIn('local')).toBe(SIGNED_OUT)
    expect(markSignedOut).toHaveBeenCalledTimes(1)
  })

  it.each([501, 404, 405])('%s なら null（口が無い）', async (status) => {
    答える(() => new Response('なし', { status }))
    expect(await fetchOpenIn('local')).toBeNull()
  })

  it('200 でも本文が HTML なら null', async () => {
    答える(
      () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    )
    expect(await fetchOpenIn('local')).toBeNull()
  })

  it('200 でも形が違えば null', async () => {
    // 一覧の口の答え（`useFilesParts.test.tsx` の偽物が返す形）
    答える(
      () =>
        new Response(
          JSON.stringify({ path: '/x', entries: [], truncated: false }),
          { status: 200 },
        ),
    )
    expect(await fetchOpenIn('local')).toBeNull()
  })

  it('線が切れたら failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await fetchOpenIn('local')).toBe(FAILED)
  })

  it('500 なら failed', async () => {
    答える(() => new Response('oops', { status: 500 }))
    expect(await fetchOpenIn('local')).toBe(FAILED)
  })

  it('形の合う答えはそのまま返る', async () => {
    const fetchMock = 答える(
      () => new Response(JSON.stringify(VIEW), { status: 200 }),
    )
    expect(await fetchOpenIn('local')).toEqual(VIEW)
    expect(fetchMock).toHaveBeenCalledWith('/api/hosts/local/open')
  })
})

describe('postOpenIn', () => {
  it('POST は content-type に application/json を付けて送る', async () => {
    const fetchMock = 答える(
      () =>
        new Response(JSON.stringify({ outcome: 'launched', view: VIEW }), {
          status: 200,
        }),
    )
    await postOpenIn('local', 'explorer', '/home/me/dev/app')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe('/api/hosts/local/open')
    expect(init.method).toBe('POST')
    expect(
      (init.headers as Record<string, string>)['content-type'],
      'JSON でない体はサーバが 415 で断る（CSRF の門）',
    ).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      app: 'explorer',
      path: '/home/me/dev/app',
    })
  })

  it('POST の断りは本文がそのまま message に出る', async () => {
    const 断り =
      'このブラウザは親PC の上で開かれていないので、窓を開けません。親PC では localhost で開いてください'
    答える(() => new Response(断り, { status: 403 }))
    expect(await postOpenIn('local', 'vscode', '/x')).toEqual({
      ok: false,
      message: 断り,
    })
  })

  it('POST が成功したら outcome と view を返す', async () => {
    答える(
      () =>
        new Response(JSON.stringify({ outcome: 'opened', view: VIEW }), {
          status: 200,
        }),
    )
    expect(await postOpenIn('local', 'vscode', '/home/me/dev/app')).toEqual({
      ok: true,
      result: { outcome: 'opened', view: VIEW },
    })
  })

  it('起こしている最中（starting）の答えも成功として返す', async () => {
    答える(
      () =>
        new Response(JSON.stringify({ outcome: 'starting', view: VIEW }), {
          status: 200,
        }),
    )
    expect(await postOpenIn('local', 'vscode', '/home/me/dev/app')).toEqual({
      ok: true,
      result: { outcome: 'starting', view: VIEW },
    })
  })

  it('線が切れたら ok:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const r = await postOpenIn('local', 'vscode', '/x')
    expect(r.ok).toBe(false)
  })
})
