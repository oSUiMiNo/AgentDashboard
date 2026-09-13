/**
 * 拡張子ごとの、開いたときの見せ方（`ファイルビュアにエディタ機能を追加` 要件③）。
 *
 * # 並ぶのは「選ぶ余地があるもの」だけ
 *
 * **ビュアーを持つ拡張子しか出さない。** `text` は表に無い拡張子すべての落ちどころで
 * ビュアーを持たないので、「見る」を選ばせても行き先が無く、[`既定のモード`] が既定へ
 * 落とす。**画面に出して黙って落とすのは「受けたふり」**である——設定画面の doc が
 * 言う「変えられないものを並べると『設定したのに効かない』になる」と同じ形。
 *
 * 要件の後半（**設定無しの拡張子はエディタで開く**）は [`既定のモード`] が満たしており、
 * ここで並べる必要が無い。
 *
 * # 既定を選んだら、行を消す
 *
 * 記録に残るのは**利用者が既定と違う見せ方を選んだ拡張子だけ**にする
 * （`SettingsView::file_modes` の doc）。既定へ戻したのに行が残ると、
 * **あとで既定を変えたときに、戻したはずの拡張子だけ古い既定に取り残される**。
 */

import { 既定のモード, 見せ方を選べる拡張子, type FileMode } from '@/lib/fileMode'
import { fileKind } from '@/lib/fileKind'
import { useSettingsStore } from '@/stores/settings'

const 見せ方のラベル: Record<FileMode, string> = {
  viewer: '見る',
  editor: '編集する',
}

/** その拡張子の既定（設定を空にして導いたもの）。 */
function 既定(拡張子: string): FileMode {
  const 仮の名前 = `x.${拡張子}`
  return 既定のモード(fileKind(仮の名前), 仮の名前, {})
}

export function FileModesCard() {
  const 対応 = useSettingsStore((state) => state.settings.file_modes)
  const update = useSettingsStore((state) => state.update)
  const loading = useSettingsStore((state) => state.loading)
  const 拡張子たち = 見せ方を選べる拡張子()

  return (
    <div
      data-testid="file-modes"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">開いたときの見せ方</h3>
      <p className="text-muted-foreground text-xs">
        ファイルビュアで開いた直後、見る側と編集する側のどちらで始めるかです。
        開いたあとはいつでも切り替えられます。
        <strong>
          {' '}
          ここに出るのは、見る側を持つ拡張子だけです。
        </strong>
        それ以外（コード・JSON・ログなど）は見る側が無いので、常に編集する側で始まります。
      </p>

      <ul className="flex flex-col gap-2 text-xs">
        {拡張子たち.map((拡張子) => {
          const 既定の値 = 既定(拡張子)
          const いまの値 = 対応[拡張子] ?? 既定の値
          return (
            <li key={拡張子} className="flex items-center gap-2">
              <code className="w-24 shrink-0">.{拡張子}</code>
              <select
                data-testid={`file-modes-select-${拡張子}`}
                className="border-border rounded border px-1.5 py-0.5 text-xs"
                disabled={loading}
                value={いまの値}
                onChange={(event) => {
                  const 選んだもの = event.target.value as FileMode
                  const 次 = { ...対応 }
                  if (選んだもの === 既定の値) {
                    delete 次[拡張子]
                  } else {
                    次[拡張子] = 選んだもの
                  }
                  void update({ file_modes: 次 })
                }}
              >
                {(['viewer', 'editor'] as FileMode[]).map((選択肢) => (
                  <option key={選択肢} value={選択肢}>
                    {見せ方のラベル[選択肢]}
                    {選択肢 === 既定の値 ? '（既定）' : ''}
                  </option>
                ))}
              </select>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
