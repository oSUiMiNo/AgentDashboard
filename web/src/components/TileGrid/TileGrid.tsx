/**
 * 一覧画面（司令塔ビュー）の本体（要件「一覧画面」／設計§10）。
 *
 * セッションをプロジェクト単位にまとめて並べる。同じフォルダで並列に走らせることが
 * 多いので、プロジェクトごとの箱にしておかないと、どれがどれの兄弟なのか分からなくなる。
 *
 * 購読するのは**構造だけ**（どの箱にどのカードが入るか）。状態の変化はここまで
 * 伝わってこないので、ツールコールのたびに一覧全体が作り直されることはない。
 * まとまりの組み立てと並びの安定は [`@/stores/sessions`] が持つ。
 */

import { ProjectGroup } from '@/components/ProjectGroup/ProjectGroup'
import {
  setAccountFilter,
  useAccountFilter,
  useProjectGroups,
  useTomlAccounts,
} from '@/stores/sessions'

export function TileGrid() {
  const groups = useProjectGroups()
  const accounts = useTomlAccounts()
  const filter = useAccountFilter()

  return (
    <div className="flex flex-col gap-3">
      {/*
        `.agent-dashboard.toml` が名乗った名前で絞り込む（セルフホスト化設計§8-5）。
        **これは権限ではない**——ローカルモードには認証が無く、ここは「いまはこの
        プロジェクト群だけ見たい」を叶えるための自己整理にすぎない。
        名乗ったカードが1枚も無ければ、選択肢そのものを出さない
      */}
      {accounts.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">絞り込み</span>
          <select
            data-testid="account-filter"
            className="border-border rounded border px-1.5 py-0.5 text-xs"
            value={filter ?? ''}
            aria-label="名乗りで絞り込む"
            onChange={(event) =>
              setAccountFilter(event.target.value === '' ? null : event.target.value)
            }
          >
            <option value="">すべて</option>
            {accounts.map((account) => (
              <option key={account} value={account}>
                {account}
              </option>
            ))}
          </select>
        </label>
      )}

      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {filter === null
            ? 'セッションはまだありません'
            : `「${filter}」のセッションはありません`}
        </p>
      ) : (
        <div data-testid="tile-grid" className="flex flex-col gap-4">
          {groups.map((group) => (
            <ProjectGroup
              key={group.project}
              project={group.project}
              cards={group.cards}
            />
          ))}
        </div>
      )}
    </div>
  )
}
