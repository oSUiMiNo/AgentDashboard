/**
 * 入力欄に付けた画像のふるい（画像添付 テスト計画フェーズ5）。
 *
 * ここで見るのは**3経路が同じ形の添付を作ること**と、**運ぶ前に断ること**である。
 * どちらも `pickImages` の1関数に閉じてあるので、React を起こさずに固定できる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACCEPTED_MEDIA_TYPES,
  ACCEPT_ATTRIBUTE,
  MAX_ATTACHMENT_BYTES,
  pickImages,
  releasePreview,
} from './attachments'

/** `size` バイトぶんの中身を持つ File。**中身は見ないので詰め物でよい**。 */
function 画像(name: string, type: string, size = 8): File {
  return new File([new Uint8Array(size)], name, { type })
}

beforeEach(() => {
  // jsdom は `createObjectURL` を持たないので、呼ばれたことだけ数える
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:${Math.random()}`),
    revokeObjectURL: vi.fn(),
  })
})

describe('受け取る顔ぶれ', () => {
  it('png / jpeg / gif / webp を受け取る', () => {
    const files = [
      画像('a.png', 'image/png'),
      画像('b.jpg', 'image/jpeg'),
      画像('c.gif', 'image/gif'),
      画像('d.webp', 'image/webp'),
    ]
    const { accepted, rejected } = pickImages(files)
    expect(accepted).toHaveLength(4)
    expect(rejected).toEqual([])
  })

  it('svg は受け取らない', () => {
    // claude 側の貼り付け処理が拾わないので、置いても添付にならない（設計§17）。
    // **「置けたのに届かない」がいちばん読み解きにくい形**なので入口で断る
    const { accepted, rejected } = pickImages([
      画像('e.svg', 'image/svg+xml'),
    ])
    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toContain('e.svg')
  })

  it('画像でないものは受け取らない', () => {
    const { accepted, rejected } = pickImages([
      画像('f.txt', 'text/plain'),
      画像('g.pdf', 'application/pdf'),
    ])
    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(2)
  })

  it('種別が分からないものも断り、そう言う', () => {
    // スマホから来たものは `type` が空のことがある。**黙って通さない**
    const { accepted, rejected } = pickImages([画像('h', '')])
    expect(accepted).toEqual([])
    expect(rejected[0]).toContain('種別が分かりません')
  })

  it('`accept` は受け取る顔ぶれと同じものを並べる', () => {
    // ここがずれると、OS の選択画面には出るのにこちらが断る形になる
    expect(ACCEPT_ATTRIBUTE.split(',')).toEqual([...ACCEPTED_MEDIA_TYPES])
    expect(ACCEPT_ATTRIBUTE).not.toContain('svg')
  })
})

describe('大きさ', () => {
  it('上限ちょうどは通す', () => {
    const { accepted } = pickImages([
      画像('big.png', 'image/png', MAX_ATTACHMENT_BYTES),
    ])
    expect(accepted).toHaveLength(1)
  })

  it('上限を超えるものは運ぶ前に断る', () => {
    // **運ばせてから断らない。** 8 MiB を投げてから言われるのでは、待ったぶんが無駄になる
    const { accepted, rejected } = pickImages([
      画像('huge.png', 'image/png', MAX_ATTACHMENT_BYTES + 1),
    ])
    expect(accepted).toEqual([])
    expect(rejected[0]).toContain('上限')
  })

  it('上限はサーバと同じ 8 MiB', () => {
    // **数を字で書く。** 定数から組み立てると、壊し方を当てたときに一緒に動いて通る
    expect(MAX_ATTACHMENT_BYTES).toBe(8_388_608)
  })
})

describe('3経路が同じ形を作る', () => {
  it('落とす・貼る・選ぶで、できる添付が同じ形になる', () => {
    // 経路ごとに判定を書き分けると、片方だけ svg が通るような食い違いが生まれる。
    // **入口が1つであることを、同じ入力から同じ形が出ることで示す**
    const 同じ画像 = () => [画像('same.png', 'image/png')]
    const 落とす = pickImages(同じ画像())
    const 貼る = pickImages(同じ画像())
    const 選ぶ = pickImages(同じ画像())

    for (const 結果 of [落とす, 貼る, 選ぶ]) {
      expect(結果.accepted).toHaveLength(1)
      expect(結果.accepted[0].file.name).toBe('same.png')
      expect(結果.accepted[0].preview).toMatch(/^blob:/)
      expect(結果.rejected).toEqual([])
    }
    // 鍵は経路によらず**別々**（同じ画像を2枚付けられる）
    expect(落とす.accepted[0].id).not.toBe(貼る.accepted[0].id)
  })

  it('通ったものと断ったものが混ざっていても、通った側だけが残る', () => {
    // まとめて落としたときに**1枚駄目だと全部消える**、という形にしない
    const { accepted, rejected } = pickImages([
      画像('ok.png', 'image/png'),
      画像('ng.svg', 'image/svg+xml'),
      画像('ok2.webp', 'image/webp'),
    ])
    expect(accepted.map((one) => one.file.name)).toEqual(['ok.png', 'ok2.webp'])
    expect(rejected).toHaveLength(1)
  })
})

describe('後始末', () => {
  it('外すときに小窓の絵を捨てる', () => {
    // 忘れると、付け外しを繰り返すたびにブラウザの中で溜まる
    const { accepted } = pickImages([画像('a.png', 'image/png')])
    releasePreview(accepted[0])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(accepted[0].preview)
  })
})
