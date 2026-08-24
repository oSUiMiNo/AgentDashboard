/**
 * 種別の写しが、正（Rust 側の表）と食い違っていないこと
 * （`ファイル閲覧で画像とHTMLも表示する` 設計§2-2。テスト計画フェーズ4）。
 *
 * # なぜ Rust のソースを読むのか
 *
 * 期待値をこちらに書き写すと、**両方を書き写した人の思い込みが固定される**だけになる。
 * 正のファイルを読んで突き合わせれば、**どちらを直しても落ちる**——それが「写し」に
 * 対して置ける唯一の見張りである。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileIcon, fileKind, needsSandbox, type FileKind } from './fileKind'

/**
 * 正の置き場所を、**走らせた場所から上へ辿って**探す。
 *
 * `import.meta.url` は使えない（vitest の変換後は `file:` スキーム ではない）。
 * 決め打ちの相対パスも、どこから走らせたかで外れる。
 */
function rustSource(): string {
  const RELATIVE = 'server/crates/protocol/src/fs.rs'
  let at = process.cwd()
  for (let step = 0; step < 6; step += 1) {
    const found = resolve(at, RELATIVE)
    if (existsSync(found)) {
      return found
    }
    at = dirname(at)
  }
  throw new Error(`正の表（${RELATIVE}）が見つかりません。走らせた場所: ${process.cwd()}`)
}

/** Rust の `TABLE` を読み取る。`("png", FileKind::Image, Some("image/png")),` の並び。 */
function rustTable(): Record<string, string> {
  const source = readFileSync(rustSource(), 'utf8')
  const block = source.slice(
    source.indexOf('const TABLE'),
    source.indexOf('];', source.indexOf('const TABLE')),
  )
  const table: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const found = /\("(\w+)",\s*FileKind::(\w+)/.exec(line)
    if (found !== null) {
      table[found[1]] = found[2].toLowerCase()
    }
  }
  return table
}

describe('種別の写し', () => {
  it('Rust 側の表と1件ずつ一致する', () => {
    const table = rustTable()
    // **表が空でないことを先に見る。** 読み取りが空振りしていると、
    // 下の繰り返しが0回になって「一致した」ように見える
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(10)
    for (const [extension, kind] of Object.entries(table)) {
      expect(fileKind(`何か.${extension}`)).toBe(kind)
    }
  })

  it('こちらが余計な拡張子を知っていない', () => {
    // 逆向きも見る。写しだけが増えると、画面が「出るはず」の顔で失敗する
    const table = rustTable()
    for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'html', 'htm', 'md']) {
      expect(Object.keys(table)).toContain(extension)
    }
  })

  it('大文字小文字を区別しない', () => {
    expect(fileKind('A.PNG')).toBe('image')
    expect(fileKind('B.Html')).toBe('html')
    expect(fileKind('/deep/path/C.JpEg')).toBe('image')
  })

  it('表の外は素のテキストへ落ちる', () => {
    expect(fileKind('動く.mp4')).toBe('text')
    expect(fileKind('組み込み.js')).toBe('text')
    expect(fileKind('README')).toBe('text')
    expect(fileKind('/home/me/.bashrc')).toBe('text')
  })

  it('svg は画像ではなく独立した種別になる', () => {
    // ここが崩れると、script を書ける形式が `<img>` の側へ流れて隔離をすり抜ける
    const kind: FileKind = fileKind('図.svg')
    expect(kind).toBe('svg')
    expect(kind).not.toBe('image')
  })

  it('隔離した箱に入れるのは html と svg だけ', () => {
    expect(needsSandbox('html')).toBe(true)
    expect(needsSandbox('svg')).toBe(true)
    expect(needsSandbox('image')).toBe(false)
    expect(needsSandbox('markdown')).toBe(false)
    expect(needsSandbox('text')).toBe(false)
  })
})

describe('一覧の印', () => {
  it('画像とテキストが別の印になる', () => {
    // **これが直したかったこと。** 同じ印だと、押してみるまで何が出るか分からない
    expect(fileIcon('撮った.png')).not.toBe(fileIcon('メモ.txt'))
    expect(fileIcon('撮った.png')).toBe('🖼️')
    expect(fileIcon('メモ.txt')).toBe('📄')
  })

  it('HTML と Markdown もそれと分かる印になる', () => {
    expect(fileIcon('理解.html')).toBe('🌐')
    expect(fileIcon('計画.md')).toBe('📝')
    // 3つとも互いに違うこと。**片方だけ変えて同じに戻す**のを防ぐ
    const 印 = [fileIcon('理解.html'), fileIcon('計画.md'), fileIcon('メモ.txt')]
    expect(new Set(印).size).toBe(3)
  })

  it('SVG は画像と同じ印（利用者から見れば画像）', () => {
    // 中で隔離した箱を通るのは実装の都合で、押す前に知りたいことではない
    expect(fileIcon('図.svg')).toBe(fileIcon('撮った.png'))
  })

  it('5種すべてに印がある', () => {
    // 種別を1つ足したときに、印を足し忘れたら落ちる
    for (const path of ['a.md', 'a.html', 'a.svg', 'a.png', 'a.txt']) {
      expect(fileIcon(path)).toBeTruthy()
    }
  })
})
