/**
 * 保存を許可する場所（`ファイルビュアにエディタ機能を追加` 設計§3-5）。
 *
 * # 既定はここに出さない
 *
 * **開いている PJT の配下は、この一覧に無くても常に書ける。** 効いている根を
 * 組み立てるのはサーバで、口座と PC で引ける PJT を記録から足している（設計§3-5）。
 * **消せない行を並べると、設定に見えるのに設定ではない**ことになるので、
 * 行にはせず**断り書きで伝える**。
 *
 * # なぜ広げるのが危ないか
 *
 * ここに足した場所は、**LAN の合言葉を知っている相手が書ける場所**でもある
 * （利用者判断・2026-09-13）。読める範囲より狭く取ってあるのは意図で、
 * **壊せる範囲を壊せない範囲より狭くする**ためである（設計§3-4）。
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings'

/** 末尾の `/` を落とす。ルートだけは `/` のまま残す。 */
function 揃える(場所: string): string {
  const 削った = 場所.trim().replace(/\/+$/, '')
  return 削った === '' ? '/' : 削った
}

export function WritableRootsCard() {
  const roots = useSettingsStore((state) => state.settings.writable_roots)
  const update = useSettingsStore((state) => state.update)
  const loading = useSettingsStore((state) => state.loading)
  const [場所, set場所] = useState('')

  const 揃えたもの = 揃える(場所)
  // **絶対パスだけを受ける。** 相対パスは「どこから見て」が決まらないので、
  // 受けても照合の相手が定まらない（設計§3-1 が字句で照合する）
  const 足せる =
    場所.trim().startsWith('/') && !roots.includes(揃えたもの) && !loading

  return (
    <div
      data-testid="writable-roots"
      className="border-border flex flex-col gap-2 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">保存を許可する場所</h3>
      <p className="text-muted-foreground text-xs">
        ファイルビュアの「編集する」で保存できる場所です。
        <strong> 開いている PJT の配下は、この一覧に無くても常に書けます。</strong>
        ここへ足すのは、PJT の外にあるものを直したいとき（設定ファイルなど）だけで足ります。
        <strong className="text-amber-300">
          {' '}
          LAN へ開いている場合、ここに足した場所は合言葉を知っている相手も書けます。
        </strong>
      </p>

      <ul data-testid="writable-roots-list" className="flex flex-col gap-1 text-xs">
        {roots.length === 0 && (
          <li className="text-muted-foreground">
            足された場所はありません（PJT の配下だけが書けます）。
          </li>
        )}
        {roots.map((root) => (
          <li key={root} className="flex items-center gap-2">
            <code className="grow break-all">{root}</code>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={`writable-roots-drop-${root}`}
              disabled={loading}
              onClick={() =>
                void update({
                  writable_roots: roots.filter((one) => one !== root),
                })
              }
            >
              外す
            </Button>
          </li>
        ))}
      </ul>

      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!足せる) {
            return
          }
          void update({ writable_roots: [...roots, 揃えたもの] }).then((ok) => {
            if (ok) {
              set場所('')
            }
          })
        }}
      >
        <Input
          data-testid="writable-roots-input"
          className="max-w-96"
          placeholder="/home/you/.claude"
          value={場所}
          onChange={(event) => set場所(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!足せる}>
          足す
        </Button>
      </form>
    </div>
  )
}
