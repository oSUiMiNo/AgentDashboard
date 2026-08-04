/**
 * このダッシュボードの素性を出すカード（バージョン表示イシュー）。
 *
 * # 目的は「アプデされているか分かる」こと
 *
 * 版の番号だけでは分からない。同じ番号でも、ソースからビルドし直せば中身は変わるし、
 * 配った箱は入れ替えるまで何も変わらない。**いつのものか**と**いつからここに在るか**を
 * 並べて初めて、更新されたのかどうかを自分で判断できる。
 *
 * # 版の切替カードとは別に、常に出す
 *
 * あちらは版を切り替えられる構成でしか中身が出ない（箱では出ない）。こちらは**箱でこそ
 * 要る**——利用者が普段見ているのがサーバ側の画面だから。
 *
 * # 2つの時刻を分けて出す
 *
 * | 出すもの | 箱で動かしていると | ソースからビルドしていると |
 * |---|---|---|
 * | 実行ファイルができた日時 | その版が作られた日（≒公開日） | 自分がビルドした日時 |
 * | ダッシュボードが起きた日時 | 箱を入れ替えた日時 | 起こし直した日時 |
 *
 * 片方だけだと、**更新したのか再起動しただけなのか**が区別できない。
 */

import { useEffect } from 'react'
import { formatDateTime, formatElapsed } from '@/lib/time'
import { isNewer, useVersionsStore } from '@/stores/versions'

export function AboutCard() {
  const versions = useVersionsStore((state) => state.versions)
  const load = useVersionsStore((state) => state.load)

  useEffect(() => {
    void load()
  }, [load])

  const running = versions.running
  const latest = versions.latest
  // 「新着か」はサーバが決めない。**走っている版より新しいか**で画面が決める（設計§8）
  const behind =
    latest && running && isNewer(latest.version, running) ? latest : null

  return (
    <div
      data-testid="about"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">このダッシュボードについて</h3>

      <dl className="flex flex-col gap-2 text-xs">
        <Row label="いま動いている版">
          <span data-testid="about-running" className="font-medium">
            {running ? `v${running}` : '不明'}
          </span>
          {behind ? (
            <span data-testid="about-behind" className="text-amber-300">
              新しい版があります（v{behind.version}）
            </span>
          ) : (
            latest && (
              <span data-testid="about-uptodate" className="text-emerald-400">
                最新です
              </span>
            )
          )}
        </Row>

        <Row
          label="この実行ファイルができた日時"
          hint="配った版なら、その版が作られた日。ソースから建てているなら、あなたがビルドした日時"
        >
          <Moment testId="about-binary-at" at={versions.binary_at} />
        </Row>

        <Row
          label="このダッシュボードが起きた日時"
          hint="上と離れていれば、入れ替えずに起こし直しただけ"
        >
          <Moment testId="about-started-at" at={versions.started_at} />
        </Row>

        <Row
          label="最後に新しい版を見に行った日時"
          hint="見に行くのは1日1回まで。新しい版が出てから知らせが出るまで最大1日ほど遅れます"
        >
          {latest ? (
            <Moment testId="about-checked-at" at={latest.checked_at} />
          ) : (
            <span data-testid="about-checked-at" className="text-muted-foreground">
              まだ一度も見に行けていません
            </span>
          )}
        </Row>
      </dl>

      {!versions.supported && (
        <p data-testid="about-unsupported" className="text-muted-foreground text-xs">
          この構成では画面から版を切り替えられません。更新するには、動かしている側
          （箱の献立表や、置いた実行ファイル）を入れ替えてください。
        </p>
      )}
    </div>
  )
}

/** 見出しと中身の1行。 */
function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <dt className="text-muted-foreground w-56 shrink-0">{label}</dt>
        <dd className="flex flex-wrap items-baseline gap-2">{children}</dd>
      </div>
      {hint && <p className="text-muted-foreground pl-0 text-[0.7rem]">{hint}</p>}
    </div>
  )
}

/**
 * 絶対時刻を主に、相対を添えて出す。
 *
 * **読めなければ「不明」と書く。** 推測で埋めると、更新の判断を誤らせる。
 */
function Moment({ testId, at }: { testId: string; at: number | null }) {
  const absolute = formatDateTime(at)
  if (absolute === null) {
    return (
      <span data-testid={testId} className="text-muted-foreground">
        不明
      </span>
    )
  }
  return (
    <span data-testid={testId}>
      {absolute}
      <span className="text-muted-foreground ml-2">
        （{formatElapsed(Date.now() - (at ?? 0))}）
      </span>
    </span>
  )
}
