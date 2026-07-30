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
 * | 選択肢の表示（`Opus 5`） | その別名で切り替えた結果を覚えたもの（設計§12） |
 *
 * # 状況で変わる別名には版番号を出さない
 *
 * `default` / `best` / `opusplan` は**特定のモデル1つを指していない**。
 * 実測した1回の結果で置き換えると嘘になる。
 *
 * - `best` を `Fable 5` と出すと、`fable` と見分けが付かなくなる
 * - `opusplan` はモードなので、たまたま実行フェーズで観測すれば `Sonnet 5` と出てしまい
 *   「Sonnet になるだけ」と誤解される（実際にそう観測された）
 *
 * この3つは説明的なラベルのまま残す。[`ModelInfo.fixed`] がその印。
 */

import type { ModelId } from './protocol'

/** 別名1つ分。**版番号は持たない**（このファイル冒頭の理由）。 */
export interface ModelInfo {
  value: ModelId
  label: string
  description: string
  /**
   * 特定のモデル1つを指す別名か。
   *
   * `false` のものは解決先が状況で変わるので、実測した版番号で置き換えてはいけない。
   */
  fixed: boolean
  /**
   * CLI の対応表でいう系統名（設計§13）。
   *
   * ここが埋まっていれば、**まだ一度も選んでいなくても**「その系統でいちばん新しい
   * モデル」の名前を出せる（`opus` → `Opus 5`）。実測が来たらそちらが優先される。
   */
  family?: string
}

/**
 * CLI 自身から取り出した、正式名と通称の対応表1件（設計§13）。
 *
 * `claude-opus-5` → `Opus 5`。**こちらが持っている表ではない**ので古びない。
 */
export interface ModelCatalogEntry {
  id: ModelId
  family: string
  display_name: string
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
    description: '指定を消し、アカウントの既定に戻す。モデル名ではない',
    fixed: false,
  },
  {
    value: 'best',
    label: '最良',
    description: '使えるなかで最も高性能なもの。組織が Fable を使えれば Fable、でなければ最新の Opus',
    fixed: false,
  },
  {
    value: 'fable',
    family: 'fable',
    label: 'Fable',
    description: '一番大きく、長く走らせる用途',
    fixed: true,
  },
  {
    value: 'opus',
    family: 'opus',
    label: 'Opus',
    description: '複雑な推論',
    fixed: true,
  },
  {
    value: 'sonnet',
    family: 'sonnet',
    label: 'Sonnet',
    description: '日常のコーディング',
    fixed: true,
  },
  {
    value: 'haiku',
    family: 'haiku',
    label: 'Haiku',
    description: '軽い作業',
    fixed: true,
  },
  {
    value: 'opusplan',
    label: 'プラン=Opus / 実行=Sonnet',
    description: 'プランモード中は Opus、実行に移ると Sonnet へ切り替わる。モードであって固定のモデルではない',
    fixed: false,
  },
  {
    value: 'opus[1m]',
    family: 'opus',
    label: 'Opus（1M）',
    description: 'Opus を100万トークンのコンテキストで使う',
    fixed: true,
  },
  {
    value: 'sonnet[1m]',
    family: 'sonnet',
    label: 'Sonnet（1M）',
    description: 'Sonnet を100万トークンのコンテキストで使う。sonnet が既に1Mへ解決される環境では効果が無い',
    fixed: true,
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
    fixed: true,
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
 * その系統でいちばん新しいモデルを、CLI の対応表から引く（設計§13）。
 *
 * 版番号は id から作らない。`claude-haiku-4-5-20251001` のように日付が付くものが
 * あるので、**id を人が読む名前へ変換してはいけない**。並び順の比較にだけ数字を使う。
 */
function newestOfFamily(
  family: string,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry | undefined {
  const numbers = (id: ModelId) =>
    (id.match(/\d+/g) ?? []).map((part) => Number(part))
  const newer = (a: number[], b: number[]) => {
    for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
      const left = a[at] ?? 0
      const right = b[at] ?? 0
      if (left !== right) {
        return left > right
      }
    }
    return false
  }

  return catalog
    .filter((entry) => entry.family === family)
    .reduce<ModelCatalogEntry | undefined>(
      (best, entry) =>
        best === undefined || newer(numbers(entry.id), numbers(best.id))
          ? entry
          : best,
      undefined,
    )
}

/**
 * 選択肢1つ分の表示。
 *
 * 名前の出どころは3段階で、**確かなものから順に**使う。
 *
 * | 順 | 出どころ | 例 |
 * |---|---|---|
 * | 1 | その別名で切り替えて CLI が名乗った値（実測） | `Opus 5 (1M context)` |
 * | 2 | CLI の対応表から引いた「その系統の最新」（推測） | `Opus 5` |
 * | 3 | こちらの表のラベル（何も分からないとき） | `Opus` |
 *
 * 2 が推測なのは「別名＝その系統の最新」と決めつけているため。たいてい合っているが、
 * 組織の設定で候補が絞られていれば外れる。だから**実測が来たら必ずそちらへ寄せる**。
 *
 * [`ModelInfo.fixed`] が `false` の別名（`既定` / `最良` / `opusplan`）は
 * どの段階も使わない。解決先が状況で変わるので、1つの名前に決めると嘘になる。
 */
export function modelOptionLabel(
  value: ModelId,
  seen: ModelAliasSeen[],
  catalog: ModelCatalogEntry[] = [],
): string {
  const info = modelInfo(value)
  if (!info.fixed) {
    return info.label
  }

  const measured = seen.find((entry) => entry.alias === value)?.display_name
  if (measured) {
    return measured
  }

  if (info.family) {
    const newest = newestOfFamily(info.family, catalog)
    if (newest) {
      // `opus[1m]` は対応表に無い。系統の最新に、こちらの表が持つ「（1M）」を足す
      return value.endsWith('[1m]')
        ? `${newest.display_name}（1M）`
        : newest.display_name
    }
  }
  return info.label
}

/**
 * いま動いているモデルが、表のどの別名にあたるか。分からなければ `null`。
 *
 * これが引けると、選択欄に「現在値」の行を別に足さずに済む——引けた別名の行が
 * そのまま選択状態になる。足してしまうと `Opus 5` の行が2つ並んで紛らわしい。
 *
 * **実測だけで判断する。** 対応表からの推測で当てにいくと、`opus` と `opus[1m]` の
 * どちらを指しているのか決められない場面で取り違える。
 */
export function aliasForCurrent(
  model: ModelId | null,
  seen: ModelAliasSeen[],
): ModelId | null {
  if (model === null) {
    return null
  }
  const hit = seen.find(
    (entry) =>
      entry.id === model &&
      MODELS.some((known) => known.value === entry.alias && known.fixed),
  )
  return hit?.alias ?? null
}
