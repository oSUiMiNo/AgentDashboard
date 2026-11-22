import { Button } from '@/components/ui/button'
import { EditorOutGlyph, FolderOutGlyph } from '@/components/ui/glyphs'
import type { OpenApp, OpenInView } from '@/lib/openIn'

interface Props {
  /** PJT のルート。**押すと開くのはここ**（いま辿っている場所ではない。仮置き） */
  root: string
  view: OpenInView
  open: (app: OpenApp, path: string) => void
  busy: boolean
}

/** パスの最後の段。`title` で「何を開くのか」を言うのに使う */
function 名前(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/**
 * パンくずの行の右端に置く、エクスプローラ・VSCode で開く2つのボタン
 * （サイドバーにエクスプローラで開くボタンが欲しい 設計§7-2）。
 *
 * **器は1つだけ。** パンくずは文字が並ぶ場所なので、`ghost` だけだと UI だと読めない
 * （`FolderBrowser` の「1つ上へ」と同じ理由）——ただし同じ形の器を2つ並べない
 * （`DESIGN.md` §15.1）。細い枠の器1つに `ghost` のボタンを2つ入れる。
 *
 * **押せないボタンにも理由を出す。** `Button` は押せないとき `pointer-events-none` に
 * なり、ボタンの `title` は乗せても出ない。外側の `span` にも同じ文を置く。
 *
 * **押した直後は薄くしない。** `aria-busy` だけを立て、二度押しは呼ぶ側で止める
 * （設計§7-4）——薄くすると「使えない」と同じ見た目になる。
 */
export function OpenInButtons({ root, view, open, busy }: Props) {
  const 開いている = view.opened.some((entry) => entry.path === root)
  const エクスプローラの説明 = view.explorer.available
    ? `エクスプローラで開く：${名前(root)}`
    : (view.explorer.reason ?? 'エクスプローラは使えません')
  const VSCodeの説明 = !view.vscode.available
    ? (view.vscode.reason ?? 'VSCode は使えません')
    : 開いている
      ? `VSCode で開いています：${名前(root)}（押すと窓を前に出します）`
      : `VSCode で開く：${名前(root)}`

  return (
    <div
      data-testid="open-in-buttons"
      className="border-border flex shrink-0 items-center gap-0.5 rounded-md border p-0.5"
    >
      <span title={エクスプローラの説明} className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="open-in-explorer"
          aria-label={エクスプローラの説明}
          title={エクスプローラの説明}
          disabled={!view.explorer.available}
          aria-busy={busy || undefined}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (!busy) {
              open('explorer', root)
            }
          }}
        >
          <FolderOutGlyph className="size-[18px]" />
        </Button>
      </span>
      <span title={VSCodeの説明} className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="open-in-vscode"
          data-open={開いている ? 'true' : undefined}
          aria-label={VSCodeの説明}
          title={VSCodeの説明}
          disabled={!view.vscode.available}
          aria-busy={busy || undefined}
          className={
            開いている
              ? 'open-in-opened'
              : 'text-muted-foreground hover:text-foreground'
          }
          onClick={() => {
            if (!busy) {
              open('vscode', root)
            }
          }}
        >
          <EditorOutGlyph className="size-[18px]" />
        </Button>
      </span>
    </div>
  )
}
