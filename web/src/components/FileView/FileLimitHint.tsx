import { Link } from 'react-router'
import { FILE_VIEW_LIMIT_HASH, formatLimit } from '@/lib/fileView'
import { useSettingsStore } from '@/stores/settings'

/**
 * 上限で断られたときに、断り文の下へ出す一言と設定への導線（設計§10-2）。
 *
 * **ファイルビュアと窓で読む面の両方から使う**——同じ文面を2か所に書くと、片方だけ直した
 * ときに言うことが食い違う。
 *
 * # 誰が変えられるかで言い分ける
 *
 * - 変えてよい人（`editable`）：設定のカードへの導線を出す。**どこを押せばよいかまで分かる**
 *   ことが要件の完了条件
 * - サーバモードで管理者でない人：誰が決めているかを言う（導線は出さない。押しても変えられない）
 * - ローカルで変えられない人（LAN の向こうから開いた等）：設定のカードの読むだけの文と揃える
 * - 設定がまだ読めていない（選択肢が空＝古いサーバか読み込み前）：導線だけ
 *
 * **画像の断りと古い PC の断りには出さない**（呼び手が出し分ける）。変えても開けないものに
 * 導線を出すと、押した先で何も解決しない。
 */
export function FileLimitHint() {
  const 上限 = useSettingsStore((state) => state.settings.file_view)
  const 導線 = (
    <Link
      data-testid="file-limit-open-settings"
      to={`/settings${FILE_VIEW_LIMIT_HASH}`}
      className="text-primary underline underline-offset-2"
    >
      設定を開く
    </Link>
  )
  if (上限.choices.length === 0) {
    return (
      <p data-testid="file-limit-hint" className="text-xs text-amber-300">
        設定の『ファイル閲覧の上限』から変えられます。{導線}
      </p>
    )
  }
  const いま = formatLimit(上限.max_bytes)
  if (上限.editable) {
    return (
      <p data-testid="file-limit-hint" className="text-xs text-amber-300">
        設定の『ファイル閲覧の上限』から変えられます（いま {いま}）。{導線}
      </p>
    )
  }
  return (
    <p data-testid="file-limit-hint" className="text-xs text-amber-300">
      {上限.via_server
        ? `上限はサーバの管理者が決めています（いま ${いま}）。管理者に上げてもらってください。`
        : `上限はこの PC のブラウザ（127.0.0.1）からだけ変えられます（いま ${いま}）。`}
    </p>
  )
}
