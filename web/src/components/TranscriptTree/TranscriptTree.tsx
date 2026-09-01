/**
 * 構造化ビュー本体（設計§10）。
 *
 * # 仮想化する理由
 *
 * 履歴は数万ノードまで育つ。全部を DOM に置くとスクロールが破綻するので、
 * 見えている範囲だけを描く。行の高さは開け閉めで変わるため、実測（`measureElement`）に
 * 任せる。
 *
 * # 末尾追従
 *
 * 作業中のセッションでは履歴が増え続ける。末尾を見ているときだけ自動で追従し、
 * 過去を読んでいる最中は引き戻さない（`anchorTo: 'end'` + `followOnAppend`）。
 * 引き戻すと「読んでいる途中で勝手に飛ぶ」という、いちばん困る挙動になる。
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { CardId } from '@/lib/protocol'
import type { FlatRow, NodeRow } from '@/stores/transcript'
import { toggleActivity, toggleBody, toggleNode, toggleRewound, useTranscript } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'
import { TranscriptRow } from './TranscriptRow'

/**
 * 行の見込み高さ。実測（`measureElement`）が入るまでの当たり。
 *
 * **本文を常に出すようになってから、「折り畳んだ1行」は当たりではなくなった。**
 * 実測（幅780px・既存フィクスチャの混在12行）は次のとおり。
 *
 * | 行 | 高さ |
 * |---|---|
 * | 思考・ツールコール（畳んだまま） | 29px |
 * | 本文が1行のアシスタント | 53px |
 * | 本文が数行のアシスタント | 118px |
 * | **混在の平均** | **42px** |
 *
 * 42 ではなく少し上を採るのは、**実物の本文はフィクスチャより長い**ため
 * （実測：フィクスチャは最長175文字、実物は中央値107文字・p99 1,461文字）。
 * そして**低いほうへ外すと「遡っている最中に画面が跳ねる」**——まだ測っていない行が
 * 多いほど総高が伸び続けるので、外すなら高い側へ外す。
 */
const ESTIMATED_ROW = 48

/** 「末尾を見ている」とみなす余白（px）。 */
const END_THRESHOLD = 80

export function TranscriptTree({ cardId }: { cardId: CardId }) {
  const rows = useTranscript(cardId)
  const subscribeTranscript = useWsStore((state) => state.subscribeTranscript)
  const parserState = useWsStore((state) => state.parserState)
  const parserDetail = useWsStore((state) => state.parserDetail)
  const scrollRef = useRef<HTMLDivElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  // 開いている間だけ購読する。閉じたカードの履歴を受け取り続けない
  useEffect(() => subscribeTranscript(cardId), [cardId, subscribeTranscript])

  /*
    行へ渡す手は**同一性を保つ**。`TranscriptRow` は `memo` で包んであるが、ここで
    毎回新しい関数を作ると props が変わったことになり、**包んだ意味が消える**。

    依存が `cardId` だけで済むのは、`toggleNode` / `toggleBody` / `toggleRewound` /
    `toggleActivity` がストアの**モジュール関数**（`stores/transcript.ts`）で、描画の
    たびに作り直されないため。
  */
  const onToggle = useCallback(
    (target: FlatRow) => {
      switch (target.kind) {
        case 'rewound':
          return toggleRewound(cardId)
        // まとめ行の鍵は合成IDなので、ノードとは別の口へ渡す（設計§2-5）
        case 'activity':
          return toggleActivity(cardId, target.id)
        default:
          return toggleNode(cardId, target.id)
      }
    },
    [cardId],
  )
  const onToggleBody = useCallback(
    (target: NodeRow) => toggleBody(cardId, target.id),
    [cardId],
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW,
    // 並び替えや開け閉めで位置がずれるため、添字ではなくノードIDで同一性を見る。
    // 添字にすると、上に行が増えるたびに実測した高さが誤って捨てられる
    getItemKey: (index) => rows[index]?.id ?? index,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: END_THRESHOLD,
    overscan: 8,
  })

  /*
    開いたら、いちばん下（最新）から見せる（設計§3）。

    **末尾追従（`followOnAppend`）だけでは届かない。** あちらが発火するのは
    「件数が増えた」瞬間だけで、しかも**その時点で末尾の近くに居た**ときに限る。
    実測したところ、届かない道が2つある。

    | 道 | 何が起きているか |
    |---|---|
    | **隠れている間に届く** | 打ち込むのは端末なので、履歴が届くのは**構造化ビューが `hidden` の間**である。高さが 0 の箱に寄せても寄る先が無く、**表示へ切り替えても寄せ直されない** |
    | **ストアが生き残る** | 履歴は module スコープの `Map`（`stores/transcript.ts`）で、閉じても消えない。**戻ってきたときは最初から N 件**なので、「増えた」ことすら観測されない |

    どちらも**追従の土俵に乗らない**ので、初期位置はここから明示的に1回だけ寄せる。

    # 条件が3つある理由

    | 条件 | なぜ要るか |
    |---|---|
    | まだ寄せていない | **2回目以降を打たない。** `/rewind` と WS の再接続は購読開始と**同じ合図**で届くので（`transcript_reset`）、回数を許すと**読んでいる最中に引き戻す**（設計§6） |
    | 行がある | 0件では寄せる先が無い。**そもそもスクロールの箱が描かれない**（下の分岐） |
    | 箱が見えている | 上の表の1つ目。**隠れている間に寄せても効かないのに、印だけが立つ** |

    **依存配列を持たない。** 行が増えた描画だけでなく、**タブが `hidden` から表示へ
    変わった描画**も拾う必要がある（下の覗き口と同じ流儀）。切り替えで箱に高さが付くと
    仮想化自身が大きさの変化を見て描き直すので、その描画でここが通る。

    **`useLayoutEffect` なのは、描く前に寄せてちらつきを消すため。** 仮想化自身の
    位置合わせも同じ層で動くので、足並みが揃う。

    # 1回では足りない（実測で確かめた）

    `scrollToEnd()` が狙うのは**その時点の DOM の末尾**である。ところが**開いた直後の
    行はまだ実測されておらず**、見込み（[`ESTIMATED_ROW`]）で積んだ総高は本物より
    ずっと低い。実測（`markdown-bodies` の6行）では総高が画面より小さく、
    **「寄せる先が無い」まま印だけが立ち**、そのあと実測で背が伸びて上に取り残された。

    そこで**背が伸びている間は寄せ続け、伸びなくなって末尾に着いたところで手を引く**。
    印を立てる条件を「1回呼んだら」ではなく「**落ち着いて末尾に居る**」にしてある。

    **測るのは DOM の実測だけにする。** ここで `getTotalSize()` や `isAtEnd()` を呼ぶと
    **仮想化の内部再計算が走って描き直しを呼び、そのたびにこの効果がまた動く**——
    実際に輪になって、テストが返ってこなくなった。`scrollHeight` と `scrollTop` は
    ただの読み取りなので、この輪を作らない。

    **暴走しない。** 背が伸びなくなれば必ず止まり、そこから先は末尾追従に任せる。
    落ち着くまでの数フレームは利用者が触る前なので、**上を読んでいる人を引き戻さない**
    という約束はここでは破れない（破れないことは E2E が見張っている）。
  */
  const alignedToEnd = useRef(false)
  const lastHeight = useRef(-1)
  useLayoutEffect(() => {
    if (alignedToEnd.current || rows.length === 0) {
      return
    }
    const container = scrollRef.current
    if (!container || container.clientHeight === 0) {
      return
    }
    const height = container.scrollHeight
    const atEnd = container.scrollTop + container.clientHeight >= height - END_THRESHOLD
    if (height === lastHeight.current && atEnd) {
      alignedToEnd.current = true
      return
    }
    lastHeight.current = height
    virtualizer.scrollToEnd({ behavior: 'auto' })
  })

  // E2E から中身を確かめるための覗き口。仮想化していると DOM に全行が無いので、
  // 「何行あるか」「末尾を見ているか」は属性で出しておく（TerminalPane と同じ手）
  useEffect(() => {
    const status = statusRef.current
    if (!status) {
      return
    }
    status.setAttribute('data-row-count', String(rows.length))
    status.setAttribute('data-at-end', String(virtualizer.isAtEnd?.(END_THRESHOLD) ?? false))
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={statusRef}
        data-testid="transcript-status"
        data-row-count="0"
        className="sr-only"
      />

      {parserState === 'degraded' && (
        <div
          data-testid="parser-degraded"
          className="mb-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200"
        >
          構造化ビューは縮退しています（ターミナルと状態表示は通常どおり動きます）
          {parserDetail ? `：${parserDetail}` : ''}
        </div>
      )}

      {/* **画面の主題を示す見出し**（`DESIGN.md` §8 の床・§13.4）。構造化ビューは
          UI 自身の見出しを1つも持っておらず、いちばん大きい文字が 14px/500 だった
          ——階層が実質2段しかない状態で、§8 の1行がそのまま未達だった。

          **質感もここが引き受ける**（§12.3 の「見出し帯・セクション見出し＝印刷面・
          プレート・中」）。§12.3 は「物質は**画面に数個しか無い面**に置く」と言う——
          この帯は画面に1つしかないので、いちばん条件に合う面である。

          **薄く保つこと。** この道具はスマホからも触るので、主題を名乗るためだけに
          行を厚くすると §4.5 の「情報より装飾が前に出る」へ寄る */}
      <div data-testid="transcript-heading" className="transcript-heading">
        <span className="transcript-heading-title">履歴</span>
        {rows.length > 0 && (
          <span className="text-muted-foreground text-xs">{rows.length}件</span>
        )}
      </div>

      <div
        ref={scrollRef}
        data-testid="transcript-tree"
        // `transcript-panel` は縁の紙の厚み（`DESIGN.md` §12.3「パネルの縁＝弱」）。
        // **物質を持たせるのは画面に数個しか無い面だけ**で、§12.3 は「一覧の行には
        // 持たせない」と名指ししている——この器は画面に1つしか無いので条件に合う
        className="transcript-panel min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-background"
      >
        {rows.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">
            まだ履歴がありません。セッションが動き出すとここに表示されます。
          </p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (!row) {
                return null
              }
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <TranscriptRow
                    cardId={cardId}
                    row={row}
                    onToggle={onToggle}
                    onToggleBody={onToggleBody}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
