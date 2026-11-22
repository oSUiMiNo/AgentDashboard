import { EditorOutGlyph } from '@/components/ui/glyphs'

/**
 * VSCode で開いている行の、行末の印（サイドバーにエクスプローラで開くボタンが欲しい
 * 設計§7-4）。
 *
 * **行の面は使わない。** いま選んでいるファイルの行がシアンの面（`folder-entry-current`）
 * を持つので、面を重ねると選んでいる行と開いている行が見分けられない。色はシアン
 * （進行中＝Primary Accent）。
 */
export function OpenedMark() {
  return (
    <span
      data-testid="folder-opened-mark"
      role="img"
      aria-label="VSCode で開いています"
      title="VSCode で開いています"
      className="grid shrink-0 place-items-center text-[color:var(--accent-solid)]"
    >
      <EditorOutGlyph className="size-3.5" />
    </span>
  )
}
