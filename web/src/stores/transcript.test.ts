import type { Node, TreeNode } from '@/lib/protocol'
import { BODY_FOLD_LIMIT } from '@/lib/markdown'
import {
  appendNodes,
  clearAllTranscripts,
  getNode,
  getRows,
  resetTranscript,
  toggleBody,
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

/**
 * 本文の折りたたみ（テスト計画フェーズ3）。
 *
 * ここで守るべき約束は2つ。
 * - **畳む相手かどうかは、本文の長さで決まる**（子がいるかどうかではない）
 * - **本文の開閉と、子の開閉は独立している**（操作を2つに分けたことの、いちばん小さい担保）
 */
describe('本文の折りたたみ', () => {
  const short = 'あ'.repeat(BODY_FOLD_LIMIT)
  const long = 'あ'.repeat(BODY_FOLD_LIMIT + 1)

  function rowOf(id: string) {
    const row = rowsOf(CARD).find((candidate) => candidate.kind === 'node' && candidate.id === id)
    if (!row || row.kind !== 'node') {
      throw new Error(`行が無い：${id}`)
    }
    return row
  }

  it('しきい値を超えた本文だけが畳む相手になる', () => {
    appendNodes(CARD, [
      node('u1', null, { kind: 'user_message', text: short }),
      node('a1', null, { kind: 'assistant_text', text: long }),
    ])
    // ちょうどは畳まない（`foldMarkdown` と同じ境目であることの確認でもある）
    expect(rowOf('u1').foldable).toBe(false)
    expect(rowOf('a1').foldable).toBe(true)
  })

  it('本文を持たない種別は、どれだけ子がいても畳む相手にならない', () => {
    appendNodes(CARD, [
      node('t1', null, tool('ok')),
      node('s1', 't1', { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }),
      // 思考は「読まなくてよいもの」として既定で畳んである。開けば整形して全文が出るので、
      // 長さで決める規則は当てない（設計§2-4）
      node('k1', null, { kind: 'thinking', text: long }),
    ])
    // ツールコールは既定で閉じているので、子のサブエージェントは開かないと並ばない
    toggleNode(CARD, 't1')
    expect(rowOf('t1').foldable).toBe(false)
    expect(rowOf('s1').foldable).toBe(false)
    expect(rowOf('k1').foldable).toBe(false)
  })

  it('`toggleBody` で開け閉めできる', () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: long })])
    expect(rowOf('a1').bodyOpen).toBe(false)
    toggleBody(CARD, 'a1')
    expect(rowOf('a1').bodyOpen).toBe(true)
    toggleBody(CARD, 'a1')
    expect(rowOf('a1').bodyOpen).toBe(false)
  })

  it('本文の開閉と子の開閉は独立している', () => {
    // 同じ集合で持つと、`▸▾` を押した瞬間に本文まで畳まれる（＝操作を2つに分けた意味が消える）
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: long }),
      node('t1', 'a1', tool('ok')),
    ])
    expect(rowOf('a1')).toMatchObject({ expanded: true, bodyOpen: false })

    toggleBody(CARD, 'a1')
    expect(rowOf('a1')).toMatchObject({ expanded: true, bodyOpen: true })

    toggleNode(CARD, 'a1')
    expect(rowOf('a1')).toMatchObject({ expanded: false, bodyOpen: true })
  })

  it('巻き戻しと後片付けで、本文の開閉も消える', () => {
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: long })])
    toggleBody(CARD, 'a1')
    expect(rowOf('a1').bodyOpen).toBe(true)

    resetTranscript(CARD)
    appendNodes(CARD, [node('a1', null, { kind: 'assistant_text', text: long })])
    expect(rowOf('a1').bodyOpen).toBe(false)
  })
})

/**
 * この工事で**変えていない**判定（テスト計画フェーズ3「変えていないもの」）。
 *
 * `▸▾` が子へ寄るのは、**本文を `expanded` で隠さなくなった結果**であって、開閉の判定を
 * 直した結果ではない。判定を2箇所で直すと、どちらが効いているのか後から読めなくなる。
 */
describe('開閉の判定は動かしていない', () => {
  const KINDS: [string, Node][] = [
    ['user_message', { kind: 'user_message', text: 'x' }],
    ['assistant_text', { kind: 'assistant_text', text: 'x' }],
    ['thinking', { kind: 'thinking', text: 'x' }],
    ['tool_call', tool('ok')],
    ['subagent', { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }],
    ['unknown', { kind: 'unknown', record_type: 'mystery', raw: {} }],
  ]

  /** 種別 × 子の有無の総当たり。値はこの工事の**前**に観測したもの。 */
  const EXPECTED: Record<string, { expandable: [boolean, boolean]; expanded: boolean }> = {
    // [子なし, 子あり]
    user_message: { expandable: [false, true], expanded: true },
    assistant_text: { expandable: [false, true], expanded: true },
    thinking: { expandable: [true, true], expanded: false },
    tool_call: { expandable: [true, true], expanded: false },
    subagent: { expandable: [false, true], expanded: false },
    unknown: { expandable: [true, true], expanded: false },
  }

  it.each(KINDS)('%s の答えが、子の有無にかかわらず変わっていない', (name, inner) => {
    for (const [index, withChild] of [false, true].entries()) {
      clearAllTranscripts()
      const nodes = [node('n1', null, inner)]
      if (withChild) {
        nodes.push(node('n2', 'n1', tool('ok')))
      }
      appendNodes(CARD, nodes)

      const row = rowsOf(CARD).find((candidate) => candidate.kind === 'node' && candidate.id === 'n1')
      if (!row || row.kind !== 'node') {
        throw new Error('行が無い')
      }
      expect(row.expandable, `${name} / 子${withChild ? 'あり' : 'なし'}`).toBe(
        EXPECTED[name].expandable[index],
      )
      expect(row.expanded, `${name} の既定`).toBe(EXPECTED[name].expanded)
    }
  })
})

describe('規模', () => {
  it(
    '数万件でも平らにできる',
    () => {
      // **数万件はここで通す。** DOM が要らないぶん速く、ブラウザ側では踏めない大きさまで
      // 見られる。時間のしきい値は置かない——他のテストと資源を取り合うと落ちる数字は
      // 役に立たない（PJTガイドライン）。O(n²) になればテスト自体の上限で落ちる
      const nodes: TreeNode[] = []
      for (let index = 0; index < 30_000; index += 1) {
        nodes.push(node(`n${index}`, null, { kind: 'assistant_text', text: `本文 ${index}` }))
      }
      appendNodes(CARD, nodes)
      expect(rowsOf(CARD)).toHaveLength(30_000)
    },
    20_000,
  )
})
