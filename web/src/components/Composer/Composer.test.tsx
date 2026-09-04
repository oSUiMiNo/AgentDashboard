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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { anyComposerBusy } from '@/lib/composerBusy'
import type { CardId } from '@/lib/protocol'
import * as hostfs from '@/lib/hostfs'
import { clearSessions, setCardError } from '@/stores/sessions'
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
  clearSessions()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 置き終わったことにする（運びは別のところで見ている）。 */
function 置けたことにする() {
  vi.spyOn(hostfs, 'uploadAttachment').mockResolvedValue({
    path: '/state/x.png',
    media_type: 'image/png',
    bytes: 8,
  })
}

function 置く() {
  render(<Composer cardId={CARD} status={動いている} host={HOST} />)
}

/**
 * 3経路の入口。**どれも待つ**——付けた時点で中身の写しを取るので、
 * `fireEvent` を撃っただけでは列に並ばない（`lib/attachments.ts` の `Attachment`）。
 */

/** 「＋」から選んだのと同じ形。 */
async function 選ぶ(files: File[]) {
  const input = screen.getByTestId('composer-file')
  await act(async () => {
    fireEvent.change(input, { target: { files } })
  })
}

/** 入力欄へ貼り付けたのと同じ形。 */
async function 貼る(files: File[]) {
  await act(async () => {
    fireEvent.paste(screen.getByTestId('composer-input'), {
      clipboardData: { files },
    })
  })
}

/** 入力欄へ落としたのと同じ形。 */
async function 落とす(files: File[]) {
  await act(async () => {
    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: { files },
    })
  })
}

describe('付ける', () => {
  it('「＋」から選ぶと添付の列に出る', async () => {
    置く()
    await 選ぶ([画像()])
    expect(screen.getByTestId('composer-attachments')).toBeTruthy()
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
  })

  it('貼り付けからも同じ列に出る', async () => {
    置く()
    await 貼る([画像('pasted.png')])
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
  })

  it('落としても同じ列に出る', async () => {
    置く()
    await 落とす([画像('dropped.png')])
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
  })

  it('断られたものは理由が出て、列には並ばない', async () => {
    置く()
    await 選ぶ([画像('e.svg', 'image/svg+xml')])
    expect(screen.getByTestId('composer-trouble').textContent).toContain('e.svg')
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('同じ名前のファイルを2つ断っても、鍵がぶつからない', async () => {
    // **文字列そのものを React の鍵にしない。** 同じ名前なら断り文も同じ文字列になる。
    //
    // **数を数えても捕まらない。** 鍵がぶつかっても React は両方を描くので、
    // `toHaveLength(2)` はどちらでも通る（実際に一度そう書いた）。**React が出す
    // 警告**が、鍵がぶつかったことを外から見る唯一の口である
    const 警告 = vi.spyOn(console, 'error').mockImplementation(() => {})
    置く()
    await 選ぶ([画像('same.svg', 'image/svg+xml'), 画像('same.svg', 'image/svg+xml')])

    expect(
      screen.getByTestId('composer-trouble').querySelectorAll('li'),
    ).toHaveLength(2)
    const 文言 = 警告.mock.calls.flat().join(' ')
    expect(文言).not.toMatch(/same key|同じキー/i)
  })

  it('畳まれるとき、置いたままの添付の絵を捨てる', async () => {
    // 付けたまま別の画面へ移ると、**送っていないぶんの `blob:` が残る**。控えの
    // 後始末は送ったぶんしか見ていないので、こちらは別に要る（コードレビュー対応9）
    const view = render(
      <Composer cardId={CARD} status={動いている} host={HOST} />,
    )
    await 選ぶ([画像()])
    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('名前が札に出る（乗せなくても読める）', async () => {
    // **絵だけを並べない。** 何を付けたのかを名前で確かめられること
    // （メッセンジャーの見せ方に揃えた・利用者の指定 2026-09-03）
    置く()
    await 選ぶ([画像('スクショ.png')])
    expect(screen.getByTestId('composer-attachment-name').textContent).toBe(
      'スクショ.png',
    )
  })

  it('サムネを押すと大きく見られる', async () => {
    // 細かい字のスクショは、札の大きさでは読めない。**送る前に確かめる道**
    置く()
    await 選ぶ([画像('スクショ.png')])
    expect(screen.queryByTestId('composer-preview')).toBeNull()

    fireEvent.click(screen.getByTestId('composer-attachment-open'))
    const 窓 = screen.getByTestId('composer-preview')
    expect(窓.querySelector('img')?.getAttribute('alt')).toBe('スクショ.png')

    fireEvent.click(screen.getByTestId('composer-preview-close'))
    expect(screen.queryByTestId('composer-preview')).toBeNull()
  })

  it('幕を押しても閉じる', async () => {
    // 見るだけの窓なので、取り違えて閉じても害が無い（`ReviveBudgetDialog` は
    // 「全部戻す」を抱えているので閉じない側だった）
    置く()
    await 選ぶ([画像()])
    fireEvent.click(screen.getByTestId('composer-attachment-open'))
    fireEvent.click(screen.getByTestId('composer-preview-backdrop'))
    expect(screen.queryByTestId('composer-preview')).toBeNull()
  })

  it('大きく見ている1枚を外したら、窓も閉じる', async () => {
    // **消えた絵を見せ続けない。** `blob:` は外した時点で捨てているので、
    // 開いたままにすると壊れた絵が残る
    置く()
    await 選ぶ([画像()])
    fireEvent.click(screen.getByTestId('composer-attachment-open'))
    fireEvent.click(screen.getByTestId('composer-attachment-remove'))
    expect(screen.queryByTestId('composer-preview')).toBeNull()
  })

  it('1つずつ外せる', async () => {
    置く()
    await 選ぶ([画像('a.png'), 画像('b.png')])
    fireEvent.click(screen.getAllByTestId('composer-attachment-remove')[0])
    expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1)
    // 外したものの小窓は捨てる
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it('終わったセッションでは添付の口を出さない', async () => {
    // **出し分けの理由はこれだけ。** かつては「宛先の PC が分からないときも出さない」と
    // していたが、`hostOf()` は `agentId ?? LOCAL_HOST` を返すので**その状態は起こらない**
    // ——本番で通らない枝を試すテストになっていた（コードレビュー対応3）。
    //
    // 古い PC のカードでも口は出る。置く側が 409 で断る（ファイル閲覧と同じ形）
    render(
      <Composer
        cardId={CARD}
        status={{ kind: 'ended', ok: true }}
        host={HOST}
      />,
    )
    expect(screen.queryByTestId('composer-attach')).toBeNull()
    expect(screen.queryByTestId('composer-file')).toBeNull()
  })
})

/**
 * 台帳（`lib/composerBusy.ts`）への配線。
 *
 * 台帳そのものの性質は `lib/composerBusy.test.ts` が見ている。ここで見るのは**継ぎ目**
 * ——添付の増減と畳みが、台帳の行の出入りに繋がっていることである。
 *
 * **ここが無いと、配線を丸ごと消す壊し方が単体で1本も落ちない**（E2E だけが落ちる＝
 * 原因からいちばん遠い場所で落ちる）。
 *
 * # 依存を真偽値にしたことは、ここでは確かめていない
 *
 * `attachments`（配列）を依存に置いても答えは同じになるので、下の3本はどちらでも通る。
 * 真偽値にしたのは**登録し直しの隙間を縮めるため**であって、答えの性質ではない
 * （`lib/terminalBridge.test.ts` の「同値なら通知しない」と同じ扱い）。
 *
 * 後始末は `@testing-library/react` の自動 cleanup（`globals: true`）が畳んでくれる
 * ので、この describe では明示的な取り下げを置いていない。
 */
describe('抱えていることを台帳へ知らせる', () => {
  it('添付を1枚付けると、抱えていることになる', async () => {
    expect(anyComposerBusy()).toBe(false)
    置く()

    await 選ぶ([画像()])

    expect(anyComposerBusy()).toBe(true)
  })

  it('全部外すと、抱えていないことに戻る', async () => {
    置く()
    await 選ぶ([画像()])

    fireEvent.click(screen.getByTestId('composer-attachment-remove'))

    expect(anyComposerBusy()).toBe(false)
  })

  it('抱えたまま畳まれると、抱えていないことに戻る', async () => {
    // 付けたまま別の画面へ移ったとき。**行を残すと、そのタブは以後ずっと読み直さない**
    const view = render(
      <Composer cardId={CARD} status={動いている} host={HOST} />,
    )
    await 選ぶ([画像()])
    expect(anyComposerBusy()).toBe(true)

    view.unmount()

    expect(anyComposerBusy()).toBe(false)
  })
})

describe('送る', () => {
  it('送信を押すまでブラウザの外へ出ない', async () => {
    // **先に運ばない。** 運んでおくと、外したときに置いたものが残る（設計§2）
    const upload = vi.spyOn(hostfs, 'uploadAttachment')
    置く()
    await 選ぶ([画像()])
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
    await 選ぶ([画像()])
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
    await 選ぶ([画像()])
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

  it('送れたら添付の列が空になる', async () => {
    置けたことにする()
    置く()
    await 選ぶ([画像()])
    fireEvent.submit(screen.getByTestId('composer'))

    await waitFor(() =>
      expect(screen.queryByTestId('composer-attachments')).toBeNull(),
    )
  })

  it('送った直後は、小窓の絵をまだ捨てない', async () => {
    // **断られたらそのまま戻せること**（設計§7-2）。ここで捨てると、戻したときに
    // 絵の出ないチップが並ぶ
    置けたことにする()
    置く()
    await 選ぶ([画像()])
    fireEvent.submit(screen.getByTestId('composer'))

    await waitFor(() =>
      expect(screen.queryByTestId('composer-attachments')).toBeNull(),
    )
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview')
  })
})

describe('断られたら戻す', () => {
  /** 送って、そのあと断りが届いたことにする。 */
  async function 送って断られる(text = '消えないこと') {
    置けたことにする()
    置く()
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
    await 選ぶ([画像()])
    fireEvent.submit(screen.getByTestId('composer'))
    await waitFor(() =>
      expect(screen.queryByTestId('composer-attachments')).toBeNull(),
    )
    // **種別は実経路に合わせる。** `stores/ws.ts` はサーバの `kind` をそのまま渡すので、
    // 送信の断りは `send_input` で届く。ここを省いて `other` にすると、送信前の地ならしで
    // 消えず、**実際には起きない筋**（前の断りが残ったまま次が届く）を固定してしまう
    act(() => setCardError(CARD, '画像の印が 1 枚ぶん出ませんでした', 'send_input'))
  }

  it('入力欄の本文が戻る', async () => {
    await 送って断られる()
    await waitFor(() =>
      expect(
        (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
      ).toBe('消えないこと'),
    )
  })

  it('添付の列が戻り、もう一度送れる', async () => {
    await 送って断られる()
    await waitFor(() =>
      expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1),
    )
    // 戻ったものをそのまま送れること（**画像を選び直さなくてよい**）
    fireEvent.submit(screen.getByTestId('composer'))
    await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2))
  })

  it('戻すぶんの小窓の絵は捨てられていない', async () => {
    await 送って断られる()
    await waitFor(() =>
      expect(screen.getAllByTestId('composer-attachment-remove')).toHaveLength(1),
    )
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview')
  })

  it('同じ文言の断りが2回続けて来ても、2回目も戻る', async () => {
    // `useCardError` は文字列をそのまま返すので、**同じ断りが2回続くと React からは
    // 変化に見えない**（`Object.is` で弾かれる）。送る前に消しているから通る
    const 同じ文言 = '画像の印が 1 枚ぶん出ませんでした'
    await 送って断られる('1回目')
    await waitFor(() =>
      expect(
        (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
      ).toBe('1回目'),
    )

    fireEvent.submit(screen.getByTestId('composer'))
    await waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2))
    // **種別を渡す。** 実際の経路（`stores/ws.ts`）はサーバの `kind` をそのまま渡すので、
    // 送信の断りは `send_input` で届く。送信前の地ならしが消すのもこの種別だけである
    // ——種別を省くと**復旧の失敗など「消えない側」まで巻き添えで消える**
    act(() => setCardError(CARD, 同じ文言, 'send_input'))

    await waitFor(() =>
      expect(
        (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
      ).toBe('1回目'),
    )
  })

  it('押したあとに打ち直していたら、戻さない', async () => {
    // 押したあとに書き始めた文のほうが新しい。**それを上書きしない**
    置けたことにする()
    置く()
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '古い文' } })
    fireEvent.submit(screen.getByTestId('composer'))
    await waitFor(() => expect(sendInput).toHaveBeenCalled())

    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '新しい文' } })
    act(() => setCardError(CARD, '断り'))

    await waitFor(() =>
      expect(
        (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
      ).toBe('新しい文'),
    )
  })

  it('窓を過ぎたら控えを捨て、そのあとの断りでは戻さない', async () => {
    // 断りには**相関IDが無い**ので、いつまでも待つと無関係な断り（権限モードの切替が
    // 断られた等）で古い本文が戻ってしまう
    vi.useFakeTimers()
    try {
      置けたことにする()
      置く()
      fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '古い文' } })
      await 選ぶ([画像()])
      fireEvent.submit(screen.getByTestId('composer'))
      // 運びは Promise なので、時計を進める前に流し切る
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.queryByTestId('composer-attachments')).toBeNull()

      // 窓を閉じる。ここで控えの絵が捨てられる
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')

      // そのあとに断りが来ても、もう戻さない
      act(() => setCardError(CARD, 'ずっと後の断り'))
      expect(
        (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
      ).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('畳まれるとき、控えの絵を捨てる', async () => {
    // 残すとブラウザの中に溜まる（`FileView` が後始末で捨てているのと同じ約束）
    置けたことにする()
    const view = render(<Composer cardId={CARD} status={動いている} host={HOST} />)
    await 選ぶ([画像()])
    fireEvent.submit(screen.getByTestId('composer'))
    await waitFor(() =>
      expect(screen.queryByTestId('composer-attachments')).toBeNull(),
    )

    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })

  it('断り文をここには出さない', async () => {
    // `SessionView` が `card-error` として既に出している。再掲すると同じ文が上下に2つ並ぶ
    await 送って断られる()
    await waitFor(() =>
      expect(
        (screen.getByTestId('composer-input') as HTMLTextAreaElement).value,
      ).toBe('消えないこと'),
    )
    expect(screen.queryByTestId('composer-trouble')).toBeNull()
  })
})
