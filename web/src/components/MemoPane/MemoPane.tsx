/**
 * メモの面（メモ設計§6-1・§6-8・§6-9・§7）。
 *
 * # 部品は1つ、宛先は props
 *
 * **全体メモとセッションメモは、この同じ部品を宛先違いで使う**（要件9・利用者の指定）。
 * 二重に実装すると、仕様を1つ変えるたびに2か所を直すことになり、やがて片方だけが直る。
 *
 * **面の中は宛先を1度も見ない。** 宛先を運ぶのは口5つのうち2つ（一覧を引く・足す）
 * だけで、直す・片付ける・消すは `id` が1件を指す。**面の中で `target` を参照したく
 * なったら、設計を疑うこと。**
 *
 * # 並べ直さない
 *
 * **並びはサーバが決めている**（設計§7-1）。ここでするのは**2段に割ること**だけで、
 * 段の中の順は受け取ったまま。
 *
 * # 溜まったら畳む（設計§6-8）
 *
 * 全体メモはセッションと違って終わらないので、いちばん長くなる。下段は直近だけ出し、
 * **上段（チェック済み）は既定で畳む**——片付けたものが画面の上半分を占めると、
 * 「片付ける」が達成感にならない。
 */

import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'

import { targetKey } from '@/lib/annotationTarget'
import { copyToClipboard } from '@/lib/clipboard'
import { useDraft } from '@/lib/drafts'
import { REHYPE_PLUGINS, REMARK_PLUGINS } from '@/lib/markdown'
import { readMemoBody, sameMemoBody } from '@/lib/memoBody'
import type { AnnotationTarget, MemoView } from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'
import { splitMemos, useMemos } from '@/stores/memos'
import { useWsStore } from '@/stores/ws'
import { MemoEditor } from './MemoEditor'

/** 下段に出す件数。超えたぶんは「ほか N 件」で畳む（§47.4 と同じ形）。 */
export const 下段に出す数 = 8

interface Props {
  target: AnnotationTarget
  /**
   * 抜け殻・終了したカード（設計§6-9）。**読めるが書けない。**
   *
   * 入力欄を出さず、チェックの付け外しもできない。**コピーはできる**——読むためだけに
   * 開く面なので、持ち出す道は残す。
   */
  readOnly?: boolean
  /** 読み上げ用の名。**全体とセッションで文言を分ける**（設計§6-4）。 */
  label: string
}

export function MemoPane({ target, readOnly = false, label }: Props) {
  const memos = useMemos(target)
  const { memoList, memoAdd } = useWsStore()

  // 開いたら引き直す。**宛先が変わったら引き直す**のも同じ効果で足りる
  const key = targetKey(target)
  useEffect(() => {
    memoList(target)
    // `target` は毎回新しい物になりうるので、**鍵で見る**
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const { checked, unchecked } = splitMemos(memos)
  const [畳んだ上段, set畳んだ上段] = useState(true)
  const [下段を全部, set下段を全部] = useState(false)
  /**
   * 送った回数。**入力欄を作り直して空にするためだけに持つ**（§6-5）。
   *
   * 送ったのに字が残ると、**送れたのかどうかが分からない**。もう一度押して同じものが
   * 2つ積まれるうえ、次に打った字が**前の続きとして同じ吹き出しへ入る**——E2E で
   * 実際にそうなった（2件送ったつもりが、2件目が1件目に継ぎ足された1件になる）。
   *
   * **エディタは中身を外から差し替えられない**ので、`key` を変えて作り直す。
   */
  const [送った回数, set送った回数] = useState(0)
  /*
    **書きかけ**（設計§8-1）。鍵は宛先の綴り（`global` ／ `session:<id>`）で、
    `targetKey()` が決める。**カードの書きかけと同じ表に同居する**が、押し出しの
    対象からは外れている（`drafts.ts`）——全体メモは「どの画面からでも開く1つ」
    なので、カードの枚数と寿命が連動する理由が無い。
  */
  const account = useAuthStore((state) => state.auth.account)
  const [書きかけ, set書きかけ] = useDraft(key, account)

  const 隠れている数 = Math.max(0, unchecked.length - 下段に出す数)
  const 出す下段 = 下段を全部 ? unchecked : unchecked.slice(隠れている数)

  return (
    <div data-testid="memo-pane" className="flex min-h-0 flex-col gap-2" aria-label={label}>
      {/* ------- 上段：片付けたもの。既定で畳む ------- */}
      {checked.length > 0 && (
        <div className="shrink-0">
          <button
            type="button"
            data-testid="memo-checked-toggle"
            aria-expanded={!畳んだ上段}
            onClick={() => set畳んだ上段((前) => !前)}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            片付けたもの {checked.length} 件
          </button>
          {!畳んだ上段 && (
            <div data-testid="memo-checked" className="mt-1 flex flex-col gap-1">
              {checked.map((memo) => (
                <MemoBubble key={memo.id} memo={memo} readOnly={readOnly} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ------- 下段：いま関係のあるもの ------- */}
      <div data-testid="memo-list" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {隠れている数 > 0 && !下段を全部 && (
          <button
            type="button"
            data-testid="memo-more"
            onClick={() => set下段を全部(true)}
            className="text-muted-foreground hover:text-foreground self-start text-xs"
          >
            ほか {隠れている数} 件
          </button>
        )}
        {出す下段.map((memo) => (
          <MemoBubble key={memo.id} memo={memo} readOnly={readOnly} />
        ))}
        {memos.length === 0 && (
          <p className="text-muted-foreground text-xs">まだ何も書かれていません。</p>
        )}
      </div>

      {/* ------- 書くところ。抜け殻には出さない（設計§6-9） ------- */}
      {readOnly ? (
        <p data-testid="memo-readonly" className="text-muted-foreground shrink-0 text-xs">
          このセッションは終わっているので、読むだけです。
        </p>
      ) : (
        <div className="shrink-0">
          <MemoEditor
            key={`compose:${key}:${送った回数}`}
            data-testid="memo-compose"
            initial={{ blocks: [], markdown: 書きかけ }}
            label={`${label}に書く`}
            onChange={set書きかけ}
            onSubmit={(body) => {
              if (body.markdown.trim() === '') {
                return
              }
              memoAdd(target, body)
              // **送ったぶんは書きかけではない。** 忘れさせてから入力欄を作り直す——
              // 順が逆だと、作り直した入力欄へ送ったばかりの字が戻ってくる
              set書きかけ('')
              set送った回数((前) => 前 + 1)
            }}
          />
          <p className="text-muted-foreground mt-1 text-[0.65rem]">
            Ctrl+Enter で送ります。最終更新から3か月経つと自動で消えます。
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * 吹き出し1つ。
 *
 * **3つのボタンは `onMouseDown` ＋ `preventDefault()` で押す**（設計§6-6）。
 * `onClick` だと、その前に入力欄から焦点が外れて面が閉じ、**押したはずのボタンが
 * 消える**——`Composer/SlashMenu.tsx` に理由付きの先例がある。
 *
 * **独立した面（全体メモ）でも同じ押し方にする。** 焦点が外れて閉じる作りでなくても、
 * **押し方が違うと片方だけ直す変更ができてしまう**（要件9）。
 */
function MemoBubble({ memo, readOnly }: { memo: MemoView; readOnly: boolean }) {
  const { memoEdit, memoCheck, memoRemove } = useWsStore()
  const [直している, set直している] = useState(false)
  const [写せなかった値, set写せなかった値] = useState<string | null>(null)
  const [消す確認, set消す確認] = useState(false)

  const body = readMemoBody(memo.body)
  const チェック済み = memo.checked_at !== undefined

  const 写す = useCallback(async (value: string) => {
    // **新しく書かない**（設計§6-7）。`copyToClipboard` を import するだけ
    const 写せた = await copyToClipboard(value)
    // **見せ方は呼ぶ側が作る。** 偽が返ったら値を選ばせる（手本は `folder-copy-fallback`）
    set写せなかった値(写せた ? null : value)
  }, [])

  if (直している) {
    return (
      <div data-testid="memo-editing" className="rounded border p-1">
        <MemoEditor
          initial={body}
          label="メモを直す"
          onSubmit={(次) => {
            // 中身が同じなら送らない。**時刻を動かすかどうかの判定はサーバがする**
            // （設計§7-3）が、線を1往復無駄にする必要も無い
            if (!sameMemoBody(body, 次)) {
              memoEdit(memo.id, 次)
            }
            set直している(false)
          }}
        />
        <div className="mt-1 flex items-center gap-2">
          {/*
            **消す道は編集の中に置く**（設計§7-8）。吹き出しの4つ目のボタンにしない——
            要件3 が「3つ出る」と数を決めている。**確認を1回挟む**（戻せないため）
          */}
          {消す確認 ? (
            <>
              <span className="text-muted-foreground text-xs">消すと戻せません。</span>
              <button
                type="button"
                data-testid="memo-remove-confirm"
                onMouseDown={(event) => {
                  event.preventDefault()
                  memoRemove(memo.id)
                }}
                className="text-destructive text-xs"
              >
                消す
              </button>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault()
                  set消す確認(false)
                }}
                className="text-muted-foreground text-xs"
              >
                やめる
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="memo-remove"
              onMouseDown={(event) => {
                event.preventDefault()
                set消す確認(true)
              }}
              className="text-muted-foreground hover:text-destructive text-xs"
            >
              消す
            </button>
          )}
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault()
              set直している(false)
            }}
            className="text-muted-foreground ml-auto text-xs"
          >
            やめる
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="memo-bubble"
      data-checked={チェック済み ? 'true' : 'false'}
      className="group bg-muted/40 relative rounded px-2 py-1"
    >
      <div data-testid="memo-body" className="prose-sm min-w-0 text-sm break-words">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
          {body.markdown}
        </ReactMarkdown>
      </div>
      <time className="text-muted-foreground text-[0.65rem]">
        {new Date(memo.noted_at).toLocaleString()}
      </time>

      {/*
        **3つ**（コピー・鉛筆・チェック）。要件3 が数を決めているので増やさない。
        **マウスオーバーで出すが、指で触る画面には `:hover` が無い**ので、
        `focus-within` でも出す（カードの `tile-ops` と同じ作法）
      */}
      <div
        data-testid="memo-ops"
        className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <button
          type="button"
          data-testid="memo-copy"
          title="この吹き出しをコピー"
          aria-label="この吹き出しをコピー"
          onMouseDown={(event) => {
            event.preventDefault()
            void 写す(body.markdown)
          }}
          className="text-muted-foreground hover:text-foreground text-xs"
        >
          コピー
        </button>
        {!readOnly && (
          <>
            <button
              type="button"
              data-testid="memo-edit"
              title="この吹き出しを直す"
              aria-label="この吹き出しを直す"
              onMouseDown={(event) => {
                event.preventDefault()
                set直している(true)
              }}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              直す
            </button>
            <button
              type="button"
              data-testid="memo-check"
              title={チェック済み ? '戻す' : '片付ける'}
              aria-label={チェック済み ? '戻す' : '片付ける'}
              onMouseDown={(event) => {
                event.preventDefault()
                memoCheck(memo.id, !チェック済み)
              }}
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              {チェック済み ? '戻す' : '片付ける'}
            </button>
          </>
        )}
      </div>

      {/*
        **写せなかったときの逃げ道**（設計§6-7）。安全なオリジンでない環境
        （スマホから LAN のアドレスで開いた場合）でも**値を取れる形**にする。
        **消すのは人の手だけ**——時間で消すと、選んで取る前に逃げ道が消える
      */}
      {写せなかった値 !== null && (
        <p className="mt-1 flex items-start gap-1 text-xs">
          <span className="min-w-0 flex-1">
            コピーできません。この値を選んで取ってください：{' '}
            <code
              data-testid="memo-copy-fallback"
              className="bg-muted/60 rounded px-1 py-0.5 font-mono break-all select-all"
            >
              {写せなかった値}
            </code>
          </span>
          <button
            type="button"
            aria-label="閉じる"
            onMouseDown={(event) => {
              event.preventDefault()
              set写せなかった値(null)
            }}
            className="text-muted-foreground shrink-0"
          >
            ✕
          </button>
        </p>
      )}
    </div>
  )
}
