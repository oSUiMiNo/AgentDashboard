/**
 * 新しいセッションを起動するフォーム。
 *
 * 起動できるのは**ダッシュボードが起動したセッションだけ**という仕様（要件「対象セッション」）
 * なので、ここが唯一の入口になる。ターミナルで手動起動したセッションの取り込みは将来検討。
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWsStore } from '@/stores/ws'

interface Props {
  disabled: boolean
}

export function SpawnForm({ disabled }: Props) {
  const spawn = useWsStore((state) => state.spawn)
  const [cwd, setCwd] = useState('')

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = cwd.trim()
        if (trimmed) {
          spawn(trimmed)
        }
      }}
    >
      <Input
        data-testid="cwd-input"
        aria-label="作業ディレクトリ"
        placeholder="/home/example/dev/プロジェクト"
        value={cwd}
        onChange={(event) => setCwd(event.target.value)}
        className="flex-1"
      />
      <Button type="submit" disabled={disabled || cwd.trim() === ''}>
        セッションを起動
      </Button>
    </form>
  )
}
