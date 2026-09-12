/**
 * ブロックエディタ（メモ設計§9-2・方針の分かれ道2）。
 *
 * **ここが BlockNote を載せる唯一の場所である。** 読むだけの吹き出しは
 * `react-markdown` で描く（`lib/memoBody.ts`）——溜まったメモの数だけ ProseMirror を
 * 立てると重いので、**立つのは「いま書いているもの」と「いま直しているもの」だけ**に
 * 抑えてある。
 *
 * # キーの割り当て
 *
 * | キー | 何が起きるか |
 * |---|---|
 * | Enter | **ブロックを割る**（エディタの既定） |
 * | Shift+Enter | 改行 |
 * | **Ctrl+Enter** | **確定**（[`isComposerSubmit`]） |
 *
 * **この2つは衝突しない**（設計§9-2）——奪われるのは素の Enter だけで、確定のキーは
 * 入力欄・ターミナルと同じ Ctrl+Enter のままである。
 *
 * **`isComposerSubmit` の型には手を入れていない**（設計§9-1）。判断材料を増やすと
 * 「Shift の扱いを間違える余地そのものが無い」という性質が壊れるので、**そのまま
 * import して使う**。
 */

import { BlockNoteView } from '@blocknote/shadcn'
import { useCreateBlockNote } from '@blocknote/react'
import { useCallback, useEffect, useRef } from 'react'

import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

import { isComposerSubmit } from '@/lib/keys'
import type { MemoBody } from '@/lib/memoBody'

interface Props {
  /** 初期の中身。**空なら新規、入っていれば編集。** */
  initial: MemoBody
  /** Ctrl+Enter で確定したとき。**中身を作って渡す。** */
  onSubmit: (body: MemoBody) => void
  /** 打つたび。書きかけを覚えるために使う（渡さなくてよい）。 */
  onChange?: (markdown: string) => void
  /** 読み上げ用。全体メモとセッションメモで**文言を分ける**（設計§6-4）。 */
  label: string
  'data-testid'?: string
}

export function MemoEditor({
  initial,
  onSubmit,
  onChange,
  label,
  'data-testid': testId,
}: Props) {
  const editor = useCreateBlockNote({
    initialContent: initial.blocks.length > 0 ? (initial.blocks as never) : undefined,
  })

  /** 最新の確定先を持つ。**エディタは作り直さない**ので、参照で渡す */
  const submitRef = useRef(onSubmit)
  submitRef.current = onSubmit
  const changeRef = useRef(onChange)
  changeRef.current = onChange

  /** いまの中身を [`MemoBody`] にする。**確定と書きかけで同じ道を通す。** */
  const 読み取る = useCallback((): MemoBody => {
    return {
      blocks: editor.document as unknown[],
      markdown: editor.blocksToMarkdownLossy(editor.document),
    }
  }, [editor])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // **入力欄と同じ述語を使う。** ここで独自に判定すると、同じ Ctrl+Enter が
      // 画面によって違う意味になる。**組み立て方も `Composer` と同じ**——
      // `isComposing` は React の合成イベントではなく生のイベントが持っている
      if (
        !isComposerSubmit({
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          isComposing: event.nativeEvent.isComposing,
        })
      ) {
        return
      }
      // エディタが素の Enter を持っていくのは既定のまま。**確定だけを横取りする**
      event.preventDefault()
      event.stopPropagation()
      submitRef.current(読み取る())
    },
    [読み取る],
  )

  // 打つたびに書きかけを覚える。**確定していない字を失わない**（設計§8-1）
  useEffect(() => {
    if (changeRef.current === undefined) {
      return
    }
    return editor.onChange(() => {
      changeRef.current?.(editor.blocksToMarkdownLossy(editor.document))
    })
  }, [editor])

  return (
    <div
      data-testid={testId}
      // **打ったキーがここから外へ漏れないこと**が、この機能の安全性そのものである
      // （要件「気をつけること1」）。ターミナルへ飛ぶと勝手に作業が始まる
      onKeyDown={onKeyDown}
      role="group"
      aria-label={label}
    >
      <BlockNoteView editor={editor} />
    </div>
  )
}
