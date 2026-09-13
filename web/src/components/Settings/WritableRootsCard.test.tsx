import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WritableRootsCard } from '@/components/Settings/WritableRootsCard'
import { useSettingsStore } from '@/stores/settings'

/** 一覧を差し替えて、読み込み中ではない状態にする。 */
function 置く(roots: string[]) {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, writable_roots: roots },
    loading: false,
  }))
}

describe('保存を許可する場所', () => {
  let update: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    update = vi
      .spyOn(useSettingsStore.getState(), 'update')
      .mockResolvedValue(true) as never
  })

  afterEach(() => {
    vi.restoreAllMocks()
    置く([])
  })

  it('足された場所が無いときは、そう言う', () => {
    置く([])
    render(<WritableRootsCard />)

    expect(screen.getByTestId('writable-roots-list')).toHaveTextContent(
      '足された場所はありません',
    )
  })

  it('足された場所が並ぶ', () => {
    置く(['/home/u/.claude', '/srv/notes'])
    render(<WritableRootsCard />)

    const list = screen.getByTestId('writable-roots-list')
    expect(list).toHaveTextContent('/home/u/.claude')
    expect(list).toHaveTextContent('/srv/notes')
  })

  /**
   * **既定（開いている PJT の配下）を行にしない。**
   *
   * 消せない行を並べると、設定に見えるのに設定ではないことになる。断り書きでは
   * 伝えるが、**一覧には出さない**。
   */
  it('既定の PJT 配下は、一覧の行にしない', () => {
    置く([])
    render(<WritableRootsCard />)

    // 断り書きには出る
    expect(screen.getByTestId('writable-roots')).toHaveTextContent(
      '開いている PJT の配下は、この一覧に無くても常に書けます',
    )
    // 行には出ない（外すボタンが1つも無い）
    expect(screen.queryByTestId(/^writable-roots-drop-/)).toBeNull()
  })

  it('足すと、末尾の区切りを落として渡す', async () => {
    置く([])
    render(<WritableRootsCard />)

    await userEvent.type(
      screen.getByTestId('writable-roots-input'),
      '/home/u/notes/',
    )
    await userEvent.click(screen.getByRole('button', { name: '足す' }))

    expect(update).toHaveBeenCalledWith({ writable_roots: ['/home/u/notes'] })
  })

  /**
   * **相対パスは受けない。** 「どこから見て」が決まらないので、照合の相手が定まらない
   * （設計§3-1 はサーバが字句で照合する）。
   */
  it('相対パスは足せない', async () => {
    置く([])
    render(<WritableRootsCard />)

    await userEvent.type(screen.getByTestId('writable-roots-input'), 'notes')

    expect(screen.getByRole('button', { name: '足す' })).toBeDisabled()
  })

  it('既に在る場所は足せない', async () => {
    置く(['/home/u/notes'])
    render(<WritableRootsCard />)

    await userEvent.type(
      screen.getByTestId('writable-roots-input'),
      '/home/u/notes',
    )

    expect(screen.getByRole('button', { name: '足す' })).toBeDisabled()
  })

  it('外すと、その場所だけを除いた一覧で渡す', async () => {
    置く(['/home/u/.claude', '/srv/notes'])
    render(<WritableRootsCard />)

    await userEvent.click(screen.getByTestId('writable-roots-drop-/srv/notes'))

    expect(update).toHaveBeenCalledWith({
      writable_roots: ['/home/u/.claude'],
    })
  })
})
