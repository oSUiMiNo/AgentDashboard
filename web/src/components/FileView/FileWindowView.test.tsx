import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileWindowView, type FileWindowViewProps } from '@/components/FileView/FileWindowView'
import type { FileChunk, FileContent } from '@/lib/hostfs'

/**
 * 窓で読む面（ファイル閲覧の上限を設定から変え、大きいものは流し読みする 設計§10-3・
 * テスト計画 フェーズ7「窓で読む面の振る舞い（jsdom で取れる部分）」）。
 *
 * **jsdom は寸法を測らない**（`scrollHeight` などは常に 0）。読み足しを起こす試験は、
 * スクロールする箱の寸法を `Object.defineProperty` で偽っている。ここで見るのは
 * 「頼みを重ねない」「古い答えを捨てる」のような**頼み方の規則**であって、実際の寸法で
 * 読み足しが起きることの確かめではない（そちらは E2E）。
 */

const KiB = 1024
const 窓幅 = 256 * KiB
const 全体 = 10 * 1024 * KiB

/** 先頭の窓（`truncated: true` で届いた中身）。多バイト字を混ぜて、`end` が字数ではなくバイト数であることを見る */
const 先頭: FileContent = {
  path: '/w/big.log',
  text: 'あいう\nabc\n',
  truncated: true,
  bytes: 全体,
  stamp: 's1',
  writable: false,
}
const 先頭のバイト数 = new TextEncoder().encode(先頭.text).length

function 窓(start: number, end: number, stamp = 's1', text = `[${start}-${end}]`): FileChunk {
  return { path: '/w/big.log', start, end, bytes: 全体, text, stamp, at_line_start: true }
}

interface 頼み {
  url: string
  offset: number
  length: string | null
  align: string | null
  resolve: (response: Response) => void
}

/** 頼みを保留にして控える `fetch`。答えは試験が `答える` で返す。 */
function 窓口を偽る(): 頼み[] {
  const calls: 頼み[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          const query = new URL(url, 'http://localhost').searchParams
          calls.push({
            url,
            offset: Number(query.get('offset')),
            length: query.get('length'),
            align: query.get('align'),
            resolve,
          })
        }),
    ),
  )
  return calls
}

async function 答える(call: 頼み | undefined, response: Response) {
  expect(call).toBeDefined()
  await act(async () => {
    call?.resolve(response)
  })
}

const 窓で = (chunk: FileChunk) => new Response(JSON.stringify(chunk), { status: 200 })

/**
 * スクロールする箱。寸法は偽れるように取っておく。
 *
 * **寸法を渡さないときは「長い中身の真ん中に居る」**（どちらの端にも近くない）にする。
 * 試験の土台（`test/setup.ts`）は `clientHeight` を表示領域の高さに固定し、jsdom は
 * `scrollHeight` を 0 で返すので、偽らないと置いた直後に「下端に居る」と読まれて
 * 読み足しが走る。`scrollTop` は jsdom では書いても残らないので、読み書きできる値にしておく。
 */
function 箱を作る(
  寸法: { scrollHeight: number; clientHeight: number; scrollTop: number } = {
    scrollHeight: 10000,
    clientHeight: 100,
    scrollTop: 5000,
  },
) {
  const box = document.createElement('div')
  document.body.appendChild(box)
  let top = 寸法.scrollTop
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 寸法.scrollHeight })
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 寸法.clientHeight })
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value
    },
  })
  return box
}

function 描く(box: HTMLDivElement, props: Partial<FileWindowViewProps> = {}) {
  return render(
    <FileWindowView
      host="local"
      path="/w/big.log"
      initial={先頭}
      windowBytes={窓幅}
      scrollRef={{ current: box }}
      {...props}
    />,
    { container: box },
  )
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('描くもの', () => {
  it('帯の部品が出て、帯と端の印は探す相手から外してある', () => {
    窓口を偽る()
    描く(箱を作る())
    expect(screen.getByTestId('file-window-position').textContent).toContain('10.0 MB')
    expect(screen.getByTestId('file-window-top')).toBeTruthy()
    expect(screen.getByTestId('file-window-end')).toBeTruthy()
    expect(screen.getByTestId('file-window-seek')).toBeTruthy()
    expect(screen.getByText('Ctrl+F は読み込んだ範囲だけを探します')).toBeTruthy()
    // **探す係は `data-file-find-skip` の下を飛ばす**（`lib/fileSearch.ts`）。付けないと
    // 「先頭へ」などの字が当たりに数えられる
    expect(screen.getByTestId('file-window-bar').hasAttribute('data-file-find-skip')).toBe(true)
    expect(screen.getByTestId('file-window-after').hasAttribute('data-file-find-skip')).toBe(true)
  })

  it('先頭の窓は、終わりを字数ではなく UTF-8 のバイト数で持つ', () => {
    窓口を偽る()
    描く(箱を作る())
    const span = screen.getByTestId('file-window-text').querySelector('span')
    expect(span?.getAttribute('data-start')).toBe('0')
    expect(span?.getAttribute('data-end')).toBe(String(先頭のバイト数))
    expect(先頭のバイト数).toBeGreaterThan(先頭.text.length)
    // 先頭なので「前を読み込み中」は出さない
    expect(screen.queryByTestId('file-window-before')).toBeNull()
  })

  it('本文は1つの pre の中に、大きさを直書きせずに置く（拡大縮小の変数が効くように）', () => {
    窓口を偽る()
    描く(箱を作る())
    const pre = screen.getByTestId('file-window-text')
    expect(pre.tagName).toBe('PRE')
    expect(pre.className).toContain('file-raw')
    expect(pre.className).not.toMatch(/\btext-(xs|sm|base|lg)\b/)
  })
})

describe('飛ぶ', () => {
  it('「末尾へ」は最後の窓を行頭へ寄せて1回頼み、並びをその1枚に入れ替える', async () => {
    const calls = 窓口を偽る()
    描く(箱を作る())
    fireEvent.click(screen.getByTestId('file-window-end'))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      `/api/hosts/local/file?path=%2Fw%2Fbig.log&as=range&offset=${全体 - 窓幅}&length=${窓幅}&align=line`,
    )
    await 答える(calls[0], 窓で(窓(全体 - 窓幅 + 5, 全体, 's1', '末尾の行\n')))
    const spans = screen.getByTestId('file-window-text').querySelectorAll('span')
    expect(spans).toHaveLength(1)
    expect(spans[0].textContent).toBe('末尾の行\n')
    // 末尾に届いたので「後を読み込み中」は出ず、前は出る
    expect(screen.queryByTestId('file-window-after')).toBeNull()
    expect(screen.getByTestId('file-window-before').textContent).toContain('ここより前を読み込み中')
  })

  it('つまみは離したときに、その位置へ飛ぶ（動かしている間は頼まない）', async () => {
    const calls = 窓口を偽る()
    描く(箱を作る())
    const seek = screen.getByTestId('file-window-seek')
    fireEvent.change(seek, { target: { value: '500' } })
    expect(calls).toHaveLength(0)
    fireEvent.pointerUp(seek)
    expect(calls).toHaveLength(1)
    expect(calls[0].offset).toBe(Math.floor(全体 / 2))
    expect(calls[0].align).toBe('line')
  })

  it('飛んだら、走っていた古い頼みの答えは並べない', async () => {
    // 箱の寸法を偽って、置いた直後に後ろへの読み足しを1つ走らせる
    const calls = 窓口を偽る()
    描く(箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }))
    expect(calls).toHaveLength(1)
    expect(calls[0].offset).toBe(先頭のバイト数)
    // 保留のまま「先頭へ」を押す
    fireEvent.click(screen.getByTestId('file-window-top'))
    expect(calls).toHaveLength(2)
    expect(calls[1].offset).toBe(0)
    // 飛んだ直後は並びが空。**ここへ古い答えが先に届くと、継ぎ目の検査では止まらない**
    // （空の並びには何でも1枚目として入る）ので、世代で捨てていることをここで見る
    await 答える(calls[0], 窓で(窓(先頭のバイト数, 先頭のバイト数 + 10, 's1', '古い答え')))
    expect(screen.getByTestId('file-window-text').textContent).not.toContain('古い答え')
    await 答える(calls[1], 窓で(窓(0, 全体, 's1', '頭から全部')))
    expect(screen.getByTestId('file-window-text').textContent).toBe('頭から全部')
  })
})

describe('読み足し', () => {
  it('読み足しの頼みは同時に1つだけ', async () => {
    // **「頼みを重ねない」の検査であって、読み足しが実際の寸法で起きることの確かめではない**
    // （寸法は偽り。実寸は E2E が見る）
    const calls = 窓口を偽る()
    const box = 箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 })
    描く(box)
    expect(calls).toHaveLength(1)
    fireEvent.scroll(box)
    fireEvent.scroll(box)
    expect(calls).toHaveLength(1)
  })

  it('継ぎ目の合う窓は後ろへ並べる', async () => {
    const calls = 窓口を偽る()
    描く(箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }))
    await 答える(calls[0], 窓で(窓(先頭のバイト数, 先頭のバイト数 + 窓幅)))
    const spans = screen.getByTestId('file-window-text').querySelectorAll('span')
    expect([...spans].map((s) => s.getAttribute('data-start'))).toEqual([
      '0',
      String(先頭のバイト数),
    ])
  })

  it('行頭へ寄せた前の窓が空で返ったら、同じ範囲を寄せずに1回だけ頼み直す', async () => {
    const calls = 窓口を偽る()
    const 寸法 = { scrollHeight: 1000, clientHeight: 100, scrollTop: 500 }
    const box = 箱を作る(寸法)
    描く(box)
    expect(calls).toHaveLength(0)
    // 末尾へ飛んで、前に窓がある状態を作る
    fireEvent.click(screen.getByTestId('file-window-end'))
    const 末尾の頭 = 全体 - 窓幅
    await 答える(calls[0], 窓で(窓(末尾の頭, 全体)))
    // 上端へ寄せて前への読み足しを起こす
    box.scrollTop = 0
    fireEvent.scroll(box)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ offset: 末尾の頭 - 窓幅, align: 'line' })
    // 寄せた先が今の先頭だった（空の窓）
    await 答える(calls[1], 窓で(窓(末尾の頭, 末尾の頭)))
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({ offset: 末尾の頭 - 窓幅, align: null })
    await 答える(calls[2], 窓で(窓(末尾の頭 - 窓幅, 末尾の頭)))
    const spans = screen.getByTestId('file-window-text').querySelectorAll('span')
    expect(spans).toHaveLength(2)
  })
})

describe('継げない答え（コードレビュー対応 2026-11-23 対応4）', () => {
  it('前へ読み足した答えが今の先頭に継がらなければ止めの印を出し、同じ頼みを撃たない', async () => {
    const calls = 窓口を偽る()
    const box = 箱を作る({ scrollHeight: 1000, clientHeight: 100, scrollTop: 500 })
    描く(box)
    fireEvent.click(screen.getByTestId('file-window-end'))
    const 末尾の頭 = 全体 - 窓幅
    await 答える(calls[0], 窓で(窓(末尾の頭, 全体)))
    box.scrollTop = 0
    fireEvent.scroll(box)
    expect(calls).toHaveLength(2)
    // 終わりが今の先頭を越える（継げない）答え
    await 答える(calls[1], 窓で(窓(末尾の頭 - 窓幅 + 10, 末尾の頭 + 4)))
    expect(screen.getByTestId('file-window-error').textContent).toBe(
      '前の部分を読み込めませんでした',
    )
    fireEvent.scroll(box)
    fireEvent.scroll(box)
    expect(calls).toHaveLength(2)
  })

  it('先頭の窓が2バイト目から始まるとき、前へ読み足すと先頭に着く', async () => {
    const calls = 窓口を偽る()
    const box = 箱を作る({ scrollHeight: 1000, clientHeight: 100, scrollTop: 500 })
    // 窓の幅を「全体−2」にすると、「末尾へ」の窓は2バイト目から始まる
    描く(box, { windowBytes: 全体 - 2 })
    fireEvent.click(screen.getByTestId('file-window-end'))
    expect(calls[0]).toMatchObject({ offset: 2 })
    await 答える(calls[0], 窓で(窓(2, 全体)))
    box.scrollTop = 0
    fireEvent.scroll(box)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ offset: 0, length: '2', align: null })
    await 答える(calls[1], 窓で(窓(0, 2)))
    const spans = screen.getByTestId('file-window-text').querySelectorAll('span')
    expect([...spans].map((span) => span.getAttribute('data-start'))).toEqual(['0', '2'])
    expect(screen.queryByTestId('file-window-before')).toBeNull()
    expect(screen.queryByTestId('file-window-error')).toBeNull()
  })

  it('続きの答えが継がらなければ止めの印を出す', async () => {
    const calls = 窓口を偽る()
    const box = 箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 })
    描く(box)
    expect(calls).toHaveLength(1)
    await 答える(calls[0], 窓で(窓(先頭のバイト数 + 5, 先頭のバイト数 + 20)))
    expect(screen.getByTestId('file-window-error').textContent).toBe('続きを読み込めませんでした')
    fireEvent.scroll(box)
    expect(calls).toHaveLength(1)
  })
})

describe('読んでいる間にファイルが変わった', () => {
  it('印の違う窓は捨て、知らせと「読み直す」を出し、読み直すと新しい印で並ぶ', async () => {
    const calls = 窓口を偽る()
    描く(箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }))
    await 答える(calls[0], 窓で(窓(先頭のバイト数, 先頭のバイト数 + 10, 's2', '変わった後')))
    expect(screen.getByTestId('file-window-changed').textContent).toBe(
      '読んでいる間にファイルが変わりました',
    )
    expect(screen.getByTestId('file-window-text').textContent).not.toContain('変わった後')
    fireEvent.click(screen.getByTestId('file-window-reload'))
    // 見ている先頭の窓の位置（頭）から頼み直す。頭なので寄せない
    expect(calls[1]).toMatchObject({ offset: 0, align: null })
    await 答える(calls[1], 窓で(窓(0, 全体, 's2', '読み直した中身')))
    expect(screen.queryByTestId('file-window-changed')).toBeNull()
    expect(screen.getByTestId('file-window-text').textContent).toBe('読み直した中身')
  })

  it('読み直すは今の先頭から寄せずに読む（コードレビュー対応 2026-11-23 対応5）', async () => {
    const calls = 窓口を偽る()
    const box = 箱を作る({ scrollHeight: 1000, clientHeight: 100, scrollTop: 500 })
    // 窓の幅を「全体−100」にすると、「末尾へ」の窓は100バイト目から始まる
    描く(box, { windowBytes: 全体 - 100 })
    fireEvent.click(screen.getByTestId('file-window-end'))
    await 答える(calls[0], 窓で(窓(100, 全体)))
    box.scrollTop = 0
    fireEvent.scroll(box)
    expect(calls).toHaveLength(2)
    await 答える(calls[1], 窓で(窓(0, 100, 's2')))
    expect(screen.getByTestId('file-window-changed')).toBeTruthy()
    fireEvent.click(screen.getByTestId('file-window-reload'))
    const last = calls[calls.length - 1]
    expect(last).toMatchObject({ offset: 100, align: null })
    await 答える(last, 窓で(窓(100, 全体, 's2')))
    const first = screen.getByTestId('file-window-text').querySelector('span')
    expect(first?.getAttribute('data-start')).toBe('100')
  })
})

describe('途中で読めない', () => {
  it('テキストでない所（415）は、頼んだ位置を3桁区切りで出して読み足しを止める', async () => {
    const calls = 窓口を偽る()
    const box = 箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 })
    描く(box)
    await 答える(
      calls[0],
      new Response('/w/big.log の 15 バイト目からはテキストではありません', { status: 415 }),
    )
    expect(screen.getByTestId('file-window-stop').textContent).toBe(
      `${先頭のバイト数.toLocaleString('en-US')} バイト目からはテキストとして読めません`,
    )
    fireEvent.scroll(box)
    expect(calls).toHaveLength(1)
  })

  it('それ以外の失敗は理由と「もう一度」を出し、押すと同じ範囲を頼み直す', async () => {
    const calls = 窓口を偽る()
    描く(箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }))
    await 答える(calls[0], new Response('PC と繋がっていません', { status: 503 }))
    expect(screen.getByTestId('file-window-error').textContent).toBe('PC と繋がっていません')
    fireEvent.click(screen.getByTestId('file-window-retry'))
    expect(calls).toHaveLength(2)
    expect(calls[1].offset).toBe(calls[0].offset)
    expect(calls[1].length).toBe(calls[0].length)
  })

  it('上限で断られたら（413）、渡された導線を出す', async () => {
    const calls = 窓口を偽る()
    描く(箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }), {
      limitHint: <p data-testid="limit-hint">設定から変えられます</p>,
    })
    await 答える(calls[0], new Response('上限を超えています', { status: 413 }))
    expect(screen.getByTestId('limit-hint')).toBeTruthy()
  })
})

describe('探し直しの合図', () => {
  it('窓の並びが変わるたびに増える数で呼ぶ', async () => {
    const calls = 窓口を偽る()
    const onGeneration = vi.fn()
    描く(箱を作る({ scrollHeight: 100, clientHeight: 100, scrollTop: 0 }), { onGeneration })
    const 置いた直後 = onGeneration.mock.calls.length
    await 答える(calls[0], 窓で(窓(先頭のバイト数, 先頭のバイト数 + 窓幅)))
    expect(onGeneration.mock.calls.length).toBeGreaterThan(置いた直後)
    const 数 = onGeneration.mock.calls.map((call) => call[0] as number)
    expect([...数].sort((a, b) => a - b)).toEqual(数)
  })
})
