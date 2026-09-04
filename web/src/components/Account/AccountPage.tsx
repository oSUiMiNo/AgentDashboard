/**
 * アカウント画面（セルフホスト化設計§8-4・§11-1）。
 *
 * 扱うのは2つ——**PC を繋ぐための鍵**（ペアリングトークン）と、**繋がった PC の一覧**。
 *
 * # 平文は発行の1回だけ
 *
 * DB にはハッシュしか無いので、後から見せ直す手段がそもそも無い。**「もう一度見る」を
 * 押せそうな見た目にしない**——控え損ねたら作り直してもらうのが正しい。
 *
 * # 失効は接続中にも効く
 *
 * サーバが立てた直後にその接続を畳む。押した瞬間にその PC のカードが「接続断」に
 * 変わるので、効いたことが一覧で分かる。
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { connectionDot } from '@/lib/protocol'
import { formatElapsed } from '@/lib/time'
import { HOME } from '@/lib/routes'
import { useNow } from '@/lib/sessions'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import { isNewer } from '@/stores/versions'

interface TokenView {
  id: string
  label: string
  /**
   * 札の用途（CLI設計§5-3）。`agent`＝PC を繋ぐ・`cli`＝CLI で叩く。
   * 見分けを出さないと、CLI の札が「繋いでこない PC」として並び続ける
   */
  kind: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

interface AgentRow {
  id: string
  name: string
  last_seen_at: number | null
  connected: boolean
  /** その PC のセッションホストの版（CICD設計§16）。名乗っていなければ無い */
  version?: string | null
}

export function AccountPage() {
  const account = useAuthStore((state) => state.auth.account)
  // 危ない組み合わせの判定に要る（CICD設計§16）。名乗っていなければ比べない
  const serverVersion = useAuthStore((state) => state.auth.version ?? '')
  const logout = useAuthStore((state) => state.logout)
  const reloadSettings = useSettingsStore((state) => state.load)

  const [tokens, setTokens] = useState<TokenView[]>([])
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [issued, setIssued] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const now = useNow()

  const reload = useCallback(async () => {
    try {
      const [tokenResponse, agentResponse] = await Promise.all([
        fetch('/api/account/tokens'),
        fetch('/api/account/agents'),
      ])
      if (tokenResponse.ok) {
        setTokens((await tokenResponse.json()) as TokenView[])
      }
      if (agentResponse.ok) {
        setAgents((await agentResponse.json()) as AgentRow[])
      }
    } catch (cause) {
      setError(String(cause))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const issue = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      const response = await fetch('/api/account/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      if (!response.ok) {
        setError(await response.text())
        return
      }
      const created = (await response.json()) as TokenView & { token: string }
      setIssued(created.token)
      setLabel('')
      await reload()
    } catch (cause) {
      setError(String(cause))
    }
  }

  const revoke = async (tokenId: string) => {
    setError(null)
    try {
      const response = await fetch(`/api/account/tokens/${tokenId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        setError(await response.text())
        return
      }
      await reload()
      // PC の接続状態は設定の応答にも載っている（バッジの引き先）。畳んだことを
      // 一覧のバッジへも反映させる
      await reloadSettings()
    } catch (cause) {
      setError(String(cause))
    }
  }

  return (
    <section
      data-testid="account-page"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
    >
      <header className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold">アカウント</h2>
        {account && (
          <span data-testid="account-name" className="text-muted-foreground text-xs">
            {account}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          data-testid="logout"
          onClick={() => void logout()}
        >
          ログアウト
        </Button>
        <Link to={HOME} className="text-primary text-xs underline">
          一覧へ戻る
        </Link>
      </header>

      {error && (
        <p data-testid="account-error" className="text-xs text-red-400">
          {error}
        </p>
      )}

      <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
        <h3 className="text-sm font-medium">PC を繋ぐための鍵</h3>
        <p className="text-muted-foreground text-xs">
          発行した文字列を、その PC の <code>agent.toml</code> の{' '}
          <code>pairing_token</code> へ貼ります。1台につき1本にしておくと、1台ぶんを
          外すときに他を巻き添えにしません。
        </p>

        <form className="flex items-center gap-2" onSubmit={issue}>
          <Input
            data-testid="token-label"
            className="max-w-64"
            placeholder="どの PC 用か（例：仕事用ノート）"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button type="submit" size="sm">
            発行する
          </Button>
        </form>

        {issued && (
          <div
            data-testid="issued-token"
            className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          >
            <span className="text-xs font-medium text-amber-200">
              この表示は一度きりです。いま控えてください。
            </span>
            <code className="text-xs break-all">{issued}</code>
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setIssued(null)}
            >
              控えました
            </Button>
          </div>
        )}

        <ul data-testid="token-list" className="flex flex-col gap-1 text-xs">
          {tokens.map((token) => (
            <li
              key={token.id}
              data-testid="token-row"
              data-revoked={token.revoked_at !== null}
              data-kind={token.kind}
              className="flex items-center gap-2"
            >
              <span
                data-testid="token-kind"
                className="border-border text-muted-foreground shrink-0 rounded border px-1"
              >
                {token.kind === 'cli' ? 'CLI' : 'PC'}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {token.label || '（札なし）'}
              </span>
              <span className="text-muted-foreground shrink-0">
                {/* CLI の札に「繋がっていません」は嘘になる（繋ぎっぱなしにしない使い方が正）。
                    PC の札だけ、貼り忘れの可能性として言う */}
                {token.last_used_at === null
                  ? token.kind === 'cli'
                    ? 'まだ使われていません'
                    : 'まだ繋がっていません'
                  : `最終使用 ${formatElapsed(now - token.last_used_at)}`}
              </span>
              {token.revoked_at === null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="revoke-token"
                  onClick={() => void revoke(token.id)}
                >
                  失効させる
                </Button>
              ) : (
                <span className="text-muted-foreground shrink-0">失効済み</span>
              )}
            </li>
          ))}
          {tokens.length === 0 && (
            <li className="text-muted-foreground">まだ1本もありません。</li>
          )}
        </ul>
      </div>

      <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
        <h3 className="text-sm font-medium">登録済みの PC</h3>
        <ul data-testid="agent-list" className="flex flex-col gap-1 text-xs">
          {agents.map((agent) => (
            <li
              key={agent.id}
              data-testid="agent-row"
              data-connected={agent.connected}
              className="flex items-center gap-2"
            >
              {/*
                **アプリの版番号の横と同じ印を使う**（細かい修正 要件19・設計§3-6）。
                緑（`emerald`）は役割色の表に無い色だったので、繋がっているときは
                進行中のシアンへ寄せた。**繋がっていないのは異常ではない**ので、
                コーラルではなく静かな灰のまま置く。
              */}
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${
                  agent.connected ? connectionDot('open') : 'bg-muted-foreground/40'
                }`}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
              {agent.version && (
                <span
                  data-testid="agent-version"
                  className={`shrink-0 ${
                    isNewer(agent.version, serverVersion)
                      ? 'text-amber-300'
                      : 'text-muted-foreground'
                  }`}
                  // **サーバのほうが古い組み合わせだけを目立たせる**（CICD設計§16）。
                  // 逆は知らない指示が読み飛ばされるだけで済むが、こちらは報告全体が
                  // 解けなくなり、カードが1枚も出なくなる
                  title={
                    isNewer(agent.version, serverVersion)
                      ? `この PC（${agent.version}）よりサーバ（${serverVersion}）が古いので、カードが出ないことがあります`
                      : undefined
                  }
                >
                  版 {agent.version}
                </span>
              )}
              {/*
                **点が言っていることを、文字で二度言わない**（細かい修正 要件19）。
                「接続中」「未接続」は左の点と同じことなので落とし、**点が持てない情報
                （最後に見かけた時刻）だけ**を残す。

                色は読み上げられないので、**点の意味は文字で必ず残す**。
              */}
              <span className="text-muted-foreground shrink-0">
                <span className="sr-only">
                  {agent.connected ? '接続中' : '未接続'}
                </span>
                {!agent.connected && agent.last_seen_at !== null
                  ? `最終 ${formatElapsed(now - agent.last_seen_at)}`
                  : null}
              </span>
            </li>
          ))}
          {agents.length === 0 && (
            <li className="text-muted-foreground">
              まだ1台も繋がっていません。上で鍵を発行して、PC 側の{' '}
              <code>agent.toml</code> へ貼ってください。
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}
