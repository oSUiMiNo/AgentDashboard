import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView } from '@/components/FileView/FileView'
import { 拡張子 } from '@/lib/fileMode'
import { settingsFixture } from '@/test/fixtures'
import { useSettingsStore } from '@/stores/settings'

/*
  **拡張子ごとの既定モード**（`ファイルビュアにエディタ機能を追加` 要件③）。

  > 各拡張子をデフォルトでどっちのトグルで開くかを設定でいじれる。
  > 設定無しの拡張子は、基本的にエディタモードで開かれる。

  **設定が無いときの既定は、種別から導く**——`md` ／ `html` ／ `svg` は見る、
  それ以外は編集する。ここが要件の後半にあたる。
*/

const ROOT = '/dev/app'

function 出す(text = '本文') {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            path: 'x',
            text,
            truncated: false,
            bytes: text.length,
            writable: true,
          }),
          { status: 200 },
        ),
    ),
  )
}

function 設定する(file_modes: Record<string, 'viewer' | 'editor'>) {
  useSettingsStore.setState({ settings: settingsFixture({ file_modes }), loading: false })
}

function 開く(path: string) {
  return render(
    <FileView
      host="local"
      root={ROOT}
      path={path}
      tabs={[path]}
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onReorderTab={() => {}}
      onReorderTabCommit={() => {}}
    />,
  )
}

beforeEach(() => {
  出す()
  設定する({})
})

afterEach(() => {
  vi.unstubAllGlobals()
  設定する({})
})

describe('設定を引くための拡張子', () => {
  it.each([
    ['メモ.txt', 'txt'],
    // **大文字で書かれていても同じ行に当てる。** 設定は小文字で持つ
    ['ヨミ.MD', 'md'],
    ['a/b/c.tar.gz', 'gz'],
    // **点を持たない名前は「拡張子が無い」**——設定の行と当ててはいけない
    ['Makefile', ''],
    // **点で始まる名前も「拡張子が無い」**。`.bashrc` は `bashrc` ではない
    ['.bashrc', ''],
    ['/dev/app/.env', ''],
  ])('%s → %s', (path, 期待) => {
    expect(拡張子(path)).toBe(期待)
  })
})

describe('拡張子ごとの既定モード', () => {
  it('設定が無ければ、種別から導く（要件「設定無しの拡張子はエディタ」）', async () => {
    開く(`${ROOT}/メモ.txt`)
    // **ビュアーを持たない種別は編集で始まる**
    expect(await screen.findByTestId('file-editor')).toBeInTheDocument()
  })

  it('設定が無ければ、md は見るで始まる', async () => {
    開く(`${ROOT}/計画.md`)
    expect(await screen.findByTestId('file-markdown')).toBeInTheDocument()
  })

  it('設定が「編集する」なら、md でも編集で始まる', async () => {
    設定する({ md: 'editor' })
    開く(`${ROOT}/計画.md`)
    expect(await screen.findByTestId('file-editor')).toBeInTheDocument()
    expect(screen.queryByTestId('file-markdown')).toBeNull()
  })

  it('大文字の名前でも、小文字の行に当たる', async () => {
    設定する({ md: 'editor' })
    開く(`${ROOT}/ケイカク.MD`)
    expect(await screen.findByTestId('file-editor')).toBeInTheDocument()
  })

  it('ビュアーを持たない種別に「見る」を選ばれても、既定へ落とす', async () => {
    /*
      **行き先が無いものを受けたふりをしない。** `txt` にビュアーは無いので、
      `viewer` を指定されても**編集で始める**——受けると、モードは「見る」なのに
      画面はエディタという食い違いが残る。
    */
    設定する({ txt: 'viewer' })
    開く(`${ROOT}/メモ.txt`)
    expect(await screen.findByTestId('file-editor')).toBeInTheDocument()
  })

  it('関係のない拡張子の行は、他のファイルに効かない', async () => {
    設定する({ json: 'viewer' })
    開く(`${ROOT}/計画.md`)
    expect(await screen.findByTestId('file-markdown')).toBeInTheDocument()
  })
})
