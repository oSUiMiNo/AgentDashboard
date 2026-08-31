import type { Node, TreeNode } from '@/lib/protocol'
import { BODY_FOLD_GRACE_LINES, BODY_FOLD_LINES, BODY_FOLD_LINES_BUBBLE } from '@/lib/markdown'
import type { ActivityRow } from './transcript'
import {
  ACTIVITY_ROW_PREFIX,
  appendNodes,
  clearAllTranscripts,
  getNode,
  getRows,
  resetTranscript,
  toggleActivity,
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
  // 実効行数で作る。**猶予まで含めたところが境目**なので、そこちょうどと1行超えを並べる
  const linesOf = (count: number) => Array.from({ length: count }, () => 'あ').join('\n')
  const short = linesOf(BODY_FOLD_LINES + BODY_FOLD_GRACE_LINES)
  const long = linesOf(BODY_FOLD_LINES + BODY_FOLD_GRACE_LINES + 1)
  /** 吹き出しだけが畳まれる長さ。アシスタントの本文はまだ1段目に届いていない */
  const 吹き出しだけ = linesOf(BODY_FOLD_LINES_BUBBLE + BODY_FOLD_GRACE_LINES + 1)

  function rowOf(id: string) {
    const row = rowsOf(CARD).find((candidate) => candidate.kind === 'node' && candidate.id === id)
    if (!row || row.kind !== 'node') {
      throw new Error(`行が無い：${id}`)
    }
    return row
  }

  it('しきい値を超えた本文だけが畳む相手になる', () => {
    appendNodes(CARD, [
      node('a0', null, { kind: 'assistant_text', text: short }),
      node('a1', null, { kind: 'assistant_text', text: long }),
    ])
    // 猶予まで含めてちょうどは畳まない（`foldDecision` と同じ境目であることの確認でもある）。
    // **同じ器どうしで比べる**——1段目は器ごとに違うので、種別を混ぜると境目が2つになる
    expect(rowOf('a0').foldable).toBe(false)
    expect(rowOf('a1').foldable).toBe(true)
  })

  it('1段目だけが器ごとに違い、猶予は同じ（設計§4-6）', () => {
    // **数字が2つあるのは書き忘れではない。** 実効行数は代表幅80桁で数えるが、吹き出しの
    // 幅は本文の70%が上限なので、同じ実効行数でも吹き出しのほうが実際には高い。
    // 75 × 0.7 ≒ 52.5 → 50 で「同じ高さで畳まれる」ように揃えてある
    appendNodes(CARD, [
      node('u2', null, { kind: 'user_message', text: short }),
      node('a2', null, { kind: 'assistant_text', text: short }),
      node('u3', null, { kind: 'user_message', text: long }),
      node('a3', null, { kind: 'assistant_text', text: long }),
    ])
    // 1段目を超えれば、どちらも畳まれる
    expect(rowOf('u3').foldable).toBe(true)
    expect(rowOf('a3').foldable).toBe(true)
    // `short` はアシスタントの猶予ちょうど＝畳まないが、**吹き出しは既に超えている**
    expect(rowOf('a2').foldable).toBe(false)
    expect(rowOf('u2').foldable).toBe(true)
  })

  it('吹き出しだけが先に畳まれる境目がある（設計§4-6）', () => {
    // ストア側が種別を渡していないと、ここで両方とも `false` になる
    appendNodes(CARD, [
      node('u4', null, { kind: 'user_message', text: 吹き出しだけ }),
      node('a4', null, { kind: 'assistant_text', text: 吹き出しだけ }),
    ])
    expect(rowOf('u4').foldable).toBe(true)
    expect(rowOf('a4').foldable).toBe(false)
  })

  it('本文を持たない種別は、どれだけ子がいても畳む相手にならない', () => {
    appendNodes(CARD, [
      node('t1', null, tool('ok')),
      node('s1', 't1', { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }),
      // 思考は「読まなくてよいもの」として既定で畳んである。開けば整形して全文が出るので、
      // 長さで決める規則は当てない（設計§2-4）
      node('k1', null, { kind: 'thinking', text: long }),
    ])
    // ツールコールは**根の直下でも**まとめ行へ束ねられる（設計§2-3）。開かないと行が並ばない
    toggleActivity(CARD, `${ACTIVITY_ROW_PREFIX}t1`)
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

  /**
   * 種別 × 子の有無の総当たり。
   *
   * **判定式（`isExpandable`）は1文字も変えていない。** 変わったのは**渡す引数**だけで、
   * 活動の子は「開けば出るもの」として数えなくなった（設計§2-5）——子がまとめ行へ移る
   * ためである。
   *
   * **「子あり」が偽へ反転したのは、本文を持つ2種別だけ。** 子として付けているのが
   * `tool_call` 1件＝**100%活動**なので、渡す引数が偽になる。`assistant_text` の行が
   * これで**要望1（本文にトグルを出さない）を自動的に満たす**。
   *
   * **`subagent` は反転しない。** 全種別へ当てると、子がツールコールだけのサブエージェントが
   * 開けなくなり、その下のまとめ行へ辿り着けなくなる。残り3種別（`thinking` ／ `tool_call` ／
   * `unknown`）は**種別そのものが判定式のフォールバックに入っている**ので動かない。
   */
  const EXPECTED: Record<string, { expandable: [boolean, boolean]; expanded: boolean }> = {
    // [子なし, 子あり]
    user_message: { expandable: [false, false], expanded: true },
    assistant_text: { expandable: [false, false], expanded: true },
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

      // 活動そのもの（ツールコール・未知）は1件でもまとめ行へ束ねられるので、
      // 開かないと実ノードの行が並ばない（設計§2-3）
      const bundled = rowsOf(CARD).find(
        (candidate) => candidate.kind === 'activity' && candidate.members.includes('n1'),
      )
      if (bundled) {
        toggleActivity(CARD, bundled.id)
      }

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

/**
 * 発言と発言の間の活動を1行に束ねる（テスト計画フェーズ3・設計§2・§3）。
 *
 * **仮想化の跳ねは目で見ても再現しにくい**ので、`id` が不変であることはここで機械が見る。
 */
describe('活動をまとめた行', () => {
  /** アシスタント本文1つと、その下の活動。いちばんよく使う形。 */
  const said = (id: string, text = 'やります') =>
    node(id, null, { kind: 'assistant_text', text })

  /** 差分の付いた編集の結果。`structuredPatch` があるものだけが合計に入る（設計§3-2）。 */
  function edit(path: string, added: number, removed: number): Node {
    return {
      kind: 'tool_call',
      name: 'Edit',
      input: { file_path: path },
      result: {
        filePath: path,
        originalFile: 'もとの中身',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: removed,
            newStart: 1,
            newLines: added,
            lines: [
              ...Array.from({ length: added }, (_, index) => `+足した ${index}`),
              ...Array.from({ length: removed }, (_, index) => `-消した ${index}`),
            ],
          },
        ],
      },
      status: 'ok',
      subagent: null,
    }
  }

  function activities(): ActivityRow[] {
    return rowsOf(CARD).filter((row): row is ActivityRow => row.kind === 'activity')
  }

  function activityOf(index = 0): ActivityRow {
    const row = activities()[index]
    if (!row) {
      throw new Error(`まとめ行が無い：${index}`)
    }
    return row
  }

  function nodeRowOf(id: string) {
    const row = rowsOf(CARD).find((candidate) => candidate.kind === 'node' && candidate.id === id)
    if (!row || row.kind !== 'node') {
      throw new Error(`行が無い：${id}`)
    }
    return row
  }

  describe('まとめる規則', () => {
    it('同じ親の下で連続する活動が、1行にまとまる', () => {
      appendNodes(CARD, [
        said('a1'),
        node('t1', 'a1', tool('ok')),
        node('t2', 'a1', tool('ok')),
        node('t3', 'a1', tool('ok')),
      ])
      expect(activities()).toHaveLength(1)
      expect(activityOf().members).toEqual(['t1', 't2', 't3'])
    })

    it('ツールコールと未知のレコードが混ざっても、1行のままである', () => {
      appendNodes(CARD, [
        said('a1'),
        node('t1', 'a1', tool('ok')),
        node('x1', 'a1', { kind: 'unknown', record_type: 'mystery', raw: {} }),
        node('t2', 'a1', tool('ok')),
      ])
      expect(activities()).toHaveLength(1)
      expect(activityOf().members).toEqual(['t1', 'x1', 't2'])
      expect(activityOf().counts.unknown).toBe(1)
    })

    it('発言が境目になり、親が変われば別のまとめ行になる', () => {
      appendNodes(CARD, [
        said('a1', 'A'),
        node('t1', 'a1', tool('ok')),
        node('t2', 'a1', tool('ok')),
        said('a2', 'B'),
        node('t3', 'a2', tool('ok')),
      ])
      expect(activities().map((row) => row.members)).toEqual([['t1', 't2'], ['t3']])
    })

    it('親をまたいでまとめない（根の直下の活動と、発言の下の活動）', () => {
      // パーサは直前にアシスタント本文が無ければツールコールを根の直下へ置く。
      // 根の並びも束ねる相手だが、親が違う以上ひとつにしない
      appendNodes(CARD, [node('t0', null, tool('ok')), said('a1'), node('t1', 'a1', tool('ok'))])
      expect(activities().map((row) => row.members)).toEqual([['t0'], ['t1']])
    })

    it('同じ親の下でも、間に別の種別が挟まれば別のまとめ行になる', () => {
      // 束ねるのは**連続する**並びである。飛び石を1つにまとめると、間に挟まったものが
      // どちらのまとまりに属するのか読めなくなる
      appendNodes(CARD, [
        said('a1'),
        node('t1', 'a1', tool('ok')),
        node('k1', 'a1', { kind: 'thinking', text: '考え中' }),
        node('t2', 'a1', tool('ok')),
      ])
      expect(activities().map((row) => row.members)).toEqual([['t1'], ['t2']])
    })

    it('活動が1件でも、まとめ行になる', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      expect(activityOf().members).toEqual(['t1'])
    })

    it('サブエージェントの中でも、同じ規則が効く', () => {
      appendNodes(CARD, [
        said('a1'),
        node('t1', 'a1', tool('ok')),
        node('s1', 't1', { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }),
        node('sa1', 's1', { kind: 'assistant_text', text: '中の発言' }),
        node('st1', 'sa1', tool('ok')),
        node('st2', 'sa1', tool('ok')),
      ])
      toggleActivity(CARD, `${ACTIVITY_ROW_PREFIX}t1`)
      toggleNode(CARD, 't1')
      toggleNode(CARD, 's1')
      const inner = activities().find((row) => row.members.includes('st1'))
      expect(inner?.members).toEqual(['st1', 'st2'])
    })

    it('発言・思考・サブエージェントは、まとめ行に入らない', () => {
      appendNodes(CARD, [
        node('u1', null, { kind: 'user_message', text: 'x' }),
        said('a1'),
        node('k1', null, { kind: 'thinking', text: 'x' }),
        node('t1', null, tool('ok')),
        node('s1', 't1', { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }),
      ])
      expect(activities().map((row) => row.members)).toEqual([['t1']])
      toggleActivity(CARD, `${ACTIVITY_ROW_PREFIX}t1`)
      toggleNode(CARD, 't1')
      // サブエージェントが出てきても、新しいまとめ行にはならない
      expect(activities().map((row) => row.members)).toEqual([['t1']])
    })
  })

  describe('id の安定', () => {
    it('まとめ行の id は `#` で始まる（実ノードのIDとぶつからない）', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      expect(activityOf().id).toBe(`${ACTIVITY_ROW_PREFIX}t1`)
      expect(activityOf().id.startsWith('#')).toBe(true)
    })

    it('活動が後から増えても、まとめ行の id が変わらない', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      const before = activityOf().id
      appendNodes(CARD, [node('t2', 'a1', tool('ok')), node('t3', 'a1', tool('ok'))])
      expect(activityOf().members).toEqual(['t1', 't2', 't3'])
      expect(activityOf().id).toBe(before)
    })

    it('上に別のまとめ行が現れても、下のまとめ行の id が変わらない', () => {
      // 巻き戻し前の枝を開くと、行が**上に**増える（新しいノードは末尾にしか付かないので、
      // 上に増える形はこれで作る）
      appendNodes(CARD, [
        node('a0', null, { kind: 'assistant_text', text: '前の枝' }, 0),
        node('t0', 'a0', tool('ok'), 0),
        node('a1', null, { kind: 'assistant_text', text: '今の枝' }, 1),
        node('t1', 'a1', tool('ok'), 1),
      ])
      const before = activityOf().id
      toggleRewound(CARD)
      expect(activities().map((row) => row.members)).toEqual([['t0'], ['t1']])
      expect(activityOf(1).id).toBe(before)
    })
  })

  describe('深さと開閉', () => {
    it('まとめ行の深さは、束ねた子と同じ（親の深さ＋1）である', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      expect(nodeRowOf('a1').depth).toBe(0)
      expect(activityOf().depth).toBe(1)
    })

    it('開いても、子の深さが増えない', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      toggleActivity(CARD, activityOf().id)
      expect(activityOf().depth).toBe(1)
      expect(nodeRowOf('t1').depth).toBe(1)
    })

    it('まとめ行の開閉が、ノードの開閉と混ざらない', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      toggleActivity(CARD, activityOf().id)
      expect(activityOf().expanded).toBe(true)
      // ツールコールは既定で閉じたまま——まとめ行を開いただけでは動かない
      expect(nodeRowOf('t1').expanded).toBe(false)
      toggleNode(CARD, 't1')
      expect(nodeRowOf('t1').expanded).toBe(true)
      expect(activityOf().expanded).toBe(true)
    })

    it('アシスタント本文の expandable が偽になる（子がまとめ行へ移るため）', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      expect(nodeRowOf('a1').expandable).toBe(false)
      // 構造としては子を持っている。数えなくなったのは「開けば出るもの」のほうだけ
      expect(nodeRowOf('a1').hasChildren).toBe(true)
    })

    it('子がツールコールだけのサブエージェントも、開ける', () => {
      // 「活動の子は数えない」を**全種別へ当てると、ここが偽になる**。すると、その下の
      // まとめ行へ辿り着く道が無くなり、「サブエージェント → ツールコール → 差分と掘れる」
      // という要件そのものが壊れる（実際に踏んだ）
      appendNodes(CARD, [
        said('a1'),
        node('t1', 'a1', tool('ok')),
        node('s1', 't1', { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }),
        node('st1', 's1', tool('ok')),
      ])
      toggleActivity(CARD, `${ACTIVITY_ROW_PREFIX}t1`)
      toggleNode(CARD, 't1')
      expect(nodeRowOf('s1').expandable).toBe(true)
    })

    it('まとめ行の開閉が、描き直しをまたいで残る', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      toggleActivity(CARD, activityOf().id)
      appendNodes(CARD, [said('a2', 'あとから来た発言')])
      expect(activityOf().expanded).toBe(true)
    })
  })

  describe('差分の合計', () => {
    it('まとめ行の差分は、子の合計になる', () => {
      appendNodes(CARD, [
        said('a1'),
        node('e1', 'a1', edit('src/one.ts', 3, 1)),
        node('e2', 'a1', edit('src/two.ts', 4, 2)),
      ])
      expect(activityOf().diff).toEqual({ added: 7, removed: 3 })
      expect(activityOf().counts.edited).toEqual(['src/one.ts', 'src/two.ts'])
    })

    it('編集を1つも含まないまとめ行には、差分が出ない', () => {
      appendNodes(CARD, [said('a1'), node('t1', 'a1', tool('ok'))])
      expect(activityOf().diff).toBeNull()
      expect(activityOf().counts.ran).toBe(1)
    })

    it('`structuredPatch` が届かない子は、合計に数えない', () => {
      const truncated: Node = {
        kind: 'tool_call',
        name: 'Edit',
        input: { file_path: 'src/big.ts' },
        // 巨大な差分はパーサ側で切り詰められ、structuredPatch ごと消える
        result: { filePath: 'src/big.ts' },
        status: 'ok',
        subagent: null,
      }
      appendNodes(CARD, [
        said('a1'),
        node('e1', 'a1', edit('src/one.ts', 2, 0)),
        node('e2', 'a1', truncated),
      ])
      // 合計は実際より小さくなる。**嘘の数を出すよりよい**（設計§3-2）
      expect(activityOf().diff).toEqual({ added: 2, removed: 0 })
      // 数えられなかった子も、件数のほうには出る
      expect(activityOf().counts.edited).toEqual(['src/one.ts', 'src/big.ts'])
    })
  })

  it(
    '活動が数万件でも平らにできる',
    () => {
      // **既存の規模テストは `assistant_text` だけ**なので、束ねも差分の合計も一度も
      // 通っていない。差分は `flatten()` のたびに全部数え直しうるので、ここで通す
      const nodes: TreeNode[] = [said('a1')]
      for (let index = 0; index < 30_000; index += 1) {
        nodes.push(node(`e${index}`, 'a1', edit(`src/file${index}.ts`, 2, 1)))
      }
      appendNodes(CARD, nodes)
      expect(activityOf().members).toHaveLength(30_000)
      expect(activityOf().diff).toEqual({ added: 60_000, removed: 30_000 })
      // 無関係なノードが1件届いて作り直しても、同じ答えが同じ速さで返ること
      appendNodes(CARD, [said('a2', 'あと')])
      expect(activityOf().diff).toEqual({ added: 60_000, removed: 30_000 })
    },
    20_000,
  )
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

/**
 * 中身の無い思考を落とす（設計§8-2・§8-3）。
 *
 * **Claude Code は思考の本文を JSONL へ書かない**（暗号化された署名だけが入る）。
 * 開いても何も出ない行は壊れているのと見分けが付かないので、行にしない。
 *
 * **落とす場所が「束ねるより前」であることが、この節の主眼である。** 描くときに
 * 隠すだけでは、思考が境目として残って前後の活動が別々のまとめ行に割れる。
 */
describe('中身の無い思考', () => {
  const 空の思考 = (id: string, parent: string | null = null) =>
    node(id, parent, { kind: 'thinking', text: '' })

  it('本文が空の思考は、行にならない', () => {
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: 'ひとこと' }),
      空の思考('k1'),
      空の思考('k2'),
    ])

    expect(rowsOf(CARD)).toHaveLength(1)
    expect(rowsOf(CARD)[0].id).toBe('a1')
  })

  it('空白だけの思考も落とす（改行や全角空白を含む）', () => {
    appendNodes(CARD, [node('k1', null, { kind: 'thinking', text: ' \n　\t' })])

    expect(rowsOf(CARD)).toHaveLength(0)
  })

  /**
   * **種別で決め打っていないこと。**
   *
   * Claude Code が本文を書くようになるか、暗号化思考でないモデルを使えば中身は入る。
   * `kind === 'thinking'` で落とす実装だと、そのとき**本物の思考まで消え、しかも
   * 誰も気づかない**。ここが落ちたら、判定が種別へ寄っている。
   */
  it('本文がある思考は、今までどおり行になる', () => {
    appendNodes(CARD, [
      空の思考('k1'),
      node('k2', null, { kind: 'thinking', text: 'まず失敗を見る' }),
      空の思考('k3'),
    ])

    const rows = rowsOf(CARD)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('k2')
  })

  /**
   * **子を持つ思考は落とさない。**
   *
   * 実データでは1件も無いが、パーサは直前に出したノードを次のレコードの親にするので
   * （`transcript-parser` の `last_emitted`）、思考が親になりうる。落とすと子が
   * 置き場所を失う。
   */
  it('子を持つ思考は、本文が空でも落とさない', () => {
    appendNodes(CARD, [空の思考('k1'), node('t1', 'k1', tool('ok'))])
    toggleNode(CARD, 'k1')

    const rows = rowsOf(CARD)
    expect(rows[0].id).toBe('k1')
    // 子は落ちた思考の下に残り、まとめ行として出る
    expect(rows[1].kind).toBe('activity')
  })

  /**
   * **この節の肝。**
   *
   * 思考を挟んだ活動が、ひと続きの1つのまとめ行になること。**落とす場所を「束ねた後」へ
   * 動かすと、ここだけが落ちる**——思考が境目として残り、2つのまとめ行に割れるためである。
   */
  it('思考を挟んだ活動が、ひと続きの1つのまとめ行になる', () => {
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: '作業する' }),
      node('t1', 'a1', tool('ok')),
      node('t2', 'a1', tool('ok')),
      空の思考('k1', 'a1'),
      空の思考('k2', 'a1'),
      node('t3', 'a1', tool('ok')),
      node('t4', 'a1', tool('ok')),
      node('t5', 'a1', tool('ok')),
    ])

    const activities = rowsOf(CARD).filter((row): row is ActivityRow => row.kind === 'activity')
    expect(activities).toHaveLength(1)
    expect(activities[0].members).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('思考しか無い区間に、空のまとめ行や隙間が残らない', () => {
    appendNodes(CARD, [
      node('a1', null, { kind: 'assistant_text', text: 'ひとこと' }),
      空の思考('k1', 'a1'),
      空の思考('k2', 'a1'),
    ])

    // 子が中身の無い思考だけなら、開く操作そのものを出さない
    // （出すと「開いても何も出ない」が1つ内側で再発する）
    const [row] = rowsOf(CARD)
    expect(row.kind === 'node' && row.expandable).toBe(false)
    expect(rowsOf(CARD)).toHaveLength(1)
  })

  it('サブエージェントの中でも落ちる', () => {
    appendNodes(CARD, [
      node('s1', null, { kind: 'subagent', agent_type: 'general-purpose', spawn_depth: 1 }),
      node('t1', 's1', tool('ok')),
      空の思考('k1', 's1'),
      node('t2', 's1', tool('ok')),
    ])
    toggleNode(CARD, 's1')

    const activities = rowsOf(CARD).filter((row): row is ActivityRow => row.kind === 'activity')
    expect(activities).toHaveLength(1)
    expect(activities[0].members).toEqual(['t1', 't2'])
  })
})
