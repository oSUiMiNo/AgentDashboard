import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView } from '@/components/FileView/FileView'

/**
 * **種類 × 帯の機能の総当たり**（利用者の指定・2026-09-08）。
 *
 * # なぜ表で見張るのか
 *
 * 1日で**同じ形の欠陥が4件**出た——拡大縮小が効かない／既定が効いていない／検索の
 * 入口が出ない／画像だけ拡大縮小が効かない。**どれも「押せるのに何も起きない」
 * 「あるべきものが黙って無い」**で、**動かないことより悪い**——壊れているのか仕様なのか、
 * 触った人に区別が付かない。
 *
 * 根は1つで、**種類ごとに描く経路が分かれていて、帯の状態がそれぞれへ届いているかが
 * 個別に決まっている**ことである。**同じ構造のままマスを埋めると、次に種類が増えた
 * ときにまた同じことが起きる。**
 *
 * だから**表そのものを検査にした**。マスは3つに分かれる。
 *
 * | 判定 | 意味 |
 * |---|---|
 * | **効く** | よい |
 * | **意図して出していない** | よい（種類的に無意味）。**「無い」ことがここに書いてある**のが担保 |
 * | **あるのに黙って何もしない** | **不具合。** この検査が落とす |
 *
 * # 種類を足したら、ここが落ちる
 *
 * 下の `種類の一覧` は `lib/fileKind.ts` の型を**ソースから読んで**突き合わせる。
 * 新しい種類を足すと、**表に行を足すまで落ちる**——埋めるべきマスが目に見える。
 */

const ROOT = '/home/me/dev/app'

/**
 * 大きさの道に繋がっている印。**種類ごとに、どれが正かまで決まっている。**
 *
 * **「どれか1つを持っていればよい」にしない。** それだと `<img>` に `file-prose` が
 * 付いていても緑になる——**CSS 上は何も効かないのに**、検査は通ってしまう。
 */
const 器から取る印 = {
  'file-markdown': 'file-prose',
  'file-raw': 'file-raw',
  'file-frame': 'file-frame',
  'file-image': 'file-image',
} as const

/**
 * **本体に直書きしてはいけない大きさ。**
 *
 * 要素へ直接効くユーティリティに、器の側の変数は勝てない——**直書きが1つ残るだけで、
 * その種類だけ拡大縮小が黙って効かなくなる**（実際に3回踏んだ）。
 */
const 直書き = ['text-sm', 'text-xs', 'leading-relaxed', 'max-w-full', 'h-auto']

interface 行 {
  kind: string
  path: string
  /** 何で描かれるか（`data-testid`） */
  本体: keyof typeof 器から取る印
  /** 生テキストで見る */
  生テキスト: '出る' | '意図して出さない'
  /** 探す入口 */
  探す: 'その場で' | '切り替えて' | '意図して出さない'
  /** 備考（**別のイシューの担当**はここへ繋ぐ） */
  備考?: string
}

/**
 * **実装が実際に見分けている5種**（`lib/fileKind.ts` の `FileKind`）。
 *
 * 描く経路は**種類 × 生テキストか**で決まるので、`markdown` と `html` は2通りある。
 * 下の「生テキストへ切り替えたとき」がそちらを見る。
 */
const 表: 行[] = [
  {
    kind: 'markdown',
    path: `${ROOT}/計画.md`,
    本体: 'file-markdown',
    生テキスト: '出る',
    探す: 'その場で',
  },
  {
    kind: 'text',
    path: `${ROOT}/メモ.txt`,
    本体: 'file-raw',
    // **既に生テキストなので、切り替える先が無い**
    生テキスト: '意図して出さない',
    探す: 'その場で',
    備考:
      '表に無い拡張子はすべてここへ落ちる（コード・構造化データ・PDF・中身が読めないもの）。' +
      '**文字コードが UTF-8 でないものは別イシュー**（`文字コードがUTF-8でないファイルをビュアが開けない`）。',
  },
  {
    kind: 'html',
    path: `${ROOT}/理解.html`,
    本体: 'file-frame',
    生テキスト: '出る',
    // **箱の中に係を置いてある**ので、見ている姿のまま探せる
    探す: 'その場で',
  },
  {
    kind: 'svg',
    path: `${ROOT}/図.svg`,
    本体: 'file-frame',
    生テキスト: '出る',
    // **`</svg>` の外に要素を置けない**ので係を足せない。先に断って生テキストへ
    探す: '切り替えて',
  },
  {
    kind: 'image',
    path: `${ROOT}/撮った.png`,
    本体: 'file-image',
    // **テキストではない**ので、切り替える先が無い
    生テキスト: '意図して出さない',
    // **文字を持たない**ので、探す先が無い
    探す: '意図して出さない',
  },
]

type Props = ComponentProps<typeof FileView>
type 埋める = 'tabs' | 'onSelectTab' | 'onCloseTab' | 'onReorderTab' | 'onReorderTabCommit'

function Viewer(props: Omit<Props, 埋める>) {
  return (
    <FileView
      {...props}
      tabs={[props.path]}
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onReorderTab={() => {}}
      onReorderTabCommit={() => {}}
    />
  )
}

/** テキストの口と生の口の両方に答える。**種類で経路が変わるので、両方要る** */
function 出す(text = '本文\nあか') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('as=')) {
        return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      return new Response(
        JSON.stringify({ path: 'x', text, truncated: false, bytes: text.length }),
        { status: 200 },
      )
    }),
  )
}

/** 画像が読み込まれたことにする。**jsdom は `load` を自分では起こさない** */
function 読み込ませる(img: HTMLElement, 幅: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 幅 })
  fireEvent.load(img)
}

beforeEach(() => {
  出す()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:偽物/0'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('種類 × 帯の機能（総当たり）', () => {
  it('表が、実装の見分ける種類を1つ残らず覆っている', () => {
    /*
      **種類を足したら、ここが落ちる。** 型をソースから読んで突き合わせるので、
      新しい種類を足しても**表に行を足すまで緑にならない**——埋めるべきマスが目に見える。
    */
    const src = readFileSync(
      resolve(process.cwd(), 'src/lib/fileKind.ts'),
      'utf8',
    )
    const 宣言 = /export type FileKind =([^\n]+)/.exec(src)
    expect(宣言, 'FileKind の宣言が見つからない').not.toBeNull()
    const 種類の一覧 = [...宣言![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1])

    expect([...種類の一覧].sort()).toEqual([...表.map((r) => r.kind)].sort())
  })

  it.each(表)('$kind：どの種類でも、帯そのものは同じだけ出る', async (行) => {
    // **タブ・外へ出す・閉じるは種類で変わらない。** 変わるものだけが下の検査になる
    render(<Viewer host="local" root={ROOT} path={行.path} onClose={() => {}} />)

    expect(await screen.findByTestId('file-tabs')).toBeInTheDocument()
    expect(screen.getByTestId('file-tab')).toBeInTheDocument()
    expect(screen.getByTestId('file-open-tab')).toBeInTheDocument()
    expect(screen.getByTestId('file-close')).toBeInTheDocument()
    // 文字の大きさの操作は、どの種類でも出る（効くかどうかは下で見る）
    expect(screen.getByTestId('file-zoom')).toBeInTheDocument()
    expect(screen.getByTestId('file-zoom-in')).toBeInTheDocument()
    expect(screen.getByTestId('file-zoom-out')).toBeInTheDocument()
  })

  it.each(表)('$kind：大きさが本体へ届いている', async (行) => {
    /*
      **これが「押せるのに何も起きない」を落とす検査である。**

      帯の操作が出ていることと、それが本体へ届いていることは**別の話**——
      画像は操作だけ出ていて、本体が器の道に繋がっていなかった。
    */
    render(<Viewer host="local" root={ROOT} path={行.path} />)

    const 器 = await screen.findByTestId('file-view')
    expect(器.className).toContain('file-zoom')
    expect(器.getAttribute('style')).toContain('--file-zoom')

    const 本体 = await screen.findByTestId(行.本体)
    expect(
      本体.className.split(/\s+/),
      `${行.kind} の本体が、その種類の印を持っていない`,
    ).toContain(器から取る印[行.本体])
    for (const 綴り of 直書き) {
      expect(
        本体.className.split(/\s+/),
        `${行.kind} の本体に大きさが直書きされている`,
      ).not.toContain(綴り)
    }
  })

  it.each(表)('$kind：生テキストの切替は、表のとおりに出る／出ない', async (行) => {
    render(<Viewer host="local" root={ROOT} path={行.path} />)
    await screen.findByTestId(行.本体)

    if (行.生テキスト === '出る') {
      expect(screen.getByTestId('file-toggle-raw')).toBeInTheDocument()
    } else {
      // **意図して出していない。** 切り替える先が無い種類
      expect(screen.queryByTestId('file-toggle-raw')).toBeNull()
    }
  })

  it.each(表)('$kind：探す入口は、表のとおりに振る舞う', async (行) => {
    render(<Viewer host="local" root={ROOT} path={行.path} />)
    await screen.findByTestId(行.本体)

    if (行.探す === '意図して出さない') {
      expect(screen.queryByTestId('file-find-open')).toBeNull()
      return
    }

    await userEvent.click(screen.getByTestId('file-find-open'))
    if (行.探す === 'その場で') {
      // **見ている姿を壊さない**
      expect(screen.getByTestId('file-find')).toBeInTheDocument()
      expect(screen.getByTestId(行.本体)).toBeInTheDocument()
    } else {
      // **黙って切り替えない。** 先に断って選ばせる
      expect(screen.getByTestId('file-find-confirm')).toBeInTheDocument()
      expect(screen.queryByTestId('file-find')).toBeNull()
    }
  })
})

describe('生テキストへ切り替えたとき', () => {
  it.each(表.filter((r) => r.生テキスト === '出る'))(
    '$kind：切り替えた先でも、大きさは本体へ届く',
    async (行) => {
      // **描く経路は「種類 × 生テキストか」で決まる。** 切り替えた先も同じ道に居ること
      render(<Viewer host="local" root={ROOT} path={行.path} />)
      await screen.findByTestId(行.本体)

      await userEvent.click(screen.getByTestId('file-toggle-raw'))

      const 本体 = await screen.findByTestId('file-raw')
      expect(本体.className.split(/\s+/)).toContain('file-raw')
      for (const 綴り of 直書き) {
        expect(本体.className.split(/\s+/)).not.toContain(綴り)
      }
    },
  )
})

describe('種類をまたいで切り替えたとき', () => {
  it('探す窓は畳まれ、倍率は残る', async () => {
    /*
      **タブが増えたことで新しく生まれた面**（利用者の指摘）。

      - **探す窓は畳む。** 前のファイルで打った語が残ると、当たりの数だけが別の文書の
        ものに見える
      - **倍率は残す。**「その人の目と画面」の都合であって、どのファイルを見ているかで
        変わらない（`lib/fileZoom.ts` の族の決め）。**タブごとではなくビュア全体で1つ**
    */
    const { rerender } = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/計画.md`} />,
    )
    await userEvent.click(await screen.findByTestId('file-find-open'))
    await userEvent.click(screen.getByTestId('file-zoom-in'))
    expect(screen.getByTestId('file-find')).toBeInTheDocument()
    expect(screen.getByTestId('file-zoom-reset')).toHaveTextContent('110%')

    rerender(<Viewer host="local" root={ROOT} path={`${ROOT}/撮った.png`} />)

    await waitFor(() => {
      expect(screen.queryByTestId('file-find')).toBeNull()
    })
    // 倍率は種類をまたいでも残る
    expect(screen.getByTestId('file-zoom-reset')).toHaveTextContent('110%')
  })

  it('画像の原寸の切り替えは、次のファイルへ持ち越さない', async () => {
    // **持ち越すと「開いた瞬間に巨大な画像が出る」**ことになる
    const { rerender } = render(
      <Viewer host="local" root={ROOT} path={`${ROOT}/一枚目.png`} />,
    )
    // **原寸が分かるまで押せない**ので、読み込みを起こす（jsdom は自分では起こさない）
    読み込ませる(await screen.findByTestId('file-image'), 1200)
    await userEvent.click(screen.getByTestId('file-image-fit'))
    expect(screen.getByTestId('file-image')).toHaveAttribute('data-fit', 'natural')

    rerender(<Viewer host="local" root={ROOT} path={`${ROOT}/二枚目.png`} />)

    await waitFor(() => {
      expect(screen.getByTestId('file-image')).toHaveAttribute('data-fit', 'contain')
    })
    // **測り直すまでは当てない。** 前の絵の原寸を次の絵へ持ち越さない
    expect(screen.getByTestId('file-image')).not.toHaveAttribute('data-measured')
  })

  it('原寸が分かるまで、切り替えは押せない', async () => {
    /*
      **押せると `calc(100% * 倍率)` に落ちて、器の幅いっぱいまで引き伸ばされる**
      ——「原寸＝1:1」と言っているのに 1:1 でない絵が出る。読めなかった絵も同じ。
    */
    render(<Viewer host="local" root={ROOT} path={`${ROOT}/撮った.png`} />)

    expect(await screen.findByTestId('file-image-fit')).toBeDisabled()

    読み込ませる(screen.getByTestId('file-image'), 1200)
    expect(screen.getByTestId('file-image-fit')).not.toBeDisabled()
    expect(screen.getByTestId('file-image')).toHaveAttribute('data-measured', 'true')
  })
})
