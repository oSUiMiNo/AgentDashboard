/**
 * まだ読まれていない追加メッセージが履歴に出るところ
 * （作業中に送った追加メッセージ テスト計画フェーズ4）。
 *
 * # なぜ描画まで通して見るのか
 *
 * 種別を1つ足すと腕を書く場所が5つあるが、**型検査が落ちるのは2つだけ**
 * （`heading` / `summary`）。`showsHeading` / `showsBodyAlways` / `RowBody` は
 * 真偽値か `default` 付きの switch なので、**腕を書き忘れても黙って通る**。
 * だから関数を個別に呼ぶのではなく**出てきた画面**を見る（画像の行と同じ理由）。
 *
 * # 消えることが要件の半分である
 *
 * 単一ノードを消す経路は経路上のどこにも無いので、読まれた待ちは
 * **`taken` を立てて行から落とす**（設計§4）。ここが効かないと、読まれたあとに
 * **同じ本文が2つ並ぶ**——このイシューがいちばん避けたい形になる。
 *
 * # 「出ない」と「まだ出ていない」を取り違えない
 *
 * ストアは `requestAnimationFrame` の周期でまとめて反映する。**rAF を潰して同期に
 * しようとしてはいけない**——仮想化の末尾追従（`TranscriptTree.tsx`）も rAF を使って
 * いるので、部品ごと壊れる（実際に一度そうした）。**無いことを言う前に、必ず
 * 出るものを1つ待つ。**
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TreeNode } from '@/lib/protocol'
import { TranscriptTree } from './TranscriptTree'
import { appendNodes, clearAllTranscripts } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'

const CARD = '11111111-2222-3333-4444-555555555555'

function 待ち(text: string, taken = false, id = 'queue:s1:0'): TreeNode {
  return {
    id,
    parent: null,
    node: { kind: 'queued_message', text, taken },
    ts: 0,
    branch: 0,
  }
}

function 発言(text: string, id = 'u1'): TreeNode {
  return {
    id,
    parent: null,
    node: { kind: 'user_message', text },
    ts: 1,
    branch: 0,
  }
}

beforeEach(() => {
  clearAllTranscripts()
  useWsStore.setState({ subscribeTranscript: () => () => {} } as never)
})

afterEach(() => {
  clearAllTranscripts()
})

function 置く(...nodes: TreeNode[]) {
  appendNodes(CARD, nodes)
  render(<TranscriptTree cardId={CARD} />)
}

const 待ちの行 = () =>
  document.querySelectorAll('[data-testid="transcript-row"][data-kind="queued_message"]')

describe('待機中の行', () => {
  it('見出しと記号が出る', async () => {
    置く(待ち('イシューの設計を進めて'))
    await screen.findByText('待機中')
    // **新しい記号を作らない。** ツールの実行中と同じ `…`（設計§7-2）
    expect(screen.getByTestId('tool-status').textContent).toBe('…')
  })

  it('吹き出しにならない（人の発言の器へ入れない）', async () => {
    // 記録が「誰が書いたか」を名乗っていないものを、人の発言と同じ器へ入れない（設計§3-1）。
    // ここが崩れると、姉妹イシューが塗りに来る面と取り合う
    置く(待ち('イシューの設計を進めて'))
    await screen.findByText('待機中')
    expect(screen.queryByTestId('user-bubble')).toBeNull()
  })

  it('畳んでいても本文の先頭1行が出る', async () => {
    // **「待機中」だけの行にしない**（設計§7-3 の床）。何が待っているのか読めないと、
    // 送った本人への手応えにならない
    置く(待ち('1行目の指示\n2行目は畳まれている'))
    await screen.findByText('1行目の指示')
    expect(screen.queryByText(/2行目は畳まれている/)).toBeNull()
  })

  it('琥珀が減光されていない（弱くする規則には下限がある）', async () => {
    // `/60` を掛けると未知のレコードより弱くなり、`DESIGN.md` §34.5 の
    // 「抑制のしすぎ」へ落ちる（設計§7-3 の床）
    置く(待ち('イシューの設計を進めて'))
    const label = await screen.findByText('待機中')
    expect(label.className).toContain('text-amber-300')
    expect(label.className).not.toContain('/60')
  })

  it('開ける行として出る', async () => {
    置く(待ち('1行目の指示\n2行目'))
    await waitFor(() => expect(待ちの行()).toHaveLength(1))
    expect(待ちの行()[0].getAttribute('data-expandable')).toBe('true')
  })
})

describe('読まれたら消える', () => {
  it('taken が立つと行にならない', async () => {
    // **目印を一緒に置く。** 無いことを言う前に、出るものを1つ待たないと
    // 「落とせた」と「まだ描かれていない」を取り違える
    置く(待ち('もう読まれた', true), 発言('目印'))
    await screen.findByText('目印')
    expect(待ちの行()).toHaveLength(0)
    expect(screen.queryByText('待機中')).toBeNull()
  })

  it('待ちと本物が同じ一括反映で来ても、同じ本文が2つ並ばない', async () => {
    // パーサは合図(a)（同じ本文の発言が出た）で、**同じバッチの中で**畳む（設計§4-1）。
    // 落とす判断が効いていないと、ここで2つ並ぶ
    置く(待ち('イシューの設計を進めて', true), 発言('イシューの設計を進めて'))
    await screen.findByText('イシューの設計を進めて')
    expect(screen.getAllByText('イシューの設計を進めて')).toHaveLength(1)
    expect(待ちの行()).toHaveLength(0)
  })

  it('畳んだ待ちが混ざっても、巻き戻しの見出しが出ない', async () => {
    // 落とす位置を間違えると、**中身の無い「巻き戻し」の見出し**が出る
    置く(待ち('もう読まれた', true), 発言('目印'))
    await screen.findByText('目印')
    expect(screen.queryByTestId('rewound-toggle')).toBeNull()
  })
})

describe('続いたときは数で言う', () => {
  // **実測ではほとんど出ない**（待ち行列の深さは9割方1）。これは模型が破綻したときに
  // 画面が埋まるのを止める歯止めで、普段の見え方を決めるものではない（設計§7-3 の天井）
  const 待ちを = (n: number) =>
    Array.from({ length: n }, (_, i) => 待ち(`指示${i}`, false, `queue:s1:${i}`))

  it('3件までは全部出る（床：ゼロにしない）', async () => {
    置く(...待ちを(3))
    await screen.findAllByText('待機中')
    expect(待ちの行()).toHaveLength(3)
    expect(document.querySelector('[data-kind="queued-more"]')).toBeNull()
  })

  it('4件以上は3行と「ほか N 件」になる', async () => {
    置く(...待ちを(5))
    await screen.findAllByText('待機中')
    expect(待ちの行()).toHaveLength(3)
    const 残り = document.querySelector('[data-kind="queued-more"]')
    expect(残り).not.toBeNull()
    expect(残り?.getAttribute('data-count')).toBe('2')
    expect(screen.getByText(/ほか 2 件/)).toBeTruthy()
  })

  it('畳んだものは数に入らない', async () => {
    // 読まれたものは並びから落ちているので、束ねの数にも入らない
    置く(待ち('済1', true, 'queue:s1:0'), 待ち('済2', true, 'queue:s1:1'), ...待ちを(2))
    await screen.findAllByText('待機中')
    expect(待ちの行()).toHaveLength(2)
    expect(document.querySelector('[data-kind="queued-more"]')).toBeNull()
  })
})
