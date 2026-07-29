/**
 * 設定画面（設計§8）。ダッシュボードで最初の1枚。
 *
 * # なぜ一覧とは別の画面なのか
 *
 * **一覧の主役は状態インジケータ**（初期実装§10）で、そこに設定を混ぜると見るべきものが
 * 埋もれる。設定は頻繁に触るものではないので、1クリック奥で構わない。
 *
 * # 保存先はサーバ
 *
 * `config.toml` へ書き戻すので、**別のタブで開いても同じ値**になり、アプリを開き直しても
 * 残る（要件「設定は、アプリを開きなおしても引き継がれてほしい」）。
 */

import { Link } from 'react-router'
import { permissionModeInfo } from '@/lib/protocol'
import { HOME } from '@/lib/routes'
import { useSettingsStore } from '@/stores/settings'

export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings)
  const loading = useSettingsStore((state) => state.loading)
  const lastError = useSettingsStore((state) => state.lastError)
  const update = useSettingsStore((state) => state.setAlwaysBypassPermissions)

  return (
    <section
      data-testid="settings-page"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
    >
      <header className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold">設定</h2>
        <Link to={HOME} className="text-primary ml-auto text-xs underline">
          一覧へ戻る
        </Link>
      </header>

      {lastError && (
        <p data-testid="settings-error" className="text-xs text-red-400">
          {lastError}
        </p>
      )}

      <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            data-testid="always-bypass-toggle"
            className="size-4"
            disabled={loading}
            checked={settings.always_bypass_permissions}
            onChange={(event) => void update(event.target.checked)}
          />
          <span className="text-sm font-medium">
            常に権限確認スキップモードで開く
          </span>
        </label>
        <p className="text-muted-foreground text-xs">
          オンにすると、一覧の起動ボタンが「全承認をスキップ」の1つだけになります。
          オフのときは3つ（スキップの指定は無し／編集の承認のみスキップ／全承認をスキップ）出ます。
          <strong className="text-amber-300">
            {' '}
            全承認をスキップは権限確認そのものを行いません。
          </strong>
        </p>
      </div>

      <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
        <h3 className="text-sm font-medium">この CLI が受け付けるモード</h3>
        <p className="text-muted-foreground text-xs">
          起動時に <code>claude --help</code> から読んだ一覧です。読めなかった場合は
          ダッシュボードが知っているモードを出します。
        </p>
        <ul data-testid="available-modes" className="flex flex-col gap-1 text-xs">
          {settings.available_modes.map((mode) => {
            const info = permissionModeInfo(mode)
            return (
              <li key={mode} className="flex gap-2">
                <span className="w-32 shrink-0 font-medium">{info.label}</span>
                <span className="text-muted-foreground">{info.description}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
