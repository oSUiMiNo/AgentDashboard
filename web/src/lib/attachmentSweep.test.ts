import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sweepAttachments, 大きさの字 } from './attachmentSweep'

/*
  **ここが守っているのは「消すほうを既定にしない」である。**

  既定が逆でも画面は動く——**確かめるつもりで呼んだ関数が消す**ので、
  気づくのは消えたあとになる。機械は何も言わない。
*/

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      total: 2_000_000_000,
      expiring: 0,
      expiring_bytes: 0,
      over_budget: true,
      removed: 3,
      freed: 200_000_000,
      applied: false,
    }),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('添付の掃除', () => {
  it('**既定は下見。** 引数を省いたら1バイトも消さない', async () => {
    await sweepAttachments('local')

    const [url] = fetchMock.mock.calls[0]!
    // **ここが `apply=true` になったら、確かめるつもりの呼び出しが消す**
    expect(url).toContain('apply=false')
  })

  it('本番は明示したときだけ', async () => {
    await sweepAttachments('local', true)

    expect(fetchMock.mock.calls[0]![0]).toContain('apply=true')
  })

  it('断られたら理由を持ち上げる（黙って0件にしない）', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'PC が繋がっていません',
    })

    await expect(sweepAttachments('local')).rejects.toThrow(/繋がっていません/)
  })
})

describe('大きさの字', () => {
  it('桁で単位が変わる', () => {
    expect(大きさの字(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(大きさの字(200 * 1024 * 1024)).toBe('200 MB')
    expect(大きさの字(2048)).toBe('2 KB')
  })
})
