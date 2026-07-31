/**
 * 新しいセッションを起動するフォーム。
 *
 * 起動できるのは**ダッシュボードが起動したセッションだけ**という仕様（要件「対象セッション」）
 * なので、ここが唯一の入口になる。ターミナルで手動起動したセッションの取り込みは将来検討。
 *
 * # 起動ボタンは権限モードの選択でもある（設計§8）
 *
 * | 設定のトグル | ボタン |
 * |---|---|
 * | OFF（既定） | 3つ：スキップの指定は無し／編集の承認のみスキップ／全承認をスキップ |
 * | ON | 1つ：全承認をスキップ |
 *
 * 「スキップの指定は無し」は**本当に何も渡さない**。利用者の `permissions.defaultMode` を
 * 尊重するという意味で、こちらで「手動確認」に固定するのとは違う（設計§9-4）。
 *
 * 並びは左から順に危険度が上がる。Enter で送ったときは**いちばん左**（＝いちばん安全な
 * 選択肢）で起動する。権限確認を飛ばす選択をダッシュボードが勝手にしないため。
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
import { permissionModeLabel, type PermissionMode } from '@/lib/protocol'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

interface Props {
  disabled: boolean
}

/** 起動ボタン1つ分。`mode` が `null` なら CLI へ何も渡さない。 */
interface LaunchButton {
  mode: PermissionMode | null
  label: string
  /** 危険なものだけ見た目を変える */
  danger: boolean
}

const ALL_BUTTONS: LaunchButton[] = [
  { mode: null, label: 'スキップの指定は無し', danger: false },
  { mode: 'acceptEdits', label: '編集の承認のみスキップ', danger: false },
  { mode: 'bypassPermissions', label: '全承認をスキップ', danger: true },
]

const BYPASS_ONLY: LaunchButton[] = ALL_BUTTONS.filter(
  (button) => button.mode === 'bypassPermissions',
)

export function SpawnForm({ disabled }: Props) {
  const spawn = useWsStore((state) => state.spawn)
  const alwaysBypass = useSettingsStore(
    (state) => state.settings.always_bypass_permissions,
  )
  const agents = useSettingsStore((state) => state.settings.agents)
  const [cwd, setCwd] = useState('')
  const [target, setTarget] = useState('')

  // 繋がっている PC だけを候補にする。切れている PC を選べても起動できない
  const connected = agents.filter((agent) => agent.connected)
  const needsTarget = connected.length > 1
  // 1台のときは選ばせない（サーバも選ぶ余地が無いときだけ通す）
  const agentId = needsTarget ? target : null

  const buttons = alwaysBypass ? BYPASS_ONLY : ALL_BUTTONS
  const trimmed = cwd.trim()
  const blocked = disabled || trimmed === '' || (needsTarget && target === '')

  return (
    <form
      data-testid="spawn-form"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) {
          spawn(trimmed, buttons[0].mode, agentId)
        }
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
      {buttons.map((button) => (
        <Button
          key={button.mode ?? 'none'}
          type="button"
          data-testid="spawn-button"
          data-mode={button.mode ?? ''}
          variant={button.danger ? 'destructive' : 'default'}
          disabled={blocked}
          title={
            button.mode === null
              ? '利用者の設定（permissions.defaultMode）どおりに起動します'
              : `${permissionModeLabel(button.mode)} で起動します`
          }
          onClick={() => spawn(trimmed, button.mode, agentId)}
        >
          {button.label}
        </Button>
      ))}
    </form>
  )
}
