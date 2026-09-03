import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ネイティブの `<select>` が読めることを、**テキストとして**確かめる。
 *
 * # なぜ画面で確かめられないのか
 *
 * 開いた一覧（`option` の並び）は**ブラウザが描く別の面**で、DOM の中に無い。
 * jsdom には存在すらしないので、単体テストで「読める」ことは原理的に見られない。
 * ここで見られるのは**そう書いてあること**までである。
 *
 * それでも書く価値があるのは、**消しても他のテストが1本も落ちない**からである。
 * 実際に踏んだ——起動フォームの「どれを起こすか」は、**マウスを乗せた行以外が
 * 見えない**状態で配られていた。単体も E2E も全部緑だった。
 *
 * 実物が読めるかどうかは、E2E（計算後の色を測る）と実機の目で確かめる。
 */
function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}

const INDEX = 読む('index.css')

/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
const 素 = INDEX.replace(/\/\*[\s\S]*?\*\//g, '')

/** `@layer base { … }` の中身を、括弧の対応で取り出す。 */
function base層(): string {
  const 開始 = 素.indexOf('@layer base')
  expect(開始, '@layer base が見つからない').toBeGreaterThan(-1)
  const 最初の波 = 素.indexOf('{', 開始)
  let 深さ = 0
  for (let i = 最初の波; i < 素.length; i += 1) {
    if (素[i] === '{') 深さ += 1
    if (素[i] === '}') {
      深さ -= 1
      if (深さ === 0) return 素.slice(最初の波 + 1, i)
    }
  }
  throw new Error('@layer base が閉じていない')
}

/** その層の中から、セレクタが一致する規則の中身を取り出す。 */
function 規則(層: string, セレクタ: string): string[] {
  const 当たり: string[] = []
  const 型 = new RegExp(`(^|[};])\\s*${セレクタ}\\s*\\{([^}]*)\\}`, 'g')
  for (const 一致 of 層.matchAll(型)) 当たり.push(一致[2])
  return 当たり
}

describe('ネイティブの select は、地と文字を自分で決める', () => {
  const 層 = base層()

  it('較正：base 層を実物から取り出せている', () => {
    // **取り出しを間違えると、以下は「当たらないから通る」空振りになる**
    expect(規則(層, 'body')).toHaveLength(1)
    expect(規則(層, 'html')).toHaveLength(1)
  })

  it('select にも option にも、地と文字の両方が書いてある', () => {
    // **`option` にも書くのが要点。** 一覧の行は `select` の色を継がないので、
    // `select` だけに書くと、閉じているときは読めて開くと読めない形になる
    for (const セレクタ of ['select', 'select option']) {
      const 当たり = 規則(層, セレクタ)
      expect(当たり, `${セレクタ} の規則が無い`).toHaveLength(1)
      expect(当たり[0], `${セレクタ} に地が無い`).toContain('background-color')
      expect(当たり[0], `${セレクタ} に文字色が無い`).toContain('color:')
    }
  })

  it('色は決め打ちではなく、テーマの変数から引く', () => {
    // 直に色を書くと、テーマを足したときにここだけ置き去りになる
    for (const セレクタ of ['select', 'select option']) {
      const 本文 = 規則(層, セレクタ)[0]
      expect(本文).toContain('var(--background)')
      expect(本文).toContain('var(--foreground)')
    }
  })

  it('base 層に置いてあるので、危険な権限モードの色づけが勝つ', () => {
    // `spawn-mode` は `bg-red-500/15 text-red-300` のような utilities で危険さを
    // 出している（設計§8）。**base 層に置く**ことで、あちらが上から効く。
    // utilities 層へ移すと、警告色が黙って消える
    expect(層).toContain('select')
    // 層の外（＝どこにも属さない素の規則）に select を書いていないこと
    const 層の外 = 素.replace(層, '')
    expect(層の外).not.toMatch(/(^|[};])\s*select\s*\{/)
  })
})
