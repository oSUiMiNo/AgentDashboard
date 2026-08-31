/**
 * セッションの権限モードを表示し、切り替える部品（設計§6・§8）。
 *
 * # 到達できないモードも隠さない（利用者の判断）
 *
 * Shift+Tab の巡回に入るモードは起動条件とアカウントで変わる（設計§11 の実測）。
 *
 * | モード | 切替で行けるか |
 * |---|---|
 * | 手動確認 / 編集を自動承認 / プラン | いつでも行ける |
 * | 自動 | アカウントの条件を満たすときだけ |
 * | 全承認をスキップ | **起動時に選んだセッションでだけ** |
 * | 確認しない | **決して行けない**（起動時にしか選べない） |
 *
 * 選択肢からは外さず、**押す前に分かることは押す前に出す**。押して着かなかった場合も
 * サーバが理由を返し、画面のエラー表示に出る。「押したのに変わらない、理由も分からない」
 * が一番困る（初期実装§11 の「不明の理由を名指しする」と同じ方針）。
 *
 * # 注意書きは、開いたときだけ出す（帯の設計§4・案B）
 *
 * 以前は選択肢の文字に括弧で足していたので、**選んだあとも `自動（環境によっては
 * 切り替えられません）` と出ていた**。補足は「押す前に知りたいもの」であって、
 * 選び終わったあとに毎回読まされるものではない。
 *
 * 標準の `<select>` は閉じているときに選択肢の文字をそのまま出すので、これは
 * 原理的にできない。**自前にしたのはここだけのため**である。
 *
 * # 中身は自分で購読する
 *
 * カードIDだけを受け取り、モードはストアから直接読む。要件が名指しで心配している
 * 「1つ変えたら他も変わる」は、値をカードの外に置いた瞬間に起きる。
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import {
  PERMISSION_MODES,
  permissionModeInfo,
  permissionModeLabel,
  permissionModeTone,
  type CardId,
  type PermissionMode,
  type PermissionReach,
} from '@/lib/protocol'
import { useSettingsStore } from '@/stores/settings'
import { useSessionCard } from '@/stores/sessions'
import { useWsStore } from '@/stores/ws'

interface Props {
  cardId: CardId
}

/** まだモードが分からないときに置く値（`radix-ui` は空文字を未選択として予約している）。 */
const 分からない = '__unknown__'

/**
 * 押す前に伝える注意書き。行けると分かっているものには何も出さない。
 *
 * **括弧を付けない。** 開いたときに選択肢の下へ小さく置くので、括弧は要らなくなった。
 */
function reachNote(
  reach: PermissionReach,
  launchedWith: PermissionMode | null,
  value: PermissionMode,
): string | null {
  switch (reach) {
    case 'cycle':
      return null
    case 'conditional':
      return '環境によっては切り替えられません'
    case 'launch-only':
      return '起動時にしか選べません'
    case 'launch-required':
      // 起動時にそのモードを選んでいれば巡回に入る
      return launchedWith === value ? null : '起動時に選んだ場合のみ'
  }
}

export function PermissionModePicker({ cardId }: Props) {
  const session = useSessionCard(cardId)
  const setPermissionMode = useWsStore((state) => state.setPermissionMode)
  const available = useSettingsStore((state) => state.settings.available_modes)

  if (!session) {
    return null
  }
  const current = session.permission_mode
  // 起動時に全承認をスキップを選んだセッションかどうかは、いまのモードからは分からない。
  // 分かる範囲でだけ注意書きを外す
  const launchedWith = current

  // サーバが `claude --help` から読んだ一覧を優先し、読めていなければ既知の表を使う
  const modes = PERMISSION_MODES.filter(
    (mode) => available.length === 0 || available.includes(mode.value),
  )
  // 表に無いモードが来ても選択肢から消えないようにする
  const 表に無い =
    current !== null && !modes.some((mode) => mode.value === current)

  return (
    <Select
      value={current ?? 分からない}
      onValueChange={(next) => setPermissionMode(cardId, next)}
    >
      <SelectTrigger
        data-testid="permission-mode-picker"
        data-mode={current ?? ''}
        aria-label="権限モード"
        // **モデルと同じ 8rem**（帯の設計§4）。ここには上限が無かったので、
        // `自動（環境によっては切り替えられません）` という1つの選択肢が
        // 短いモードを選んでいるときも幅を決めていた
        className={`w-32 ${permissionModeTone(current)}`}
      >
        {/* まだ分からない状態を、空欄ではなく「不明」として出す */}
        {permissionModeLabel(current)}
      </SelectTrigger>
      <SelectContent>
        {表に無い && current !== null && (
          <SelectItem
            value={current}
            data-testid="permission-mode-option"
            data-value={current}
          >
            {permissionModeLabel(current)}
          </SelectItem>
        )}
        {modes.map((mode) => (
          <SelectItem
            key={mode.value}
            value={mode.value}
            data-testid="permission-mode-option"
            data-value={mode.value}
            note={reachNote(mode.reach, launchedWith, mode.value)}
          >
            {permissionModeInfo(mode.value).label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
