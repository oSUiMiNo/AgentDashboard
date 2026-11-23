import { ContextMenuItem } from '@/components/ui/context-menu'
import { isOpenedIn, type OpenApp, type OpenInView } from '@/lib/openIn'

interface Props {
  /** その行の絶対パス */
  path: string
  view: OpenInView
  open: (app: OpenApp, path: string) => void
}

/**
 * サイドバーの行の右クリックに足す2項目（サイドバーにエクスプローラで開くボタンが欲しい
 * 設計§7-5）。文字で出す（要件）。
 *
 * **押せない項目にも理由を出す。** radix は押せない項目を `pointer-events-none` にする
 * ので、項目の `title` は乗せても出ない。中の `span` を `pointer-events-auto` にして、
 * そこにも同じ文を置く。
 *
 * 区切り線は呼ぶ側（`FolderBrowser` の行）で置く——この部品は前後に何が並ぶかを知らない。
 */
export function OpenInMenuItems({ path, view, open }: Props) {
  const 開いている = isOpenedIn(view, path)
  const エクスプローラの理由 = view.explorer.reason ?? 'エクスプローラは使えません'
  const VSCodeの理由 = view.vscode.reason ?? 'VSCode は使えません'
  const VSCodeの文字 = 開いている ? 'VSCode で開いています（前に出す）' : 'VSCode で開く'

  return (
    <>
      <ContextMenuItem
        data-testid="folder-menu-open-explorer"
        disabled={!view.explorer.available}
        title={view.explorer.available ? undefined : エクスプローラの理由}
        onSelect={() => open('explorer', path)}
      >
        {view.explorer.available ? (
          'エクスプローラで開く'
        ) : (
          <span className="pointer-events-auto" title={エクスプローラの理由}>
            エクスプローラで開く
          </span>
        )}
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="folder-menu-open-vscode"
        disabled={!view.vscode.available}
        title={view.vscode.available ? undefined : VSCodeの理由}
        onSelect={() => open('vscode', path)}
      >
        {view.vscode.available ? (
          VSCodeの文字
        ) : (
          <span className="pointer-events-auto" title={VSCodeの理由}>
            {VSCodeの文字}
          </span>
        )}
      </ContextMenuItem>
    </>
  )
}
