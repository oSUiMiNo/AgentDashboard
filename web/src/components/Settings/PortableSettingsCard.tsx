/**
 * このアカウントの設定をファイルへ持ち出すカード（持ち出し設計§13）。
 *
 * # 書き出しはブラウザに任せる
 *
 * 応答に `Content-Disposition` が付いているので、リンクを踏ませるだけで落ちてくる。
 * **サーバ側でファイルを作らない**——置き場所を決める必要が無く、消す責任も生まれない。
 * スマホのブラウザからでも取れる。
 *
 * # 読み込みの結果は必ず出す
 *
 * 設定画面は変化が地味で、「押したけど何か起きたのか分からない」が起きやすい。
 * 反映した件数と、無視したキーと、断られた理由を、押した場所のすぐ下に出す。
 */

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/settings'

/** `POST /api/settings/import` の応答（持ち出し設計§9）。 */
interface ImportOutcome {
  applied: string[]
  ignored: string[]
}

export function PortableSettingsCard() {
  const load = useSettingsStore((state) => state.load)
  const picker = useRef<HTMLInputElement>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function read(file: File) {
    setBusy(true)
    setOutcome(null)
    setError(null)
    try {
      const response = await fetch('/api/settings/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await file.text(),
      })
      const text = await response.text()
      if (!response.ok) {
        // **断られた理由をそのまま出す。** どのキーがどう駄目かがサーバから来ている
        setError(text || `読み込めませんでした（${response.status}）`)
        return
      }
      setOutcome(JSON.parse(text) as ImportOutcome)
      // 入った値を画面へ反映する（読み直さないと古い値が出たままになる）
      await load()
    } catch (cause) {
      setError(`読み込めませんでした: ${String(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="portable-settings"
      className="border-border flex flex-col gap-2 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">設定の持ち出し</h3>
      <p className="text-muted-foreground text-xs">
        このアカウントの設定をファイルへ書き出し、読み込んで戻せます。別の端末や別の
        アカウントへ同じ設定を移すときに使います。
        <strong className="text-amber-300">
          {' '}
          LAN のパスワードなどの秘密は含まれません。
        </strong>
      </p>

      <div className="flex items-center gap-2">
        {/*
          リンクを踏ませるだけ。fetch して Blob を組み立てる作りにすると、
          **ファイル名の決め方が画面側にも生まれる**（サーバの応答と食い違う余地）
        */}
        <Button asChild size="sm" variant="outline">
          <a data-testid="portable-export" href="/api/settings/export" download>
            書き出す
          </a>
        </Button>
        <Button
          data-testid="portable-import"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          読み込む
        </Button>
        <input
          ref={picker}
          data-testid="portable-file"
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // 同じファイルを続けて選べるようにする（選び直しに反応しなくなる）
            event.target.value = ''
            if (file) {
              void read(file)
            }
          }}
        />
      </div>

      {error && (
        <p data-testid="portable-error" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {outcome && (
        <p data-testid="portable-outcome" className="text-xs text-emerald-400">
          {outcome.applied.length}件を反映しました。
          {outcome.ignored.length > 0 &&
            ` 知らない項目は無視しました：${outcome.ignored.join('、')}`}
        </p>
      )}
    </div>
  )
}
