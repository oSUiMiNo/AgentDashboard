/**
 * 送った画像が履歴に出るところ（画像添付 テスト計画フェーズ5）。
 *
 * # なぜ描画まで通して見るのか
 *
 * 腕を書く場所が5つある（`heading` / `summary` / `showsHeading` / `showsBodyAlways` /
 * `RowBody`）。このうち **`showsHeading` と `showsBodyAlways` は真偽値を返すので、
 * 腕を書き忘れても型検査が黙って通る**。「畳んだときの見え方が崩れる」のはそこなので、
 * 関数を個別に呼ぶのではなく**出てきた画面**を見る。
 *
 * # 絵は `Node` に載っていない
 *
 * 載っているのは置き場所だけで、絵は生ファイルの口から取り返す（設計§10-3）。
 * だから `readBlob` を差し替えて、**取りに行ったか**と**渡した先**を見る。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Node, TreeNode } from '@/lib/protocol'
import { TranscriptTree } from './TranscriptTree'
import * as hostfs from '@/lib/hostfs'
import { appendNodes, clearAllTranscripts } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'

const CARD = '11111111-2222-3333-4444-555555555555'
const PATH = '/state/attachments/x/20260902-010203-a1b2c3d4.png'

function 画像ノード(inner: Partial<Extract<Node, { kind: 'image' }>> = {}): TreeNode {
  return {
    id: 'i1',
    parent: null,
    node: {
      kind: 'image',
      path: PATH,
      media_type: 'image/png',
      file_name: 'スクショ.png',
      ...inner,
    },
    ts: 0,
    branch: 0,
  }
}

beforeEach(() => {
  clearAllTranscripts()
  useWsStore.setState({ subscribeTranscript: () => () => {} } as never)
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:picture'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  clearAllTranscripts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function 置く(node: TreeNode) {
  appendNodes(CARD, [node])
  render(<TranscriptTree cardId={CARD} />)
}

describe('画像の行', () => {
  it('生ファイルの口から取って blob: を `<img src>` に渡す', async () => {
    // **`<img src>` に口の URL を直に渡さない。** `<img>` の失敗は理由を運べないので、
    // 断られたのか壊れているのかを画面が言えなくなる
    const readBlob = vi.spyOn(hostfs, 'readBlob').mockResolvedValue({
      url: 'blob:picture',
      bytes: 8,
      mediaType: 'image/png',
    })
    置く(画像ノード())

    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('blob:picture')
    expect(img.getAttribute('src')).not.toContain('/api/hosts/')
    expect(readBlob).toHaveBeenCalledWith(expect.any(String), PATH)
  })

  it('畳んでも絵が出る（本文を持つ種別として扱う）', async () => {
    vi.spyOn(hostfs, 'readBlob').mockResolvedValue({
      url: 'blob:picture',
      bytes: 8,
      mediaType: 'image/png',
    })
    置く(画像ノード())
    // 開く操作をしていない状態で出ていること。`showsBodyAlways` の腕が無いと
    // ここで消える（型検査は真偽値なので黙って通る）
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
  })

  it('元のファイル名が出る（ディスク上の採番した名前ではない）', async () => {
    vi.spyOn(hostfs, 'readBlob').mockResolvedValue({
      url: 'blob:picture',
      bytes: 8,
      mediaType: 'image/png',
    })
    置く(画像ノード())
    await waitFor(() => expect(screen.getByText(/スクショ\.png/)).toBeTruthy())
    // 採番した名前は出さない——押した人には何のことか分からない
    expect(screen.queryByText(/20260902-010203/)).toBeNull()
  })

  it('見出しが出る（発言と違って主ではない）', async () => {
    vi.spyOn(hostfs, 'readBlob').mockResolvedValue({
      url: 'blob:picture',
      bytes: 8,
      mediaType: 'image/png',
    })
    置く(画像ノード())
    await waitFor(() => expect(screen.getByText('画像')).toBeTruthy())
  })

  it('使い終わった blob: を捨てる', async () => {
    vi.spyOn(hostfs, 'readBlob').mockResolvedValue({
      url: 'blob:picture',
      bytes: 8,
      mediaType: 'image/png',
    })
    const view = render(<TranscriptTree cardId={CARD} />)
    appendNodes(CARD, [画像ノード()])
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
    view.unmount()
    // 忘れると、開くたびにブラウザの中で溜まる
    await waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:picture'),
    )
  })
})

describe('読み直し', () => {
  it('同じ行の置き場所が差し替わったら、前の失敗を引きずらない', async () => {
    // **同じ ID で送り直される**ことが要点（相棒レコードが置き場所を運んでくると、
    // パーサは同じ NodeId で出し直す）。そのとき**部品は作り直されない**ので、
    // 効果の入口で状態を戻さないと `error` が残り、**二度と絵が出ない**
    // （コードレビュー対応7）。
    //
    // **新しい行を足すテストでは捕まらない。** あちらは部品ごと新しくなるので、
    // 状態を戻していなくても通ってしまう（実際に一度そう書いた）
    const readBlob = vi
      .spyOn(hostfs, 'readBlob')
      .mockRejectedValueOnce(new hostfs.HostFsError(503, '応じません'))
      .mockResolvedValue({
        url: 'blob:picture',
        bytes: 8,
        mediaType: 'image/png',
      })

    render(<TranscriptTree cardId={CARD} />)
    appendNodes(CARD, [画像ノード()])
    await waitFor(() => expect(screen.getByText(/応じません/)).toBeTruthy())

    // **同じ ID のまま**置き場所だけ差し替える（相棒が届いたのと同じ形）
    appendNodes(CARD, [
      { ...画像ノード({ path: '/state/b.png' }) },
    ])

    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
    expect(screen.queryByText(/応じません/)).toBeNull()
    expect(readBlob).toHaveBeenCalledTimes(2)
  })
})

describe('出せないとき', () => {
  it('404 は「保管期間を過ぎた」と言う', async () => {
    // 添付は3カ月で掃かれるが、**記録には置き場所が残り続ける**（掃除は記録を触らない）。
    // だから古い履歴は必ずここへ来る。**壊れているのではない**ので、そう言い分ける
    vi.spyOn(hostfs, 'readBlob').mockRejectedValue(
      new hostfs.HostFsError(404, 'その場所は見つかりません'),
    )
    置く(画像ノード())
    await waitFor(() =>
      expect(screen.getByText(/保管期間を過ぎました/)).toBeTruthy(),
    )
    expect(screen.queryByText(/読めません/)).toBeNull()
  })

  it('本文の無い失敗でも、フォルダの語が出ない', async () => {
    // `reason()` の既定は「フォルダを読めませんでした」。`readBlob` が既定のままだと、
    // **画像の行の上にフォルダの話が出る**（コードレビュー対応8）
    vi.spyOn(hostfs, 'readBlob').mockRejectedValue(
      new hostfs.HostFsError(500, '画像を読めませんでした'),
    )
    置く(画像ノード())
    await waitFor(() =>
      expect(screen.getByText(/画像を読めませんでした/)).toBeTruthy(),
    )
    expect(screen.queryByText(/フォルダ/)).toBeNull()
  })

  it('404 以外は理由をそのまま出す', async () => {
    vi.spyOn(hostfs, 'readBlob').mockRejectedValue(
      new hostfs.HostFsError(403, 'この PC は他人のものです'),
    )
    置く(画像ノード())
    await waitFor(() =>
      expect(screen.getByText(/他人のものです/)).toBeTruthy(),
    )
    // **404 と同じ言い方にしない。** 期限切れと権限の話は直し方が違う
    expect(screen.queryByText(/保管期間/)).toBeNull()
  })

  it('置き場所が無いときは、絵の代わりに「残っていない」と言う', async () => {
    // claude がクリップボードから直に受けた画像には置き場所が無い（§21 読み替え1）。
    // **絵は出せないが、画像があったことは出せる**
    const readBlob = vi.spyOn(hostfs, 'readBlob')
    置く(画像ノード({ path: null }))
    await waitFor(() =>
      expect(screen.getByText(/手元に残っていません/)).toBeTruthy(),
    )
    // 取りに行きもしないこと
    expect(readBlob).not.toHaveBeenCalled()
  })
})
