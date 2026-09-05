/**
 * 打ったスラッシュコマンドの行と、押すと出る中身のカード
 * （`人が打っていないものを、人の発言として出さない` 設計§11）。
 *
 * # なぜ本文の中の字を押させないのか
 *
 * 構造化ビューは**行のどこを押しても本文が開く**（行そのものが `<button>`）。
 * 打った形を本文へ混ぜたまま押させると、**押し分けが成り立たない**——だから
 * `bodyTextOf` から打った形を外し、ここで別の部品として描く（§11-4）。
 *
 * # なぜ「その場」に出すのか
 *
 * 利用者の指定である。**別の画面へ飛ばすと、どの発言から開いたのかを戻ってから
 * 思い出すことになる**——読んでいる流れの中に置くほうが、読む相手に近い。
 */

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { REHYPE_PLUGINS, REMARK_PLUGINS } from '@/lib/markdown'
import {
  type CommandFile,
  FRONT_MATTER_FOLD_LINES,
  type FrontMatterEntry,
  loadCommandFile,
} from '@/lib/slashCommandFile'

/** どの箱から出たかを、読む人の言葉で言う。 */
const 出どころ: Record<CommandFile['source'], string> = {
  'project-command': 'この PJT のコマンド',
  'user-command': '利用者のコマンド',
  'project-skill': 'この PJT のスキル',
  'user-skill': '利用者のスキル',
}

/**
 * 打った形の1行。**押せることは色と太さで言う**（利用者の指定）。
 *
 * **記号は既存と揃える**——`›`（畳）と `⌄`（開）を**テキストの直後**に置く
 * （行の設計§5-2）。新しい記号を作らない。
 */
export function SlashCommandLine({
  typed,
  open,
  host,
  project,
  onToggle,
}: {
  typed: string
  open: boolean
  host: string
  project: string | undefined
  onToggle: () => void
}) {
  return (
    <div className="mt-1">
      <button
        type="button"
        data-testid="slash-command"
        data-open={open}
        onClick={onToggle}
        className="slash-command inline-flex max-w-full items-baseline gap-1 rounded px-1 text-left"
      >
        <span className="truncate font-medium">{typed}</span>
        <span aria-hidden className="shrink-0 text-xs opacity-70">
          {open ? '⌄' : '›'}
        </span>
      </button>
      {open && <SlashCommandCard host={host} project={project} typed={typed} />}
    </div>
  )
}

/**
 * 中身のカード。
 *
 * **押したときにだけ読みに行く。** 履歴には打ったスラッシュコマンドがいくつも並ぶので、
 * 出しっぱなしにすると開いてもいないカードのぶんまでディスクを読む。
 */
function SlashCommandCard({
  host,
  project,
  typed,
}: {
  host: string
  project: string | undefined
  typed: string
}) {
  const [file, setFile] = useState<CommandFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setFile(null)
    setError(null)
    loadCommandFile(host, typed, project)
      .then((found) => {
        if (alive) {
          setFile(found)
        }
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      alive = false
    }
  }, [host, project, typed])

  return (
    <div data-testid="slash-command-card" className="slash-card mt-1 rounded px-3 py-2">
      {error !== null && (
        // **黙って空を出さない**（§11-2）。「押しても何も出ない」と「置き場所に無い」は別物
        <p data-testid="slash-command-error" className="text-muted-foreground text-xs whitespace-pre-wrap">
          {error}
        </p>
      )}
      {error === null && file === null && (
        <p className="text-muted-foreground text-xs">読んでいます…</p>
      )}
      {file !== null && (
        <>
          <p className="text-muted-foreground mb-2 text-xs">
            <span className="text-amber-300/80">{出どころ[file.source]}</span>
            <span className="mx-1">·</span>
            <span className="break-all">{file.path}</span>
          </p>
          {file.front.length > 0 && (
            <dl data-testid="slash-command-front" className="mb-2 grid gap-1">
              {file.front.map((entry) => (
                <FrontMatterRow key={entry.key} entry={entry} />
              ))}
            </dl>
          )}
          <div className="prose-dashboard text-xs leading-relaxed">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {file.body}
            </ReactMarkdown>
          </div>
          {file.truncated && (
            // 上限の内側で切ったことは**隠さない**（`FileView` と同じ扱い）
            <p className="text-muted-foreground mt-2 text-xs">…（上限まで読みました）</p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * フロントマターの1項目。
 *
 * **値が [`FRONT_MATTER_FOLD_LINES`] 行以上なら畳む**（利用者の指定）。畳んだ姿は
 * **1行目＋`…`** で、押すと開く。3行までを畳まないのは、畳んでも縮まないためである。
 */
function FrontMatterRow({ entry }: { entry: FrontMatterEntry }) {
  const foldable = entry.lines >= FRONT_MATTER_FOLD_LINES
  const [open, setOpen] = useState(false)
  const folded = foldable && !open
  const head = entry.value.split('\n', 1)[0] ?? ''

  return (
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-2" data-testid="front-matter-row">
      <dt className="text-amber-300/80 shrink-0 font-medium">{entry.key}</dt>
      <dd className="min-w-0">
        {foldable ? (
          <button
            type="button"
            data-testid="front-matter-toggle"
            data-open={open}
            onClick={() => setOpen((now) => !now)}
            className="w-full text-left"
          >
            <span className="whitespace-pre-wrap break-words">{folded ? head : entry.value}</span>
            <span className="text-muted-foreground ml-1">{folded ? '…' : ''}</span>
            <span aria-hidden className="text-muted-foreground ml-1 text-xs">
              {open ? '⌄' : '›'}
            </span>
          </button>
        ) : (
          <span className="whitespace-pre-wrap break-words">{entry.value}</span>
        )}
      </dd>
    </div>
  )
}
