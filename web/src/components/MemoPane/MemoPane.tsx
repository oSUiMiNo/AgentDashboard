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

import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'

import { targetKey } from '@/lib/annotationTarget'
import {
  sweepAttachments,
  大きさの字,
  type AttachmentSweep,
} from '@/lib/attachmentSweep'
import { copyToClipboard } from '@/lib/clipboard'
import { markComposerBusy } from '@/lib/composerBusy'
import { useDraft } from '@/lib/drafts'
import { REHYPE_PLUGINS, REMARK_PLUGINS } from '@/lib/markdown'
import { readMemoBody, sameMemoBody } from '@/lib/memoBody'
import { 消えるまでの字 } from '@/lib/memoRetention'
import { 画像を運ぶ as 一枚運ぶ, type 画像の置き場所 } from '@/lib/memoImage'

/**
 * 送れなかったときの断り。**`Composer` と同じ事象なので、同じ文面を使う。**
 *
 * 別の文面を作ると、利用者から見て**同じことが2通りの言い方で出る**。同じものは同じ
 * 言葉で言う。
 */
const 送れていない文言 =
  '送れていません（つながりが切れています）。打った文はそのまま残してあるので、つながり直してから送り直してください'
import type { AnnotationTarget, MemoView } from '@/lib/protocol'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { splitMemos, useMemos } from '@/stores/memos'
import { useWsStore } from '@/stores/ws'
import { MemoEditor } from './MemoEditor'

/**
 * 掃く先。**全体メモは `null`（サーバの記録）、セッションメモはその PC。**
 *
 * **置き場所が2つあるのは帰属が違うから**（メモ設計§10-1 の【決着】）だが、
 * **利用者から見ると「メモの画像が溢れた」は1つの出来事**なので、同意の画面は1つ。
 */
function 掃く先(保存先: 画像の置き場所): string | null {
  return 保存先.where === 'account' ? null : 保存先.host
}

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
  /**
   * 画像の置き場所（設計§10-1）。**渡さなければ画像を貼れない。**
   *
   * # なぜ宛先から引けないのか
   *
   * **添付は PC のディスクへ置く**（`<state_dir>/attachments/<カードID>/`）ので、
   * 宛先のほかに**どの PC か**と**どのカードか**が要る。宛先（`AnnotationTarget`）が
   * 持っているのは `claude_session_id` だけで、**そこから PC もカードも引けない**
   * ——カードは呼ぶ側が知っているので、呼ぶ側が渡す。
   *
   * **全体メモには渡せない**（カードが無く、どの PC かも決まらない）。
   * 設計§10-1 の【未解決】がここに出ている。
   */
  /**
   * **省略できない。** 渡し忘れても画面は動く（押しても貼れないだけ）ので、
   * **言われるまで気づけない**——`assertNever` と同じ発想で、
   * **「誰も捕まえない」を `make ci` が拾う側へ移してある。**
   *
   * 画像を置かない面（読むだけ）は `null` を**明示する**。
   */
  保存先: 画像の置き場所 | null
}

export function MemoPane({ target, readOnly = false, label, 保存先 }: Props) {
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
  /**
   * 送れなかったことを、**面の中に出す**（レビュー対応1）。
   *
   * **`Composer` は黙っていられる**——あちらは `SessionView` が `card-error` で
   * 出してくれるからである。**独立した面には、出してくれる親が居ない。** 全体メモは
   * 設定画面の上にも出るので、なおさら外に頼れない。
   *
   * **宛先で出し分けない。** セッションメモだけ `card-error` に乗せる形も採れるが、
   * それをすると**面の中が宛先を見る**ことになる——この部品が守っている「面の中は
   * 宛先を1度も見ない」（要件9）が崩れる。
   */
  const [送れなかった, set送れなかった] = useState<string | null>(null)
  /*
    **書きかけ**（設計§8-1）。鍵は宛先の綴り（`global` ／ `session:<id>`）で、
    `targetKey()` が決める。**カードの書きかけと同じ表に同居する**が、押し出しの
    対象からは外れている（`drafts.ts`）——全体メモは「どの画面からでも開く1つ」
    なので、カードの枚数と寿命が連動する理由が無い。
  */
  const account = useAuthStore((state) => state.auth.account)
  const [書きかけ, set書きかけ] = useDraft(key, account)

  /*
    **いつ消えるかは設定から引く**（設計§11-3）。**固定文言にしない**——
    90日を30日へ縮めた人に「3か月で消えます」と言うと、3倍の嘘になる。
  */
  const 消えるまで = 消えるまでの字(
    useSettingsStore((state) => state.settings.memo_limits.retention_days),
  )

  /*
    **溢れたときの同意**（要件10・設計§10-2）。

    **既存の `sweep()` を変えていない。** PC が起きたときの掃除は toml の値のまま
    黙って走る——ここが挟むのは**メモから画像を置いたあと**の経路だけである。

    **3か月の掃除には同意を求めない。** 期間で消えるのは既存の振る舞いで、
    要件10 が同意を求めているのは**容量で溢れたとき**だけ。
  */
  const [溢れ, set溢れ] = useState<AttachmentSweep | null>(null)
  const [消している, set消している] = useState(false)

  /** 画像を置いたあとに1度だけ数える。**消さない。** */
  const 溢れを見る = useCallback(async () => {
    if (保存先 === null) {
      return
    }
    try {
      // **掃く先も宛先で分かれる**（メモ設計§10-1 の【決着】）。全体メモは
      // サーバの記録、セッションメモはその PC のディスク
      const 下見 = await sweepAttachments(掃く先(保存先), false)
      // **収まっていれば何も出さない。** 出すと、押す必要のない確認が毎回挟まる
      set溢れ(下見.over_budget ? 下見 : null)
    } catch {
      // **数えられなくても書く道は塞がない。** 掃除は起動時にも走る（既存の振る舞い）
      set溢れ(null)
    }
  }, [保存先])

  /*
    **画像を運ぶ道**（設計§10-1）。保存先を渡されたときだけ組み立てる。

    **中身は `lib/memoImage.ts` に在る**——ふるいと置き場所の決め方を面から出して
    おかないと、**エディタを立てないと確かめられない**（jsdom では画像を貼る操作を
    再現できないので、貼る道が1本も守られないまま緑になる）。
  */
  const 画像を運ぶ = useCallback(
    async (file: File): Promise<string> => {
      if (保存先 === null) {
        throw new Error('画像の置き場所が決まっていません')
      }
      const url = await 一枚運ぶ(保存先, file)
      // **置いたあとに数える。** 置く前に数えると、いま置くぶんが勘定に入らない
      void 溢れを見る()
      return url
    },
    [保存先, 溢れを見る],
  )

  /*
    **運んでいる間は版切替の門に札を上げる**（設計§8-2）。

    札は**オブジェクト**なので、登録ごとに別物であり解除に本人確認が要らない。
    **面が画面外にありうる**ことに注意——PJT 専用画面はセッション全数を仮想化なしに
    描くので、横スクロールの外にあるメモの面が読み直しを止めうる。
  */
  const 札を下ろす = useRef<(() => void) | null>(null)
  const 抱える = useCallback((抱えている: boolean) => {
    if (抱えている) {
      札を下ろす.current ??= markComposerBusy()
      return
    }
    札を下ろす.current?.()
    札を下ろす.current = null
  }, [])
  // 面ごと消えるときに札を残さない。**残すと、以後どの版切替も止まる**
  useEffect(() => () => 抱える(false), [抱える])

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
                <MemoBubble
                  key={memo.id}
                  memo={memo}
                  readOnly={readOnly}
                  画像を運ぶ={保存先 === null ? undefined : 画像を運ぶ}
                  抱える={抱える}
                />
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
          <MemoBubble
                  key={memo.id}
                  memo={memo}
                  readOnly={readOnly}
                  画像を運ぶ={保存先 === null ? undefined : 画像を運ぶ}
                  抱える={抱える}
                />
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
            onUploadImage={保存先 === null ? undefined : 画像を運ぶ}
            on抱える={抱える}
            onSubmit={(body) => {
              if (body.markdown.trim() === '') {
                return
              }
              // **送れたときだけ消す。** 送れていない文が消えるのが、いちばん困る
              // 形である（`Composer.tsx` の同じ約束・`send` の doc が名指しで禁じて
              // いる）。**型が `boolean` を返すので、確かめずに進む道が無い**
              if (!memoAdd(target, body)) {
                set送れなかった(送れていない文言)
                return
              }
              set送れなかった(null)
              // **送ったぶんは書きかけではない。** 忘れさせてから入力欄を作り直す——
              // 順が逆だと、作り直した入力欄へ送ったばかりの字が戻ってくる
              set書きかけ('')
              set送った回数((前) => 前 + 1)
            }}
          />
          {/*
            **送れなかったことを、面の中に出す**（レビュー対応1）。**黙って戻らない**——
            押したのに何も起きないのが、利用者から見ていちばん困る。

            **打った文は消していない**ので、つながり直して押し直せばよい。そのことも
            書いて渡す。
          */}
          {送れなかった !== null && (
            <p
              data-testid="memo-send-failed"
              role="status"
              className="text-destructive mt-1 text-xs"
            >
              {送れなかった}
            </p>
          )}
          {/*
            **溢れたときの同意**（要件10・設計§10-2）。**消す前に必ず押させる。**

            既存の掃除は黙って消すが、**要件10 は容量で溢れたときだけ同意を求めて
            いる**。3か月の掃除はここを通らない。
          */}
          {溢れ !== null && (
            <div
              data-testid="memo-sweep-consent"
              role="alertdialog"
              aria-label="画像の置き場所が上限を超えました"
              className="border-destructive/50 mt-1 rounded border p-2 text-xs"
            >
              <p>
                画像の置き場所が上限（{大きさの字(溢れ.total)} 使用中）を超えました。
                <strong>古いものから {溢れ.removed} 件（{大きさの字(溢れ.freed)}）</strong>
                を消すと空きます。
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  data-testid="memo-sweep-apply"
                  disabled={消している}
                  onClick={async () => {
                    if (保存先 === null) {
                      return
                    }
                    set消している(true)
                    try {
                      await sweepAttachments(掃く先(保存先), true)
                      set溢れ(null)
                    } finally {
                      set消している(false)
                    }
                  }}
                  className="border-destructive text-destructive rounded border px-2 py-0.5"
                >
                  {消している ? '消しています…' : '消す'}
                </button>
                <button
                  type="button"
                  data-testid="memo-sweep-dismiss"
                  onClick={() => set溢れ(null)}
                  className="text-muted-foreground rounded border px-2 py-0.5"
                >
                  そのままにする
                </button>
              </div>
            </div>
          )}
          <p
            data-testid="memo-retention-note"
            className="text-muted-foreground mt-1 text-[0.65rem]"
          >
            Ctrl+Enter で送ります。
            {消えるまで !== '' &&
              `最終更新から${消えるまで}経つと自動で消えます。`}
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
function MemoBubble({
  memo,
  readOnly,
  画像を運ぶ,
  抱える,
}: {
  memo: MemoView
  readOnly: boolean
  /** 直すときにも画像を貼れる（要件2）。**渡されなければ貼れない。** */
  画像を運ぶ?: (file: File) => Promise<string>
  抱える: (抱えている: boolean) => void
}) {
  const { memoEdit, memoCheck, memoRemove } = useWsStore()
  const [直している, set直している] = useState(false)
  const [写せなかった値, set写せなかった値] = useState<string | null>(null)
  const [消す確認, set消す確認] = useState(false)
  /**
   * この吹き出しで送れなかったことを出す（レビュー対応1）。**本体とは別に持つ。**
   *
   * 直す・片付ける・消すは**この吹き出しの中で完結する**ので、断りも同じ場所に出す。
   * 本体の入力欄の下へ出すと、**どの吹き出しの話か分からない。**
   */
  const [送れなかった, set送れなかった] = useState<string | null>(null)

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
          onUploadImage={画像を運ぶ}
          on抱える={抱える}
          onSubmit={(次) => {
            // 中身が同じなら送らない。**時刻を動かすかどうかの判定はサーバがする**
            // （設計§7-3）が、線を1往復無駄にする必要も無い
            if (!sameMemoBody(body, 次)) {
              // **送れなければ閉じない。** 閉じると直した内容が消え、しかも
              // サーバには1行も残らない（`Composer` の「送れたときだけ消す」と
              // 同じ約束）
              if (!memoEdit(memo.id, 次)) {
                set送れなかった(送れていない文言)
                return
              }
            }
            set送れなかった(null)
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
                  if (!memoRemove(memo.id)) {
                    set送れなかった(送れていない文言)
                    return
                  }
                  set送れなかった(null)
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
        {/*
          **編集中の枝にも断りが要る。** ここは早期 return なので、下の枝に置いた
          断りは描画されない——**消す・直すはこの枝の中で押される**ので、断りも
          ここに無いと「押しても何も起きない」に戻る
        */}
        {送れなかった !== null && (
          <p
            data-testid="memo-row-send-failed"
            role="status"
            className="text-destructive mt-1 text-xs"
          >
            {送れなかった}
          </p>
        )}
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
                if (!memoCheck(memo.id, !チェック済み)) {
                  set送れなかった(送れていない文言)
                  return
                }
                set送れなかった(null)
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
      {/*
        **この吹き出しで送れなかったことを出す**（レビュー対応1）。**黙って戻らない。**

        直す・片付ける・消すは、押しても画面が変わらないと**押せていないのか、
        送れていないのかが区別できない**。
      */}
      {送れなかった !== null && (
        <p
          data-testid="memo-row-send-failed"
          role="status"
          className="text-destructive mt-1 text-xs"
        >
          {送れなかった}
        </p>
      )}
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
