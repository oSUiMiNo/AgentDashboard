/**
 * 機械そのものの区画（縮小設計§10）。
 *
 * # なぜ設定画面で、上部の帯ではないのか
 *
 * 縮小は**機械ぜんぶ**に効く操作で、`DESIGN.md` §39.2 が持つ2段（画面ぜんぶ／
 * セッション1本）のどちらでもない。上部の帯は §39.2 自身が「取り合いになっている
 * 場所」と書いており、**押す頻度が最も低く、最も壊れると痛い操作**を最も混んでいる
 * 場所へ置くのは筋が悪い。
 *
 * # 3つ揃って初めて「押しどき」が読める
 *
 * 空洞の数字だけでは、いま押すべきかが決まらない。**最後に縮めた時刻**（前回から
 * どれだけ経ったか）と**打てない理由**（押しても断られるか）が並んで初めて判断
 * できる。**数字1つとボタン1つで終わらせない**（`DESIGN.md` §8 の床）。
 *
 * # WSL でなければ、区画ごと出さない
 *
 * 空洞という概念が無い機械で「— GB」と出すと、**壊れているのと見分けが付かない。**
 *
 * # 撃った後に「失敗」と断定しない
 *
 * 縮小は自分を殺す操作なので、撃った直後にサーバが死ぬ。**線が切れたことは
 * 「撃てなかった」ではない**——むしろ撃てた証拠でありうる。区別できないものを
 * 失敗として出すと嘘になるので、**分からないときは分からないと出す**（§10-2）。
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LOCAL_HOST } from '@/lib/routes'
import { formatDateTime } from '@/lib/time'
import {
  fetchCompactView,
  gib,
  runCompact,
  SIGNED_OUT,
  type CompactView,
} from '@/lib/compact'

/** 撃った後に画面へ出す一言。 */
type 結末 = { 調子: 'ok' | 'warn'; 文: string } | null

interface ConfirmProps {
  view: CompactView
  onCancel: () => void
  onRun: () => void
}

/**
 * 縮める前の確認。
 *
 * 器は `ReviveBudgetDialog` を写した（このアプリで唯一のダイアログの形）。
 * **新しい部品を作らない。**
 *
 * **この操作だけは装飾より文言が先である。** 押した人が失うものを、押す前に
 * 数で見せる。
 */
function CompactConfirm({ view, onCancel, onRun }: ConfirmProps) {
  return (
    <>
      {/* 暗い幕。**押しても閉じない**——取り違えて落とすほうが痛い */}
      <div aria-hidden className="fixed inset-0 z-40 bg-black/60" />
      <div
        data-testid="machine-compact-confirm"
        role="dialog"
        aria-label="縮めると、走っている claude が全部落ちます"
        className="bg-background fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto p-4 sm:inset-x-auto sm:inset-y-16 sm:left-1/2 sm:w-[min(34rem,90vw)] sm:-translate-x-1/2 sm:rounded-xl sm:border sm:shadow-xl"
      >
        <header className="flex shrink-0 items-center gap-2">
          <h2 className="text-sm font-semibold">
            縮めると、走っている claude が全部落ちます
          </h2>
        </header>

        <p className="text-xs">
          いま <strong>{view.alive_cards} 枚</strong>が落ちます。
          WSL ごと止めてから仮想ディスクを縮めるので、
          <strong>
            {' '}
            このダッシュボードから起こしたセッションも、外で開いている端末も戻りません。
          </strong>
        </p>

        <p className="text-xs">
          縮むと約 <strong>{gib(view.slack_bytes ?? 0)}</strong> が Windows へ返ります。
          <strong className="text-amber-300">
            {' '}
            10〜15分まったく反応が無い時間があります
          </strong>
          が、止めないでください。
        </p>

        <footer className="flex shrink-0 items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="machine-compact-cancel"
            onClick={onCancel}
          >
            やめる
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            data-testid="machine-compact-go"
            onClick={onRun}
          >
            縮める
          </Button>
        </footer>
      </div>
    </>
  )
}

export function MachineCard() {
  const [view, setView] = useState<CompactView | null>(null)
  const [確認中, set確認中] = useState(false)
  const [結末, set結末] = useState<結末>(null)

  useEffect(() => {
    // **開いたときに1回だけ聞く。** 空洞は秒単位で変わるものではないので、
    // 常時ポーリングする理由が無い
    void fetchCompactView(LOCAL_HOST).then((answer) => {
      setView(answer === SIGNED_OUT || answer === null ? null : answer)
    })
  }, [])

  // **読めなければ出さない。** WSL でない機械と、聞けなかった場合の両方がここ
  if (view === null || view.slack_bytes === null) {
    return null
  }

  const 押せない = view.manual_blocker

  return (
    <div
      data-testid="machine"
      className="border-border flex flex-col gap-2 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">機械</h3>
      <p className="text-muted-foreground text-xs">
        WSL の仮想ディスクは、中で消しても Windows へは返りません。返すには縮める操作が要り、
        <strong> その操作は走っている claude を全部落とします。</strong>
      </p>

      {/* 1つ目：いま押せば何が返るか */}
      <p data-testid="machine-slack" className="text-xs">
        いま縮めれば約 <strong>{gib(view.slack_bytes)}</strong> 戻る見込みです
        {view.vhdx_bytes !== null && `（仮想ディスクは ${gib(view.vhdx_bytes)}）`}
      </p>

      {/* 2つ目：前回からどれだけ経ったか */}
      <p data-testid="machine-last" className="text-muted-foreground text-xs">
        {view.last_compact === null
          ? 'まだ一度も縮めていません'
          : `最後に縮めたのは ${formatDateTime(view.last_compact) ?? '不明'}`}
      </p>

      {/* 3つ目：押しても断られるか */}
      <p data-testid="machine-blocker" className="text-muted-foreground text-xs">
        {押せない ?? 'いま押せます'}
      </p>

      <div>
        <Button
          type="button"
          size="sm"
          data-testid="machine-compact"
          disabled={押せない !== null}
          onClick={() => set確認中(true)}
        >
          いま縮める
        </Button>
      </div>

      {結末 !== null && (
        <p
          data-testid="machine-outcome"
          className={
            結末.調子 === 'ok'
              ? 'text-xs'
              : 'text-xs text-amber-300'
          }
        >
          {結末.文}
        </p>
      )}

      {確認中 && (
        <CompactConfirm
          view={view}
          onCancel={() => set確認中(false)}
          onRun={() => {
            set確認中(false)
            void runCompact(LOCAL_HOST, false).then((outcome) => {
              if (outcome.kind === 'fired') {
                set結末({
                  調子: 'ok',
                  文: '縮小を頼みました。まもなく WSL ごと落ちます。',
                })
                return
              }
              if (outcome.kind === 'refused') {
                set結末({ 調子: 'warn', 文: outcome.reason })
                return
              }
              // **「失敗した」と断定しない。** 撃てて機械が落ちたのかもしれない
              set結末({
                調子: 'warn',
                文: '返事が返りませんでした。撃てて機械が落ちたのか、届かなかったのかは、この画面からは分かりません。しばらくしてから開き直して、最後に縮めた時刻を見てください。',
              })
            })
          }}
        />
      )}
    </div>
  )
}
