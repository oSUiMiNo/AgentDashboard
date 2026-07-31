/**
 * 入口の画面（セルフホスト化設計§8-2・§8-3・§11-1）。
 *
 * # 3通りを1枚で出し分ける
 *
 * | 状況 | 出すもの |
 * |---|---|
 * | 管理者がまだ居ない（セルフホスト） | 最初のセットアップ |
 * | アカウントログイン | 名前＋パスワード |
 * | LAN 開放 | パスワードのみ（名前という概念が無い） |
 *
 * 分岐の材料は `GET /api/me` だけ。**ブラウザ側で構成を推測しない**——URL やポートから
 * 当てにいくと、リバースプロキシの裏で必ず外れる。
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/stores/auth'

export function AuthGate() {
  const auth = useAuthStore((state) => state.auth)
  const lastError = useAuthStore((state) => state.lastError)
  const login = useAuthStore((state) => state.login)
  const setup = useAuthStore((state) => state.setup)

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  // 名前が要るのはアカウントログインとセットアップだけ。LAN は共有パスワード1本
  const needsName = auth.mode === 'account'
  const isSetup = auth.mode === 'account' && auth.setup_open

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const done = isSetup
      ? setup(name, password)
      : login(needsName ? name : null, password)
    void done.finally(() => {
      setBusy(false)
      setPassword('')
    })
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      <form
        data-testid={isSetup ? 'setup-form' : 'login-form'}
        data-mode={auth.mode}
        onSubmit={submit}
        className="border-border flex w-80 flex-col gap-3 rounded-xl border p-6"
      >
        <h2 className="text-sm font-semibold">
          {isSetup ? '最初の管理者を作る' : 'ログイン'}
        </h2>
        <p className="text-muted-foreground text-xs">
          {isSetup
            ? 'このダッシュボードにはまだ誰も登録されていません。ここで作ったアカウントが管理者になります。'
            : auth.mode === 'lan_password'
              ? 'このダッシュボードは同じネットワークへ開かれています。設定画面で登録した共有パスワードを入れてください。'
              : 'アカウントの名前とパスワードを入れてください。'}
        </p>

        {needsName && (
          <label className="flex flex-col gap-1 text-xs">
            名前
            <Input
              data-testid="login-name"
              autoComplete="username"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs">
          パスワード
          <Input
            type="password"
            data-testid="login-password"
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {lastError && (
          <p data-testid="login-error" className="text-xs text-red-400">
            {lastError}
          </p>
        )}

        <Button type="submit" disabled={busy || password.length === 0}>
          {isSetup ? '作って入る' : '入る'}
        </Button>

        {auth.mode === 'lan_password' && (
          <p className="text-muted-foreground text-xs">
            通信は暗号化されていません。信頼できるネットワークの中だけで使ってください。
          </p>
        )}
      </form>
    </div>
  )
}
