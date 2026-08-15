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
import { useEffect, useRef } from 'react'
import type { CardId } from '@/lib/protocol'
import { toggleBody, toggleNode, toggleRewound, useTranscript } from '@/stores/transcript'
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

      <div
        ref={scrollRef}
        data-testid="transcript-tree"
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-background"
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
                    onToggle={(target) =>
                      target.kind === 'rewound'
                        ? toggleRewound(cardId)
                        : toggleNode(cardId, target.id)
                    }
                    onToggleBody={(target) => toggleBody(cardId, target.id)}
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
