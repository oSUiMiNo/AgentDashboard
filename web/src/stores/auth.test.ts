import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore, type AuthView } from '@/stores/auth'

/**
 * 入口の状態と、**画面より新しいサーバに気づく仕掛け**（CICD設計§11）。
 *
 * ここが見ているのは `load()` の版比較の4性質である。**この4つは、版が切り替わったら
 * タブが自分で読み直す仕掛けの土台**になっており、とくに「初回は立たない」は
 * **読み直しが輪にならない根拠そのもの**——読み直すとページごと作り直されて `version` が
 * `undefined` から始まるので、そこで印が立たないことが「読み直しは一度きり」を意味する。
 *
 * # 初期値はモジュール読み込み時に控えて戻す
 *
 * 暫定値（`UNKNOWN`）は export されていないので、`versions.test.ts` と同じく最初の状態を
 * 控えておき `beforeEach` で戻す。ストアはモジュールに1つなので、前のテストで立った印が
 * 残ると、以降が「聞く前から立っている」状態で通ってしまう。
 */

const 初期 = useAuthStore.getState().auth

/** `GET /api/me` の応答をひとまとめに作る。 */
function me(overrides: Partial<AuthView> = {}): AuthView {
  return {
    mode: 'open',
    authenticated: true,
    account: null,
    is_admin: false,
    setup_open: false,
    from_loopback: true,
    ...overrides,
  }
}

/** 次に `load()` が受け取る応答を決める。 */
function 応答(auth: AuthView) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(auth)))),
  )
}

/** その応答で1回聞く。 */
async function 聞く(auth: AuthView) {
  応答(auth)
  await useAuthStore.getState().load()
}

const 印 = () => useAuthStore.getState().serverChanged

beforeEach(() => {
  useAuthStore.setState({
    auth: 初期,
    loading: true,
    lastError: null,
    serverChanged: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('画面より新しいサーバに気づく', () => {
  /**
   * **輪止めそのもの。** 読み直した先ではストアが作り直されてここへ戻るので、
   * この1本が「読み直しは一度きり」を担保している。
   */
  it('初めて版を聞いた時点では、印は立たない', async () => {
    await 聞く(me({ version: '0.1.80' }))

    expect(印()).toBe(false)
  })

  it('知っていた版と違う版が返ると、印が立つ', async () => {
    await 聞く(me({ version: '0.1.80' }))

    await 聞く(me({ version: '0.1.81' }))

    expect(印()).toBe(true)
  })

  it('同じ版を何度聞いても、印は立たない', async () => {
    await 聞く(me({ version: '0.1.80' }))

    await 聞く(me({ version: '0.1.80' }))
    await 聞く(me({ version: '0.1.80' }))

    expect(印()).toBe(false)
  })

  /**
   * 版を返さないのは、この仕掛けより前のサーバ（`0.1.1` 以前）である。
   * **比べる相手が無いので立てない**——立てると、古いサーバへ繋いだだけで
   * 読み直しが走る。
   */
  it('版を返さないサーバでは、印は立たない', async () => {
    await 聞く(me({ version: '0.1.80' }))

    await 聞く(me())

    expect(印()).toBe(false)
  })

  /**
   * 印は掛け金で、**降ろす口はリポジトリに1つも無い**。降ろせるようにすると、
   * 「気づいたのに、次の応答で無かったことになる」形を作れてしまう。
   */
  it('一度立った印は、そのあと同じ版を聞いても降りない', async () => {
    await 聞く(me({ version: '0.1.80' }))
    await 聞く(me({ version: '0.1.81' }))

    await 聞く(me({ version: '0.1.81' }))

    expect(印()).toBe(true)
  })
})
