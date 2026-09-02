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
  it('png / jpeg / gif / webp を受け取る', async () => {
    const files = [
      画像('a.png', 'image/png'),
      画像('b.jpg', 'image/jpeg'),
      画像('c.gif', 'image/gif'),
      画像('d.webp', 'image/webp'),
    ]
    const { accepted, rejected } = await pickImages(files)
    expect(accepted).toHaveLength(4)
    expect(rejected).toEqual([])
  })

  it('svg は受け取らない', async () => {
    // claude 側の貼り付け処理が拾わないので、置いても添付にならない（設計§17）。
    // **「置けたのに届かない」がいちばん読み解きにくい形**なので入口で断る
    const { accepted, rejected } = await pickImages([
      画像('e.svg', 'image/svg+xml'),
    ])
    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toContain('e.svg')
  })

  it('画像でないものは受け取らない', async () => {
    const { accepted, rejected } = await pickImages([
      画像('f.txt', 'text/plain'),
      画像('g.pdf', 'application/pdf'),
    ])
    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(2)
  })

  it('種別が分からないものも断り、そう言う', async () => {
    // スマホから来たものは `type` が空のことがある。**黙って通さない**
    const { accepted, rejected } = await pickImages([画像('h', '')])
    expect(accepted).toEqual([])
    expect(rejected[0]).toContain('種別が分かりません')
  })

  it('`accept` は受け取る顔ぶれと同じものを並べる', async () => {
    // ここがずれると、OS の選択画面には出るのにこちらが断る形になる
    expect(ACCEPT_ATTRIBUTE.split(',')).toEqual([...ACCEPTED_MEDIA_TYPES])
    expect(ACCEPT_ATTRIBUTE).not.toContain('svg')
  })
})

describe('大きさ', () => {
  it('上限ちょうどは通す', async () => {
    const { accepted } = await pickImages([
      画像('big.png', 'image/png', MAX_ATTACHMENT_BYTES),
    ])
    expect(accepted).toHaveLength(1)
  })

  it('上限を超えるものは運ぶ前に断る', async () => {
    // **運ばせてから断らない。** 8 MiB を投げてから言われるのでは、待ったぶんが無駄になる
    const { accepted, rejected } = await pickImages([
      画像('huge.png', 'image/png', MAX_ATTACHMENT_BYTES + 1),
    ])
    expect(accepted).toEqual([])
    expect(rejected[0]).toContain('上限')
  })

  it('上限はサーバと同じ 8 MiB', async () => {
    // **数を字で書く。** 定数から組み立てると、壊し方を当てたときに一緒に動いて通る
    expect(MAX_ATTACHMENT_BYTES).toBe(8_388_608)
  })
})

describe('3経路が同じ形を作る', () => {
  it('落とす・貼る・選ぶで、できる添付が同じ形になる', async () => {
    // 経路ごとに判定を書き分けると、片方だけ svg が通るような食い違いが生まれる。
    // **入口が1つであることを、同じ入力から同じ形が出ることで示す**
    const 同じ画像 = () => [画像('same.png', 'image/png')]
    const 落とす = await pickImages(同じ画像())
    const 貼る = await pickImages(同じ画像())
    const 選ぶ = await pickImages(同じ画像())

    for (const 結果 of [落とす, 貼る, 選ぶ]) {
      expect(結果.accepted).toHaveLength(1)
      expect(結果.accepted[0].name).toBe('same.png')
      expect(結果.accepted[0].preview).toMatch(/^blob:/)
      expect(結果.rejected).toEqual([])
    }
    // 鍵は経路によらず**別々**（同じ画像を2枚付けられる）
    expect(落とす.accepted[0].id).not.toBe(貼る.accepted[0].id)
  })

  it('通ったものと断ったものが混ざっていても、通った側だけが残る', async () => {
    // まとめて落としたときに**1枚駄目だと全部消える**、という形にしない
    const { accepted, rejected } = await pickImages([
      画像('ok.png', 'image/png'),
      画像('ng.svg', 'image/svg+xml'),
      画像('ok2.webp', 'image/webp'),
    ])
    expect(accepted.map((one) => one.name)).toEqual(['ok.png', 'ok2.webp'])
    expect(rejected).toHaveLength(1)
  })
})

describe('安全でないオリジンでも動く', () => {
  /**
   * **`crypto.randomUUID` が無い場所がある。** スマホから
   * `http://<LAN の IP>:8787` で開くと `isSecureContext` が `false` になり、
   * `crypto.randomUUID` は `undefined` になる（実測）。呼べば例外で、
   * **画像を1枚拾った瞬間に添付の道が丸ごと死ぬ**——押しても貼っても何も起きない
   * という形で表に出た。
   *
   * **jsdom は持っているので、既存のテストは全部通っていた。** 取り上げないと
   * この穴は二度と見えない。
   */
  it('`crypto.randomUUID` が無くても添付を作れる', async () => {
    const 素のcrypto = globalThis.crypto
    vi.stubGlobal('crypto', {
      ...素のcrypto,
      randomUUID: undefined,
      getRandomValues: 素のcrypto.getRandomValues?.bind(素のcrypto),
    })

    const { accepted, rejected } = await pickImages([画像('a.png', 'image/png')])
    expect(accepted).toHaveLength(1)
    expect(accepted[0].id).toBeTruthy()
    expect(rejected).toEqual([])
  })

  it('鍵は重ならない', async () => {
    // 外すときの目印と React の鍵に使う。**同じ画像を2枚付けても別々**であること
    const { accepted } = await pickImages([
      画像('same.png', 'image/png'),
      画像('same.png', 'image/png'),
    ])
    expect(accepted[0].id).not.toBe(accepted[1].id)
  })
})

describe('元が読めなくなっても送れる形にする', () => {
  /**
   * **`File` は「その場で読める」ことを保証しない。**
   *
   * 中身はディスク（スマホなら `content://` の一時ファイル）に在り、`File` はそこへの
   * 参照でしかない。選んでから送信を押すまでの間に元が書き換わる・消える・
   * クリップボードが入れ替わると、**送ろうとした瞬間に読めなくなる**。
   *
   * Chrome はこれを `net::ERR_UPLOAD_FILE_CHANGED` で弾き、`fetch` は
   * **HTTP の応答を1つも返さないまま `TypeError: Failed to fetch` を投げる**。
   * 利用者のスマホで実際に出た（2026-09-03。2枚のうち1枚目は届き、2枚目で落ちた）。
   *
   * だから**付けた時点で写しを取る**。ここが守られているかを、
   * 「送る中身が元の `File` そのものではないこと」で固定する。
   */
  it('送る中身は、元の File そのものではない', () => {
    // **同一性で見る。** 中身の一致で見ると、写しを取らずに `file` を入れても通る
    const 元 = 画像('a.png', 'image/png')
    return pickImages([元]).then(({ accepted }) => {
      expect(accepted[0].bytes).not.toBe(元)
      expect(accepted[0].bytes.size).toBe(元.size)
      expect(accepted[0].bytes.type).toBe('image/png')
    })
  })

  it('小窓の絵も写しから作る', async () => {
    // 元から作ると、元が消えた瞬間に絵が壊れる。**送れるのに見えない**という形になる
    const 元 = 画像('a.png', 'image/png')
    const { accepted } = await pickImages([元])
    const 渡されたもの = vi.mocked(URL.createObjectURL).mock.calls.at(-1)?.[0]
    expect(渡されたもの).toBe(accepted[0].bytes)
    expect(渡されたもの).not.toBe(元)
  })

  it('付けた時点で読めなければ、その場で断る', async () => {
    // **送信を押してから落ちない。** 押してから英語で「Failed to fetch」と出るより、
    // 付けた瞬間に読めないと言うほうが、撮り直す判断ができる
    const 壊れた = 画像('gone.png', 'image/png')
    壊れた.arrayBuffer = () => Promise.reject(new Error('読めません'))

    const { accepted, rejected } = await pickImages([壊れた])
    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toContain('gone.png')
    expect(rejected[0]).toContain('読めませんでした')
  })

  it('1枚読めなくても、読めた側は残る', async () => {
    // まとめて付けたときに**1枚駄目だと全部消える**、という形にしない
    const 壊れた = 画像('gone.png', 'image/png')
    壊れた.arrayBuffer = () => Promise.reject(new Error('読めません'))

    const { accepted, rejected } = await pickImages([
      画像('ok.png', 'image/png'),
      壊れた,
      画像('ok2.webp', 'image/webp'),
    ])
    expect(accepted.map((one) => one.name)).toEqual(['ok.png', 'ok2.webp'])
    expect(rejected).toHaveLength(1)
  })

  it('断るものは読まない', async () => {
    // 8 MiB を読んでから「大きすぎます」と言うのでは、写しを取る意味が薄れる。
    // **大きさと種別を見てから読む**順序であることを、読む口が呼ばれないことで見る
    const 大きい = 画像('huge.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)
    const 読む = vi.fn(() => Promise.resolve(new ArrayBuffer(0)))
    大きい.arrayBuffer = 読む
    const 種別違い = 画像('e.svg', 'image/svg+xml')
    種別違い.arrayBuffer = 読む

    await pickImages([大きい, 種別違い])
    expect(読む).not.toHaveBeenCalled()
  })
})

describe('後始末', () => {
  it('外すときに小窓の絵を捨てる', async () => {
    // 忘れると、付け外しを繰り返すたびにブラウザの中で溜まる
    const { accepted } = await pickImages([画像('a.png', 'image/png')])
    releasePreview(accepted[0])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(accepted[0].preview)
  })
})
