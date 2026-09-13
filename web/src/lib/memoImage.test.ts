import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { 画像を運ぶ } from './memoImage'

afterEach(() => {
  vi.unstubAllGlobals()
})

/*
  **ここが守っているのは「誰も捕まえない」側である**（メモ実行レポート・フェーズ3〜5）。

  ふるいを外しても、置き場所を取り違えても、**コンパイラは何も言わない**。
  エディタを立てて画像を貼る操作は jsdom で再現できないので、**この関数を直に
  叩く形でしか守れない。**
*/

const uploadAttachment = vi.fn()
vi.mock('@/lib/hostfs', async () => {
  const 本物 = await vi.importActual<typeof import('@/lib/hostfs')>('@/lib/hostfs')
  return {
    ...本物,
    uploadAttachment: (...args: unknown[]) => uploadAttachment(...args),
  }
})

const 置き場所 = { where: 'card', host: 'local', cardId: 'card-1' } as const

function 画像(type: string, bytes = 10): File {
  return new File([new Uint8Array(bytes)], `x.${type.split('/')[1]}`, { type })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      url: '/api/memo-blobs/blob-1',
      media_type: 'image/png',
      bytes: 10,
    }),
  })
  vi.stubGlobal('fetch', fetchMock)
  uploadAttachment.mockReset()
  uploadAttachment.mockResolvedValue({
    path: '/home/u/.agentdashboard/attachments/card-1/20260913-010203-abcdef01.png',
    media_type: 'image/png',
    bytes: 10,
  })
})

describe('メモへ貼る画像', () => {
  it('置き場所のカードへ運ぶ。**宛先ではなくカードIDで置く**', async () => {
    await 画像を運ぶ(置き場所, 画像('image/png'))

    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    const [host, cardId] = uploadAttachment.mock.calls[0]!
    expect(host).toBe('local')
    expect(cardId).toBe('card-1')
  })

  it('本文へ入るのは**読める URL** であって、ディスクのパスではない', async () => {
    const url = await 画像を運ぶ(置き場所, 画像('image/png'))

    // **パスをそのまま入れると、別の機械から開いたときに読めない絵になる**
    expect(url).not.toBe('/home/u/.agentdashboard/attachments/card-1/20260913-010203-abcdef01.png')
    expect(url).toContain('/api/hosts/local/file')
    expect(url).toContain('as=raw')
  })

  it('**svg は断る。** 入力欄と同じふるいを通っている証拠である', async () => {
    // **ここが落ちたら、ふるいを通っていない。** 独自に判定すると片方だけ svg が通る
    await expect(画像を運ぶ(置き場所, 画像('image/svg+xml'))).rejects.toThrow(
      /添付できません/,
    )
    expect(uploadAttachment).not.toHaveBeenCalled()
  })

  it('断りの文はそのまま持ち上げる（「置けません」に潰さない）', async () => {
    await expect(画像を運ぶ(置き場所, 画像('application/pdf'))).rejects.toThrow(
      /application\/pdf/,
    )
  })

  it('**全体メモは PC を通らない。** 記録の口へ置く', async () => {
    /*
      **帰属と保管を揃える**（メモ設計§10-1 の【決着】）。全体メモはアカウントに
      属するので、本文と同じ記録へ置く——**PC のディスクへ置くと、別の端末から
      開いたときに画像だけ欠ける**（要件10）。

      **口を取り違えても画面は動く**ので、機械は何も言わない。ここで固定する。
    */
    const url = await 画像を運ぶ({ where: 'account' }, 画像('image/png'))

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/memo-blobs')
    expect(url).toBe('/api/memo-blobs/blob-1')
  })

  it('全体メモでも、ふるいは同じものを通る（svg は断る）', async () => {
    // **要件9（同じ部品・同じ口）。** 割れるのは保管先だけである
    await expect(
      画像を運ぶ({ where: 'account' }, 画像('image/svg+xml')),
    ).rejects.toThrow(/添付できません/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('大きすぎるものは運ぶ前に断る（運んでから断ると待たされたぶんが無駄になる）', async () => {
    const 大きい = new File([new Uint8Array(9 * 1024 * 1024)], 'x.png', {
      type: 'image/png',
    })

    await expect(画像を運ぶ(置き場所, 大きい)).rejects.toThrow()
    expect(uploadAttachment).not.toHaveBeenCalled()
  })
})
