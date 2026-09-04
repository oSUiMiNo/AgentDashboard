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

/** 「時間では消えない」と決めた種別を拾う。 */
function 消えない(): string[] {
  const src = 読む('src', 'stores', 'sessions.ts')
  const 本体 = /const 消えない: ReadonlySet<ErrorKind> = new Set\(\[([^\]]*)\]\)/.exec(src)
  expect(本体, '寿命の表を拾えていない').not.toBeNull()
  return [...本体![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
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

  it('消えないと決めた種別は、実在する種別だけ', () => {
    // 綴りを間違えると**その1件が黙って5秒側へ落ちる**。エラーは出ない
    for (const kind of 消えない()) {
      expect(tsの種別(), `${kind} は種別に無い`).toContain(kind)
    }
  })

  it('カードが見つからない・端末が開けない・復旧の失敗は消えない側にいる', () => {
    // 設計§7-3 の表。**ここが崩れると、押した理由が読む前に消える**
    expect(消えない().sort()).toEqual(['not_found', 'revive', 'sub_pty'])
  })
})
