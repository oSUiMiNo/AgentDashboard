import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 断りの種別が、共有境界の両側で揃っていることを見張る（細かい修正 設計§7-2）。
 *
 * # なぜソースを読むのか
 *
 * **`send_error` の呼び出しが `kind` を渡していることは、型が見ている**——引数なので
 * 書き忘れるとコンパイルが通らない。機械の見張りが要るのはそこではなく、
 * **Rust とブラウザで綴りが揃っているか**である。
 *
 * 揃っていないと、**その種別だけ既定（`other`＝5秒）へ静かに落ちる**。
 * 復旧の失敗が5秒で消える、という形でしか表に出ない。
 */
function 読む(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), 'utf8')
}

/** Rust の `pub enum ErrorKind` を snake_case で拾う。 */
function rustの種別(): string[] {
  const src = 読む('..', 'server', 'crates', 'protocol', 'src', 'ws.rs')
  const 本体 = /pub enum ErrorKind \{([\s\S]*?)\n\}/.exec(src)
  expect(本体, 'Rust 側の ErrorKind を拾えていない').not.toBeNull()
  const 素 = 本体![1].replace(/\/\/\/.*$/gm, '').replace(/#\[[^\]]*\]/g, '')
  return [...素.matchAll(/^\s*([A-Z]\w*),/gm)].map((m) =>
    m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
  )
}

/** ブラウザ側の union を拾う。 */
function tsの種別(): string[] {
  const src = 読む('src', 'lib', 'protocol.ts')
  const 本体 = /export type ErrorKind =([\s\S]*?)\n\n/.exec(src)
  expect(本体, 'ブラウザ側の ErrorKind を拾えていない').not.toBeNull()
  return [...本体![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

/** 断りを積むところ（寿命を焼いている場所）を拾う。 */
function 積むところ(): string {
  const src = 読む('src', 'stores', 'sessions.ts')
  const 本体 = /export function pushCardNotice\([\s\S]*?\n\}/.exec(src)
  expect(本体, '断りを積むところを拾えていない').not.toBeNull()
  return 本体![0]
}

describe('断りの種別', () => {
  it('Rust とブラウザで、綴りも顔ぶれも揃っている', () => {
    // 揃っていないと、**その種別だけ既定（5秒）へ静かに落ちる**
    expect([...tsの種別()].sort()).toEqual([...rustの種別()].sort())
  })

  it('種別が2つ以上ある（拾い損ねていないことの較正）', () => {
    // 正規表現が空振りしても「揃っている」は通ってしまう
    expect(rustの種別().length).toBeGreaterThan(5)
  })

  it('寿命から外れる種別は、1つも無い', () => {
    /*
      **種別で寿命を分けるのはやめた**（2026-09-06・利用者の指定。設計§7-3）。
      かつては4種を「消えない」側に置いていたが、**行から下ろしてもベルに残る**ので
      分ける理由が消えた。

      ここで見るのは**種別による分岐が復活していないこと**。1件でも外すと、その断りが
      行に出たまま居座り、「ここに出るものは全部おなじ仕組み」が崩れる。
    */
    const 積む = 積むところ()
    expect(積む, '寿命を焼いていない').toMatch(/expiresAt:\s*いま \+ 寿命,/)
    // 種別を見て寿命を変える形（三項・`Set.has`・`includes`）が入っていないこと
    const 寿命の行 = /expiresAt:([^\n]*)/.exec(積む)![1]
    expect(寿命の行, '種別で寿命を分けている').not.toMatch(/kind|has\(|includes\(|\?/)
  })

  it('下ろす印を持っている（器から捨てていない）', () => {
    // **下ろすことと捨てることは別**。捨てるとベルからも消えて、溜めた意味が無くなる
    expect(積むところ()).toMatch(/retired:\s*false,/)
  })
})
