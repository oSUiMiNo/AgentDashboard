import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { 原寸を測る, 貼るときのブロック, 貼るときの幅, 画像を運ぶ } from './memoImage'

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

  /*
    **作ったら捨てる**（レビュー対応4）。

    `pickImages` は**通した1枚ごとに object URL を1本作る**。ここは `bytes` しか
    使わないので、**捨てなければ貼るたびに溜まり、タブの寿命いっぱい残る**。

    **メモ側のファイルを `createObjectURL` で引くと0件**なので、ここで止めると
    「割り当てが無いのだから漏れようがない」と読める——**割り当ては1つ下の共有
    ヘルパに在る。** 呼び先まで辿らないと見えない形だった。
  */
  it('運び終えたら object URL を捨てる（成功したとき）', async () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: revoke })

    await 画像を運ぶ(置き場所, 画像('image/png'))

    expect(revoke).toHaveBeenCalledWith('blob:x')
  })

  it('運びに失敗しても object URL を捨てる', async () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:y', revokeObjectURL: revoke })
    uploadAttachment.mockRejectedValueOnce(new Error('置けません'))

    await expect(画像を運ぶ(置き場所, 画像('image/png'))).rejects.toThrow()

    // **失敗した道でも捨てる。** 捨て漏らすのは、たいてい例外の側である
    expect(revoke).toHaveBeenCalledWith('blob:y')
  })
})

/*
  **貼った直後の幅**（利用者の要望・2026-09-14「初期は横幅の4割サイズで貼ってほしい」）。

  **ここも「誰も捕まえない」側である。** `previewWidth` を載せ忘れても、原寸より
  大きく載せても、コンパイラは何も言わない——画面は動いたまま、**絵の大きさだけが
  間違う。** jsdom は CSS を1バイトも当てないので見た目そのものは確かめられないが、
  **ブロックへ入る数字**はここで固定できる。
*/

/** 原寸を測る口を差し替える。**jsdom には `createImageBitmap` が無い。** */
function 原寸が(幅: number | undefined): void {
  if (幅 === undefined) {
    vi.stubGlobal('createImageBitmap', undefined)
    return
  }
  vi.stubGlobal('createImageBitmap', async () => ({ width: 幅, height: 1, close: vi.fn() }))
}

describe('貼った直後の幅', () => {
  it('入る幅の4割になる', () => {
    // **800 の4割は 320。** 原寸のほうが広いので、頭打ちには当たらない
    expect(貼るときの幅(800, 1920)).toBe(320)
  })

  it('原寸を超えない（小さい絵を引き伸ばさない）', () => {
    /*
      **いま正しく出ているものを動かさない。** 4割を素直に入れると 100px の
      アイコンが 320px へ膨らむ——器の幅がそのまま `<img>` の幅になるので、
      **この変更で初めて壊れる**側である。
    */
    expect(貼るときの幅(800, 100)).toBe(100)
  })

  it('掴み手が許す下限（64px）を下回らない', () => {
    // **人が掴んで作れる幅の中に収める。** 100 の4割は 40 で、掴んでも作れない
    expect(貼るときの幅(100, 1920)).toBe(64)
  })

  it('下限より原寸が小さければ、原寸が勝つ（それでも引き伸ばさない）', () => {
    expect(貼るときの幅(100, 32)).toBe(32)
  })

  it('入る幅が測れなければ、何も入れない（いままでどおりに倒す）', () => {
    /*
      **4割だけを入れる道へ倒さない。** 原寸が測れていない絵に割合だけを当てると、
      **無かった壊れ方（引き伸ばし）が増える**——要望が通らないだけより悪い。
    */
    expect(貼るときの幅(undefined, 1920)).toBeUndefined()
    expect(貼るときの幅(0, 1920)).toBeUndefined()
    expect(貼るときの幅(Number.NaN, 1920)).toBeUndefined()
  })

  it('原寸が測れなければ、何も入れない', () => {
    expect(貼るときの幅(800, undefined)).toBeUndefined()
    expect(貼るときの幅(800, 0)).toBeUndefined()
    expect(貼るときの幅(800, Number.NaN)).toBeUndefined()
  })
})

describe('原寸を測る', () => {
  it('横の実寸を返す', async () => {
    原寸が(1920)

    expect(await 原寸を測る(new Blob([new Uint8Array(4)]))).toBe(1920)
  })

  it('**測ったら捨てる。** 残すと貼るたびに1枚ずつ溜まる', async () => {
    // **この模組の `画像を運ぶ` と同じ約束**（object URL を捨てるのと同じ理由）
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', async () => ({ width: 10, height: 1, close }))

    await 原寸を測る(new Blob([new Uint8Array(4)]))

    expect(close).toHaveBeenCalledTimes(1)
  })

  it('口が無ければ `undefined`（投げない）', async () => {
    原寸が(undefined)

    expect(await 原寸を測る(new Blob([new Uint8Array(4)]))).toBeUndefined()
  })
})

describe('貼った直後にブロックへ渡すもの', () => {
  it('**幅を載せて返す。** 載せないと必ず横幅いっぱいになる', async () => {
    原寸が(1920)

    const 渡すもの = await 貼るときのブロック(画像('image/png'), '/api/memo-blobs/b1', 800)

    // **文字列で返すと、エディタは URL しか入れない**——`previewWidth` は既定の
    // `undefined` のままになり、器が `fit-content` ＝ 横幅いっぱいに伸びる
    expect(渡すもの).toEqual({
      props: { name: 'x.png', url: '/api/memo-blobs/b1', previewWidth: 320 },
    })
  })

  it('`name` も一緒に載せる（物体を返すと経路によって落ちるため）', async () => {
    /*
      **文字列を返したときだけ**、選ぶ経路（ファイルの面）はエディタ側で
      `{ props: { name, url } }` を組み立てている。物体を返すとその組み立てを
      通らないので、**載せ忘れると絵の名前（`alt`）だけが経路によって消える。**
    */
    原寸が(1920)

    const 渡すもの = await 貼るときのブロック(画像('image/png'), '/u', 800)

    expect(渡すもの).toHaveProperty('props.name', 'x.png')
  })

  it('原寸が測れなければ、URL の文字列のまま返す（いままでと同じ道）', async () => {
    // **`createImageBitmap` が無い環境がある**（jsdom・古い WebView）
    原寸が(undefined)

    expect(await 貼るときのブロック(画像('image/png'), '/u', 800)).toBe('/u')
  })

  it('原寸を測れずに投げても、貼りは通す', async () => {
    /*
      **運び終えた絵を、幅が測れないという理由で捨てない。** ここで投げると
      エディタは失敗として扱い、**サーバに置かれた絵だけが残って本文には入らない。**
    */
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('decode できません')
    })

    expect(await 貼るときのブロック(画像('image/png'), '/u', 800)).toBe('/u')
  })
})
