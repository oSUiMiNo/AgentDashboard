import { useSettingsStore } from './settings'

/**
 * 設定ストア（テスト計画フェーズ5「設定」）。
 *
 * 保存先が**サーバ**であることがこの機能の要点なので、「サーバへ書きにいくこと」と
 * 「サーバの応答で手元を作り直すこと」を固定する。ブラウザに持つと別のタブで
 * 食い違う（設計§8）。
 */

const INITIAL = useSettingsStore.getState().settings

beforeEach(() => {
  useSettingsStore.setState({
    settings: INITIAL,
    loading: true,
    lastError: null,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('設定ストア', () => {
  it('サーバから読んだ値で作り直す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              always_bypass_permissions: true,
              available_modes: ['default', 'bypassPermissions'],
            }),
            { status: 200 },
          ),
      ),
    )

    await useSettingsStore.getState().load()

    expect(fetch).toHaveBeenCalledWith('/api/settings')
    expect(useSettingsStore.getState().settings.always_bypass_permissions).toBe(
      true,
    )
    expect(useSettingsStore.getState().loading).toBe(false)
  })

  it('読めなくても既定値のまま動く', async () => {
    // サーバが居なくても画面は出す。既定は**スキップしない側**（設計§9）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('繋がらない')
      }),
    )

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().settings.always_bypass_permissions).toBe(
      false,
    )
    expect(useSettingsStore.getState().loading).toBe(false)
  })

  it('トグルはサーバへ書きにいき、応答で手元を作り直す', async () => {
    // 引数の型を明示する。省略すると mock.calls の要素が空タプルとして推論され、
    // 「何を送ったか」を型どおりには読めなくなる
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            always_bypass_permissions: true,
            available_modes: ['default'],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await useSettingsStore.getState().setAlwaysBypassPermissions(true)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/settings')
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe('{"always_bypass_permissions":true}')
    expect(useSettingsStore.getState().settings.always_bypass_permissions).toBe(
      true,
    )
  })

  it('保存に失敗したら黙らずに理由を残す', async () => {
    // 黙って戻ると「変えたのに効かない」という追いにくい状態になる
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('書き込めません', { status: 500 })),
    )

    await useSettingsStore.getState().setAlwaysBypassPermissions(true)

    expect(useSettingsStore.getState().lastError).toContain('保存できません')
    expect(useSettingsStore.getState().settings.always_bypass_permissions).toBe(
      false,
    )
  })
})
