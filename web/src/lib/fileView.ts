/**
 * ファイル閲覧の上限（ファイル閲覧の上限を設定から変え、大きいものは流し読みする 設計§9）の
 * 決める側。
 *
 * **画面は定数の写しを持たない**（設計§1）。値は全部 `GET /api/settings` の `file_view`
 * から受け取り、ここでは**受け取った値をどう読むか**だけを決める。
 */

import { formatBytes } from '@/lib/format'
import type { FileViewChoice } from '@/stores/settings'

/** 警告の段。設定のカードの確認の窓が出す `data-step` の綴りと同じ（設計§9-2） */
export type FileViewWarning = 'server' | 'cloud'

/**
 * 上限を変えるときに出す警告の段（Rust `server_core::file_view::warnings_for` の写し）。
 *
 * - **上げるときだけ**（`value > current`）、かつ `warnFrom` 以上のとき
 * - `warnFrom` はサーバの `file_view.warn_from_bytes`（サーバかクラウドのときだけ数。
 *   どちらでもなければ null）。**5 MiB を画面に写さないために、サーバの値を受け取る**
 * - 順は サーバ → クラウド
 *
 * Rust と同じ見本の表で両側を試す（`fileView.test.ts` と `file_view.rs` の
 * `警告の規則の見本の表`）。片方だけ直すと片方が落ちる。
 */
export function warningsFor(
  value: number,
  current: number,
  warnFrom: number | null,
  viaServer: boolean,
  meteredCloud: boolean,
): FileViewWarning[] {
  if (warnFrom === null || value < warnFrom || value <= current) {
    return []
  }
  const steps: FileViewWarning[] = []
  if (viaServer) {
    steps.push('server')
  }
  if (meteredCloud) {
    steps.push('cloud')
  }
  return steps
}

/**
 * 上限・天井の表記。`formatBytes` から末尾の「.0」だけを落とす（「3.0 MB」→「3 MB」）。
 *
 * **同じカードに「3 MB」（選択肢の名前）と「3.0 MB」（説明文）を並べないため。**
 * 小数が意味を持つ値（4.8 MB）は残す。
 */
export function formatLimit(bytes: number): string {
  return formatBytes(bytes).replace(/\.0 /, ' ')
}

/**
 * 選ぶ欄の1行の文字（設計§9-1）：`{label}（{3桁区切り} バイト）`、既定には末尾に「・既定」。
 *
 * **3桁区切りは `en-US` で固定する**——実行環境の言語で区切りの字が変わると、
 * 試験と画面の見え方が機械ごとに割れる。
 */
export function optionText(choice: FileViewChoice, defaultBytes: number): string {
  const text = `${choice.label}（${choice.bytes.toLocaleString('en-US')} バイト）`
  return choice.bytes === defaultBytes ? `${text}・既定` : text
}
