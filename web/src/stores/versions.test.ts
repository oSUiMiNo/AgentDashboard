import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isNewer, useVersionsStore, type VersionsView } from '@/stores/versions'

const EMPTY = useVersionsStore.getState().versions

/** サーバの応答をひとまとめに作る。 */
function view(overrides: Partial<VersionsView> = {}): VersionsView {
  return {
    supported: true,
    editable: true,
    entries: [],
    selected: null,
    outcome: null,
    latest: null,
    stranded_cards: 0,
    zombie_children: null,
    install: null,
    install_unavailable: null,
    pointer_path: '/tmp/使い捨て/version-current',
    running: '9.9.9',
    binary_at: 1_700_000_000_000,
    started_at: 1_700_000_100_000,
    ...overrides,
  }
}

beforeEach(() => {
  useVersionsStore.setState({
    versions: EMPTY,
    loading: true,
    busy: false,
    lastError: null,
    unverified: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('版のストア', () => {
  it('サーバから読んだ一覧で作り直す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(view({ selected: '0.2.0' })), {
            status: 200,
          }),
      ),
    )

    await useVersionsStore.getState().load()

    expect(useVersionsStore.getState().versions.selected).toBe('0.2.0')
    expect(useVersionsStore.getState().loading).toBe(false)
  })

  it('読めなくても何もできない側のまま出す', async () => {
    // 読めていない間に押せる顔をすると、実際には断られる操作をボタンとして見せる
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('繋がりません')
      }),
    )

    await useVersionsStore.getState().load()

    expect(useVersionsStore.getState().versions.supported).toBe(false)
    expect(useVersionsStore.getState().versions.editable).toBe(false)
  })

  it('選ぶと予約になり、応答で手元を作り直す', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(view({ selected: '0.2.0' })), {
          status: 200,
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const ok = await useVersionsStore.getState().select('0.2.0')

    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/versions/selected')
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe('{"version":"0.2.0","confirm_unverified":false}')
    expect(useVersionsStore.getState().versions.selected).toBe('0.2.0')
  })

  it('確かめられないときは断らずに同意を求める', async () => {
    // **428 は「断った」ではない。** 同意すれば進める道が残っている（設計§9）
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('この版は記録の形を答えられません', { status: 428 }),
      ),
    )

    const ok = await useVersionsStore.getState().select('0.1.0')

    expect(ok).toBe(false)
    expect(useVersionsStore.getState().unverified).toEqual({
      version: '0.1.0',
      reason: 'この版は記録の形を答えられません',
    })
    // 断りとして扱うと、いちばん戻りたい先へ永久に戻れなくなる
    expect(useVersionsStore.getState().lastError).toBeNull()
  })

  it('断られたら黙らずに理由を残す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('選べません: 3本揃っていません', { status: 409 })),
    )

    const ok = await useVersionsStore.getState().select('0.2.0')

    expect(ok).toBe(false)
    expect(useVersionsStore.getState().lastError).toBe(
      '選べません: 3本揃っていません',
    )
  })
})

describe('版の大小', () => {
  it('3つ組で比べる', () => {
    // 素の文字列比較だと 0.10.0 < 0.9.0 になる
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
  })

  it('同じ版は新しくない', () => {
    expect(isNewer('0.1.1', '0.1.1')).toBe(false)
  })

  it('読めない版は比べない', () => {
    // 比べられないことと選べないことは別（設計§2）
    expect(isNewer('nightly', '0.1.1')).toBe(false)
    expect(isNewer('0.2.0', '不明')).toBe(false)
  })
})
