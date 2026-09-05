import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * セッション画面の見た目を、**テキストとして**確かめる（細かい修正 設計§5）。
 *
 * jsdom はカスケードを解決しないので、画面から計算後の値を読むことはできない。
 * ここで見られるのは**そう書いてあること**まで——実際にどう見えるかは E2E と実機の目で
 * 確かめる（`e2e/transcript.spec.ts` ／ `e2e/dashboard.spec.ts`）。
 */
function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}
/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
const 素 = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '')

const INDEX = 素(読む('index.css'))
const CONTROLS = 素(読む('controls.css'))
const SESSION = 読む('components/SessionView/SessionView.tsx')
const TERMINAL = 読む('components/TerminalPane/TerminalPane.tsx')
const TREE = 読む('components/TranscriptTree/TranscriptTree.tsx')
const ROW = 読む('components/TranscriptTree/TranscriptRow.tsx')

describe('吹き出しの横幅（§5-1）', () => {
  it('下限があり、上限と同じ土俵で書いてある', () => {
    // 素の `20em` だと狭い画面で**下限が上限を追い越して枠から出る**。
    // `min()` で下限のほうを譲る。**数字より、この形が守りたいもの**である
    // （下限は 25 → 20 へ変わった。2026-09-05・利用者の指定）
    const 規則 = /\.speech-bubble \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(規則, '.speech-bubble が見つからない').not.toBeNull()
    expect(規則![1]).toMatch(/min-width:\s*min\(20em,\s*70%\)/)
  })

  it('上限は 70% のまま', () => {
    expect(ROW).toContain('max-w-[70%]')
  })
})

describe('「履歴」の帯（§5-2）', () => {
  it('帯が消えている', () => {
    // 件数以外に何も出していなかった（要件2）
    expect(TREE).not.toContain('transcript-heading')
    expect(INDEX).not.toContain('.transcript-heading')
  })

  it('新しい帯を建てていない', () => {
    // **消したものの代わりに別の帯を建てると、消したかったものがそのまま戻る**
    expect(TREE).not.toMatch(/transcript-(band|header|title)\b/)
  })

  it('床の見出しは、画面の帯が引き受けている', () => {
    // §13.2 の Section Title（15〜18px / Semibold）。`text-base` = 16px
    const h2 = /data-testid="project-name"\s*\n\s*className="([^"]*)"/.exec(SESSION)
    expect(h2, 'project-name の見出しが見つからない').not.toBeNull()
    expect(h2![1]).toContain('text-base')
    expect(h2![1]).toContain('font-semibold')
  })

  it('履歴の器は、縁の紙の厚みを持ったまま', () => {
    // 物質感の受け皿の1つ（§12.3「パネルの縁＝弱」）。帯を外したぶん、ここは残す
    expect(INDEX).toMatch(/\.transcript-panel \{[\s\S]*?box-shadow:/)
  })
})

describe('選択の印（§5-3）', () => {
  const 規則 =
    /\[data-testid='transcript-row'\]\[data-body-open='true'\] \.row-shell \{([\s\S]*?)\n\}/.exec(
      INDEX,
    )

  it('印は行ではなく、中身の器に付いている', () => {
    // **ださく見えた原因は線そのものではなく置き場所**だった——右寄せの吹き出しでは、
    // 行の左端に引くと中身との間に画面3割ぶんの空白ができる
    expect(規則, '器に当てる規則が見つからない').not.toBeNull()
    // 行そのものへ当てる規則は残っていないこと
    expect(INDEX).not.toMatch(/\[data-body-open='true'\] \{/)
  })

  it('本文を持つ種別は、どれも掛かりを持っている', () => {
    /*
      **「3種類」は器の作り分け（吹き出し／`body-shell`／素）であって、行の種類ではない。**
      ここを取り違えて `MarkdownBody` にだけ付けていたため、**ツールコールと未知の行は
      開いても印が出なかった**——それらは `MarkdownBody` を通らない。

      内訳：`MarkdownBody` が4（吹き出し・`body-shell`・素を字下げの有無で2度）、
      ツールコールが1、未知が1。**サブエージェントは本文を持たない**（子を出し入れする
      だけ）ので対象外。
    */
    expect(ROW.match(/row-shell/g) ?? []).toHaveLength(6)
    expect(ROW).toContain('speech-bubble row-shell')
    expect(ROW).toContain('body-shell row-shell')
    // ツールコールと未知の器。**ここが落ちたら、その種別だけ印が消えている**
    expect(ROW).toContain('row-shell mt-1 ml-6 space-y-2')
    expect(ROW).toMatch(/row-shell[^"]*max-h-64/)
  })

  it('左辺の Accent と背景 Tint の2つを重ねている', () => {
    // 1つだけだと §27.3 の言う「単なる 1px Border」に近づく
    expect(規則![1]).toContain('inset 2px 0 0 var(--accent-edge)')
    expect(規則![1]).toContain('var(--accent-face)')
  })

  it('行の高さを変えない（inset で描く）', () => {
    expect(規則![1]).toMatch(/box-shadow:\s*\n?\s*inset/)
    expect(規則![1]).not.toMatch(/\bborder(-\w+)?:/)
  })

  it('地は background-image で重ねる（吹き出しの地を上書きしない）', () => {
    // `background` を書くと、地を1箇所で持つ約束（`--bubble-ground`）が壊れる
    expect(規則![1]).toContain('background-image:')
    expect(規則![1]).not.toMatch(/\n\s*background:/)
  })

  it('紫（--select）を使っていない', () => {
    // あれは一覧のカード専用。構造化ビューはシアンのまま
    expect(規則![1]).not.toContain('--select')
  })

  it('Hover と Pressed はそのまま残っている', () => {
    // 印を作り直しても、§8 の床「目に見える反応3つ」の他の2つを巻き添えにしない
    // Hover は Tailwind なので TSX 側、Pressed は `index.css` の §27.4
    expect(ROW).toContain('hover:bg-muted/40')
    expect(INDEX).toContain('scale(0.99)')
  })
})

describe('ターミナルの背景（§5-4）', () => {
  it('古い色がどこにも残っていない', () => {
    // **同じ色が2箇所に別々に書かれていた。** 片方だけ直すと、端末の外周にだけ古い色が残る
    expect(素(TERMINAL)).not.toContain('#0b0f14')
  })

  it('端末側はアプリの地と同じ値で塗る（透明にしない）', () => {
    // 透かすと裏の要素が透けて文字が読めなくなる。**同じ色で塗る**ほうが結果が安定する
    expect(TERMINAL).toContain("theme: { background: '#0a0a0a' }")
    expect(素(TERMINAL)).not.toMatch(/background:\s*'transparent'/)
  })

  it('入れ物の側は変数から取る（リテラルを増やさない）', () => {
    expect(TERMINAL).toContain('bg-background')
  })
})

describe('操作列（§5-5）', () => {
  it('絵の大きさが 14px に揃っている', () => {
    // ゴミ箱だけ無指定で 16px になっていた
    expect(SESSION).toContain('<TrashGlyph className="size-3.5" />')
    // 電源の絵は共有部品の側にある（フェーズ1で `ui/power-button.tsx` へ切り出した）
    expect(読む('components/ui/power-button.tsx')).toContain('<PowerGlyph className="size-3.5" />')
  })

  it('群の間は、群の中より広い', () => {
    // `DESIGN.md` §15.3「細線1本で区切らず、**間隔で群を切る**」
    expect(SESSION).toContain('ml-3 flex shrink-0 items-center gap-2')
  })

  it('平らな器を、電源側の質感へ寄せてある', () => {
    expect(CONTROLS).toMatch(/\.ops-raised \{[\s\S]*?box-shadow:/)
    // ターミナル切替・拡大縮小・終了に加え、**枝分かれ**の4つ
    // （ブランチ設計§7-2 で操作列へ1つ増えた。電源は別の器を持っている）
    expect(SESSION.match(/ops-raised/g) ?? []).toHaveLength(3)
  })

  it('塗るのは電源の点灯だけ（4つとも同じ盛り上がりにしない）', () => {
    // `DESIGN.md` §15.1。寄せた器は**輪郭だけ**で、地を塗らない
    const 規則 = /\.ops-raised \{([\s\S]*?)\n\}/.exec(CONTROLS)
    expect(規則![1]).not.toMatch(/\n\s*background:\s*(?!image)/)
    expect(規則![1]).not.toContain('--power-lit')
  })

  it('28px の箱の外へはみ出さない（枠は内側に描く）', () => {
    // `dashboard.spec.ts` が「ボタンの見た目を変えても行の高さは変わらない」を見張っている
    const 規則 = /\.ops-raised \{([\s\S]*?)\n\}/.exec(CONTROLS)
    expect(規則![1]).not.toMatch(/\n\s*border:/)
    expect(規則![1]).toContain('inset 0 0 0 1px')
  })

  it('電源を大きくしていない', () => {
    expect(CONTROLS).toContain('inline-size: 1.75rem')
  })
})
