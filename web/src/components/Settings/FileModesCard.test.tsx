import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileModesCard } from '@/components/Settings/FileModesCard'
import { 見せ方を選べる拡張子 } from '@/lib/fileMode'
import { useSettingsStore } from '@/stores/settings'

/** 対応を差し替えて、読み込み中ではない状態にする。 */
function 置く(対応: Record<string, 'viewer' | 'editor'>) {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, file_modes: 対応 },
    loading: false,
  }))
}

describe('開いたときの見せ方', () => {
  let update: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    update = vi
      .spyOn(useSettingsStore.getState(), 'update')
      .mockResolvedValue(true) as never
  })

  afterEach(() => {
    vi.restoreAllMocks()
    置く({})
  })

  /**
   * **選ぶ余地があるものだけを並べる。**
   *
   * `text`（表に無い拡張子すべての落ちどころ）と `image` はビュアーを持たないので、
   * 「見る」を選ばせても行き先が無い。**出して黙って既定へ落とすのは「受けたふり」**
   * なので、はじめから出さない。
   */
  it('ビュアーを持つ拡張子だけが並ぶ', () => {
    置く({})
    render(<FileModesCard />)

    for (const 拡張子 of ['md', 'markdown', 'html', 'htm', 'svg']) {
      expect(screen.getByTestId(`file-modes-select-${拡張子}`)).toBeInTheDocument()
    }
    // ビュアーを持たないもの（text へ落ちる／画像）は出ない
    for (const 拡張子 of ['json', 'yaml', 'toml', 'ts', 'txt', 'png', 'jpg']) {
      expect(screen.queryByTestId(`file-modes-select-${拡張子}`)).toBeNull()
    }
    // 並ぶ数は、選べる拡張子の数と一致する
    expect(見せ方を選べる拡張子()).toHaveLength(5)
  })

  it('設定が無ければ、既定が選ばれている', () => {
    置く({})
    render(<FileModesCard />)

    expect(screen.getByTestId('file-modes-select-md')).toHaveValue('viewer')
    expect(screen.getByTestId('file-modes-select-html')).toHaveValue('viewer')
  })

  it('設定が在れば、そちらが選ばれている', () => {
    置く({ md: 'editor' })
    render(<FileModesCard />)

    expect(screen.getByTestId('file-modes-select-md')).toHaveValue('editor')
    // 触っていない拡張子は既定のまま
    expect(screen.getByTestId('file-modes-select-svg')).toHaveValue('viewer')
  })

  it('既定と違うものを選ぶと、その拡張子が記録に入る', async () => {
    置く({})
    render(<FileModesCard />)

    await userEvent.selectOptions(
      screen.getByTestId('file-modes-select-md'),
      'editor',
    )

    expect(update).toHaveBeenCalledWith({ file_modes: { md: 'editor' } })
  })

  /**
   * **既定へ戻したら、行を消す。**
   *
   * 記録に残すのは利用者が既定と違う見せ方を選んだ拡張子だけ（`SettingsView::file_modes`
   * の doc）。戻したのに行が残ると、**あとで既定を変えたときに、戻したはずの拡張子だけ
   * 古い既定に取り残される。**
   */
  it('既定へ戻すと、その行が記録から消える', async () => {
    置く({ md: 'editor', html: 'editor' })
    render(<FileModesCard />)

    await userEvent.selectOptions(
      screen.getByTestId('file-modes-select-md'),
      'viewer',
    )

    expect(update).toHaveBeenCalledWith({ file_modes: { html: 'editor' } })
  })

  it('どちらが既定かが、選択肢に出る', () => {
    置く({})
    render(<FileModesCard />)

    const 選択肢 = screen
      .getByTestId('file-modes-select-md')
      .querySelectorAll('option')
    const 既定の印が付いたもの = [...選択肢].filter((one) =>
      one.textContent?.includes('（既定）'),
    )
    expect(既定の印が付いたもの).toHaveLength(1)
    expect(既定の印が付いたもの[0]).toHaveValue('viewer')
  })
})
