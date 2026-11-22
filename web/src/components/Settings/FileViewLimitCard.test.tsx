import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileViewLimitCard } from '@/components/Settings/FileViewLimitCard'
import { useSettingsStore, type FileViewSettings } from '@/stores/settings'
import { fileViewFixture, settingsFixture } from '@/test/fixtures'

/**
 * ファイル閲覧の上限のカード（ファイル閲覧の上限を設定から変え、大きいものは流し読みする
 * テスト計画フェーズ6）。
 *
 * 試験の中の数（MiB・GiB）は試験ファイルの中の定数。**製品コードは写しを持たない**
 * （全部サーバの `file_view` から受け取る）。
 */

const MIB = 1024 * 1024
const GIB = 1024 * MIB

const サーバ: Partial<FileViewSettings> = {
  via_server: true,
  warn_from_bytes: 5 * MIB,
  max_bytes: 3 * MIB,
  default_bytes: 3 * MIB,
}
const クラウド = { name: 'Amazon EC2', source: 'dmi' as const }

/** ストアの本物の保存。試験ごとに差し替え、終わったら戻す */
const 本物の保存 = useSettingsStore.getState().update
let update: ReturnType<typeof vi.fn>

/** 上限の一式を差し替えて、読み込み中ではない状態にする。 */
function 置く(overrides: Partial<FileViewSettings> = {}, loading = false) {
  useSettingsStore.setState({
    settings: settingsFixture({ file_view: fileViewFixture(overrides) }),
    loading,
  })
}

function 描く(入口 = '/settings') {
  return render(
    <MemoryRouter initialEntries={[入口]}>
      <FileViewLimitCard />
    </MemoryRouter>,
  )
}

function 選ぶ欄(): HTMLSelectElement {
  return screen.getByTestId('file-view-limit-select') as HTMLSelectElement
}

beforeEach(() => {
  置く()
  // **試験ごとに新しい偽物を差し込む。** ストアの状態を `spyOn` で包むと、`setState` が
  // 包みを次の状態へ写し、呼ばれた回数が試験をまたいで積み上がる
  update = vi.fn().mockResolvedValue(true)
  useSettingsStore.setState({ update: update as never })
})

afterEach(() => {
  vi.restoreAllMocks()
  useSettingsStore.setState({ update: 本物の保存 })
  置く()
})

describe('カードの中身', () => {
  it('16個が並び、既定の1つにだけ印が付き、いまの値が選ばれている', () => {
    描く()
    const options = within(選ぶ欄()).getAllByRole('option')
    expect(options).toHaveLength(16)
    for (const option of options) {
      expect(option.textContent).toMatch(/^\d+ (MB|GB)（[\d,]+ バイト）(・既定)?$/)
    }
    const 既定 = options.filter((option) => option.textContent?.endsWith('・既定'))
    expect(既定).toHaveLength(1)
    expect(既定[0].textContent).toBe('5 GB（5,368,709,120 バイト）・既定')
    expect(選ぶ欄().value).toBe(String(5 * GIB))
  })

  it('いまの値が選択肢に無いときは、先頭に足して黙って別の値を選んだ顔をしない', () => {
    置く({ max_bytes: 2 * MIB })
    描く()
    const options = within(選ぶ欄()).getAllByRole('option')
    expect(options).toHaveLength(17)
    expect(options[0].textContent).toBe('2 MB（2,097,152 バイト）')
    expect(選ぶ欄().value).toBe(String(2 * MIB))
  })

  it('説明文は一括で読む線・プレビューの天井・画像の上限を、サーバの値で言う', () => {
    描く()
    const card = screen.getByTestId('file-view-limit')
    expect(card.textContent).toContain('3 MB を超えるファイルは、生テキストで少しずつ読みます')
    expect(card.textContent).toContain('32 MB までなら描いた形で見られます')
    expect(card.textContent).toContain('画像は別の上限（8 MB）で、この設定では変わりません')
  })

  it('状況の一言は、当たるときだけ出る', () => {
    const { unmount } = 描く()
    expect(screen.queryByTestId('file-view-limit-via-server')).toBeNull()
    expect(screen.queryByTestId('file-view-limit-cloud')).toBeNull()
    unmount()

    置く({ ...サーバ, cloud: クラウド })
    const 二度目 = 描く()
    expect(screen.getByTestId('file-view-limit-via-server').textContent).toContain(
      '既定は 3 MB です',
    )
    const 雲 = screen.getByTestId('file-view-limit-cloud').textContent
    expect(雲).toContain('クラウド（Amazon EC2）')
    expect(雲).toContain('DMI')
    二度目.unmount()

    置く({ cloud: { name: '設定で指定', source: 'config' } })
    描く()
    expect(screen.getByTestId('file-view-limit-cloud').textContent).toContain(
      '設定ファイルの指定から',
    )
  })

  it('既定へ戻すは、値を入れてあって変えてよいときだけ出て、押すと既定へ戻す', async () => {
    const { unmount } = 描く()
    expect(screen.queryByTestId('file-view-limit-reset')).toBeNull()
    unmount()

    置く({ configured: true, editable: false })
    const 二度目 = 描く()
    expect(screen.queryByTestId('file-view-limit-reset')).toBeNull()
    二度目.unmount()

    置く({ configured: true, max_bytes: 10 * MIB })
    描く()
    await userEvent.click(screen.getByTestId('file-view-limit-reset'))
    // 下げる・戻す操作に警告は出さない
    expect(screen.queryByTestId('file-view-limit-confirm')).toBeNull()
    expect(update).toHaveBeenCalledWith({ file_view_max_bytes: 'default' })
  })
})

describe('警告の段の数', () => {
  it('ローカル（クラウドでもない）は0段で、そのまま保存する', async () => {
    描く()
    await userEvent.selectOptions(選ぶ欄(), String(10 * MIB))
    expect(screen.queryByTestId('file-view-limit-confirm')).toBeNull()
    expect(update).toHaveBeenCalledWith({ file_view_max_bytes: 10 * MIB })
  })

  it('サーバは1段で、「変える」で1回だけ保存する', async () => {
    置く(サーバ)
    描く()
    await userEvent.selectOptions(選ぶ欄(), String(10 * MIB))
    const 窓 = screen.getByTestId('file-view-limit-confirm')
    expect(窓.dataset.step).toBe('server')
    expect(within(窓).getByRole('heading').textContent).toBe(
      '上限を 10 MB にすると、転送量が増えます',
    )
    expect(窓.textContent).toContain('モバイル回線で見るときは、スマホの通信量に注意してください')
    expect(update).not.toHaveBeenCalled()
    const 進む = screen.getByTestId('file-view-limit-confirm-go')
    expect(進む.textContent).toBe('変える')
    await userEvent.click(進む)
    expect(screen.queryByTestId('file-view-limit-confirm')).toBeNull()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ file_view_max_bytes: 10 * MIB })
  })

  it('サーバでクラウドなら2段で、保存は最後の段の後の1回だけ', async () => {
    置く({ ...サーバ, cloud: クラウド })
    描く()
    await userEvent.selectOptions(選ぶ欄(), String(10 * MIB))
    expect(screen.getByTestId('file-view-limit-confirm').dataset.step).toBe('server')
    const 続ける = screen.getByTestId('file-view-limit-confirm-go')
    expect(続ける.textContent).toBe('続ける')
    await userEvent.click(続ける)
    const 二段目 = screen.getByTestId('file-view-limit-confirm')
    expect(二段目.dataset.step).toBe('cloud')
    expect(within(二段目).getByRole('heading').textContent).toBe(
      'このサーバはクラウド（Amazon EC2）の上で動いていると判定しました',
    )
    expect(update).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('file-view-limit-confirm-go'))
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ file_view_max_bytes: 10 * MIB })
  })

  it('ローカルでもクラウドなら、クラウドの1段だけ', async () => {
    置く({ cloud: クラウド, warn_from_bytes: 5 * MIB, max_bytes: 3 * MIB })
    描く()
    await userEvent.selectOptions(選ぶ欄(), String(10 * MIB))
    expect(screen.getByTestId('file-view-limit-confirm').dataset.step).toBe('cloud')
    expect(screen.getByTestId('file-view-limit-confirm-go').textContent).toBe('変える')
  })

  it('下げるときは、サーバでクラウドでも出ない', async () => {
    置く({ ...サーバ, cloud: クラウド, max_bytes: 10 * MIB })
    描く()
    await userEvent.selectOptions(選ぶ欄(), String(5 * MIB))
    expect(screen.queryByTestId('file-view-limit-confirm')).toBeNull()
    expect(update).toHaveBeenCalledWith({ file_view_max_bytes: 5 * MIB })
  })

  it.each([
    ['1段目の「やめる」', 0, 'click'],
    ['2段目の「やめる」', 1, 'click'],
    ['2段目の Esc', 1, 'escape'],
  ] as const)('%s で取り消すと、窓が消えて元の値に戻り、保存しない', async (_name, 段, 手) => {
    置く({ ...サーバ, cloud: クラウド })
    描く()
    await userEvent.selectOptions(選ぶ欄(), String(10 * MIB))
    if (段 === 1) {
      await userEvent.click(screen.getByTestId('file-view-limit-confirm-go'))
      expect(screen.getByTestId('file-view-limit-confirm').dataset.step).toBe('cloud')
    }
    if (手 === 'escape') {
      await userEvent.keyboard('{Escape}')
    } else {
      await userEvent.click(screen.getByTestId('file-view-limit-confirm-cancel'))
    }
    expect(screen.queryByTestId('file-view-limit-confirm')).toBeNull()
    expect(選ぶ欄().value).toBe(String(3 * MIB))
    expect(update).not.toHaveBeenCalled()
  })

  it('覚えない：押し切った後にもう一度選ぶと、また出る', async () => {
    置く(サーバ)
    描く()
    await userEvent.selectOptions(選ぶ欄(), String(10 * MIB))
    await userEvent.click(screen.getByTestId('file-view-limit-confirm-go'))
    expect(update).toHaveBeenCalledTimes(1)
    // 保存の答えは見本のまま（3 MiB）。もう一度上げると、また確かめる
    await userEvent.selectOptions(選ぶ欄(), String(10 * MIB))
    expect(screen.getByTestId('file-view-limit-confirm').dataset.step).toBe('server')
  })
})

describe('管理者でない人は選べない', () => {
  it('サーバでは「管理者だけ」、ローカルでは「127.0.0.1 から」と言い、選ぶ欄を閉じる', () => {
    置く({ ...サーバ, editable: false })
    const { unmount } = 描く()
    expect(選ぶ欄().disabled).toBe(true)
    expect(screen.getByTestId('file-view-limit-readonly').textContent).toBe(
      'サーバの管理者だけが変えられます。',
    )
    unmount()

    置く({ editable: false })
    描く()
    expect(選ぶ欄().disabled).toBe(true)
    expect(screen.getByTestId('file-view-limit-readonly').textContent).toContain('127.0.0.1')
  })
})

describe('ハッシュで開くとカードへ送る', () => {
  it('読み込みが済んでから1回だけ送り、ハッシュが無ければ送らない', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    置く({}, true)
    const { unmount } = 描く('/settings#file-view-limit')
    expect(scroll).not.toHaveBeenCalled()
    act(() => {
      useSettingsStore.setState({ loading: false })
    })
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll).toHaveBeenCalledWith({ block: 'start' })
    unmount()

    scroll.mockClear()
    描く('/settings')
    expect(scroll).not.toHaveBeenCalled()
  })
})

describe('古いサーバでも壊れない', () => {
  it('読み込み中は「読み込み中です」だけ、選択肢の無い答えは「変えられません」だけ', () => {
    置く({}, true)
    const { unmount } = 描く()
    expect(screen.getByTestId('file-view-limit-loading')).toBeTruthy()
    expect(screen.queryByTestId('file-view-limit-select')).toBeNull()
    unmount()

    置く({ choices: [] })
    描く()
    expect(screen.getByTestId('file-view-limit-unsupported').textContent).toBe(
      'この版のサーバは上限を変えられません。',
    )
    expect(screen.queryByTestId('file-view-limit-select')).toBeNull()
  })
})
