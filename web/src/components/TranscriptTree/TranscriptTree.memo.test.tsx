import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@/lib/protocol'
import { appendNodes, clearAllTranscripts } from '@/stores/transcript'

/**
 * 履歴の1行を、更新のたびに解析し直さないこと（コードレビュー対応・対応3）。
 *
 * # なぜ別のファイルにするか
 *
 * ここは `TranscriptRow` を**差し替えて**、渡ってくる props の同一性を見る。同じファイルに
 * 置くと、本物の行を必要とする既存のテストまで差し替わってしまう。
 *
 * # 何が壊れると困るのか
 *
 * 履歴が流れている間、ストアは**フレームごとに**通知する。行が `memo` で包まれていないか、
 * 包んでいても親が**毎回新しい関数**を渡していると、可視の行すべてがそのたびに
 * マークダウンを解析し直す。**2つは対で効く**ので、両方を見る。
 */

const 見たprops = vi.hoisted(() => [] as { onToggle: unknown; onToggleBody: unknown }[])

vi.mock('./TranscriptRow', () => ({
  TranscriptRow: (props: { onToggle: unknown; onToggleBody: unknown }) => {
    見たprops.push(props)
    return <div data-testid="row-stub" />
  },
}))

const { TranscriptTree } = await import('./TranscriptTree')
const { TranscriptRow: 本物の行 } = await vi.importActual<
  typeof import('./TranscriptRow')
>('./TranscriptRow')

const CARD = '11111111-2222-3333-4444-555555555555'

function node(id: string, text: string): TreeNode {
  return {
    id,
    parent: null,
    node: { kind: 'assistant_text', text },
    ts: 0,
    branch: 0,
  }
}

beforeEach(() => {
  見たprops.length = 0
  clearAllTranscripts()
})

afterEach(() => {
  clearAllTranscripts()
})

describe('履歴の1行を、更新のたびに解析し直さない', () => {
  it('行は memo で包まれている', () => {
    // 構造で見る。**外した瞬間に落ちる**ので、包み忘れが黙って戻ることが無い
    expect((本物の行 as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })

  it('行へ渡す手は、更新をまたいで同じものである', async () => {
    appendNodes(CARD, [node('a', 'はじめ')])
    render(<TranscriptTree cardId={CARD} />)
    await waitFor(() => expect(見たprops.length).toBeGreaterThan(0))
    const 最初 = 見たprops[見たprops.length - 1]!

    // 履歴が伸びた＝親が描き直される。ここで手が作り直されると memo が効かない
    appendNodes(CARD, [node('b', 'つづき')])
    await waitFor(() => expect(見たprops.length).toBeGreaterThan(2))
    const あと = 見たprops[見たprops.length - 1]!

    expect(あと.onToggle).toBe(最初.onToggle)
    expect(あと.onToggleBody).toBe(最初.onToggleBody)
  })
})
