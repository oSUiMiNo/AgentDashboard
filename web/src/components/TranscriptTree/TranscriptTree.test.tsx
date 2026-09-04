import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MessageOrigin, Node, TreeNode } from '@/lib/protocol'
import { BODY_FOLD_GRACE_LINES, BODY_FOLD_LINES } from '@/lib/markdown'
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

  it('会話の本文は既定で見えており、活動は1行にまとまる', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    // 発言2つ＋まとめ行1つ。ツールコール2件は**束ねられて**1行になる（設計§2-3）
    await waitForRows(3)

    expect(rowsOf('user_message')).toHaveLength(1)
    expect(rowsOf('assistant_text')).toHaveLength(1)
    expect(rowsOf('tool_call')).toHaveLength(0)
    expect(rowsOf('activity')).toHaveLength(1)
    expect(rowsOf('activity')[0].dataset.memberCount).toBe('2')
  })

  it('まとめ行を開くと、束ねられていたツールコールが並ぶ', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)

    const bundled = rowsOf('activity')[0]
    expect(bundled.dataset.expanded).toBe('false')
    await userEvent.click(within(bundled).getByRole('button'))
    expect(rowsOf('tool_call')).toHaveLength(2)
  })

  it('ツールコールは既定で閉じており、開くと中身が出る', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)
    await userEvent.click(within(rowsOf('activity')[0]).getByRole('button'))

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
    await waitForRows(3)
    await userEvent.click(within(rowsOf('activity')[0]).getByRole('button'))

    // Agent のツールコールを開く → サブエージェントが現れる
    expect(rowsOf('subagent')).toHaveLength(0)
    await userEvent.click(within(rowsOf('tool_call')[1]).getByRole('button'))
    expect(rowsOf('subagent')).toHaveLength(1)

    // サブエージェントを開く → その中の活動も、同じ規則でまとめ行になる
    await userEvent.click(within(rowsOf('subagent')[0]).getByRole('button'))
    const inner = rowsOf('activity').find((row) => (row.textContent ?? '').includes('README.md'))
    if (!inner) {
      throw new Error('サブエージェントの中のまとめ行が無い')
    }

    // さらに開くと、中のツールコールそのものまで掘れる
    await userEvent.click(within(inner).getByRole('button'))
    const names = rowsOf('tool_call').map((row) => row.textContent ?? '')
    expect(names.some((text) => text.includes('Read'))).toBe(true)
  })

  it('入れ子の深さが行に出る', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)
    expect(rowsOf('assistant_text')[0].dataset.depth).toBe('0')
    // まとめ行は束ねた子と同じ深さに置く（設計§2-4）
    expect(rowsOf('activity')[0].dataset.depth).toBe('1')

    // 開いても深さは増えない
    await userEvent.click(within(rowsOf('activity')[0]).getByRole('button'))
    expect(rowsOf('activity')[0].dataset.depth).toBe('1')
    expect(rowsOf('tool_call')[0].dataset.depth).toBe('1')
  })

  it('行数を E2E から読めるように出しておく', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    // 仮想化していると DOM に全行が無いので、件数は属性で見せる
    await waitForRows(3)
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

/**
 * しきい値を超える本文。冒頭は必ず整形できる形にしてある。
 *
 * 長さを**しきい値から作る**ので、実機で 75行 を決め直してもこの土台は追随する。
 * **猶予まで含めて1行超える**ようにしてある（超えないと畳まれない）。
 */
const LONG = `${MARKDOWN}\n\n${Array.from(
  { length: BODY_FOLD_LINES + BODY_FOLD_GRACE_LINES + 1 },
  () => 'ながい本文。',
).join('\n')}`

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

  it('行が空いていなくても、改行が改行として出る', async () => {
    // マークダウンの決まりでは素の改行は繋がってしまう。**打ったとおりに見せる**ほうを採る
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 'あいう\nかきく\nさしす' })])
    renderTree()
    await waitForRows(1)

    const body = within(rowByKind('assistant_text')).getByTestId('row-body')
    expect(body.querySelectorAll('br')).toHaveLength(2)
  })

  it('利用者の本文でも改行が出る', async () => {
    // **同じ部品・同じ配列を通る**ので、片方だけ直る形が構造的に作れない
    appendNodes(CARD, [node('u1', null, { kind: 'user_message', text: 'あいう\nかきく' })])
    renderTree()
    await waitForRows(1)

    const body = within(rowByKind('user_message')).getByTestId('row-body')
    expect(body.querySelectorAll('br')).toHaveLength(1)
  })

  it('囲みコードと表の中では、改行が二重にならない', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: MARKDOWN })])
    renderTree()
    await waitForRows(1)

    const row = rowByKind('assistant_text')
    expect(row.querySelector('pre')?.querySelectorAll('br')).toHaveLength(0)
    expect(within(row).getByRole('table').querySelectorAll('br')).toHaveLength(0)
  })

  it('思考は畳んでいるあいだ先頭1行だけを覗かせ、開くと全文が整形されて出る', async () => {
    appendNodes(CARD, [node('k1', null, { kind: 'thinking', text: MARKDOWN })])
    renderTree()
    await waitForRows(1)

    // 覗かせるのは先頭1行だけ（設計§8）。本文の残り（箇条書き・表）は出ていない
    const folded = rowByKind('thinking')
    expect(within(folded).queryAllByRole('listitem')).toHaveLength(0)
    expect(within(folded).queryByRole('table')).toBeNull()

    await userEvent.click(within(rowByKind('thinking')).getByRole('button'))
    const opened = rowByKind('thinking')
    expect(within(opened).getByRole('heading', { level: 2 })).toBeInTheDocument()
    expect(within(opened).getAllByRole('listitem')).toHaveLength(2)
    expect(within(opened).getByRole('table')).toBeInTheDocument()
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
    // 根の直下のツールコールも束ねられるので、まず開く（設計§2-3）
    await waitForRows(1)
    await userEvent.click(within(rowByKind('activity')).getByRole('button'))

    await userEvent.click(within(rowByKind('tool_call')).getByRole('button'))
    const row = rowByKind('tool_call')
    // 整形する本文には `row-body` の器が付く。ツールの中身は素の `<pre>` のまま
    expect(within(row).queryByTestId('row-body')).toBeNull()
    expect(row.querySelector('pre')).not.toBeNull()
    expect(row.textContent).toContain('## echo **hi**')
  })
})

describe('二重が消えて、全文が読める', () => {
  it.each([
    ['user_message', { kind: 'user_message', text: '一度きりの文' } as Node],
    ['assistant_text', { kind: 'assistant_text', text: '一度きりの文' } as Node],
  ])('%s には見出しの行が無く、本文が1度だけ出る', async (kind, inner) => {
    // **発言には見出しを付けない**（設計§5-3）。利用者は右の吹き出し、アシスタントは
    // 本文そのもので読み分けるので、横に同じ文字を並べる余地がそもそも無くなった
    appendNodes(CARD, [node('n1', null, inner)])
    renderTree()
    await waitForRows(1)

    const row = rowByKind(kind)
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
    expect(row.textContent).toContain('一度きりの文')
    // 本文は `row-body` の器に1つだけ
    expect(within(row).getAllByTestId('row-body')).toHaveLength(1)
  })

  it('思考の本文が、見出しの横に出ない', async () => {
    appendNodes(CARD, [node('k1', null, { kind: 'thinking', text: '一度きりの文' })])
    renderTree()
    await waitForRows(1)

    await userEvent.click(within(rowByKind('thinking')).getByRole('button'))
    // 見出しの `<button>` の中に本文が入っていないこと（本文は button の外の兄弟にある）
    const headingButton = within(rowByKind('thinking')).getAllByRole('button')[0]
    expect(headingButton.textContent).not.toContain('一度きりの文')
    expect(rowByKind('thinking').textContent).toContain('一度きりの文')
  })

  it('利用者の発言は右寄せの吹き出しになる', async () => {
    appendNodes(CARD, [node('u1', null, { kind: 'user_message', text: 'こちらの指示' })])
    renderTree()
    await waitForRows(1)
    expect(within(rowByKind('user_message')).getByTestId('user-bubble')).toBeInTheDocument()
  })

  it('アシスタントの本文は吹き出しにしない', async () => {
    // 吹き出しは利用者の発言だけ。両方を箱に入れると、どちらが誰か読めなくなる
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 'あちらの返事' })])
    renderTree()
    await waitForRows(1)
    expect(within(rowByKind('assistant_text')).queryByTestId('user-bubble')).toBeNull()
  })

  it('まとめ行は「やったこと」を出し、ツールの要約は開けば残る', async () => {
    // 否定側だけを見ていると、要約を丸ごと消す実装でも通ってしまう
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)

    // 束ねた行はツール名を出さず、過去形で「やったこと」を書く（設計§3-1）
    const bundled = rowsOf('activity')[0]
    expect(bundled.textContent).toContain('編集済み calc.py')
    // 差分の合計も出る（+1 -1）
    expect(within(bundled).getByTestId('activity-diff').textContent).toContain('+1')

    await userEvent.click(within(bundled).getByRole('button'))
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

describe('子の開け閉めと「続きを読む」は別の操作', () => {
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

  it('まとめ行を開け閉めしても、本文は隠れない', async () => {
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

    await userEvent.click(within(rowByKind('activity')).getByRole('button'))
    expect(rowsOf('tool_call')).toHaveLength(1)
    await userEvent.click(within(rowByKind('activity')).getByRole('button'))
    // 子は畳まれ、本文は残る
    expect(rowsOf('tool_call')).toHaveLength(0)
    expect(rowByKind('assistant_text').textContent).toContain('畳んでも読める本文')
  })

  it('子を持つ本文にも、開け閉めのボタンが出ない', async () => {
    // 子はまとめ行へ移ったので、本文の行は「開けば出るもの」を持たない（設計§2-5）。
    // 要望1（本文にトグルを出さない）が、この帰結として満たされる
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: 'ひとりごと' }),
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
    expect(within(rowByKind('assistant_text')).queryAllByRole('button')).toHaveLength(0)
  })

  it('利用者の本文に子がついても、本文は隠れない', async () => {
    // 未知レコードは直前の利用者の本文の子になる（フェーズ1 の実測）
    appendNodes(CARD, [
      node('u1', null, { kind: 'user_message', text: '子がついた指示' }),
      node('x1', 'u1', { kind: 'unknown', record_type: 'mystery', raw: {} }),
    ])
    renderTree()
    await waitForRows(2)

    // 未知のレコードもまとめ行へ束ねられる。開け閉めしても発言は残る
    await userEvent.click(within(rowByKind('activity')).getByRole('button'))
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

/**
 * 見出しと記号（テスト計画フェーズ5「見出しと記号」「吹き出しと主従」・設計§5）。
 *
 * **無くなったことは、無くなった側で見ないと守れない。** 絵文字も `▸▾` も「出ていない」が
 * 約束なので、置き換えたほうだけを見ていると、うっかり戻したときに誰も気づかない。
 */
describe('見出しと記号', () => {
  /** 全廃した絵文字（設計§5-1）。 */
  const 消した絵文字 = ['👤', '🤖', '💭', '🔧', '🧩', '❔']

  it('絵文字も `▸▾` も、どこにも出ていない', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)

    // まとめ行を開いて、ツールコールとサブエージェントの見出しまで出しておく
    for (const row of rowsOf('activity')) {
      await userEvent.click(within(row).getByRole('button'))
    }
    const 画面 = rowsOf()
      .map((row) => row.textContent ?? '')
      .join('')
    for (const 絵文字 of [...消した絵文字, '▸', '▾']) {
      expect(画面).not.toContain(絵文字)
    }
  })

  it('記号は `›`／`⌄` で、テキストの後ろに置かれる', async () => {
    // **右端揃えにしない**（設計§5-2）。深いところで字下げが積み上がると尻の記号が潰れ、
    // 横並びでは列が狭くてテキストと遠く離れる
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)

    const まとめ = rowsOf('activity')[0]!
    const ボタン = within(まとめ).getByRole('button')
    expect(ボタン.textContent).toContain('›')
    // 記号は中身の最後。間に伸びる詰め物（`flex-1`）を挟むと右端へ飛ぶ
    expect(ボタン.lastElementChild?.textContent).toBe('›')

    await userEvent.click(ボタン)
    expect(within(rowsOf('activity')[0]!).getByRole('button').textContent).toContain('⌄')
  })

  it('見出しは、発言以外にだけ残る', async () => {
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)

    // 発言には見出しの行が無い（本文だけ）
    expect(within(rowByKind('user_message')).queryAllByRole('button')).toHaveLength(0)
    expect(within(rowByKind('assistant_text')).queryAllByRole('button')).toHaveLength(0)
    // まとめ行には見出しが残る
    expect(within(rowByKind('activity')).getByRole('button').textContent).toContain('編集済み')
  })

  it('吹き出しは幅いっぱいにならない', async () => {
    // 幅いっぱいだと右寄せであることが読み取れない（設計§5-3）
    appendNodes(CARD, [node('u1', null, { kind: 'user_message', text: 'みじかい' })])
    renderTree()
    await waitForRows(1)

    expect(screen.getByTestId('user-bubble').className).toContain('max-w-[70%]')
  })

  it('主従はウェイトと明度で付ける（発言は強く、活動は弱く）', async () => {
    // **箱にも罫線にも頼らない**（設計§5-3）。同じ見た目になったらこの行が落ちる
    appendNodes(CARD, conversation())
    renderTree()
    await waitForRows(3)

    const 発言 = within(rowByKind('assistant_text')).getByTestId('row-body').className
    const 活動 = within(rowByKind('activity')).getByRole('button').textContent
    expect(発言).toContain('font-medium')
    expect(発言).toContain('text-foreground')
    expect(活動).toBeTruthy()
    expect(
      within(rowByKind('activity')).getByRole('button').firstElementChild?.className,
    ).toContain('text-muted-foreground')
  })
})

/**
 * 畳んだ本文の末尾に敷くフェード（テスト計画フェーズ5「マスク」・設計§6）。
 *
 * **見た目そのものは jsdom では測れない**（`mask-image` の効きも帯の高さも実際には描かれない）。
 * ここで固定するのは**どの行に出て、どの行に出ないか**——マスクの有無が「続きがあるか」と
 * 1対1であること、という約束のほうである。実際に帯が見えるかは E2E と実機の仕事。
 */
describe('畳んだ本文のフェード', () => {
  /** ちょうど猶予に収まり、畳まれない本文。 */
  const GRACE = Array.from(
    { length: BODY_FOLD_LINES + BODY_FOLD_GRACE_LINES },
    () => 'ぎりぎり',
  ).join('\n')

  /**
   * 帯を敷く**器**を引く（フェーズ11・設計§6-7-2）。
   *
   * 帯は本文の箱（`row-body`）ではなく**器そのもの**に敷く。本文の箱に敷くと、
   * 吹き出しの内側余白のぶんだけ左右と下が届かず「中に貼った紙」に見える。
   */
  function shellOf(kind: 'assistant_text' | 'user_message'): HTMLElement {
    const row = rowByKind(kind)
    const shell =
      kind === 'user_message'
        ? within(row).getByTestId('user-bubble')
        : row.querySelector<HTMLElement>('.body-shell')
    if (!shell) {
      throw new Error(`帯の器が見つからない（${kind}）`)
    }
    return shell
  }

  it('畳んだ本文にだけフェードが付く', async () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    renderTree()
    await waitForRows(1)

    const body = within(rowByKind('assistant_text')).getByTestId('row-body')
    expect(body.dataset.fade).toBe('shallow')
    expect(shellOf('assistant_text').className).toContain('body-fade')
  })

  it('帯は器に敷き、本文の箱には敷かない', async () => {
    // **これが落ちるのは、帯を `row-body` へ戻したとき**（壊し方①）。器へ敷いていないと
    // 吹き出しの内側余白のぶんだけ左右と下が届かず、要望①が満たせない
    appendNodes(CARD, [
      node('u1', null, { kind: 'user_message', text: LONG }),
      node('a1', null, { kind: 'assistant_text', text: LONG }),
    ])
    renderTree()
    await waitForRows(2)

    for (const kind of ['user_message', 'assistant_text'] as const) {
      expect(shellOf(kind).className).toContain('body-fade')
      expect(within(rowByKind(kind)).getByTestId('row-body').className).not.toContain('body-fade')
    }
  })

  it('畳んでいるあいだだけ、帯に押す面が出る', async () => {
    // 要望10。**擬似要素では押せない**ので実要素で足してある（設計§6-7-5）。
    // 開けば帯が無くなるので、押す面も消える
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    renderTree()
    await waitForRows(1)

    expect(screen.getByTestId('body-hitbox')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('body-toggle'))
    expect(screen.queryByTestId('body-hitbox')).toBeNull()
  })

  it('押す面を押すと本文が開く', async () => {
    // **これが要望10 の本体。**「続きを読む」の文字をピンポイントで突かなくても開く
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    renderTree()
    await waitForRows(1)

    await userEvent.click(screen.getByTestId('body-hitbox'))
    expect(screen.getByTestId('body-toggle')).toHaveTextContent('畳む')
  })

  it('畳まない本文には押す面を出さない', async () => {
    // 帯が無いところに押す面だけ在ると、**押しても何も起きない面**になる
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 'みじかい' })])
    renderTree()
    await waitForRows(1)

    expect(screen.queryByTestId('body-hitbox')).toBeNull()
  })

  it('「続きを読む」は帯の上へ重なり、開くと流れへ戻る', async () => {
    // 要望②（マスクの中に書いてある感じ）。**重ねるのは畳んでいるあいだだけ**——
    // 開いているときは重ねる相手（帯）が無い
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    renderTree()
    await waitForRows(1)

    const toggle = screen.getByTestId('body-toggle')
    expect(toggle.className).toContain('body-toggle-float')

    await userEvent.click(toggle)
    expect(screen.getByTestId('body-toggle').className).not.toContain('body-toggle-float')
  })

  it('開くとフェードが消え、畳み直すと戻る', async () => {
    // 「フェードしている＝まだ続きがある」を守るのは、開いた側でも同じ（設計§6-4）
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: LONG })])
    renderTree()
    await waitForRows(1)

    await userEvent.click(screen.getByTestId('body-toggle'))
    const opened = within(rowByKind('assistant_text')).getByTestId('row-body')
    expect(opened.dataset.fade).toBeUndefined()
    expect(shellOf('assistant_text').className).not.toContain('body-fade')

    await userEvent.click(screen.getByTestId('body-toggle'))
    expect(within(rowByKind('assistant_text')).getByTestId('row-body').dataset.fade).toBe('shallow')
  })

  it('猶予に入って畳まなかった本文には出ない', async () => {
    // **これが落ちるのは、畳んだかどうかではなく長さでフェードを決めたとき。**
    // 猶予の本文は最後まで出ているので、フェードすると「続きがある」という嘘になる
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: GRACE })])
    renderTree()
    await waitForRows(1)

    expect(screen.queryByTestId('body-toggle')).toBeNull()
    const body = within(rowByKind('assistant_text')).getByTestId('row-body')
    expect(body.dataset.fade).toBeUndefined()
    expect(shellOf('assistant_text').className).not.toContain('body-fade')
  })

  it('畳んだ思考の覗かせた1行には出ない', async () => {
    // 覗かせているのは1行だけなので、そこへ2行分の帯を敷くと覗かせた意味が消える。
    // 思考は長さで畳む道を通らない（設計§8）ので、構造として当たらないことを固定する
    appendNodes(CARD, [node('t1', null, { kind: 'thinking', text: LONG })])
    renderTree()
    await waitForRows(1)

    const body = within(rowByKind('thinking')).getByTestId('row-body')
    expect(body.dataset.fade).toBeUndefined()
  })

  it('残りが多い本文では深い段になる', async () => {
    // 3段が実際に描き分けられていること（`fadeDepth` の単体だけでは配線を見ていない）
    const 度を超えて長い = Array.from({ length: 400 }, () => 'ながい本文。').join('\n')
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: 度を超えて長い })])
    renderTree()
    await waitForRows(1)

    const body = within(rowByKind('assistant_text')).getByTestId('row-body')
    expect(body.dataset.fade).toBe('deep')
    expect(shellOf('assistant_text').className).toContain('body-fade-deep')
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

/** 実効行数がちょうど `count` になる本文（畳みの境目を字で書くため）。 */
function linesOf(count: number): string {
  return Array.from({ length: count }, (_, i) => `${i + 1}行目`).join('\n')
}

/**
 * 人が打っていないものの見分け
 * （`人が打っていないものを、人の発言として出さない` テスト計画フェーズ6）。
 *
 * **要件の最優先事項は「人が打った文を機械側へ落とさない」こと。** 器・左右・畳み・
 * トグルは、その見分けが画面に出ているかを確かめるためにある。
 */
describe('誰が入れたか', () => {
  const 人 = (text: string): Node => ({ kind: 'user_message', text, origin: { kind: 'human' } })
  const 機械 = (text: string, origin: MessageOrigin): Node => ({
    kind: 'user_message',
    text,
    origin,
  })

  async function 出す(inner: Node) {
    appendNodes(CARD, [node('n1', null, inner)])
    renderTree()
    await waitForRows(1)
    return within(rowsOf('user_message')[0])
  }

  it('人の発言は右寄せの吹き出しのまま', async () => {
    const row = await 出す(人('こちらの指示'))
    const bubble = row.getByTestId('user-bubble')
    expect(bubble).toBeInTheDocument()
    expect(bubble.className).not.toContain('speech-bubble-machine')
    expect(bubble.parentElement?.className).toContain('justify-end')
    expect(row.queryByTestId('origin-label')).not.toBeInTheDocument()
  })

  it('印が1つも無い記録も、人の発言のまま', async () => {
    // **安全側の門。** ここに人が打った `/clear` `/model` が来る（設計§1-3）
    const row = await 出す({ kind: 'user_message', text: '/clear' })
    expect(row.getByTestId('user-bubble').className).not.toContain('speech-bubble-machine')
    expect(row.queryByTestId('origin-label')).not.toBeInTheDocument()
  })

  it('機械が入れたものは左寄せの吹き出しになる', async () => {
    const row = await 出す(機械('通知です', { kind: 'task_notification' }))
    const bubble = row.getByTestId('user-bubble')
    expect(bubble.className).toContain('speech-bubble-machine')
    expect(bubble.parentElement?.className).toContain('justify-start')
    expect(bubble.dataset.origin).toBe('task_notification')
  })

  it('機械が入れたものは、名乗りを画面に出す', async () => {
    // **7種の文言そのものは純関数の側で見る**（`messageOrigin.test.ts`）。
    // ここで確かめるのは「名乗りが画面へ配線されていること」だけ
    const row = await 出す(機械('連絡', { kind: 'peer', name: 'sample-peer-session' }))
    expect(row.getByTestId('origin-label').textContent).toBe(
      '他セッションから（sample-peer-session）',
    )
  })

  it('知らない名乗りは、その名前のまま出る', async () => {
    // 丸めると**記録が名乗ったことを捨てる**ことになる（設計§2-3）
    const row = await 出す(機械('調整', { kind: 'other', name: 'coordinator' }))
    expect(row.getByTestId('origin-label').textContent).toBe('coordinator')
  })

  it('機械が入れたものは11行で畳まれる', async () => {
    const row = await 出す(機械(linesOf(11), { kind: 'injected' }))
    expect(row.getByTestId('body-toggle')).toBeInTheDocument()
  })

  it('12行の機械も畳まれる（猶予を当てない）', async () => {
    // **既存の原則を1つ外している**（設計§6-6）。猶予は高さの話、こちらは格の話
    const row = await 出す(機械(linesOf(12), { kind: 'injected' }))
    expect(row.getByTestId('body-toggle')).toBeInTheDocument()
  })

  it('10行の機械は畳まれない', async () => {
    const row = await 出す(機械(linesOf(10), { kind: 'injected' }))
    expect(row.queryByTestId('body-toggle')).not.toBeInTheDocument()
  })

  it('人の発言は、同じ行数でも畳まれない', async () => {
    // 畳みの規則は機械だけのもの。人へ当てると、短い指示まで畳まれる
    const row = await 出す(人(linesOf(12)))
    expect(row.queryByTestId('body-toggle')).not.toBeInTheDocument()
  })

  it('スラッシュコマンドは打った形で出て、開くと展開が見える', async () => {
    const inner: Node = {
      kind: 'user_message',
      text: '/sample-skill-1 calc.py',
      origin: { kind: 'human' },
      command: { typed: '/sample-skill-1 calc.py', expansion: '指定されたファイルを読め。' },
    }
    const row = await 出す(inner)
    const body = row.getByTestId('row-body')
    expect(body.textContent).toContain('/sample-skill-1 calc.py')
    expect(body.textContent).not.toContain('指定されたファイルを読め。')
    // **生のタグが1文字も出ない**
    expect(body.textContent).not.toContain('command-name')

    await userEvent.click(row.getByTestId('body-toggle'))
    expect(row.getByTestId('row-body').textContent).toContain('指定されたファイルを読め。')
  })

  it('展開が無いコマンドにはトグルが出ない', async () => {
    // **展開が無いほうが多数派である**（実測66%。設計§3-4）
    const inner: Node = {
      kind: 'user_message',
      text: '/clear',
      origin: { kind: 'human' },
      command: { typed: '/clear', expansion: null },
    }
    const row = await 出す(inner)
    expect(row.getByTestId('row-body').textContent).toContain('/clear')
    expect(row.queryByTestId('body-toggle')).not.toBeInTheDocument()
  })
})
