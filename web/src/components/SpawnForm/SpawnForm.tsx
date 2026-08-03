/**
 * 新しいセッションを起動するフォーム。
 *
 * 起動できるのは**ダッシュボードが起動したセッションだけ**という仕様（要件「対象セッション」）
 * なので、ここが唯一の入口になる。ターミナルで手動起動したセッションの取り込みは将来検討。
 *
 * # 権限モードは選んでから起こす（設計§8）
 *
 * 選択肢は3つで、下へ行くほど危険度が上がる。**選び直さないかぎり既定のまま**で、
 * 既定は設定のトグルが決める。
 *
 * | 設定のトグル | ドロップダウンの既定 |
 * |---|---|
 * | OFF（既定） | スキップの指定は無し |
 * | ON | 全承認をスキップ |
 *
 * 「スキップの指定は無し」は**本当に何も渡さない**。利用者の `permissions.defaultMode` を
 * 尊重するという意味で、こちらで「手動確認」に固定するのとは違う（設計§9-4）。
 *
 * ## 選んだ値は起動のたびに捨てる
 *
 * 持つのは「利用者が選んだ値」だけで、選んでいない間（`undefined`）は既定に従う。
 * この1つの規則で2つが同時に成り立つ。
 *
 * - 設定は `GET /api/settings` の応答で**後から**届くので、初期値を焼き込むと反映されない
 * - 起動したら選択を捨てるので、**前回の選択が残って意図しないモードで起こす**ことがない
 *
 * トグルが ON の人にとっては「別のモードで1本だけ起こしても、次はまた全承認スキップに
 * 戻っている」という形になる。危険な既定を選んだ意図を保ちつつ、選び忘れの事故は防ぐ。
 *
 * # どの PC で起こすかを選ぶ（セルフホスト化設計§5-1）
 *
 * 繋がっている PC が**2台以上のときだけ**選択肢を出す。1台のときとローカルモードでは
 * 選ぶ余地が無いので、出すと迷わせるだけになる。選ばずに送るとサーバが断る——
 * 黙って1台目へ送ると、意図しない PC で本物の claude が起動する。
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  permissionModeTone,
  type PermissionMode,
} from '@/lib/protocol'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

interface Props {
  disabled: boolean
}

/** 起動時に選べる権限モード。`mode` が `null` なら CLI へ何も渡さない。 */
interface LaunchMode {
  mode: PermissionMode | null
  label: string
  /** 選んだときに何が起きるかを、押す前に伝える */
  hint: string
}

/**
 * 選択欄の値は `mode ?? ''`（`PermissionModePicker` と同じ綴り）。
 * `''` が「指定なし」で、そのまま `null` としてサーバへ渡る。
 */
const LAUNCH_MODES: LaunchMode[] = [
  {
    mode: null,
    label: 'スキップの指定は無し',
    hint: '利用者の設定（permissions.defaultMode）どおりに起動します',
  },
  {
    mode: 'acceptEdits',
    label: '編集の承認のみスキップ',
    hint: 'ファイル編集の確認だけを飛ばして起動します',
  },
  {
    mode: 'bypassPermissions',
    label: '全承認をスキップ',
    hint: '権限確認そのものを行いません',
  },
]

/** 設定のトグルが ON のときの既定。 */
const BYPASS_VALUE = 'bypassPermissions'

export function SpawnForm({ disabled }: Props) {
  const spawn = useWsStore((state) => state.spawn)
  const alwaysBypass = useSettingsStore(
    (state) => state.settings.always_bypass_permissions,
  )
  const agents = useSettingsStore((state) => state.settings.agents)
  const [cwd, setCwd] = useState('')
  const [target, setTarget] = useState('')
  // `undefined` は「まだ選んでいない」＝既定に従う（上のドキュメント参照）
  const [picked, setPicked] = useState<string | undefined>(undefined)

  // 繋がっている PC だけを候補にする。切れている PC を選べても起動できない
  const connected = agents.filter((agent) => agent.connected)
  const needsTarget = connected.length > 1
  // 1台のときは選ばせない（サーバも選ぶ余地が無いときだけ通す）
  const agentId = needsTarget ? target : null

  const value = picked ?? (alwaysBypass ? BYPASS_VALUE : '')
  const mode: PermissionMode | null = value === '' ? null : value
  const selected =
    LAUNCH_MODES.find((entry) => (entry.mode ?? '') === value) ??
    LAUNCH_MODES[0]

  const trimmed = cwd.trim()
  const blocked = disabled || trimmed === '' || (needsTarget && target === '')

  const launch = () => {
    if (blocked) {
      return
    }
    spawn(trimmed, mode, agentId)
    // 選択を捨てて既定へ戻す。次の1本を前回のモードで起こさないため
    setPicked(undefined)
  }

  return (
    <form
      data-testid="spawn-form"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        launch()
      }}
    >
      <Input
        data-testid="cwd-input"
        aria-label="作業ディレクトリ"
        placeholder="/home/example/dev/プロジェクト"
        title={
          'Windows 側から貼ったパスも受け取ります（\\ 区切り／先頭の区切り抜け／' +
          '\\\\wsl.localhost\\... ／ C:\\...）'
        }
        value={cwd}
        onChange={(event) => setCwd(event.target.value)}
        className="min-w-64 flex-1"
      />
      {needsTarget && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">起動する PC</span>
          <select
            data-testid="spawn-target"
            className="border-border rounded border px-1.5 py-1 text-xs"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            aria-label="起動する PC"
          >
            {/* **既定を作らない。** 勝手に1台目を選ぶと、意図しない PC で起動する */}
            <option value="">選んでください</option>
            {connected.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">権限モード</span>
        <select
          data-testid="spawn-mode"
          data-mode={mode ?? ''}
          aria-label="権限モード"
          title={selected.hint}
          value={value}
          onChange={(event) => setPicked(event.target.value)}
          // 危険なモードほど目立たせる（設計§8）。バッジと同じ色づかいを使う
          className={`rounded border px-1.5 py-1 text-xs ${permissionModeTone(mode)}`}
        >
          {LAUNCH_MODES.map((entry) => (
            <option key={entry.mode ?? 'none'} value={entry.mode ?? ''}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="submit"
        data-testid="spawn-button"
        disabled={blocked}
        title={`${selected.label}：${selected.hint}`}
      >
        セッションを起動
      </Button>
    </form>
  )
}
