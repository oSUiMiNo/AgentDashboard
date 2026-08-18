/// <reference types="node" />
// `src/` は**ブラウザ向けの型だけ**で検査する（`tsconfig.app.json` の `types` に `node` は
// 入れていない）。入れるとアプリのソースに `fs` を書けてしまうので、緩めずにこのファイル
// だけへ型を足す。**リポジトリの外を読むのはテストの中だけ**という線を、型でも保つ。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERMINAL_GRID } from './TerminalPane'

/**
 * 端末の格子と、CLI の既定が離れていないこと（コードレビュー対応9）。
 *
 * # なぜ台帳にするのか
 *
 * 120×40 を選んだ根拠は「録画・画面のゴールデン・`session screen` の既定と揃うこと」
 * だが、**揃っていることを見ているのは散文だけ**だった。`cli.rs` の既定を直した人は、
 * web 側が置いていかれたことに気づけない。
 *
 * 揃っている必要があるのは、あの口が **`SubPty` の桁行でそのまま PTY をリサイズする**
 * ためである（last-writer-wins）。既定のまま叩いた人が、**ブラウザで開いている人の表示を
 * 作り替えてしまう**のを避けたい。
 *
 * このリポジトリは、この種の境界の不変条件を**台帳の検査**で守る作法を持っている
 * （`cli_surface.toml` ／ `dependencies.rs` ／ `swallowed.toml`）。同じ扱いにする。
 *
 * # 読めなければ落ちる
 *
 * `readFileSync` は見つからなければ投げる。**黙って通る道を作らない**ためで、
 * ファイルが動いたときは「読めなかった」として落ちるのが正しい。
 */

/** `agentdashboard session screen` の口を宣言している場所。 */
function cliSource(): string {
  // **`new URL(…, import.meta.url)` は使えない**（Vite がアセットとして解決しようとする）。
  // パスを文字列として組み立てれば介入しない——`keys.test.ts` が `fixtures/` を読むのと同じ形
  const ここ = dirname(fileURLToPath(import.meta.url))
  return readFileSync(
    resolve(ここ, '../../../../server/crates/core/src/cli.rs'),
    'utf8',
  )
}

/**
 * `Screen { … }` の中で、その引数に付いている `default_value_t` を読む。
 *
 * **綴りだけで探さない。** `default_value_t = 120` を全文から拾う形にすると、
 * **既定が変わった瞬間に「見つからない」**という遠い落ち方になり、落ちた場で
 * 「いくつになったのか」が読めない。口と引数の名前で場所を決めて、値だけを読む。
 */
function 既定値(source: string, 引数: string): number {
  const lines = source.split('\n')
  const 始まり = lines.findIndex((line) => line.trim() === 'Screen {')
  expect(始まり, '`Screen {` の宣言が cli.rs に在ること').toBeGreaterThanOrEqual(0)
  const 終わり = lines.findIndex(
    (line, index) => index > 始まり && line.trim() === '},',
  )
  expect(終わり, '`Screen { … }` の終わりが読めること').toBeGreaterThan(始まり)

  const 本文 = lines.slice(始まり, 終わり)
  const 引数の行 = 本文.findIndex((line) => line.trim().startsWith(`${引数}:`))
  expect(引数の行, `\`Screen\` に \`${引数}\` が在ること`).toBeGreaterThan(0)
  // 属性は引数の直前に付く
  const 数字 = /default_value_t = (\d+)/.exec(本文[引数の行 - 1])
  expect(数字, `\`${引数}\` の既定値を読めること`).not.toBeNull()
  return Number(数字![1])
}

describe('端末の格子と CLI の既定', () => {
  it('`session screen` の既定と、ブラウザの格子が同じであること', () => {
    // ここが割れると、CLI を**既定のまま叩いただけ**でブラウザの表示が作り替わる
    const source = cliSource()
    expect({
      cols: 既定値(source, 'cols'),
      rows: 既定値(source, 'rows'),
    }).toEqual({ cols: TERMINAL_GRID.cols, rows: TERMINAL_GRID.rows })
  })
})
