import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Node, TreeNode } from '@/lib/protocol'
import { TranscriptTree } from './TranscriptTree'
import { appendNodes, clearAllTranscripts } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'

/**
 * 構造化ビューの表示（テスト計画フェーズ5「TranscriptTree」「diff表示」）。
 *
 * 確かめたいのは「掘れること」。ツールコールを開くと中身が出て、サブエージェントを開くと
 * その中の作業が見えること、という要件そのものを見る。
 */

const CARD = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  clearAllTranscripts()
})

afterEach(() => {
  clearAllTranscripts()
})

/**
 * ストアは rAF でまとめてから反映するので、描画が追いつくまで待つ。
 *
 * rAF を同期実行に差し替える手は使えない。仮想化ライブラリがスクロール位置の
 * 調整に rAF を使っており、同期にすると自分を呼び続けて止まらなくなる。
 */
async function waitForRows(count: number) {
  await waitFor(() => {
    expect(screen.getByTestId('transcript-status').dataset.rowCount).toBe(String(count))
  })
}

function node(
  id: string,
  parent: string | null,
  inner: Node,
  branch = 0,
): TreeNode {
  return { id, parent, node: inner, ts: 0, branch }
}

/** ユーザ → アシスタント → ツールコール → サブエージェント → その中のツールコール。 */
function conversation(): TreeNode[] {
  return [
    node('u1', null, { kind: 'user_message', text: 'テストを直して' }),
    node('a1', null, { kind: 'assistant_text', text: 'まず失敗を確認します' }),
    node('t1', 'a1', {
      kind: 'tool_call',
      name: 'Edit',
      input: { file_path: '/work/calc.py' },
      result: {
        filePath: '/work/calc.py',
        originalFile: 'def add(a, b): return a - b\n',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-def add(a, b): return a - b', '+def add(a, b): return a + b'],
          },
        ],
      },
      status: 'ok',
      subagent: null,
    }),
    node('t2', 'a1', {
      kind: 'tool_call',
      name: 'Agent',
      input: { description: '調査' },
      result: null,
      status: 'pending',
      subagent: {
        agent_type: 'general-purpose',
        transcript_path: 'subagents/agent-a1.jsonl',
        spawn_depth: 1,
      },
    }),
    node('agent:a1', 't2', { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }),
    node('t3', 'agent:a1', {
      kind: 'tool_call',
      name: 'Read',
      input: { file_path: 'README.md' },
      result: { type: 'file' },
      status: 'ok',
      subagent: null,
    }),
  ]
}

function renderTree() {
  // WebSocket は張らない。購読の送信は繋がっていなければ黙って捨てられる
  const result = render(<TranscriptTree cardId={CARD} />)
  return result
}

function rowsOf(kind?: string) {
  const all = screen.queryAllByTestId('transcript-row')
  return kind ? all.filter((row) => row.dataset.kind === kind) : all
}

describe('構造化ビュー', () => {
  it('履歴が無いときは案内を出す', () => {
    renderTree()
    expect(screen.getByText(/まだ履歴がありません/)).toBeInTheDocument()
  })

  it('会話の本文は既定で見えており、ツールコールも並ぶ', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(4)

    expect(rowsOf('user_message')).toHaveLength(1)
    expect(rowsOf('assistant_text')).toHaveLength(1)
    // アシスタント本文は既定で開いているので、その子のツールコールが見える
    expect(rowsOf('tool_call')).toHaveLength(2)
  })

  it('ツールコールは既定で閉じており、開くと中身が出る', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(4)

    const edit = rowsOf('tool_call')[0]
    expect(edit.dataset.expanded).toBe('false')
    expect(within(edit).queryByTestId('diff-view')).toBeNull()

    await userEvent.click(within(edit).getByRole('button'))
    const opened = rowsOf('tool_call')[0]
    expect(opened.dataset.expanded).toBe('true')
    expect(within(opened).getByTestId('diff-view')).toBeInTheDocument()
  })

  it('サブエージェントを開くとその中の作業まで掘れる', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(4)

    // Agent のツールコールを開く → サブエージェントが現れる
    expect(rowsOf('subagent')).toHaveLength(0)
    await userEvent.click(within(rowsOf('tool_call')[1]).getByRole('button'))
    expect(rowsOf('subagent')).toHaveLength(1)

    // サブエージェントを開く → その中のツールコールが現れる
    await userEvent.click(within(rowsOf('subagent')[0]).getByRole('button'))
    const names = rowsOf('tool_call').map((row) => row.textContent ?? '')
    expect(names.some((text) => text.includes('Read'))).toBe(true)
  })

  it('入れ子の深さが行に出る', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(4)
    expect(rowsOf('assistant_text')[0].dataset.depth).toBe('0')
    expect(rowsOf('tool_call')[0].dataset.depth).toBe('1')
  })

  it('行数を E2E から読めるように出しておく', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    // 仮想化していると DOM に全行が無いので、件数は属性で見せる
    await waitForRows(4)
  })

  it('パーサが縮退していると知らせる', () => {
    useWsStore.setState({ parserState: 'degraded', parserDetail: 'パーサが終了しました' })
    renderTree()
    expect(screen.getByTestId('parser-degraded')).toHaveTextContent('縮退しています')
    useWsStore.setState({ parserState: 'ok', parserDetail: null })
  })
})
