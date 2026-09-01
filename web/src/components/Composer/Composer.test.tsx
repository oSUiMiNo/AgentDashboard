/**
 * 添付を付けて送るところ（画像添付 テスト計画フェーズ5）。
 *
 * ふるいそのものは `lib/attachments.test.ts` が見ている。ここで見るのは**継ぎ目**——
 * 3経路が同じ列を作ること、外せること、**送信を押すまで外へ出ないこと**、
 * **運びに失敗したら送らずに残すこと**である。
 *
 * # `compact` を渡す試験が無いのは意図である
 *
 * `Composer` は `compact` を受け取らない（`InputDock` が消費する）。**分岐が無いことが
 * 「両方の画面に出る」ことの根拠**なので、ここで分岐を試すと、あとから分岐を足しても
 * 気づけない試験を書くことになる（設計§9-2）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import type { CardId } from '@/lib/protocol'
import * as hostfs from '@/lib/hostfs'
import { useWsStore } from '@/stores/ws'

const CARD = '11111111-2222-3333-4444-555555555555' as CardId
const HOST = 'local'
const 動いている = { kind: 'waiting_input' } as const

function 画像(name = 'a.png', type = 'image/png'): File {
  return new File([new Uint8Array(8)], name, { type })
}

let sendInput: ReturnType<typeof vi.fn>

beforeEach(() => {
  sendInput = vi.fn(() => true)
  useWsStore.setState({ sendInput } as never)
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function 置く() {
  render(<Composer cardId={CARD} status={動いている} host={HOST} />)
}

/** 「＋」から選んだのと同じ形。 */
function 選ぶ(files: File[]) {
  const input = screen.getByTestId('composer-file')
  fireEvent.change(input, { target: { files } })
}

describe('付ける', () => {
  it('「＋」から選ぶと添付の列に出る', () => {
    置く()
    選ぶ([画像()])
    expect(screen.getByTestId('composer-attachments')).toBeTruthy()
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
  })

  it('貼り付けからも同じ列に出る', () => {
    置く()
    fireEvent.paste(screen.getByTestId('composer-input'), {
      clipboardData: { files: [画像('pasted.png')] },
    })
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
  })

  it('落としても同じ列に出る', () => {
    置く()
    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: { files: [画像('dropped.png')] },
    })
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
  })

  it('断られたものは理由が出て、列には並ばない', () => {
    置く()
    選ぶ([画像('e.svg', 'image/svg+xml')])
    expect(screen.getByTestId('composer-trouble').textContent).toContain('e.svg')
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('1つずつ外せる', () => {
    置く()
    選ぶ([画像('a.png'), 画像('b.png')])
    fireEvent.click(screen.getAllByTestId('composer-attachment-remove')[0])
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
    // 外したものの小窓は捨てる
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it('宛先の PC が分からないときは添付の口を出さない', () => {
    // できないことをボタンにしない（設計§4-1）
    render(<Composer cardId={CARD} status={動いている} host={null} />)
    expect(screen.queryByTestId('composer-attach')).toBeNull()
    expect(screen.queryByTestId('composer-file')).toBeNull()
  })
})

describe('送る', () => {
  it('送信を押すまでブラウザの外へ出ない', async () => {
    // **先に運ばない。** 運んでおくと、外したときに置いたものが残る（設計§2）
    const upload = vi.spyOn(hostfs, 'uploadAttachment')
    置く()
    選ぶ([画像()])
    fireEvent.click(screen.getAllByTestId('composer-attachment-remove')[0])
    expect(upload).not.toHaveBeenCalled()
  })

  it('押してから運び、置き終わったパスを本文と一緒に送る', async () => {
    const upload = vi
      .spyOn(hostfs, 'uploadAttachment')
      .mockResolvedValue({ path: '/state/x.png', media_type: 'image/png', bytes: 8 })
    置く()
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'これを見て' },
    })
    選ぶ([画像()])
    fireEvent.submit(screen.getByTestId('composer'))

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(sendInput).toHaveBeenCalledWith(CARD, 'これを見て', [
        '/state/x.png',
      ]),
    )
  })

  it('添付が無いときは空の配列で送る', async () => {
    置く()
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'ふつうの指示' },
    })
    fireEvent.submit(screen.getByTestId('composer'))
    await waitFor(() =>
      expect(sendInput).toHaveBeenCalledWith(CARD, 'ふつうの指示', []),
    )
  })

  it('運びに失敗したら送らず、添付も入力欄の中身も残す', async () => {
    vi.spyOn(hostfs, 'uploadAttachment').mockRejectedValue(
      new hostfs.HostFsError(413, '大きすぎます'),
    )
    置く()
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: '消えないこと' },
    })
    選ぶ([画像()])
    fireEvent.submit(screen.getByTestId('composer'))

    await waitFor(() =>
      expect(screen.getByTestId('composer-trouble').textContent).toContain(
        '大きすぎます',
      ),
    )
    expect(sendInput).not.toHaveBeenCalled()
    // **押し直せること。** ここで消すと、画像を選び直すところからやり直しになる
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
    expect(
      (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
    ).toBe('消えないこと')
  })

  it('送れたら添付の列が空になり、小窓の絵を捨てる', async () => {
    vi.spyOn(hostfs, 'uploadAttachment').mockResolvedValue({
      path: '/state/x.png',
      media_type: 'image/png',
      bytes: 8,
    })
    置く()
    選ぶ([画像()])
    fireEvent.submit(screen.getByTestId('composer'))

    await waitFor(() =>
      expect(screen.queryByTestId('composer-attachments')).toBeNull(),
    )
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })
})
