/**
 * 打ったスラッシュコマンドを押すと出るカード
 * （`人が打っていないものを、人の発言として出さない` テスト計画フェーズ12）。
 *
 * # なぜ描画まで通して見るのか
 *
 * **フロントマターの畳みは、割る側と描く側の2つが揃って初めて成立する。**
 * `splitFrontMatter` の単体（`lib/slashCommandFile.test.ts`）は「4行と数えた」
 * ことしか言わない——**数えた結果で畳んだか**は画面を見ないと分からない。
 *
 * # ファイルは `Node` に載っていない
 *
 * 載っているのは打った形だけで、中身はディスクから取り返す（設計§11-1）。
 * だから `listDir` と `readFile` を差し替えて、**取りに行ったか**と
 * **どこを探したか**を見る。
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@/lib/protocol'
import { TranscriptTree } from './TranscriptTree'
import * as hostfs from '@/lib/hostfs'
import { appendNodes, clearAllTranscripts } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'

const CARD = '11111111-2222-3333-4444-555555555555'

/** 実物と同じ形の SKILL.md（`description` が4行）。 */
const SKILL = [
  '---',
  'name: sample-skill-1',
  'description: |',
  '  1行目の説明',
  '  2行目の説明',
  '  3行目の説明',
  '  4行目の説明',
  'model: opus',
  '---',
  '',
  '# 見出し',
  '',
  '本文である。',
].join('\n')

function コマンドのノード(typed = '/sample-skill-1 引数'): TreeNode {
  return {
    id: 'c1',
    parent: null,
    node: { kind: 'user_message', text: typed, origin: { kind: 'human' }, command: { typed } },
    ts: 0,
    branch: 0,
  }
}

beforeEach(() => {
  clearAllTranscripts()
  useWsStore.setState({ subscribeTranscript: () => () => {} } as never)
})

afterEach(() => {
  clearAllTranscripts()
  vi.restoreAllMocks()
})

function 置く(node: TreeNode) {
  appendNodes(CARD, [node])
  render(<TranscriptTree cardId={CARD} />)
}

/** ホームを答え、指定した1つだけが読める形にする。 */
function 差し替える(読める: Record<string, string>) {
  const listDir = vi
    .spyOn(hostfs, 'listDir')
    .mockResolvedValue({ path: '/home/me', entries: [], truncated: false } as never)
  const readFile = vi.spyOn(hostfs, 'readFile').mockImplementation(async (_host, path) => {
    const text = 読める[path]
    if (text === undefined) {
      throw new hostfs.HostFsError(404, `${path} を開けません`)
    }
    return { path, text, truncated: false, bytes: text.length }
  })
  return { listDir, readFile }
}

describe('スラッシュコマンドのカード', () => {
  it('押すまで読みに行かない', async () => {
    // **押したときにだけ読む**（設計§11）。履歴にはコマンドがいくつも並ぶ
    const { readFile } = 差し替える({})
    置く(コマンドのノード())
    await screen.findByTestId('slash-command')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('利用者のスキルまで探して、中身を出す', async () => {
    const { readFile } = 差し替える({ '/home/me/.claude/skills/sample-skill-1/SKILL.md': SKILL })
    置く(コマンドのノード())

    await userEvent.click(await screen.findByTestId('slash-command'))
    const card = await screen.findByTestId('slash-command-card')
    await waitFor(() => expect(within(card).getByTestId('slash-command-front')).toBeInTheDocument())

    // 本文はマークダウンとして出る（`#` が字のまま残らない）
    expect(within(card).getByRole('heading', { name: '見出し' })).toBeInTheDocument()
    // どこから出たかを言う
    expect(card.textContent).toContain('利用者のスキル')
    // **PJT のコマンドから先に探した**（解決順・設計§11-2）
    expect(readFile.mock.calls.map((call) => call[1])[0]).toBe(
      '/home/me/.claude/commands/sample-skill-1.md',
    )
  })

  it('4行の項目は畳まれ、押すと開く', async () => {
    // **利用者の指定**。畳んだ姿は1行目＋`…`
    差し替える({ '/home/me/.claude/skills/sample-skill-1/SKILL.md': SKILL })
    置く(コマンドのノード())
    await userEvent.click(await screen.findByTestId('slash-command'))

    const toggle = await screen.findByTestId('front-matter-toggle')
    expect(toggle.getAttribute('data-open')).toBe('false')
    expect(toggle.textContent).toContain('1行目の説明')
    expect(toggle.textContent).toContain('…')
    // 畳んでいるあいだは4行目が出ない
    expect(toggle.textContent).not.toContain('4行目の説明')

    await userEvent.click(toggle)
    expect(toggle.getAttribute('data-open')).toBe('true')
    expect(toggle.textContent).toContain('4行目の説明')
  })

  it('3行の項目は畳まない（境目のすぐ内側）', async () => {
    // 畳んでも縮まないので、畳む仕掛けのほうが背が高くなる。
    // **3行で確かめる**——1行で書くと、下限を3へ動かしても落ちない
    const 短い 
      = ['---', 'description: |', '  1行目', '  2行目', '  3行目', 'model: opus', '---', '本文'].join('\n')
    差し替える({ '/home/me/.claude/commands/sample-skill-1.md': 短い })
    置く(コマンドのノード())
    await userEvent.click(await screen.findByTestId('slash-command'))

    const front = await screen.findByTestId('slash-command-front')
    expect(front.textContent).toContain('3行目')
    expect(screen.queryByTestId('front-matter-toggle')).not.toBeInTheDocument()
  })

  it('見つからなければ、探した場所を言う', async () => {
    // **黙って空を出さない**（設計§11-2）
    差し替える({})
    置く(コマンドのノード())
    await userEvent.click(await screen.findByTestId('slash-command'))

    const error = await screen.findByTestId('slash-command-error')
    expect(error.textContent).toContain('見つかりませんでした')
    expect(error.textContent).toContain('/home/me/.claude/commands/sample-skill-1.md')
    expect(error.textContent).toContain('/home/me/.claude/skills/sample-skill-1/SKILL.md')
  })

  it('名前を取れない打ち方は、読みに行かずに断る', async () => {
    // 関所を通らないものでディスクを叩かない
    const { readFile } = 差し替える({})
    置く(コマンドのノード('/../../etc/passwd'))
    await userEvent.click(await screen.findByTestId('slash-command'))

    const error = await screen.findByTestId('slash-command-error')
    expect(error.textContent).toContain('コマンドの名前を取れませんでした')
    expect(readFile).not.toHaveBeenCalled()
  })
})
