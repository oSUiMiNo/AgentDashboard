import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Node, TreeNode } from '@/lib/protocol'
import { BODY_FOLD_LIMIT } from '@/lib/markdown'
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

/**
 * 本文の見せ方（テスト計画フェーズ4）。
 *
 * 確かめたいのは3つ。**整形されて出ること**、**同じ文字が二重に出ないこと**、そして
 * **`▸▾` と「続きを読む」が別の操作であること**。
 */

/** マークダウンの記法を一通り含む本文。 */
const MARKDOWN = [
  '## 見出し',
  '',
  '- 箇条書き1',
  '- 箇条書き2',
  '',
  '**強調**した文。',
  '',
  '| 列A | 列B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```js',
  'const a = 1',
  '```',
].join('\n')

/** しきい値を超える本文。冒頭は必ず整形できる形にしてある。 */
const LONG = `${MARKDOWN}\n\n${'ながい本文。'.repeat(200)}`

function rowByKind(kind: string) {
  const row = rowsOf(kind)[0]
  if (!row) {
    throw new Error(`行が無い：${kind}`)
  }
  return row
}

describe('本文を整形して出す', () => {
  it('アシスタントの本文が要素として出る', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: MARKDOWN })])
    renderTree()
    await waitForRows(1)

    const row = rowByKind('assistant_text')
    expect(within(row).getByRole('heading', { level: 2 })).toHaveTextContent('見出し')
    expect(within(row).getAllByRole('listitem')).toHaveLength(2)
    expect(within(row).getByRole('table')).toBeInTheDocument()
    expect(within(row).getByText('強調').tagName).toBe('STRONG')
    expect(row.querySelector('pre code')).not.toBeNull()
    // 記号のまま並んでいないこと（`##` や `**` が字面で出ていたら整形されていない）
    expect(row.textContent).not.toContain('## 見出し')
  })

  it('利用者の本文も同じように整形される', async () => {
    appendNodes(CARD, [node('u1', null, { kind: 'user_message', text: MARKDOWN })])
    renderTree()
    await waitForRows(1)
    expect(within(rowByKind('user_message')).getByRole('heading', { level: 2 })).toBeInTheDocument()
  })

  it('思考は既定で畳まれ、開くと整形されて出る', async () => {
    appendNodes(CARD, [node('k1', null, { kind: 'thinking', text: MARKDOWN })])
    renderTree()
    await waitForRows(1)

    expect(rowByKind('thinking').querySelector('h2')).toBeNull()
    await userEvent.click(within(rowByKind('thinking')).getByRole('button'))
    expect(within(rowByKind('thinking')).getByRole('heading', { level: 2 })).toBeInTheDocument()
  })

  it('ツールコールの中身は整形しない', async () => {
    // 入力・結果・差分は本文ではない。ここまで整形すると、JSON の記号が消えて読めなくなる
    appendNodes(CARD, [
      node('t1', null, {
        kind: 'tool_call',
        name: 'Bash',
        input: { command: '## echo **hi**' },
        result: null,
        status: 'ok',
        subagent: null,
      }),
    ])
    renderTree()
    await waitForRows(1)

    await userEvent.click(within(rowByKind('tool_call')).getByRole('button'))
    const row = rowByKind('tool_call')
    expect(row.querySelector('h2')).toBeNull()
    expect(row.textContent).toContain('## echo **hi**')
  })
})

describe('二重が消えて、全文が読める', () => {
  it.each([
    ['user_message', { kind: 'user_message', text: '一度きりの文' } as Node],
    ['assistant_text', { kind: 'assistant_text', text: '一度きりの文' } as Node],
    ['thinking', { kind: 'thinking', text: '一度きりの文' } as Node],
  ])('%s の本文が、見出しの横に出ない', async (kind, inner) => {
    appendNodes(CARD, [node('n1', null, inner)])
    renderTree()
    await waitForRows(1)

    const row = rowByKind(kind)
    if (kind === 'thinking') {
      await userEvent.click(within(row).getByRole('button'))
    }
    // 見出しの `<button>` の中に本文が入っていないこと（本文は button の外の兄弟にある）
    const headingButton = within(rowByKind(kind)).getAllByRole('button')[0]
    expect(headingButton.textContent).not.toContain('一度きりの文')
    expect(rowByKind(kind).textContent).toContain('一度きりの文')
  })

  it('ツールコールとサブエージェントの要約は残る', async () => {
    // 否定側だけを見ていると、要約を丸ごと消す実装でも通ってしまう
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(4)

    expect(within(rowsOf('tool_call')[0]).getAllByRole('button')[0].textContent).toContain(
      '/work/calc.py',
    )
  })

  it('子を持たない本文でも全文が読める', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: '子のいない報告' })])
    renderTree()
    await waitForRows(1)
    expect(rowByKind('assistant_text').textContent).toContain('子のいない報告')
  })

  it('子を持つ本文でも全文が読める', async () => {
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: '子のいる前置き' }),
      node('t1', 'a1', {
        kind: 'tool_call',
        name: 'Read',
        input: { file_path: 'x' },
        result: null,
        status: 'ok',
        subagent: null,
      }),
    ])
    renderTree()
    await waitForRows(2)
    expect(rowByKind('assistant_text').textContent).toContain('子のいる前置き')
  })
})

describe('`▸▾` と「続きを読む」は別の操作', () => {
  it('しきい値以内の本文には、本文を開く操作が出ない', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 'みじかい' })])
    renderTree()
    await waitForRows(1)
    expect(screen.queryByTestId('body-toggle')).toBeNull()
  })

  it('しきい値を超えると「続きを読む」が出て、押すと全文になる', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    renderTree()
    await waitForRows(1)

    const folded = rowByKind('assistant_text').textContent ?? ''
    expect(folded.length).toBeLessThan(LONG.length)
    expect(screen.getByTestId('body-toggle')).toHaveTextContent('続きを読む')

    await userEvent.click(screen.getByTestId('body-toggle'))
    expect(screen.getByTestId('body-toggle')).toHaveTextContent('畳む')
    expect((rowByKind('assistant_text').textContent ?? '').length).toBeGreaterThan(folded.length)
  })

  it('`▸▾` を押しても本文は隠れない', async () => {
    // 本文を `expanded` で囲い直すと、ここだけが落ちる
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: '畳んでも読める本文' }),
      node('t1', 'a1', {
        kind: 'tool_call',
        name: 'Read',
        input: { file_path: 'x' },
        result: null,
        status: 'ok',
        subagent: null,
      }),
    ])
    renderTree()
    await waitForRows(2)

    await userEvent.click(within(rowByKind('assistant_text')).getAllByRole('button')[0])
    // 子は畳まれ、本文は残る
    expect(rowsOf('tool_call')).toHaveLength(0)
    expect(rowByKind('assistant_text').textContent).toContain('畳んでも読める本文')
  })

  it('子を持たない本文の行には `▸▾` が出ない', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 'ひとりごと' })])
    renderTree()
    await waitForRows(1)
    expect(within(rowByKind('assistant_text')).getAllByRole('button')[0]).toBeDisabled()
  })

  it('利用者の本文に子がついても、本文は隠れない', async () => {
    // 未知レコードは直前の利用者の本文の子になる（フェーズ1 の実測）
    appendNodes(CARD, [
      node('u1', null, { kind: 'user_message', text: '子がついた指示' }),
      node('x1', 'u1', { kind: 'unknown', record_type: 'mystery', raw: {} }),
    ])
    renderTree()
    await waitForRows(2)

    await userEvent.click(within(rowByKind('user_message')).getAllByRole('button')[0])
    expect(rowByKind('user_message').textContent).toContain('子がついた指示')
  })
})

describe('生の HTML', () => {
  it('`<br/>` は改行として出る', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 'まえ<br/>あと' })])
    renderTree()
    await waitForRows(1)

    const row = rowByKind('assistant_text')
    expect(row.querySelector('br')).not.toBeNull()
    expect(row.textContent).not.toContain('<br/>')
  })

  it('それ以外の HTML は字面として出る', async () => {
    // ここで消すと、消えたことに利用者が気づけない（履歴には「生テキストで見る」が無い）
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 'まえ<span>なか</span>あと' })])
    renderTree()
    await waitForRows(1)

    const body = within(rowByKind('assistant_text')).getByTestId('row-body')
    expect(body.textContent).toContain('<span>')
    expect(body.querySelector('span')).toBeNull()
  })

  it('`<script>` は要素として描かれない', async () => {
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: 'まえ<script>alert(1)</script>あと' }),
    ])
    renderTree()
    await waitForRows(1)

    const row = rowByKind('assistant_text')
    expect(row.querySelector('script')).toBeNull()
    expect(row.textContent).toContain('<script>')
  })
})

describe('状態の持ち場', () => {
  it('本文を開け閉めしても、行が作り直されない', async () => {
    // 行の同一性はノードIDで見ている。添字にすると、実測した高さが捨てられる
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    renderTree()
    await waitForRows(1)

    const before = rowByKind('assistant_text')
    await userEvent.click(screen.getByTestId('body-toggle'))
    expect(rowByKind('assistant_text')).toBe(before)
  })

  it('描き直しても畳み方が変わらない', async () => {
    // 開閉をコンポーネントの状態に置くと、画面の外へ出た行が戻ってきたときに畳み直される。
    // ストアに置いてあるので、丸ごと作り直しても残る
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    const first = renderTree()
    await waitForRows(1)
    await userEvent.click(screen.getByTestId('body-toggle'))
    expect(screen.getByTestId('body-toggle')).toHaveTextContent('畳む')

    first.unmount()
    renderTree()
    await waitForRows(1)
    expect(screen.getByTestId('body-toggle')).toHaveTextContent('畳む')
  })
})
