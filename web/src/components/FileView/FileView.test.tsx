/**
 * ファイル1つの見せ方（設計§15。テスト計画 フェーズ4「ファイルの見せ方」）。
 *
 * ここで守っているのは2つ。**貼れる値が正しく取れること**と、**整形が嘘をつかないこと**。
 * とくに生の HTML は、通してしまっても画面は普通に見えるので、目視では気づけない。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView } from '@/components/FileView/FileView'

const ROOT = '/home/me/dev/app'

/** `/api/hosts/{host}/file` の応答。 */
function content(text: string, truncated = false) {
  return {
    path: `${ROOT}/計画.md`,
    text,
    truncated,
    bytes: text.length,
  }
}

let written: string[] = []
/** `createObjectURL` で作ったもの／捨てたもの（下の「画像と HTML」で数える）。 */
const made: { url: string; size: number }[] = []
const revoked: string[] = []

function serve(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  )
}

beforeEach(() => {
  written = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        written.push(text)
      }),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function show(path = `${ROOT}/計画.md`) {
  render(<FileView host="local" root={ROOT} path={path} />)
}

describe('ファイルの見せ方', () => {
  it('相対パスがコピーでき、何からの相対パスかが画面に出る', async () => {
    serve(content('# 計画'))
    show(`${ROOT}/MyDocs/計画.md`)

    // 基準を書かない相対パスは、貼られた側で解釈できない
    expect(await screen.findByTestId('file-relative-path')).toHaveTextContent(
      'MyDocs/計画.md',
    )
    expect(screen.getByTestId('file-relative-base')).toHaveTextContent(ROOT)

    await userEvent.click(screen.getByTestId('file-copy'))
    await waitFor(() => expect(written).toEqual(['MyDocs/計画.md']))
    expect(screen.getByTestId('file-copied')).toHaveTextContent('コピーしました')
  })

  it('コピーできない環境では、黙らずに値を選べる形で出す', async () => {
    // **セキュアコンテキストでないと `navigator.clipboard` は存在しない。**
    // LAN へ開いて `http://192.168.x.x:8787` で見ている場合がまさにそれで、
    // 黙って失敗すると「押しても何も起きない」だけが残る（設計§29）。
    //
    // **「在るが失敗する」ではなく「無い」を置く。** 以前はここで `writeText` を
    // 拒否させていたが、それは名前が言っていることと違う環境だった——本物は
    // `.writeText` を**読んだ時点**で落ち、拒否は Promise が拒まれるだけで、
    // **三層のうちどこへ入るかが変わる**（`lib/clipboard.ts`）。
    // jsdom は `document.execCommand` も持たないので、これだけで①②とも自然に落ちる
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    serve(content('# 計画'))
    show(`${ROOT}/MyDocs/計画.md`)

    await userEvent.click(await screen.findByTestId('file-copy'))

    await waitFor(() =>
      expect(screen.getByTestId('file-copied')).toHaveTextContent(
        'コピーできません',
      ),
    )
    // 利用者が自分で取れること（注釈が約束している逃げ道）
    expect(screen.getByTestId('file-copy-fallback')).toHaveTextContent(
      'MyDocs/計画.md',
    )
  })

  it('Markdown が整形され、チェックボックスの入り／未入りが読める', async () => {
    serve(content('# 計画\n\n- [x] 済んだこと\n- [ ] まだのこと\n'))
    show()

    const boxes = await screen.findAllByRole('checkbox')
    // 進捗そのものなので、入り／未入りが**別々に読める**ことまで見る
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('計画')
  })

  it('生の HTML が実行も表示もされない', async () => {
    serve(
      content(
        '# 見出し\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(2)</script>\n\n```html\n<div>コードブロックの中</div>\n```\n',
      ),
    )
    const { container } = render(
      <FileView host="local" root={ROOT} path={`${ROOT}/計画.md`} />,
    )
    await screen.findByTestId('file-markdown')

    // **タグとして出ていないこと**を見る
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    // **字面としても出ていないこと**（`skipHtml`。設計§27）。フェーズ0 で
    // 「字面が無いこと」を条件にして落ちたのは、逃がされて残っていたため——
    // いまは木から取り除いているので、無いことが正しい条件になる
    expect(screen.getByTestId('file-markdown').textContent).not.toContain(
      'onerror',
    )
    // **コードブロックの中は消えない。** 取り除くのは HTML のノードだけで、
    // 囲まれた中身はただの文字列として残る（ここを壊すのが唯一の怖い副作用）
    expect(screen.getByText('<div>コードブロックの中</div>')).toBeInTheDocument()
    // 整形自体は効いている（丸ごと素通ししているわけではない）
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('見出し')
  })

  it('素の改行が、改行として出る', async () => {
    // **履歴と同じ配列を使っている**ことの現れ（`構造化ビューでメッセージの改行が
    // 反映されない` 設計§5）。同じ字を貼れば同じ見え方になる
    serve(content('あいう\nかきく\n'))
    const { container } = render(<FileView host="local" root={ROOT} path={`${ROOT}/計画.md`} />)
    await screen.findByTestId('file-markdown')

    expect(container.querySelectorAll('br')).toHaveLength(1)
  })

  it('`<br/>` も改行として出る（`skipHtml` があっても消えない）', async () => {
    // **`skipHtml` は rehype が走った「あと」に効く。** 先に `br` 要素へ変わったものは
    // 残り、残りの生 HTML はいままでどおり落ちる。このリポジトリのドキュメントは
    // 節の区切りに `<br/>` を2行置く作法なので、**意図した行間がここで戻る**
    serve(content('# 見出し\n\n---\n<br/>\n<br/>\n\n本文\n'))
    const { container } = render(<FileView host="local" root={ROOT} path={`${ROOT}/計画.md`} />)
    await screen.findByTestId('file-markdown')

    expect(container.querySelectorAll('br')).toHaveLength(2)
    // 字面としては出ない（`skipHtml` は効いたまま）
    expect(screen.getByTestId('file-markdown').textContent).not.toContain('<br')
  })

  it('囲みコードの中の改行は、二重にならない', async () => {
    serve(content('```\n1行目\n2行目\n```\n'))
    const { container } = render(<FileView host="local" root={ROOT} path={`${ROOT}/計画.md`} />)
    await screen.findByTestId('file-markdown')

    expect(container.querySelectorAll('br')).toHaveLength(0)
    expect(screen.getByText(/1行目/).textContent).toContain('1行目\n2行目')
  })

  it('生テキストへ切り替えられる', async () => {
    serve(content('# 計画\n\n本文\n'))
    show()

    await screen.findByTestId('file-markdown')
    await userEvent.click(screen.getByTestId('file-toggle-raw'))

    // 整形が嘘をついたときに確かめる先が要る（設計§15）
    expect(screen.getByTestId('file-raw')).toHaveTextContent('# 計画')
    expect(screen.queryByTestId('file-markdown')).toBeNull()

    await userEvent.click(screen.getByTestId('file-toggle-raw'))
    expect(await screen.findByTestId('file-markdown')).toBeInTheDocument()
  })

  it('Markdown ではないファイルは、最初から生テキストで出る', async () => {
    serve(content('const a = 1\n'))
    show(`${ROOT}/src/index.ts`)

    expect(await screen.findByTestId('file-raw')).toHaveTextContent('const a = 1')
    // 切り替える意味が無いので、切替そのものを出さない
    expect(screen.queryByTestId('file-toggle-raw')).toBeNull()
  })

  it('打ち切られた中身が、打ち切られたと分かる', async () => {
    serve(content('先頭だけ', true))
    show()

    // 黙って切ると「そこで終わっている」と読めてしまう（設計§9）
    expect(await screen.findByTestId('file-truncated')).toBeInTheDocument()
  })

  it('大きい Markdown は整形せずに始まり、なぜそうしたかが出る', async () => {
    // **`bytes` で決まる**ので、材料そのものを大きくしなくても道は通る。
    // 整形は大きさに対して超線形に伸び、3 MiB では終わらない（実測。`FileView.tsx`）
    serve({
      path: `${ROOT}/大きい.md`,
      text: '# 大きい文書',
      truncated: false,
      bytes: 512 * 1024,
    })
    show(`${ROOT}/大きい.md`)

    expect(await screen.findByTestId('file-raw')).toHaveTextContent('# 大きい文書')
    expect(screen.queryByTestId('file-markdown')).toBeNull()
    // **黙って生テキストにしない。** 何も言わずに出すと、整形が壊れたように見える
    expect(screen.getByTestId('file-heavy')).toBeInTheDocument()
  })

  it('大きくても、整形そのものは禁じない', async () => {
    serve({
      path: `${ROOT}/大きい.md`,
      text: '# 大きい文書',
      truncated: false,
      bytes: 512 * 1024,
    })
    show(`${ROOT}/大きい.md`)

    await screen.findByTestId('file-raw')
    await userEvent.click(screen.getByTestId('file-toggle-raw'))

    // 待つと決めるのは利用者。押せば整形するし、断り書きは引っ込む
    expect(await screen.findByTestId('file-markdown')).toBeInTheDocument()
    expect(screen.queryByTestId('file-heavy')).toBeNull()
  })

  it('上限の内側なら、今までどおり整形で始まる', async () => {
    serve({
      path: `${ROOT}/計画.md`,
      text: '# 計画',
      truncated: false,
      bytes: 256 * 1024,
    })
    show()

    // 境目ちょうどは整形の側。**上げたことで普段の文書の出方を変えない**
    expect(await screen.findByTestId('file-markdown')).toBeInTheDocument()
    expect(screen.queryByTestId('file-heavy')).toBeNull()
  })

  it('読めないときは理由がそのまま出る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('大きすぎます（343 KB）', { status: 413 })),
    )
    show()

    // 権限・不在・大きすぎ、はどれも利用者が直せる（設計§17）
    expect(await screen.findByTestId('file-error')).toHaveTextContent(
      '大きすぎます',
    )
  })
})

/**
 * 画像と HTML（`ファイル閲覧で画像とHTMLも表示する` 設計§7。テスト計画フェーズ4）。
 *
 * **否定側の主張が多いので、肯定側と対で書く。** 「叩かない」「出さない」は、
 * 探し方が間違っているときにも同じ答えを返す。
 */
describe('画像と HTML', () => {
  /** 呼ばれた URL を全部控える。**「叩かない」を数で言うため。** */
  function record(handler: (url: string) => Response) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        return handler(url)
      }),
    )
    return calls
  }

  beforeEach(() => {
    // jsdom は `createObjectURL` を持たない。**捨てたかどうかを数えたい**ので、
    // 作った URL と捨てた URL の両方を控える形にする
    made.length = 0
    revoked.length = 0
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        const url = `blob:偽物/${made.length}`
        made.push({ url, size: blob.size })
        return url
      }),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn((url: string) => {
        revoked.push(url)
      }),
    })
  })

  it('画像は生の口から取って img に渡す。テキストの口は1回も叩かない', async () => {
    const calls = record(
      () =>
        new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )
    render(<FileView host="local" root={ROOT} path={`${ROOT}/撮った.png`} />)

    const image = await screen.findByTestId('file-image')
    expect(image).toHaveAttribute('src', 'blob:偽物/0')
    // **二度運ばない**（設計§7-2）。`as=raw` の1本だけが叩かれていること
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('as=raw')
    // 生テキストは出さず、代わりに素性を出す（設計§7-4）
    expect(screen.queryByTestId('file-toggle-raw')).toBeNull()
    expect(screen.getByTestId('file-meta')).toHaveTextContent('image/png')
  })

  it('断られたら、本文をそのまま断り欄へ出す', async () => {
    record(() => new Response('大きすぎます（9000000 バイト）', { status: 413 }))
    render(<FileView host="local" root={ROOT} path={`${ROOT}/大きい.png`} />)

    expect(await screen.findByTestId('file-error')).toHaveTextContent(
      '大きすぎます（9000000 バイト）',
    )
    // 断られたときは箱も画像も出さない
    expect(screen.queryByTestId('file-image')).toBeNull()
  })

  it('中身が画像でないときは、断られたのとは別の言い方をする', async () => {
    record(
      () =>
        new Response(new Blob(['これは画像ではありません'], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )
    render(<FileView host="local" root={ROOT} path={`${ROOT}/嘘.png`} />)

    const image = await screen.findByTestId('file-image')
    // jsdom は画像を解こうとしないので、`onError` を自分で起こす
    fireEvent.error(image)

    const broken = await screen.findByTestId('file-broken')
    expect(broken).toHaveTextContent('画像として読めません')
    // **断り欄とは別の場所に出ること。** 同じ言葉に潰すと、直す場所が分からなくなる
    expect(screen.queryByTestId('file-error')).toBeNull()
  })

  it('別のファイルへ移ると、作った URL を捨てる', async () => {
    record(
      () =>
        new Response(new Blob([new Uint8Array([1])], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )
    const view = render(
      <FileView host="local" root={ROOT} path={`${ROOT}/一枚目.png`} />,
    )
    await screen.findByTestId('file-image')
    expect(revoked).toHaveLength(0)

    view.rerender(<FileView host="local" root={ROOT} path={`${ROOT}/二枚目.png`} />)
    await waitFor(() => expect(revoked).toContain('blob:偽物/0'))
  })

  it('HTML は先にテキストの口で読んでから、隔離した箱に入れる', async () => {
    const calls = record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/理解.html`,
            text: '<!doctype html><p>理解</p>',
            truncated: false,
            bytes: 26,
          }),
          { status: 200 },
        ),
    )
    render(<FileView host="local" root={ROOT} path={`${ROOT}/理解.html`} />)

    const frame = await screen.findByTestId('file-frame')
    // **鍵の片方。** 空の `sandbox` は「許可を1つも与えない」の意味
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame.getAttribute('src')).toContain('as=raw')
    expect(frame.getAttribute('src')).toContain(encodeURIComponent(`${ROOT}/理解.html`))
    // 先に叩くのはテキストの口（`as=raw` を含まない）
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('as=raw')
  })

  it('HTML が読めなかったら、箱を出さずに理由だけを出す', async () => {
    record(() => new Response('その場所は見つかりません', { status: 404 }))
    render(<FileView host="local" root={ROOT} path={`${ROOT}/無い.html`} />)

    expect(await screen.findByTestId('file-error')).toHaveTextContent(
      'その場所は見つかりません',
    )
    expect(screen.queryByTestId('file-frame')).toBeNull()
  })

  it('SVG も同じ箱に入る（img へ落ちない）', async () => {
    record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/図.svg`,
            text: '<svg></svg>',
            truncated: false,
            bytes: 11,
          }),
          { status: 200 },
        ),
    )
    render(<FileView host="local" root={ROOT} path={`${ROOT}/図.svg`} />)

    expect(await screen.findByTestId('file-frame')).toHaveAttribute('sandbox', '')
    expect(screen.queryByTestId('file-image')).toBeNull()
  })

  it('HTML でも生テキストへ行き来できる', async () => {
    record(
      () =>
        new Response(
          JSON.stringify({
            path: `${ROOT}/理解.html`,
            text: '<!doctype html><p>理解</p>',
            truncated: false,
            bytes: 26,
          }),
          { status: 200 },
        ),
    )
    render(<FileView host="local" root={ROOT} path={`${ROOT}/理解.html`} />)
    await screen.findByTestId('file-frame')

    await userEvent.click(screen.getByTestId('file-toggle-raw'))

    expect(screen.getByTestId('file-raw')).toHaveTextContent('<p>理解</p>')
    expect(screen.queryByTestId('file-frame')).toBeNull()
  })
})
