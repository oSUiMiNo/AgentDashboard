import { render, screen, waitFor } from '@testing-library/react'
import { TERMINAL_OPTIONS, TerminalPane } from './TerminalPane'
import { useWsStore } from '@/stores/ws'

/**
 * WebGL レンダラの取り扱い（テスト計画フェーズ5「TerminalPane」）。
 *
 * GPU コンテキストは、別のタブが GPU を食い潰したときやドライバの再起動で**普通に失われる**。
 * 失ったまま放置すると端末の描画だけが静かに止まり、利用者からは「固まった」ように見える。
 * 落としたら DOM レンダラへ退避して描画を続けることが、ここで守りたい約束。
 *
 * フロー制御の判定そのものは `src/lib/flow.test.ts`、実ブラウザでの発火は E2E が見る。
 */

/** コンテキストロストをテストから起こせる WebGL アドオン。 */
let loseContext: (() => void) | undefined
let disposed = false

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(handler: () => void) {
      loseContext = handler
    }
    dispose() {
      disposed = true
    }
    // xterm 側から呼ばれる最低限の口
    activate() {}
  },
}))

const CARD = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  loseContext = undefined
  disposed = false
})

afterEach(() => {
  useWsStore.getState().disconnect()
})

describe('TerminalPane', () => {
  it('WebGL を失ったら DOM レンダラへ退避する', async () => {
    render(<TerminalPane cardId={CARD} />)

    const status = screen.getByTestId('terminal-status')
    await waitFor(() => expect(status).toHaveAttribute('data-renderer', 'webgl'))
    expect(loseContext).toBeDefined()

    // GPU コンテキストが失われた
    loseContext?.()

    await waitFor(() => expect(status).toHaveAttribute('data-renderer', 'dom'))
    expect(disposed).toBe(true)
  })

  // xterm の既定はブロックで、カーソル位置の文字を塗り潰すため上書きモードに見える。
  // WebGL レンダラのカーソルは canvas 描画なので CSS では戻せない。ここが唯一の指定箇所
  it('カーソルは挿入モードに見えるバーにする', () => {
    expect(TERMINAL_OPTIONS.cursorStyle).toBe('bar')
  })
})
