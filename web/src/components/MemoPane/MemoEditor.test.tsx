import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
  **エディタの口へ実際に何を返しているか**を見る（利用者の要望・2026-09-14
  「初期は横幅の4割サイズで貼ってほしい」）。

  # なぜ `useCreateBlockNote` を差し替えるのか

  **貼る操作そのものは jsdom で再現できない。** ProseMirror を本物のまま立てても、
  落とす・貼り付ける・選ぶのどれも起こせないので、`uploadFile` は1度も呼ばれない
  ——**口が塞がっていても緑になる。**

  そこで**エディタを作るときに渡した中身を掴んで、`uploadFile` を直に叩く。**
  ここで確かめたいのは「面がエディタへ何を渡すか」だけなので、中身は要らない。

  **幅の決め方そのものは `lib/memoImage.test.ts` が持つ。** こちらが守るのは
  **配線**——測った幅を渡しているか、運び手の返り値を素通しにしていないか、である。
  片方だけでは守れない：決め方が正しくても渡していなければ絵は横幅いっぱいのままで、
  **どちらのテストも緑になる。**
*/

/** `useCreateBlockNote` へ渡された中身。 */
let 渡した: { uploadFile?: (file: File) => Promise<unknown> } | undefined

/** 作られたエディタの代役。**`domElement` は測る対象そのもの。** */
const エディタ: { domElement: HTMLElement | undefined } = { domElement: undefined }

vi.mock('@blocknote/react', () => ({
  useCreateBlockNote: (options: Record<string, unknown>) => {
    渡した = options as never
    return エディタ
  },
}))
vi.mock('@blocknote/shadcn', () => ({
  BlockNoteView: () => <div data-testid="blocknote" />,
}))
vi.mock('@blocknote/core/fonts/inter.css', () => ({}))
vi.mock('@blocknote/shadcn/style.css', () => ({}))

const { MemoEditor } = await import('./MemoEditor')

/**
 * 面の中身に幅を持たせる。**jsdom は CSS を当てない**ので `clientWidth` は常に 0
 * になる——測る場所を取り違えていないかは見られないが、**測った数字が幅の決め方へ
 * 渡っているか**はここで固定できる。
 */
function 面の幅を(px: number): HTMLElement {
  const 面 = document.createElement('div')
  const 内側 = document.createElement('div')
  Object.defineProperty(内側, 'clientWidth', { value: px, configurable: true })
  面.appendChild(内側)
  return 面
}

beforeEach(() => {
  渡した = undefined
  エディタ.domElement = undefined
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1920, height: 1080, close: vi.fn() }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function 貼る道を開けて(運び手: (file: File) => Promise<string>): void {
  render(<MemoEditor initial={{ blocks: [], markdown: '' }} onSubmit={vi.fn()} label="メモ" onUploadImage={運び手} />)
}

const 絵 = () => new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' })

describe('貼った直後の幅を、エディタへ渡す', () => {
  it('**運び手の返り値を素通ししない。** 幅を載せた物体を返す', async () => {
    /*
      素通し（URL の文字列をそのまま返す）と、`previewWidth` が既定の `undefined` の
      ままになる。そのとき絵の器は `width: fit-content` ＋ `max-width: 100%` なので、
      **原寸が広い絵は必ず横幅いっぱいまで伸びる**——利用者が見ていたのはこれである。
    */
    エディタ.domElement = 面の幅を(800)
    貼る道を開けて(async () => '/api/memo-blobs/b1')

    const 返り = await 渡した!.uploadFile!(絵())

    // 800 の4割 ＝ 320。原寸（1920）のほうが広いので頭打ちには当たらない
    expect(返り).toEqual({
      props: { name: 'shot.png', url: '/api/memo-blobs/b1', previewWidth: 320 },
    })
  })

  it('**面の幅を測って渡している**（決め打ちの数字ではない）', async () => {
    エディタ.domElement = 面の幅を(500)
    貼る道を開けて(async () => '/u')

    expect(await 渡した!.uploadFile!(絵())).toHaveProperty('props.previewWidth', 200)
  })

  it('面の幅が測れなければ、URL の文字列のまま返す（いままでと同じ道）', async () => {
    // `domElement` が無いのは、面がまだ立っていないとき
    貼る道を開けて(async () => '/u')

    expect(await 渡した!.uploadFile!(絵())).toBe('/u')
  })

  it('運び手が投げたら、そのまま投げる（幅の話で握り潰さない）', async () => {
    エディタ.domElement = 面の幅を(800)
    貼る道を開けて(async () => {
      throw new Error('置けません')
    })

    await expect(渡した!.uploadFile!(絵())).rejects.toThrow('置けません')
  })

  it('運んでいる間は札を上げ、終えたら下ろす（版の切替に巻き込まれない）', async () => {
    // **既にある約束を、幅を足したついでに落としていないか**（設計§8-2）
    const 札: boolean[] = []
    エディタ.domElement = 面の幅を(800)
    render(
      <MemoEditor
        initial={{ blocks: [], markdown: '' }}
        onSubmit={vi.fn()}
        label="メモ"
        onUploadImage={async () => '/u'}
        on抱える={(v) => 札.push(v)}
      />,
    )

    await 渡した!.uploadFile!(絵())

    expect(札).toEqual([true, false])
  })
})
