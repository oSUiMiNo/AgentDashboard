/**
 * ダッシュボード自身の版を切り替えるカード（CICD設計§14・§15）。
 *
 * # 選ぶことと効かせることを分けて見せる
 *
 * ドロップダウンで選ぶのは**次に起こす版**で、押した瞬間には何も落ちない。
 * 落ちるのは「いま入れ替える」を押したときだけなので、両者を並べず、
 * 予約が入っている間だけ入れ替えの導線を出す。
 *
 * # いま走っている版と、次に起こす版は別々に出す
 *
 * 切替のあと再起動の前は、この2つがずれる。選択中の印だけだと
 * 「押しても何も起きない」ように見える。
 *
 * # 同じ版名の行が並ぶのは異常ではない
 *
 * ソースからビルドした版と配った版は同じ番号を名乗るので、**開発者の機械では
 * 初日から同名の行が3つ並ぶ**。名前だけでは選びようがないので実パスを併記する。
 */

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/format'
import {
  installLabel,
  isNewer,
  useVersionsStore,
  type VersionEntry,
} from '@/stores/versions'

export function VersionsCard() {
  const versions = useVersionsStore((state) => state.versions)
  const loading = useVersionsStore((state) => state.loading)
  const busy = useVersionsStore((state) => state.busy)
  const lastError = useVersionsStore((state) => state.lastError)
  const unverified = useVersionsStore((state) => state.unverified)
  const load = useVersionsStore((state) => state.load)
  const select = useVersionsStore((state) => state.select)
  const unselect = useVersionsStore((state) => state.unselect)
  const install = useVersionsStore((state) => state.install)
  const remove = useVersionsStore((state) => state.remove)
  const restart = useVersionsStore((state) => state.restart)
  const dismissUnverified = useVersionsStore((state) => state.dismissUnverified)

  useEffect(() => {
    void load()
  }, [load])

  const running = versions.entries.find((entry) => entry.running)
  const stored = versions.entries.filter((entry) => entry.origin === 'stored')
  const usage = stored.reduce((total, entry) => total + entry.size_bytes, 0)
  // 「新着か」はサーバが決めない。**走っている版より新しいか**で画面が決める（設計§8）
  const update =
    versions.latest &&
    versions.latest.has_artifact &&
    running &&
    isNewer(versions.latest.version, running.version)
      ? versions.latest
      : null

  if (!versions.supported) {
    // できないことをボタンにしない（設計§14）
    return (
      <div
        data-testid="versions"
        data-supported="false"
        className="border-border flex flex-col gap-2 rounded-xl border p-4"
      >
        <h3 className="text-sm font-medium">ダッシュボードの版</h3>
        <p className="text-muted-foreground text-xs">
          この構成では版を切り替えられません。箱で動かしている場合は、献立表
          （<code>docker/compose.yml</code>）の <code>image:</code> の版を書き換えて
          取り直してください。
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="versions"
      data-supported="true"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">ダッシュボードの版</h3>

      {lastError && (
        <p data-testid="versions-error" className="text-xs text-red-400">
          {lastError}
        </p>
      )}

      {versions.outcome?.failed_reason && (
        <p data-testid="versions-outcome" className="text-xs text-amber-300">
          {versions.outcome.attempted ?? '選んだ版'} で起動できなかったので、
          {versions.outcome.running} で立ち上げました（
          {versions.outcome.failed_reason}）
        </p>
      )}

      <p data-testid="versions-running" className="text-xs">
        <span className="text-muted-foreground">いま動いている版</span>{' '}
        {running ? running.version : '不明'}
        {running && (
          <span className="text-muted-foreground ml-2">{running.path}</span>
        )}
      </p>

      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground shrink-0">次に起こす版</span>
        <select
          data-testid="versions-picker"
          data-selected={versions.selected ?? ''}
          aria-label="次に起こす版"
          value={versions.selected ?? ''}
          disabled={loading || busy || !versions.editable}
          onChange={(event) => {
            const value = event.target.value
            void (value === '' ? unselect() : select(value))
          }}
          className="border-border min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs"
        >
          <option value="">
            入れる側が置いた版のまま（予約なし）
          </option>
          {stored.map((entry) => (
            <option key={entry.path} value={entry.version} title={entry.path}>
              {optionLabel(entry)}
            </option>
          ))}
        </select>
      </label>

      {versions.selected && (
        <div
          data-testid="versions-reservation"
          className="border-border flex flex-col gap-2 rounded-lg border p-3"
        >
          <p className="text-xs">
            <strong className="text-amber-300">{versions.selected}</strong>{' '}
            を予約しています。次に起こしたときから効きます。
          </p>
          <p data-testid="versions-stranded" className="text-muted-foreground text-xs">
            {versions.stranded_cards === 0
              ? 'いま入れ替えても、失われるセッションはありません。'
              : `いま入れ替えると ${versions.stranded_cards} 枚が抜け殻になります（履歴は残りますが、操作はできなくなります）。`}
          </p>
          <p className="text-muted-foreground text-xs">
            入れ替えると画面は一度切れます。戻ってこない場合は、端末で{' '}
            <code>agentdashboard</code> を実行してください。
          </p>
          <div className="flex gap-2">
            <Button
              data-testid="versions-restart"
              size="sm"
              disabled={busy || !versions.editable}
              onClick={() => void restart()}
            >
              いま入れ替える
            </Button>
            <Button
              data-testid="versions-cancel"
              variant="ghost"
              size="sm"
              disabled={busy || !versions.editable}
              onClick={() => void unselect()}
            >
              予約を取り消す
            </Button>
          </div>
        </div>
      )}

      {unverified && (
        <div
          data-testid="versions-confirm"
          className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="text-xs">{unverified.reason}</p>
          <p className="text-muted-foreground text-xs">
            この版には版を選ぶ画面がありません。
            <strong className="text-amber-300">
              戻ると、画面からは戻ってこられなくなります。
            </strong>{' '}
            手で戻すには次の2行を実行してください。
          </p>
          <pre className="text-muted-foreground overflow-x-auto text-[11px]">
            {`cat  ~/.local/state/agentdashboard/version-current\nrm   ~/.local/state/agentdashboard/version-current`}
          </pre>
          <div className="flex gap-2">
            <Button
              data-testid="versions-confirm-ok"
              size="sm"
              disabled={busy}
              onClick={() => void select(unverified.version, true)}
            >
              承知のうえで {unverified.version} を選ぶ
            </Button>
            <Button
              data-testid="versions-confirm-cancel"
              variant="ghost"
              size="sm"
              onClick={dismissUnverified}
            >
              やめる
            </Button>
          </div>
        </div>
      )}

      {update && (
        <p data-testid="versions-update" className="flex items-center gap-2 text-xs">
          <span>新しい版があります（{update.version}）</span>
          <Button
            size="sm"
            disabled={busy || !versions.editable || !!versions.install_unavailable}
            onClick={() => void install(update.version)}
          >
            取ってくる
          </Button>
        </p>
      )}

      {versions.install && (
        <p
          data-testid="versions-install"
          data-phase={versions.install.phase}
          className="text-muted-foreground text-xs"
        >
          {versions.install.version}：{installLabel(versions.install.phase)}
          {versions.install.reason && `（${versions.install.reason}）`}
        </p>
      )}

      {versions.install_unavailable && (
        <p data-testid="versions-install-unavailable" className="text-muted-foreground text-xs">
          {versions.install_unavailable}
        </p>
      )}

      {stored.length > 0 && (
        <ul data-testid="versions-stored" className="flex flex-col gap-1">
          {stored.map((entry) => (
            <li key={entry.path} className="flex items-center gap-2 text-xs">
              <span className="shrink-0">{entry.version}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {entry.path}
              </span>
              <span className="text-muted-foreground shrink-0">
                {formatBytes(entry.size_bytes)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !versions.editable || entry.running}
                onClick={() => void remove(entry.version)}
              >
                消す
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p data-testid="versions-usage" className="text-muted-foreground text-xs">
        保管庫の使用量：{formatBytes(usage)}（{stored.length} 版）
      </p>

      {!versions.editable && (
        <p data-testid="versions-readonly" className="text-muted-foreground text-xs">
          版の切り替えは、この PC のブラウザ（127.0.0.1）または管理者のアカウント
          からだけできます。
        </p>
      )}
    </div>
  )
}

/**
 * 選択肢の文言。
 *
 * **選べない版も選択肢から消さない。** 消すと「なぜ出てこないのか」が分からなく
 * なるので、括弧書きで理由を添える（`PermissionModePicker` と同じ扱い）。
 */
function optionLabel(entry: VersionEntry): string {
  if (entry.usable) {
    return entry.version
  }
  return `${entry.version}（${entry.reason ?? '選べません'}）`
}
