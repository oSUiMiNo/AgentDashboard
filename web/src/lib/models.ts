/**
 * 切り替え先として選べるモデルの別名表（設計§3）。
 *
 * `PERMISSION_MODES`（`protocol.ts`）と同じ「**サービスごとの表**」の形にしてある。
 * 将来 codex 等を対象に足すときは、同じ形の表をもう1つ持てばよい。
 *
 * # このファイルを単独にしている理由
 *
 * 表を他の関心事と混ぜないため。設計§8 は「別名が増えたときの追随を自己修復に
 * 担わせる」を検討していて、そのときの修復範囲を**このファイル1つ**に限れるように
 * してある（追随そのものは設計§12 の判断で今回は見送り）。
 *
 * # 表に版番号を書いてはいけない
 *
 * ここに「Opus 5」と書くと2つの意味で壊れる。
 *
 * 1. **古びる。** モデルは定期的に更新される
 * 2. **環境によって違う。** 別名の解決先はプロバイダで変わる（`opus` は Anthropic API
 *    なら Opus 5、Microsoft Foundry なら Opus 4.6）。1つの表に正しい版番号は書けない
 *
 * 版番号は2つの経路で画面に出る。どちらも**表からではなく実測から**来る。
 *
 * | 何 | どこから |
 * |---|---|
 * | いま動いているモデルの名前 | CLI が `statusLine` でくれる `display_name`（設計§4） |
 * | 選択肢の括弧内（`Opus（Opus 5）`） | その別名で切り替えた結果を覚えたもの（設計§12） |
 */

import type { ModelId } from './protocol'

/** 別名1つ分。**版番号は持たない**（このファイル冒頭の理由）。 */
export interface ModelInfo {
  value: ModelId
  label: string
  description: string
}

/**
 * ある別名が、この環境で実際に何に解決されたか。
 *
 * サーバが「切り替えを要求したあと CLI が名乗り直した値」を覚えたもの。
 * **推測では埋めない**ので、一度も選んでいない別名はここに現れない。
 */
export interface ModelAliasSeen {
  /** 送った別名（`opus`） */
  alias: ModelId
  /** CLI が名乗ったフルID（`claude-opus-5`） */
  id: ModelId
  /** CLI が名乗った表示名（`Opus 5`） */
  display_name: string
}

/**
 * 切り替え先の別名。並びは公式ドキュメントの一覧に合わせてある。
 *
 * `default` はモデル名ではなく「指定を消してアカウントの既定へ戻す」特別な値。
 */
export const MODELS: ModelInfo[] = [
  {
    value: 'default',
    label: '既定',
    description: '指定を消し、アカウントの既定に戻す',
  },
  {
    value: 'best',
    label: '最良',
    description: '使えるなかで最も高性能なもの',
  },
  {
    value: 'fable',
    label: 'Fable',
    description: '一番大きく、長く走らせる用途',
  },
  {
    value: 'opus',
    label: 'Opus',
    description: '複雑な推論',
  },
  {
    value: 'sonnet',
    label: 'Sonnet',
    description: '日常のコーディング',
  },
  {
    value: 'haiku',
    label: 'Haiku',
    description: '軽い作業',
  },
  {
    value: 'opusplan',
    label: 'Opus → Sonnet',
    description: 'プラン中は Opus、実行は Sonnet',
  },
  {
    value: 'opus[1m]',
    label: 'Opus（1M）',
    description: '100万トークンのコンテキスト',
  },
  {
    value: 'sonnet[1m]',
    label: 'Sonnet（1M）',
    description: '100万トークンのコンテキスト',
  },
]

/**
 * 別名の情報を引く。**表に無い値でも落ちない。**
 *
 * 表に無い値が届く場面は3つあり、どれも「知らないから表示できない」で止まっては
 * いけない（設計§3）。
 *
 * - 利用者が端末ペインで直接 `/model claude-opus-4-6` のようにフルIDを打った
 * - 組織の管理者が `availableModels` で候補を絞っている
 * - 新しい別名が出て、まだこの表が追いついていない
 */
export function modelInfo(value: ModelId): ModelInfo {
  const known = MODELS.find((entry) => entry.value === value)
  if (known) {
    return known
  }
  return {
    value,
    label: value,
    description: 'このダッシュボードが知らないモデルです',
  }
}

/**
 * いま動いているモデルとして画面に出す文字列。
 *
 * 優先順は **CLI がくれた表示名 → 値そのもの → 「不明」**。`label` を先に使うのは、
 * そちらだけが版番号を持っているため（`claude-opus-5` ではなく `Opus 5` と出したい）。
 *
 * `null` を「不明」と出すのは、**まだ CLI が名乗っていない**という意味であって
 * 「モデルが無い」ではない。空欄にすると、その区別が画面から消える。
 */
export function modelLabel(
  model: ModelId | null,
  label?: string | null,
): string {
  if (label) {
    return label
  }
  return model === null ? '不明' : modelInfo(model).label
}

/**
 * 選択肢1つ分の表示。学習済みなら版番号を括弧で併記する（設計§12）。
 *
 * 例：`Opus（Opus 5）`。まだ一度も選んでいない別名は括弧が付かない——
 * **推測で埋めない**ので、この環境でその別名が何に解決されるかを知らないから。
 */
export function modelOptionLabel(
  value: ModelId,
  seen: ModelAliasSeen[],
): string {
  const label = modelInfo(value).label
  const hit = seen.find((entry) => entry.alias === value)
  // 別名と表示名がたまたま同じ文字列のときに `Sonnet（Sonnet）` としない
  if (!hit || hit.display_name === label) {
    return label
  }
  return `${label}（${hit.display_name}）`
}
