import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionsCard } from '@/components/Settings/VersionsCard'
import {
  useVersionsStore,
  type VersionEntry,
  type VersionsView,
} from '@/stores/versions'

/** 一覧の1行を作る。 */
function entry(overrides: Partial<VersionEntry> = {}): VersionEntry {
  return {
    version: '0.1.1',
    origin: 'stored',
    path: '/state/versions/0.1.1/agentdashboard',
    usable: true,
    running: false,
    selected: false,
    size_bytes: 28_000_000,
    reason: null,
    ...overrides,
  }
}

/** サーバの応答を流し込む。 */
function show(overrides: Partial<VersionsView> = {}) {
  useVersionsStore.setState({
    versions: {
      supported: true,
      editable: true,
      entries: [],
      selected: null,
      outcome: null,
      latest: null,
      stranded_cards: 0,
      install: null,
      install_unavailable: null,
      // 既定と違う場所を入れておく。**決め打ちに戻っても気づけるようにするため**
      pointer_path: '/tmp/使い捨て/version-current',
      running: '9.9.9',
      binary_at: 1_700_000_000_000,
      started_at: 1_700_000_100_000,
      ...overrides,
    },
    loading: false,
    busy: false,
    lastError: null,
    unverified: null,
  })
  render(<VersionsCard />)
}

beforeEach(() => {
  // 描いた瞬間に読みに行くので、繋がらない形で塞いでおく
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('版のカード', () => {
  it('いま動いている版と次に起こす版を別々に出す', async () => {
    // 切替のあと再起動の前はこの2つがずれる。選択中の印だけだと
    // 「押しても何も起きない」ように見える（設計§14）
    show({
      entries: [
        entry({ version: '0.1.1', origin: 'installed', running: true, path: '/bin/agentdashboard' }),
        entry({ version: '0.2.0', selected: true }),
      ],
      selected: '0.2.0',
    })

    expect(await screen.findByTestId('versions-running')).toHaveTextContent('0.1.1')
    expect(screen.getByTestId('versions-picker')).toHaveValue('0.2.0')
    expect(screen.getByTestId('versions-reservation')).toHaveTextContent('0.2.0')
  })

  it('選べない版も選択肢から消さず理由を添える', async () => {
    show({
      entries: [entry({ version: '0.2.0', usable: false, reason: '3本揃っていません' })],
    })

    expect(
      await screen.findByRole('option', { name: '0.2.0（3本揃っていません）' }),
    ).toBeInTheDocument()
  })

  it('同じ版名が並んでも実パスで見分けが付く', async () => {
    // ソースからビルドした版と配った版は同じ番号を名乗るので、**開発者の機械では
    // 初日から同名の行が並ぶ**（設計§14）
    show({
      entries: [
        entry({ version: '0.1.1', path: '/state/versions/0.1.1/agentdashboard' }),
        entry({ version: '0.1.1', path: '/別の場所/0.1.1/agentdashboard' }),
      ],
    })

    const listed = await screen.findByTestId('versions-stored')
    expect(listed).toHaveTextContent('/state/versions/0.1.1/agentdashboard')
    expect(listed).toHaveTextContent('/別の場所/0.1.1/agentdashboard')
  })

  it('押す前に抜け殻になる枚数を出す', async () => {
    show({ entries: [entry({ version: '0.2.0', selected: true })], selected: '0.2.0', stranded_cards: 3 })

    expect(await screen.findByTestId('versions-stranded')).toHaveTextContent(
      '3 枚が抜け殻になります',
    )
  })

  it('失うものが無いときはそう言う', async () => {
    show({ entries: [entry({ version: '0.2.0', selected: true })], selected: '0.2.0' })

    expect(await screen.findByTestId('versions-stranded')).toHaveTextContent(
      '失われるセッションはありません',
    )
  })

  it('保管庫の使用量を出す', async () => {
    // 黙って溜まる形にしない（設計§14）
    show({ entries: [entry({ size_bytes: 28_000_000 }), entry({ path: '/b', size_bytes: 28_000_000 })] })

    expect(await screen.findByTestId('versions-usage')).toHaveTextContent('53.4 MB')
  })

  it('使えない構成では機能ごと出さず案内を出す', async () => {
    show({ supported: false })

    const card = await screen.findByTestId('versions')
    expect(card).toHaveAttribute('data-supported', 'false')
    expect(card).toHaveTextContent('compose.yml')
    expect(screen.queryByTestId('versions-picker')).not.toBeInTheDocument()
  })

  it('押せない相手には理由を出す', async () => {
    // 変えられないものを黙って並べない
    show({ editable: false, entries: [entry()] })

    expect(await screen.findByTestId('versions-readonly')).toBeInTheDocument()
    expect(screen.getByTestId('versions-picker')).toBeDisabled()
  })

  it('前回の結末を画面を開いた時点で出す', async () => {
    // 知らせにすると届かない。**繋いだ瞬間に読める状態**として持つ（設計§11）
    show({
      outcome: {
        attempted: '0.2.0',
        attempted_path: '/state/versions/0.2.0/agentdashboard',
        running: '0.1.1',
        failed_reason: '起動できませんでした',
        at: 1,
      },
    })

    expect(await screen.findByTestId('versions-outcome')).toHaveTextContent(
      '0.2.0 で起動できなかったので、0.1.1 で立ち上げました',
    )
  })

  it('走っている版より新しいときだけ取ってくる導線を出す', async () => {
    // **新着かどうかはサーバが決めない**（設計§8）
    show({
      entries: [entry({ version: '0.1.1', running: true })],
      latest: { version: '0.2.0', prerelease: false, has_artifact: true, checked_at: 1 },
    })

    expect(await screen.findByTestId('versions-update')).toHaveTextContent('0.2.0')
  })

  it('自分の機械向けの箱が無い版は勧めない', async () => {
    show({
      entries: [entry({ version: '0.1.1', running: true })],
      latest: { version: '0.2.0', prerelease: false, has_artifact: false, checked_at: 1 },
    })

    expect(screen.queryByTestId('versions-update')).not.toBeInTheDocument()
  })

  it('取ってくる仕事の段階を出す', async () => {
    show({ install: { version: '0.2.0', phase: 'installing', reason: null } })

    const progress = await screen.findByTestId('versions-install')
    expect(progress).toHaveAttribute('data-phase', 'installing')
    expect(progress).toHaveTextContent('取ってきています')
  })

  it('確かめられないときは手で戻す2行を先に見せる', async () => {
    // 戻した先には版を選ぶ画面が無い。**押す前に逃げ道を見せる**（設計§9）
    show({ entries: [entry({ version: '0.1.0' })] })
    useVersionsStore.setState({
      unverified: { version: '0.1.0', reason: 'この版は記録の形を答えられません' },
    })

    const dialog = await screen.findByTestId('versions-confirm')
    expect(dialog).toHaveTextContent('画面からは戻ってこられなくなります')

    // **サーバが答えた実際の場所**を出す。既定を決め打ちで書くと、置き場所を
    // 移している利用者に存在しないパスを案内することになり、唯一の出口が塞がる
    // **そのまま貼れる形**であることまで見たいので、空白を潰さない生の中身で照合する
    const escape = await screen.findByTestId('versions-confirm-escape')
    expect(escape.textContent).toContain('cat  /tmp/使い捨て/version-current')
    expect(escape.textContent).toContain('rm   /tmp/使い捨て/version-current')
    expect(escape.textContent).not.toContain('~/.local/state/agentdashboard')
  })

  it('走っている版は消せない', async () => {
    show({ entries: [entry({ running: true })] })

    const listed = await screen.findByTestId('versions-stored')
    const remove = listed.querySelector('button')
    expect(remove).toBeDisabled()
  })

  it('選ぶとサーバへ予約を頼む', async () => {
    const select = vi.fn(async () => true)
    show({ entries: [entry({ version: '0.2.0' })] })
    useVersionsStore.setState({ select })

    await userEvent.selectOptions(screen.getByTestId('versions-picker'), '0.2.0')

    expect(select).toHaveBeenCalledWith('0.2.0')
  })
})
