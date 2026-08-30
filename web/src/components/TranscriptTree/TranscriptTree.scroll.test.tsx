import { render, screen, waitFor } from '@testing-library/react'
import type { Node, TreeNode } from '@/lib/protocol'
import { appendNodes, clearAllTranscripts } from '@/stores/transcript'

/**
 * 開いたら、いちばん下（最新）から見せる（設計§3・テスト計画フェーズ2）。
 *
 * # なぜ別のファイルにするか
 *
 * ここは `useVirtualizer` を**差し替えて**、寄せる指示が何回出たかを見る。同じファイルに
 * 置くと、**本物の仮想化を要る既存のテストまで差し替わってしまう**。
 * `TranscriptTree.memo.test.tsx` が同じ理由でファイルを分けている。
 *
 * # 測るのは位置ではなく回数
 *
 * jsdom はレイアウトを持たないので **`scrollHeight` も `Element.prototype.scrollTo` も
 * 無い**（`src/test/setup.ts` が埋めているのは `clientHeight` の類だけ）。したがって
 * 「実際に末尾へ着いたか」はここでは測れない——**それは E2E の持ち場**である。
 *
 * だから `scrollToEnd` は**記録するだけで本物へ委譲しない**。委譲すると jsdom に無い
 * `scrollTo` へ落ちて、確かめたいこととは無関係な理由で落ちる。
 *
 * # 「隠れている間は寄せない」は、ここでは確かめない
 *
 * 横並び（PJT 専用画面）で構造化ビューが `hidden` のまま履歴を受け取る場面（設計§7）は、
 * **この層では作れなかった。** `clientHeight` を要素へ再定義して隠したつもりでも、
 * 実装が読む値には反映されず寄せる指示が出る（実測）。**jsdom には `display: none` の
 * レイアウトが無いので、手で作った擬装は本物の代わりにならない。**
 *
 * **確かめる先は E2E にある**——`e2e/transcript.spec.ts`
 * 「横並びでは、構造化ビューへ切り替えたときに末尾から見える」が、実ブラウザで
 * 「隠れている間は寄せず、表示した瞬間に寄せる」ことをそのまま見ている。
 *
 * # 「落ち着いたら二度と寄せない」も、ここでは確かめない
 *
 * 同じ理由による。**印が立つ条件は「背が伸びなくなって末尾に居る」こと**だが、
 * jsdom の `scrollHeight` は常に 0 で、伸びも縮みも起きない——**落ち着いたかどうかを
 * 表現できる材料が無い**。実測でも、落ち着きを待ってから追記すると寄せる回数が増えた。
 *
 * **確かめる先はやはり E2E**——「遡っている最中に履歴が増えても、引き戻されない」が、
 * 実ブラウザで「上を読んでいる人は追記が来ても引き戻されない」ことを見ている。
 * こちらのほうが**要件が言っていることそのもの**でもある（要件「守ること」）。
 */

const 記録 = vi.hoisted(() => ({
  寄せた: [] as unknown[],
  // `useVirtualizer` は同じインスタンスを返し続けるので、包みが二重に積まれないよう見張る
  包んだ: new WeakSet<object>(),
}))

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual')
  return {
    ...actual,
    useVirtualizer: ((options: never) => {
      const instance = actual.useVirtualizer(options) as unknown as {
        scrollToEnd: (...args: unknown[]) => void
      }
      if (!記録.包んだ.has(instance)) {
        記録.包んだ.add(instance)
        instance.scrollToEnd = (...args: unknown[]) => {
          記録.寄せた.push(args)
        }
      }
      return instance
    }) as unknown as typeof actual.useVirtualizer,
  }
})

const { TranscriptTree } = await import('./TranscriptTree')

const CARD = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  clearAllTranscripts()
  記録.寄せた.length = 0
})

afterEach(() => {
  clearAllTranscripts()
})

function node(id: string, inner: Node): TreeNode {
  return { id, parent: null, node: inner, ts: 0, branch: 0 }
}

function 会話(...ids: string[]): TreeNode[] {
  return ids.map((id) => node(id, { kind: 'assistant_text', text: `本文 ${id}` }))
}

/** ストアは rAF でまとめてから反映するので、描画が追いつくまで待つ。 */
async function 行が出るまで(count: number) {
  await waitFor(() => {
    expect(screen.getByTestId('transcript-status').dataset.rowCount).toBe(String(count))
  })
}

/** 寄せる指示が出るまで待つ。 */
async function 寄せるまで() {
  await waitFor(() => {
    expect(記録.寄せた.length).toBeGreaterThan(0)
  })
}


describe('開いたら末尾から見せる', () => {
  it('行が届いたら、末尾へ寄せる', async () => {
    render(<TranscriptTree cardId={CARD} />)
    expect(記録.寄せた).toHaveLength(0)

    appendNodes(CARD, 会話('a1', 'a2', 'a3'))
    await 行が出るまで(3)
    await 寄せるまで()
  })

  it('最初から行がある状態でマウントしても、末尾へ寄せる', async () => {
    // **ストアは module スコープで、unmount しても消えない**（設計§2-2）。別のページから
    // 戻ってきたときはこの形になり、「0件→N件」という増加が一度も観測されない。
    // `appendNodes` は rAF でまとめるので、**描く前に**入り切るのを待つ
    appendNodes(CARD, 会話('a1', 'a2', 'a3'))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    render(<TranscriptTree cardId={CARD} />)
    await 行が出るまで(3)
    await 寄せるまで()
  })

  it('行が0件のままなら、一度も寄せない', async () => {
    render(<TranscriptTree cardId={CARD} />)
    expect(screen.getByText(/まだ履歴がありません/)).toBeInTheDocument()

    // 少し待っても出ないこと。**壊れないことも同時に見ている**（要件「履歴が0件の
    // セッションでも壊れないこと」）
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(記録.寄せた).toHaveLength(0)
  })

})
