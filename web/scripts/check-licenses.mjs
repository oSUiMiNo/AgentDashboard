#!/usr/bin/env node
/**
 * 依存ツリーに GPL のパッケージが混ざっていないかを見る門。
 *
 * # なぜ要るのか
 *
 * ブロックエディタに BlockNote を採ったが（設計§5-2）、**同じ作者の `@blocknote/xl-*` は
 * `GPL-3.0 OR PROPRIETARY`** である。このリポジトリは**公開で、web を実行ファイルへ
 * 焼き込んで配る**ので、GPL のものが1つでも混ざると**配布そのものができなくなる**。
 *
 * **守りたいのは「いま入っていないこと」ではなく「あとから黙って入らないこと」**である。
 * `xl-*` は明示的に足さない限り入らないが、**あとから足した依存が連れてくる**ことがある。
 *
 * # 目視で数えない
 *
 * 綴りの照合は**部分一致で空振りする**。実際に踏みうる形が3つある。
 *
 * ```
 * ✗ s.includes('GPL')  … LGPL-2.1 と AGPL-3.0 も引っかかる（LGPL は別物で、使ってよい）
 * ✗ s === 'GPL-3.0'    … 'GPL-3.0 OR PROPRIETARY' を素通りする（xl-* がまさにこの形）
 * ✓ SPDX 式を区切ってトークンで完全一致
 * ```
 *
 * **デュアルライセンスを SPDX だけで判定しない。** `GPL-3.0 OR PROPRIETARY` は
 * 「金を払えば専有ライセンスを選べる」という意味で、**払っていないこちらは GPL 側しか
 * 選べない**。だから綴りとは別に、**名前（`@blocknote/xl-` 接頭辞）でも落とす**。
 *
 * # 使い方
 *
 * ```
 * npm run check-licenses                 # npm query を自分で叩く（1〜2分）
 * node scripts/check-licenses.mjs --input <file.json>   # 外から食わせる（検査自体の試験用）
 * ```
 *
 * **`--input` があるのは、この検査をわざと壊して落ちることを確かめるため**である。
 * テストできない検査を置くと、**検査があるのに何も見ていない状態**に気づけない。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 名前で落とすもの。**デュアルなので綴りだけでは切れない**（上記） */
const DENIED_NAME_PREFIXES = ['@blocknote/xl-']

/**
 * 綴りで落とすもの。**トークン完全一致で照合する**ので、`LGPL-2.1` や `AGPL` を
 * 部分一致で巻き込まない。`LGPL-*` は動的リンクなら使えるため**ここに入れない**。
 */
const DENIED_LICENSES = new Set(
  ['GPL-1.0', 'GPL-2.0', 'GPL-3.0', 'AGPL-1.0', 'AGPL-3.0'].flatMap((base) => [
    base,
    `${base}-only`,
    `${base}-or-later`,
    `${base}+`,
  ]),
)

/**
 * SPDX 式をトークンへ割る。`OR` `AND` `WITH` と括弧で切り、演算子そのものは捨てる。
 * 例：`'(GPL-3.0 OR PROPRIETARY)'` → `['GPL-3.0', 'PROPRIETARY']`
 */
export function tokenizeSpdx(expr) {
  if (typeof expr !== 'string') return []
  return expr
    .split(/[()\s]+/)
    .filter(Boolean)
    .filter((t) => !['OR', 'AND', 'WITH'].includes(t.toUpperCase()))
}

/** パッケージ1つを見て、落とす理由があれば返す。無ければ `null` */
export function judge(pkg) {
  const name = pkg.name ?? '(名前なし)'
  const prefix = DENIED_NAME_PREFIXES.find((p) => name.startsWith(p))
  if (prefix) {
    return { name, version: pkg.version, license: pkg.license, reason: `名前が ${prefix} で始まる（デュアルだが GPL 側しか選べない）` }
  }
  const hit = tokenizeSpdx(pkg.license).find((t) => DENIED_LICENSES.has(t))
  if (hit) {
    return { name, version: pkg.version, license: pkg.license, reason: `ライセンスに ${hit} を含む` }
  }
  return null
}

/** 依存の一覧を見て、落とすもの・ライセンス不明のもの・MPL のものを仕分ける */
export function inspect(packages) {
  const denied = []
  const unknown = []
  const mpl = []
  for (const pkg of packages) {
    const bad = judge(pkg)
    if (bad) denied.push(bad)
    if (pkg.license == null || pkg.license === '') unknown.push(pkg.name ?? '(名前なし)')
    if (tokenizeSpdx(pkg.license).includes('MPL-2.0')) mpl.push(`${pkg.name}@${pkg.version}`)
  }
  return { denied, unknown, mpl, total: packages.length }
}

function load() {
  const i = process.argv.indexOf('--input')
  if (i !== -1) {
    const path = process.argv[i + 1]
    if (!path) {
      console.error('--input にファイルの場所がありません')
      process.exit(2)
    }
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  // 既定は自分で数える。web/ で叩く前提
  const out = execFileSync('npm', ['query', '*', '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return JSON.parse(out)
}

function main() {
  const { denied, unknown, mpl, total } = inspect(load())

  console.log(`依存 ${total} 件を見ました。`)

  if (unknown.length > 0) {
    // 落とさないが黙らせない。いまは web 自身の1件だけのはず
    console.log(`\nライセンスが読めないもの ${unknown.length} 件：${unknown.join(', ')}`)
  }

  if (mpl.length > 0) {
    // MPL 3.2(a)：配ったものにはソースの入手方法を告知する義務がある。
    // ただし**配布物に載るものだけ**が対象で、ビルド時の道具は含まない（設計§5-4）
    console.log(`\nMPL-2.0 のもの ${mpl.length} 件（配布物に載るものは告知の対象）：`)
    for (const m of mpl) console.log(`  ${m}`)
  }

  if (denied.length > 0) {
    console.error(`\n落とします。GPL のものが ${denied.length} 件あります：`)
    for (const d of denied) {
      console.error(`  ${d.name}@${d.version}  ライセンス=${d.license}`)
      console.error(`    → ${d.reason}`)
    }
    console.error('\nこのリポジトリは公開で、web は実行ファイルへ焼き込まれます。')
    console.error('GPL のものが混ざると配布そのものができません（設計§5-4）。')
    process.exit(1)
  }

  console.log('\nGPL のものはありません。')
}

// `--input` で読み込むだけの試験でも使えるよう、直に叩かれたときだけ走らせる
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
}
