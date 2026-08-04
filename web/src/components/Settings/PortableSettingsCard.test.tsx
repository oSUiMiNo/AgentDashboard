import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortableSettingsCard } from '@/components/Settings/PortableSettingsCard'
import { useSettingsStore } from '@/stores/settings'

/** 読み込ませるファイルを1つ作る。 */
function file(text: string) {
  return new File([text], 'agentdashboard-settings.json', {
    type: 'application/json',
  })
}

describe('設定の持ち出し', () => {
  beforeEach(() => {
    // 読み込みの後に画面を作り直す経路が走るので、通信には行かせない
    vi.spyOn(useSettingsStore.getState(), 'load').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('書き出しはサーバの口を直に指す', () => {
    // fetch して Blob を組み立てる作りにすると、**ファイル名の決め方が画面側にも
    // 生まれる**。リンクを踏ませるだけにしてある
    render(<PortableSettingsCard />)

    const link = screen.getByTestId('portable-export')
    expect(link).toHaveAttribute('href', '/api/settings/export')
    expect(link).toHaveAttribute('download')
  })

  it('読み込むと件数が出る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"applied":["sync_interval_secs"],"ignored":[]}',
      }),
    )
    render(<PortableSettingsCard />)

    await userEvent.upload(screen.getByTestId('portable-file'), file('{}'))

    await waitFor(() => {
      expect(screen.getByTestId('portable-outcome')).toHaveTextContent(
        '1件を反映しました',
      )
    })
    expect(screen.queryByTestId('portable-error')).toBeNull()
  })

  it('無視した項目があればそれも出る', async () => {
    // **黙って捨てない。** 反映されない項目があることが伝わらないと、
    // 「読み込んだのに効いていない」が説明の付かない現象になる
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          '{"applied":["sync_interval_secs"],"ignored":["未来のキー"]}',
      }),
    )
    render(<PortableSettingsCard />)

    await userEvent.upload(screen.getByTestId('portable-file'), file('{}'))

    await waitFor(() => {
      expect(screen.getByTestId('portable-outcome')).toHaveTextContent(
        '未来のキー',
      )
    })
  })

  it('断られたら理由をそのまま出す', async () => {
    // サーバはどのキーがどう駄目かを返してくる。要約すると直しようが無くなる
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'scrollback_lines は 1〜1000000 の範囲で指定してください',
      }),
    )
    render(<PortableSettingsCard />)

    await userEvent.upload(screen.getByTestId('portable-file'), file('{}'))

    await waitFor(() => {
      expect(screen.getByTestId('portable-error')).toHaveTextContent(
        'scrollback_lines',
      )
    })
    expect(screen.queryByTestId('portable-outcome')).toBeNull()
  })
})
