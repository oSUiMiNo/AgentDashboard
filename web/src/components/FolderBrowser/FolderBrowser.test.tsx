/**
 * 一覧のコピー（設計「フォルダとファイル一覧のコピーボタンが効かない」§5）。
 *
 * **写せなかったときの側を見る。** 写せたときは既存の2本
 * （`useFilesParts.test.tsx` ／ `ProjectAdd.test.tsx`）が見ているが、
 * **写せなかったときは単体も E2E も1本も無かった**——それがこのイシューの症状
 * そのもので、スマホでは値を手に入れる手段が1つも残らなかった。
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderBrowser } from '@/components/FolderBrowser/FolderBrowser'

const ROOT = '/home/me/dev/app'

function listing(path: string, names: string[]) {
  return {
    path,
    entries: names.map((name) => ({
      name,
      kind: name.includes('.') ? ('file' as const) : ('dir' as const),
      is_project: false,
    })),
    truncated: false,
  }
}

beforeEach(() => {
  /**
   * **安全でないオリジンを、そのまま写した形。**
   *
   * `navigator.clipboard` は**存在しない**——「呼ぶと失敗する」のではなく居ない。
   * そして jsdom は `document.execCommand` も持たないので、**三層のうち①②が
   * どちらも使えず、逃げ道まで落ちる**。スマホで踏んでいるのと同じ形になる。
   */
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(listing(ROOT, ['MyDocs', '計画.md'])), {
          status: 200,
        }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function 置く() {
  render(<FolderBrowser host="local" start={ROOT} root={ROOT} />)
}

async function 行たち() {
  return await screen.findAllByTestId('folder-copy')
}

describe('写せなかったとき', () => {
  it('値がパネルの上に出て、そこから取れる', async () => {
    置く()
    await userEvent.click((await 行たち())[0])

    await waitFor(() =>
      expect(screen.getByTestId('folder-copy-failed')).toHaveTextContent(
        'コピーできません',
      ),
    )
    // **フォルダは末尾に `/`。** 逃げ道から取った値も、押して入る値と同じでなければ意味が無い
    expect(screen.getByTestId('folder-copy-fallback')).toHaveTextContent(
      'MyDocs/',
    )
  })

  it('値は選べる形で出る（指でなぞれば全体が取れる）', async () => {
    // **字で「選べます」と書くのではなく、選べる指定そのものを見る。**
    // スマホには `title` を読む操作が無いので、ここが唯一の受け皿になる
    置く()
    await userEvent.click((await 行たち())[0])

    await waitFor(() =>
      expect(screen.getByTestId('folder-copy-fallback')).toHaveClass(
        'select-all',
      ),
    )
  })

  it('押した行のボタンにも「コピーできません」と出る', async () => {
    置く()
    const 行 = await 行たち()
    await userEvent.click(行[0])

    await waitFor(() => expect(行[0]).toHaveTextContent('コピーできません'))
    // 押していない行は手つかずのまま
    expect(行[1]).toHaveTextContent('コピー')
    expect(行[1]).not.toHaveTextContent('コピーできません')
  })

  it('別の行を押すと、前の行の答えは消える', async () => {
    // **答えは1組しか持たない**（設計§5）。覚え続けると上に何行も並び、
    // どれが最後に押したものか分からなくなる
    置く()
    const 行 = await 行たち()

    await userEvent.click(行[0])
    await waitFor(() =>
      expect(screen.getByTestId('folder-copy-fallback')).toHaveTextContent(
        'MyDocs/',
      ),
    )

    await userEvent.click(行[1])
    await waitFor(() =>
      expect(screen.getByTestId('folder-copy-fallback')).toHaveTextContent(
        '計画.md',
      ),
    )
    // 逃げ道は1つだけ。**前のぶんが残らない**
    expect(screen.getAllByTestId('folder-copy-fallback')).toHaveLength(1)
    expect(行[0]).not.toHaveTextContent('コピーできません')
  })

  it('次の行を押した瞬間に、前の答えは消える（返ってくるのを待たない）', async () => {
    // **待つと、押したのに前の行の値が出たままになる。**「1組だけ持つ」の意味は
    // 「最後に押したものだけが答え」なので、**押した瞬間**に前のぶんは無効になる。
    //
    // 答えが返るまでを自分で握らないと、この差は見えない——`waitFor` で待つと、
    // 消してから入れ直したのか、入れ替わっただけなのかが区別できない
    // 入れ物へ入れて渡す。素の変数だと、TS が「コールバックの中の代入」を
    // 見てくれず `null` のまま絞り込む
    const 待ち: { 返す?: () => void } = {}
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise<void>((done) => {
              待ち.返す = done
            }),
        ),
      },
    })

    置く()
    const 行 = await 行たち()

    await userEvent.click(行[0])
    待ち.返す?.()
    await waitFor(() => expect(行[0]).toHaveTextContent('コピーしました'))

    // 2行目を押す。**まだ答えは返していない**
    await userEvent.click(行[1])
    expect(行[0]).not.toHaveTextContent('コピーしました')
    expect(行[1]).toHaveTextContent('コピー')
  })

  it('押すまでは、逃げ道を出さない', async () => {
    置く()
    await 行たち()

    expect(screen.queryByTestId('folder-copy-failed')).toBeNull()
  })

  it('押しても階層は動かない', async () => {
    // 開く的とコピーの的は分けてある（設計§13）。逃げ道を足しても崩れていないこと
    置く()
    await userEvent.click((await 行たち())[0])

    await waitFor(() =>
      expect(screen.getByTestId('folder-copy-failed')).toBeInTheDocument(),
    )
    expect(screen.getByTestId('folder-browser')).toHaveAttribute(
      'data-path',
      ROOT,
    )
  })
})

describe('写せたとき', () => {
  it('逃げ道は出さず、押した行だけが「コピーしました」になる', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })

    置く()
    const 行 = await 行たち()
    await userEvent.click(行[0])

    await waitFor(() => expect(行[0]).toHaveTextContent('コピーしました'))
    // **写せたのに逃げ道が出ると、押せていないように見える**
    expect(screen.queryByTestId('folder-copy-failed')).toBeNull()
    expect(行[1]).toHaveTextContent('コピー')
  })
})
