import type { Node, TreeNode } from '@/lib/protocol'
import {
  appendNodes,
  clearAllTranscripts,
  getNode,
  getRows,
  resetTranscript,
  toggleNode,
  toggleRewound,
} from './transcript'

/**
 * 構造化ビューのストア（テスト計画フェーズ5「ストア」「TranscriptTree」）。
 *
 * ここが守るべき約束は4つ。
 * - 同じノードIDは**上書き**（ツールコールは結果が届いてから送り直される）
 * - 平らにした並びが**展開状態を反映**する（掘れる表示の土台）
 * - 巻き戻しで**全部捨てる**
 * - `/rewind` で分岐した**古い枝は畳む**（設計§16）
 */

const CARD = '11111111-2222-3333-4444-555555555555'

/** いまの行の並び。 */
const rowsOf = getRows

/** ストアは rAF でまとめてから反映するので、テストでは即座に流す。 */
beforeEach(() => {
  clearAllTranscripts()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearAllTranscripts()
})

function node(
  id: string,
  parent: string | null,
  inner: Node,
  branch = 0,
): TreeNode {
  return { id, parent, node: inner, ts: 0, branch }
}

function tool(status: 'pending' | 'ok'): Node {
  return {
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'npm test' },
    result: status === 'ok' ? { stdout: '1 passed' } : null,
    status,
    subagent: null,
  }
}

describe('履歴ストア', () => {
  it('同じIDのノードは上書きされる', () => {
    appendNodes(CARD, [node('t1', null, tool('pending'))])
    appendNodes(CARD, [node('t1', null, tool('ok'))])

    const stored = getNode(CARD, 't1')
    expect(stored?.node).toMatchObject({ kind: 'tool_call', status: 'ok' })
  })

  it('巻き戻しで全部捨てる', () => {
    appendNodes(CARD, [node('u1', null, { kind: 'user_message', text: 'やって' })])
    resetTranscript(CARD)
    expect(getNode(CARD, 'u1')).toBeUndefined()
  })

  it('開け閉めを切り替えられる', () => {
    // ツールコールは既定で閉じている（詳細は開いたときだけ出す）
    appendNodes(CARD, [node('t1', null, tool('ok'))])
    toggleNode(CARD, 't1')
    toggleNode(CARD, 't1')
    // 例外にならず、ノード自体は保持され続ける
    expect(getNode(CARD, 't1')).toBeDefined()
  })

  it('親が届いていない子も保持される', () => {
    // 順不同で届くことがある。捨てると履歴が欠ける
    appendNodes(CARD, [node('child', 'missing-parent', { kind: 'thinking', text: '考え中' })])
    expect(getNode(CARD, 'child')).toBeDefined()
  })

  it('巻き戻し前の枝は既定で畳まれ、開けば読める', () => {
    // `/rewind` は JSONL を巻き戻さず、同じファイルに2つ目の根として追記する（設計§16）。
    // そのまま全部並べると「巻き戻したのに前のやりとりが見えている」ことになる
    appendNodes(CARD, [
      node('u1', null, { kind: 'user_message', text: '最初の指示' }, 0),
      node('a1', null, { kind: 'assistant_text', text: 'やりました' }, 0),
      node('u2', null, { kind: 'user_message', text: 'やり直しの指示' }, 1),
      node('a2', null, { kind: 'assistant_text', text: '了解' }, 1),
    ])

    const folded = rowsOf(CARD)
    expect(folded[0]).toMatchObject({ kind: 'rewound', count: 2, expanded: false })
    // 見えるのは見出し1行＋最新の枝2行だけ
    expect(folded.filter((row) => row.kind === 'node').map((row) => row.id)).toEqual([
      'u2',
      'a2',
    ])

    toggleRewound(CARD)
    const opened = rowsOf(CARD)
    expect(opened[0]).toMatchObject({ kind: 'rewound', expanded: true })
    expect(opened.filter((row) => row.kind === 'node').map((row) => row.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ])
  })

  it('巻き戻していなければ見出し行は出ない', () => {
    appendNodes(CARD, [
      node('u1', null, { kind: 'user_message', text: 'やって' }, 0),
      node('a1', null, { kind: 'assistant_text', text: 'はい' }, 0),
    ])
    expect(rowsOf(CARD).some((row) => row.kind === 'rewound')).toBe(false)
  })

  it('カードごとに独立している', () => {
    const other = '99999999-9999-9999-9999-999999999999'
    appendNodes(CARD, [node('a', null, { kind: 'assistant_text', text: 'A' })])
    appendNodes(other, [node('b', null, { kind: 'assistant_text', text: 'B' })])

    expect(getNode(CARD, 'b')).toBeUndefined()
    expect(getNode(other, 'b')).toBeDefined()

    resetTranscript(CARD)
    expect(getNode(other, 'b')).toBeDefined()
  })
})
