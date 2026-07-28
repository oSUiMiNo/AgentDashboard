import type { Node, TreeNode } from '@/lib/protocol'
import {
  appendNodes,
  clearAllTranscripts,
  getNode,
  resetTranscript,
  toggleNode,
} from './transcript'

/**
 * 構造化ビューのストア（テスト計画フェーズ5「ストア」「TranscriptTree」）。
 *
 * ここが守るべき約束は3つ。
 * - 同じノードIDは**上書き**（ツールコールは結果が届いてから送り直される）
 * - 平らにした並びが**展開状態を反映**する（掘れる表示の土台）
 * - 巻き戻しで**全部捨てる**
 */

const CARD = '11111111-2222-3333-4444-555555555555'

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

function node(id: string, parent: string | null, inner: Node): TreeNode {
  return { id, parent, node: inner, ts: 0 }
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
