/**
 * ファイル閲覧の上限のカード（ファイル閲覧の上限を設定から変え、大きいものは流し読みする
 * 設計§9）。
 *
 * - これより大きいファイルは開かない、という線を16個の選択肢から選ぶ
 * - **警告は選んだ瞬間だけ出し、覚えない**（設計§9-2）。ファイルを開くたびに確かめると、
 *   慣れて押されるだけになる。上限そのものが既に守っている
 * - **画面は定数の写しを持たない**（設計§1）。選択肢・既定・天井は全部サーバから受け取る
 * - `editable` は出し分けにだけ使う。**弾くのはサーバ**（変えてよくない人の保存は 403）
 */

import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  FILE_VIEW_LIMIT_HASH,
  formatLimit,
  optionText,
  warningsFor,
  type FileViewWarning,
} from '@/lib/fileView'
import {
  useSettingsStore,
  type FileViewCloud,
  type FileViewSettings,
} from '@/stores/settings'

/** 警告の窓を出している間の中身 */
interface 候補 {
  value: number
  label: string
  段: FileViewWarning[]
  何段目: number
}

/** 判定の出どころを、初めて読む人にも分かる言葉で */
function 出どころ(cloud: FileViewCloud): string {
  return cloud.source === 'dmi'
    ? 'DMI（機械が名乗る製造元の情報）'
    : '設定ファイルの指定'
}

export function FileViewLimitCard() {
  const fileView = useSettingsStore((state) => state.settings.file_view)
  const loading = useSettingsStore((state) => state.loading)
  const update = useSettingsStore((state) => state.update)
  const { hash } = useLocation()
  const [候補, set候補] = useState<候補 | null>(null)
  const [保存中, set保存中] = useState<number | 'default' | null>(null)
  const 外枠 = useRef<HTMLDivElement>(null)
  const 送った = useRef(false)

  /*
    **ハッシュで開かれたら、このカードを見える位置へ送る**（ファイルビュアの断り文の導線）。
    読み込みが済んでから送る——読み込み中に送ると、上のカードが後から伸びて位置がずれる
  */
  useEffect(() => {
    if (hash === FILE_VIEW_LIMIT_HASH && !loading && !送った.current) {
      送った.current = true
      外枠.current?.scrollIntoView({ block: 'start' })
    }
  }, [hash, loading])

  const 保存する = async (value: number | 'default') => {
    set保存中(value)
    // 失敗は `update` が `lastError` を立て、設定画面の上部に出る（既存の道）。
    // 選ぶ欄はサーバの値へ戻る
    await update({ file_view_max_bytes: value })
    set保存中(null)
  }

  return (
    <div
      ref={外枠}
      id="file-view-limit"
      data-testid="file-view-limit"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">ファイル閲覧の上限</h3>
      {loading ? (
        // 暫定値の空の選択肢で「変えられません」と嘘を言わない
        <p
          data-testid="file-view-limit-loading"
          className="text-muted-foreground text-xs"
        >
          読み込み中です。
        </p>
      ) : fileView.choices.length === 0 ? (
        <p
          data-testid="file-view-limit-unsupported"
          className="text-muted-foreground text-xs"
        >
          この版のサーバは上限を変えられません。
        </p>
      ) : (
        <本体
          fileView={fileView}
          候補={候補}
          保存中={保存中}
          選んだ={(value, label) => {
            const 段 = warningsFor(
              value,
              fileView.max_bytes,
              fileView.warn_from_bytes,
              fileView.via_server,
              fileView.cloud !== null,
            )
            if (段.length === 0) {
              void 保存する(value)
            } else {
              set候補({ value, label, 段, 何段目: 0 })
            }
          }}
          戻す={() => void 保存する('default')}
        />
      )}
      {候補 !== null && (
        <FileViewLimitConfirm
          候補={候補}
          fileView={fileView}
          取り消す={() => set候補(null)}
          進む={() => {
            if (候補.何段目 + 1 < 候補.段.length) {
              set候補({ ...候補, 何段目: 候補.何段目 + 1 })
              return
            }
            set候補(null)
            void 保存する(候補.value)
          }}
        />
      )}
    </div>
  )
}

/** 選ぶ欄・説明・状況の一言・既定へ戻す・読むだけの一言 */
function 本体({
  fileView,
  候補,
  保存中,
  選んだ,
  戻す,
}: {
  fileView: FileViewSettings
  候補: 候補 | null
  保存中: number | 'default' | null
  選んだ: (value: number, label: string) => void
  戻す: () => void
}) {
  const {
    max_bytes,
    default_bytes,
    choices,
    editable,
    via_server,
    cloud,
    configured,
  } = fileView
  // いまの値が選択肢に無いことがある（別の版で入った値など）。
  // **黙って別の値を選んだ顔をしない**ので、無ければ先頭に足す（`Choice` と同じ作法）
  const options = choices.some((choice) => choice.bytes === max_bytes)
    ? choices
    : [{ bytes: max_bytes, label: formatLimit(max_bytes) }, ...choices]
  const value =
    候補?.value ?? (typeof 保存中 === 'number' ? 保存中 : max_bytes)

  return (
    <>
      <select
        data-testid="file-view-limit-select"
        aria-label="ファイル閲覧の上限"
        className="border-border w-fit rounded border px-1.5 py-0.5 text-xs"
        disabled={!editable || 保存中 !== null || 候補 !== null}
        value={value}
        onChange={(event) => {
          const picked = options.find(
            (choice) => String(choice.bytes) === event.target.value,
          )
          if (picked !== undefined) {
            選んだ(picked.bytes, picked.label)
          }
        }}
      >
        {options.map((choice) => (
          <option key={choice.bytes} value={choice.bytes}>
            {optionText(choice, default_bytes)}
          </option>
        ))}
      </select>
      <p className="text-muted-foreground text-xs">
        これより大きいファイルは開きません（中身を読まずに断ります）。
        {formatLimit(fileView.whole_text_bytes)}{' '}
        を超えるファイルは、生テキストで少しずつ読みます（整形と編集はできません）。HTML と
        SVG は {formatLimit(fileView.preview_max_bytes)}{' '}
        までなら描いた形で見られます。画像は別の上限（
        {formatLimit(fileView.image_max_bytes)}）で、この設定では変わりません。
      </p>
      {via_server && (
        <p data-testid="file-view-limit-via-server" className="text-xs">
          サーバを介して動いているので、既定は {formatLimit(default_bytes)}{' '}
          です。
        </p>
      )}
      {cloud !== null && (
        <p data-testid="file-view-limit-cloud" className="text-xs">
          このサーバはクラウド（{cloud.name}）の上で動いていると判定しました（
          {出どころ(cloud)}から）。
        </p>
      )}
      {configured && editable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="file-view-limit-reset"
          className="w-fit"
          disabled={保存中 !== null}
          onClick={戻す}
        >
          既定（{formatLimit(default_bytes)}）に戻す
        </Button>
      )}
      {!editable && (
        <p
          data-testid="file-view-limit-readonly"
          className="text-muted-foreground text-xs"
        >
          {via_server
            ? 'サーバの管理者だけが変えられます。'
            : 'この PC のブラウザ（127.0.0.1）からだけ変えられます。'}
        </p>
      )}
    </>
  )
}

/**
 * 上限を上げる前の確認（設計§9-2）。
 *
 * 器は `MachineCard.tsx` の `CompactConfirm`（＝`ReviveBudgetDialog` の写し。このアプリで
 * 唯一のダイアログの形）を写した。**新しい部品の型を作らない。** 写し元が持たない
 * Esc の取り消しと、取り消しへの焦点だけを足した。
 */
function FileViewLimitConfirm({
  候補,
  fileView,
  取り消す,
  進む,
}: {
  候補: 候補
  fileView: FileViewSettings
  取り消す: () => void
  進む: () => void
}) {
  useEffect(() => {
    const 押した = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        取り消す()
      }
    }
    globalThis.addEventListener('keydown', 押した)
    return () => globalThis.removeEventListener('keydown', 押した)
  }, [取り消す])

  const 段 = 候補.段[候補.何段目]
  const 最後 = 候補.何段目 + 1 >= 候補.段.length
  const cloud = fileView.cloud
  const 見出し =
    段 === 'server'
      ? `上限を ${候補.label} にすると、転送量が増えます`
      : `このサーバはクラウド（${cloud?.name ?? ''}）の上で動いていると判定しました`

  return (
    <>
      {/* 暗い幕。**押しても閉じない**——取り違えて上げるほうが痛い */}
      <div aria-hidden className="fixed inset-0 z-40 bg-black/60" />
      <div
        data-testid="file-view-limit-confirm"
        data-step={段}
        role="dialog"
        aria-label={見出し}
        className="bg-background fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto p-4 sm:inset-x-auto sm:inset-y-16 sm:left-1/2 sm:w-[min(34rem,90vw)] sm:-translate-x-1/2 sm:rounded-xl sm:border sm:shadow-xl"
      >
        <header className="flex shrink-0 items-center gap-2">
          <h2 className="text-sm font-semibold">{見出し}</h2>
        </header>

        {段 === 'server' ? (
          <p className="text-xs">
            このダッシュボードはサーバを介して動いているので、開いたファイルはサーバからブラウザへ流れます。生テキストは見ているところだけを少しずつ運びますが、HTML
            と SVG を描いた形で見ると最大{' '}
            {formatLimit(fileView.preview_max_bytes)} を丸ごと運びます。
            <strong>
              モバイル回線で見るときは、スマホの通信量に注意してください。
            </strong>
          </p>
        ) : (
          // 金額の目安の出典：調査レポート.md §1（東京の下り $0.114/GB・$1=150円として）
          <p className="text-xs">
            従量課金の契約なら、流れた量がそのまま請求に乗ります（目安：AWS の東京で 1GB
            あたり約17円〈税抜・2026-08 時点〉、月100GBまでは無料枠の中）。判定は
            {cloud === null ? '' : 出どころ(cloud)}
            によるもので、従量課金の契約かどうかまでは分かりません。
          </p>
        )}

        <footer className="flex shrink-0 items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="file-view-limit-confirm-cancel"
            autoFocus
            onClick={取り消す}
          >
            やめる
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="file-view-limit-confirm-go"
            onClick={進む}
          >
            {最後 ? '変える' : '続ける'}
          </Button>
        </footer>
      </div>
    </>
  )
}
