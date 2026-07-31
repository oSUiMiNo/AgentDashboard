/**
 * セッションのモデルを表示し、切り替える部品（設計§5・§7・§12）。
 *
 * # 中身は自分で購読する
 *
 * カードIDだけを受け取り、モデルはストアから直接読む。要件が名指しで心配している
 * 「1つ変えたら他も変わる」は、**値をカードの外に置いた瞬間に起きる**。
 * `useWsStore`（zustand）はグローバル単一値しか持たないので、そこへモデルを置いてはいけない。
 *
 * # 表示と選択肢で出どころが違う
 *
 * | 何 | 出どころ | 例 |
 * |---|---|---|
 * | いま動いているモデル | CLI が `statusLine` で名乗った表示名 | `Opus 5` |
 * | 切り替え先 | こちらが持つ別名の表 | `Opus` |
 * | 選択肢の括弧 | その別名で切り替えたときの実測 | `Opus（Opus 5）` |
 *
 * # 表は PC ごと
 *
 * CLI の版は PC ごとに違うので、選択肢の材料は**そのセッションが属する PC の表**から
 * 取る（セルフホスト化設計§13-4）。1台ぶんで全部を作ると、その PC に無いモデルが並ぶ。
 *
 * **版番号はどれも表からは来ない**（設計§3）。別名の解決先はプロバイダで変わるので、
 * 表に正しい版番号は書けない。だから CLI が名乗った値と、実測して覚えた値だけを使う。
 *
 * # 現在値は選択肢に無い
 *
 * CLI が名乗るのはフルID（`claude-opus-5`）で、選択肢は別名（`opus`）。文字列が
 * 一致しないので、`<select>` の値として成立させるには**現在値の選択肢を先頭に足す**しかない。
 */

import {
  MODELS,
  aliasForCurrent,
  modelInfo,
  modelLabel,
  modelOptionLabel,
} from '@/lib/models'
import type { CardId } from '@/lib/protocol'
import { useSessionCard } from '@/stores/sessions'
import { modelTableFor, useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

interface Props {
  cardId: CardId
}

export function ModelPicker({ cardId }: Props) {
  const session = useSessionCard(cardId)
  const setModel = useWsStore((state) => state.setModel)
  const tables = useSettingsStore((state) => state.settings.model_tables)

  if (!session) {
    return null
  }

  // **そのセッションが属する PC の表を見る**（設計§13-4）。CLI の版は PC ごとに
  // 違うので、どれか1台の表で全部の選択肢を作ると、その PC に無いモデルが並ぶ。
  // ローカルモードには PC という単位が無いので `"local"` の1本を引く
  const table = modelTableFor(tables, session.agent_id)
  const seen = table.aliases ?? []
  const catalog = table.catalog ?? []

  const { model, model_label: label, model_requested: requested } = session
  // 切替中は要求した別名を出す。**確定した値と同じ顔をさせない**（設計§5）。
  // CLI に拒否されると確定は届かないので、これを確定と混ぜると画面が嘘をつき続ける
  const switching = requested !== null
  // いま動いているモデルが表の別名で言い当てられるなら、その行を選択状態にする。
  // 言い当てられないときだけ「現在値」の行を先頭へ足す（足すと同じ名前が2行並ぶため）
  const alias = aliasForCurrent(model, seen)
  const needsOwnRow = switching || alias === null

  return (
    <label className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">モデル</span>
      <select
        data-testid="model-picker"
        data-model={model ?? ''}
        data-requested={requested ?? ''}
        value={needsOwnRow ? (model ?? '') : alias}
        onChange={(event) => setModel(cardId, event.target.value)}
        aria-label="モデル"
        // 切替が終わるまで受け付けない。サーバも同じ理由で断るので（連打がロック待ちの
        // 行列になり、他のカードの切替まで後ろへずれる）、ここはその写しにあたる
        disabled={switching}
        className={`max-w-48 truncate rounded border px-1.5 py-0.5 text-xs ${
          switching
            ? 'border-amber-500/40 text-amber-300'
            : 'border-border text-muted-foreground'
        }`}
      >
        {needsOwnRow && (
          <option value={model ?? ''}>
            {switching
              ? `${modelLabel(requested, null)} へ切替中…`
              : modelLabel(model, label)}
          </option>
        )}
        {MODELS.map((entry) => (
          <option
            key={entry.value}
            value={entry.value}
            title={modelInfo(entry.value).description}
          >
            {modelOptionLabel(entry.value, seen, catalog)}
          </option>
        ))}
      </select>
    </label>
  )
}
