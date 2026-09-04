/**
 * PJT 専用画面（設計§14。テスト計画 フェーズ4「PJT 専用画面」）。
 *
 * セッションの中身は [`SessionView`] 自身のテストが見ているので、ここでは差し替える。
 * 端末を作る部品を巻き込むと、**確かめたいのは配置なのに、落ちる理由が xterm になる**。
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupView } from '@/components/GroupView/GroupView'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions } from '@/stores/sessions'
import { applyProjectSnapshot, clearProjects } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'
import { settingsFixture } from '@/test/fixtures'

vi.mock('@/components/SessionView/SessionView', () => ({
  SessionView: ({ cardId }: { cardId: string }) => (
    <div data-testid="session-view" data-card={cardId} />
  ),
}))

const HOST = 'local'
const PROJECT = '/home/me/dev/app'

function card(cardId: string): SessionMeta {
  return {
    card_id: cardId,
    project: PROJECT,
    claude_session_id: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: 'working',
    subagent_active: 0,
    last_activity_at: 1,
    last_assistant_message: null,
    created_at: 1,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    session_title: null,
    position: 0,
    nickname: null,
    branched_from: null,
  } as unknown as SessionMeta
}

function show() {
  render(
    <MemoryRouter>
      <GroupView host={HOST} project={PROJECT} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  clearSessions()
  globalThis.localStorage.clear()
  useSettingsStore.setState({
    settings: settingsFixture(),
    loading: false,
    lastError: null,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ path: PROJECT, entries: [], truncated: false }),
          { status: 200 },
        ),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PJT 専用画面', () => {
  it('切り替えボタンでサイドバーが開閉する', async () => {
    show()
    expect(screen.queryByTestId('project-files-panel')).toBeNull()

    await userEvent.click(screen.getByTestId('project-files-toggle'))
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-files-toggle'))
    // **`waitFor` で待つ。** 出入りに動きを付けた（設計§6）ので、畳んだ意味が
    // 「DOM から消える」から「やがて消える」へ変わった。jsdom でも `exit` は
    // 完了するが非同期である（実測）
    await waitFor(() =>
      expect(screen.queryByTestId('project-files-panel')).toBeNull(),
    )
  })

  it('開閉が覚えられ、開き直しても保たれる', async () => {
    show()
    await userEvent.click(screen.getByTestId('project-files-toggle'))
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()

    // 画面を作り直す＝別の枠を開いた・再読み込みした、と同じこと
    cleanup()
    show()

    // 押し直さずに開いている（**サーバではなくブラウザ側**に覚えている）
    expect(screen.getByTestId('project-files-panel')).toBeInTheDocument()
    expect(globalThis.localStorage.getItem('agentdashboard.project-files-open')).toBe('1')
  })

  it('狭い画面では、左端の帯として出る（全画面にしない）', async () => {
    show()
    await userEvent.click(screen.getByTestId('project-files-toggle'))
    const panel = screen.getByTestId('project-files-panel')

    /*
      **2026-08-28 に期待が変わった。** それまでは `inset-0` で画面全体を覆っていたが、
      実機で触って3つの不具合になった——裏が何も見えない・アプリのヘッダごと覆うので
      切り替えボタンへ届かない・被さっているのか画面が切り替わったのか分からない。

      利用者が示した参考（ChatGPT のウェブアプリ）に合わせて、**左端の帯**にした。
      `inset-y-0 left-0` なので `right` は自動——**裏の本文がその場に残って見える。**

      広い画面が `absolute` で `fixed` ではないのは、**`fixed` のままだと画面の上端から
      被さってアプリのヘッダ（設定・アカウント）まで覆う**ため。`absolute` なら
      取り合いの器の左端と高さがそのまま枠になる。
    */
    expect(panel.className).toContain('fixed')
    expect(panel.className).toContain('inset-y-0')
    expect(panel.className).toContain('left-0')
    // **全画面に戻したら落ちること。** これがこの1本の仕事
    expect(panel.className).not.toContain('inset-0 ')
    // どれだけ狭い機械でも、裏が15%は見えている
    expect(panel.className).toContain('w-[min(85vw,20rem)]')
    expect(panel.className).toContain('md:absolute')
    expect(panel.className).not.toContain('md:static')
    expect(panel.className).toContain('md:w-[var(--files-folder-w,20rem)]')
    // 狭い画面用の閉じる操作がある（参考の ✕ にあたるもの）
    expect(screen.getByTestId('project-files-close')).toBeInTheDocument()
  })

  it('セッションが0本でも画面が開き、「+」だけが出る', () => {
    show()

    expect(screen.getByTestId('group-view')).toBeInTheDocument()
    expect(screen.getByTestId('spawn-open')).toBeInTheDocument()
    /*
      **レールは0本でも描く**（2026-08-27）。以前はここで `null` を見ていたが、
      **中身の列をレールの中へ入れた**ので、描かないと**0本の PJT でファイルを開いても
      何も出なくなる**。空のレールが1つ在ること自体は、画面に何も足さない
    */
    expect(screen.getByTestId('group-rail')).toBeInTheDocument()
    expect(screen.queryAllByTestId('session-view')).toHaveLength(0)
    expect(
      screen.getByText('このプロジェクトのセッションはありません'),
    ).toBeInTheDocument()
  })

  it('右側のセッション横並びは現行のまま', () => {
    applySessionSnapshot([card('c1'), card('c2')])
    show()

    const rail = screen.getByTestId('group-rail')
    expect(within(rail).getAllByTestId('session-view')).toHaveLength(2)
    // 横スクロールで全件並べる（上限を設けない、という既存の判断）
    expect(rail.className).toContain('overflow-x-auto')
  })
})

/**
 * セッション専用画面と骨格を揃える（設計§16・テスト計画フェーズ8）。
 *
 * **揃ったことの証明は「同じ関数を使っている」ことに置く。** 見た目の一致を
 * 目で比べても、次に片方だけ直したときには何も言ってくれない。
 */
describe('GroupView のヘッダは、セッション専用画面と揃っている', () => {
  function 開く(entries: string[] = ['/', `/p/${HOST}/x`]) {
    return render(
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/" element={<p>一覧に居ます</p>} />
          <Route
            path="/p/:host/:project"
            element={<GroupView host={HOST} project={PROJECT} />}
          />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('見出しはフォルダ名だけで、フルパスは title に残る', () => {
    // **`projectDisplayName` を再利用している**ので、同じ PJT がセッション専用画面と
    // 同じ名前・同じ番号で出る（設計§16-2）。別々に書くとここがずれる
    show()
    const 見出し = screen.getByRole('heading', { level: 2 })
    expect(見出し).toHaveTextContent('app')
    expect(見出し).not.toHaveTextContent(PROJECT)
    expect(見出し).toHaveAttribute('title', PROJECT)
  })

  it('「+」は名前のすぐ右で、記号になっている', () => {
    // 右端は「画面に効く」場所。`+` は**その PJT に効く**ので名前の隣（設計§16-4）
    show()
    const 見出し = screen.getByRole('heading', { level: 2 })
    const 次 = 見出し.nextElementSibling
    expect(次?.querySelector('[data-testid="spawn-open"]')).not.toBeNull()

    const 足す = screen.getByTestId('spawn-open')
    expect(足す.querySelector('svg')).not.toBeNull()
    // 全角の `＋` を文字として置かない
    expect(足す).not.toHaveTextContent('＋')
  })

  it('「一覧へ戻る」の文字は消え、✕ になっている', () => {
    show()
    expect(screen.queryByText('一覧へ戻る')).toBeNull()
    const 閉じる = screen.getByTestId('close-group')
    expect(閉じる).toHaveAttribute('aria-label', '閉じる')
    expect(閉じる.querySelector('svg')).not.toBeNull()
    // **目印はセッション専用画面と別。** 同じにすると、どちらの ✕ を掴んでいるか読めない
    expect(screen.queryByTestId('close-session')).toBeNull()
  })

  it('✕ を押すと、開く前の画面へ戻る', async () => {
    開く()
    await userEvent.click(screen.getByTestId('close-group'))
    expect(screen.getByText('一覧に居ます')).toBeInTheDocument()
  })

  it('いきなり開いた画面で ✕ を押しても、一覧へ行く', async () => {
    // **戻り先が無いときの分岐**（`backTargetFor`）。セッション専用画面と同じ関数
    開く([`/p/${HOST}/x`])
    await userEvent.click(screen.getByTestId('close-group'))
    expect(screen.getByText('一覧に居ます')).toBeInTheDocument()
  })

  it('同じ名前の PJT が複数あると、セッション専用画面と同じ番号が付く', () => {
    /*
      **ここが「揃った」ことの証明である。**

      名前だけを出すことは、その場で `split('/').pop()` を書いても達成できてしまう。
      **ずれるのは番号のほう**——衝突の見つけ方と並べる順（枠が作られた順）まで
      同じでなければ、同じ PJT が画面によって `app` と `app (2)` に分かれる。
      だから `projectDisplayName` の再利用を、番号で見張る（設計§16-2）。
    */
    applyProjectSnapshot([
      { id: 'p2', host: HOST, path: '/後/app', created_at: 20, position: 0 },
      { id: 'p1', host: HOST, path: PROJECT, created_at: 10, position: 0 },
    ])
    render(
      <MemoryRouter>
        <GroupView host={HOST} project={PROJECT} />
      </MemoryRouter>,
    )
    // 先に作られたほうが (1)。**押した瞬間に入れ替わらない根拠**（`created_at`）
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('app (1)')
    clearProjects()
  })

  it('揃えないものは、揃えないままにしてある', () => {
    // セッション数の札は残る（セッション専用画面には数える対象が無いだけ）
    show()
    expect(screen.getByText(/セッション$/)).toBeInTheDocument()
    // **始末のボタンは出さない**——カードが複数あるので宛先が一意に定まらない（設計§16-5）
    expect(screen.queryByTestId('power-card')).toBeNull()
    expect(screen.queryByTestId('close-card')).toBeNull()
  })
})

