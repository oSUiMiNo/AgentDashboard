import { beforeEach, describe, expect, it, vi } from 'vitest'

import { 画像を運ぶ } from './memoImage'

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

const 置き場所 = { host: 'local', cardId: 'card-1' }

function 画像(type: string, bytes = 10): File {
  return new File([new Uint8Array(bytes)], `x.${type.split('/')[1]}`, { type })
}

beforeEach(() => {
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

  it('大きすぎるものは運ぶ前に断る（運んでから断ると待たされたぶんが無駄になる）', async () => {
    const 大きい = new File([new Uint8Array(9 * 1024 * 1024)], 'x.png', {
      type: 'image/png',
    })

    await expect(画像を運ぶ(置き場所, 大きい)).rejects.toThrow()
    expect(uploadAttachment).not.toHaveBeenCalled()
  })
})
