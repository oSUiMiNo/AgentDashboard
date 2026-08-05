/**
 * ファイル1つの見せ方（設計§15。テスト計画 フェーズ4「ファイルの見せ方」）。
 *
 * ここで守っているのは2つ。**貼れる値が正しく取れること**と、**整形が嘘をつかないこと**。
 * とくに生の HTML は、通してしまっても画面は普通に見えるので、目視では気づけない。
 */

import { render, screen, waitFor } from '@testing-library/react'
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
