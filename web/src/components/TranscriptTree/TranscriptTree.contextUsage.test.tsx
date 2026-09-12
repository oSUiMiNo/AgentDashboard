/**
 * `/context` の報告を絵で出す（コンテキストの残量 テスト計画フェーズ6）。
 *
 * # なぜ描画まで通して見るのか
 *
 * 分類（`machineMessage.test.ts`）と読み取り（`contextReport.test.ts`）は
 * それぞれ単体で落ちる。**しかし2つが緑でも、`head` へ差す配線が抜けていれば
 * 画面には何も出ない**——繋がっていることを見られるのはここだけである。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TreeNode } from '@/lib/protocol'
import { TranscriptTree } from './TranscriptTree'
import { appendNodes, clearAllTranscripts, toggleBody } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'

const CARD = '11111111-2222-3333-4444-555555555555'

/**
 * 実物の骨格。**末尾の表は合成である**——実物には利用者の MCP ツール・
 * カスタムエージェント・スキルの**実名**が並ぶので、このリポジトリ（公開設定）
 * へ持ち込まない。
 */
const 使い具合 = [
  '## Context Usage',
  '',
  '**Model:** claude-opus-5',
  '**Tokens:** 241.5k / 1m (24%)',
  '',
  '### Estimated usage by category',
  '',
  '| Category | Tokens | Percentage |',
  '|----------|--------|------------|',
  '| System prompt | 4.3k | 0.4% |',
  '| Free space | 758.5k | 75.9% |',
  '',
  '### MCP tools',
  '',
  '| Tool | Tokens |',
  '|------|--------|',
  '| example__alpha | 1.2k |',
].join('\n')

function 差し込まれた文(text: string, id = 'u1'): TreeNode {
  return {
    id,
    parent: null,
    node: { kind: 'user_message', text, origin: { kind: 'injected' }, command: null },
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

describe('/context の報告を絵で出す', () => {
  it('絵が出て、合計と内訳が読める', async () => {
    置く(差し込まれた文(使い具合))
    const カード = await screen.findByTestId('context-usage-card')
    expect(カード).toHaveTextContent('24%')
    expect(カード).toHaveTextContent('241.5k / 1m')
    expect(within(カード).getByText('System prompt')).toBeTruthy()
  })

  it('対象は `## Context Usage` の1種だけ——他の機械メッセージには出ない', async () => {
    // **他のローカルコマンド出力の描き方を変えていない**（要件の「やらないこと」）
    置く(差し込まれた文('<local-command-stdout>Login successful</local-command-stdout>', 'u2'))
    // **行が出るまで待ってから見る。** 待たずに `null` を確かめると、描画が
    // 間に合っていないだけで通る——**空振りする形**である（実際に一度踏んだ）
    await waitFor(() => expect(screen.getAllByTestId('transcript-row').length).toBe(1))
    expect(screen.queryByTestId('context-usage-card')).toBeNull()
  })

  it('絵は開閉の記号を持たない——畳みは既存の仕掛けが担う', async () => {
    // **新しい畳み方・新しい記号を作っていない**（設計§8）。原文の開閉は
    // `MarkdownBody` の仕組みがそのまま担うので、絵の側は状態も記号も持たない
    置く(差し込まれた文(使い具合))
    const カード = await screen.findByTestId('context-usage-card')
    expect(カード.textContent).not.toContain('›')
    expect(カード.textContent).not.toContain('⌄')
    expect(カード.querySelector('button')).toBeNull()
  })

  it('原文は捨てていない——開けば末尾の表まで読める', async () => {
    置く(差し込まれた文(使い具合))
    await screen.findByTestId('context-usage-card')
    // 畳んでいるあいだは末尾の表が出ていない（長さの正体がここ）。
    //
    // **探すのは見出しにする。** 表のセル（`example__alpha`）はマークダウンの
    // 強調記法（`__`）に食われて要素が割れるので、字で探すと当たらない
    expect(screen.queryByText('MCP tools')).toBeNull()
    // **開く操作は既存の仕掛けをそのまま呼ぶ。** 絵の側は開閉を持っていないので、
    // ここで確かめたいのは「**専用の畳み方を作らずに既存へ乗れているか**」である
    toggleBody(CARD, 'u1')
    await waitFor(() => expect(screen.getByText('MCP tools')).toBeTruthy())
  })
})
