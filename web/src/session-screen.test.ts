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

  it('上限は、人が 70%・機械が 77%', () => {
    // **1.1倍は機械だけ**（2026-09-06・利用者の指定「人間の方は今のまま」）。
    // 数は字で書く——実装の定数から組み立てると、一緒に動いて通ってしまう
    expect(ROW).toContain("machine ? 'max-w-[77%]' : 'max-w-[70%]'")
  })
})

describe('機械の吹き出しの地（2026-09-06・鮮やかにした）', () => {
  const 規則 = /\.speech-bubble-machine \{([\s\S]*?)\n\}/.exec(INDEX)

  it('濁っていた古い色は、どこにも残っていない', () => {
    // 前は `#4a3410`＝C=0.060 で、人の青（C=0.106）の56%しか彩度が無かった
    expect(INDEX).not.toContain('#4a3410')
  })

  it('採用した色になっている', () => {
    expect(規則, '.speech-bubble-machine が見つからない').not.toBeNull()
    expect(規則![1]).toContain('#714904')
  })

  it('地は1箇所でしか持たない', () => {
    // 本体・しっぽ・中のコードが全部この1変数から引く（設計§6-4）。
    // **2箇所になった時点でずれる**
    expect((INDEX.match(/#714904/g) ?? []).length).toBe(1)
  })
})

describe('コードの見せ方（2026-09-06・参考へそっくり寄せた）', () => {
  it('インラインとブロックが同じ地を使う', () => {
    /*
      **参考（ChatGPT）は2つを同色にしている**——実測でどちらも `#2e5183` だった。
      前はブロックだけ暗くしており（地＋黒12%）、**そこが最も食い違っていた**。
    */
    const code = /\.prose-dashboard code \{([\s\S]*?)\n\}/.exec(INDEX)
    const pre = /\.prose-dashboard pre \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(code![1]).toContain('var(--code-ground')
    expect(pre![1]).toContain('var(--code-ground')
    // 暗くする書き方が残っていないこと
    expect(INDEX).not.toContain('black 12%')
  })

  it('吹き出しの中では、地から実測どおりの割合で作る', () => {
    /*
      参考の実測を sRGB で解くと、**どちらも「地＋白」の単純な混色**だった。

      ```
      #173e76 + 白10% = #2e5183   （インライン／ブロック）
      #173e76 + 白19% = #436390   （つまみ）
      ```

      **`in srgb` で書く。** 係数を sRGB のチャンネル値から解いたので、`in oklch` に
      すると同じ数字でも別の色になる
    */
    const 規則 = /\.speech-bubble \{\n\s*--code-ground([\s\S]*?)\n\}/.exec(INDEX)
    expect(規則, '--code-ground を定める規則が見つからない').not.toBeNull()
    expect(規則![0]).toContain('in srgb, var(--bubble-ground) 90%, white')
    expect(規則![0]).toContain('in srgb, var(--bubble-ground) 81%, white')
  })

  it('横スクロールバーは細く、軌道は透明', () => {
    /*
      **両方書く。** 片方だけだと、もう一方のブラウザで太い既定のまま残る
      （利用者が見ていたのがこれ）。

      **`INDEX` 全体に対して探さないこと。** `scrollbar-width: thin` は `.slash-card`
      にもあるので、**コードブロックから消しても文字列は残る**——実際それで壊し方が
      空振りした（2026-09-06）。**規則の中身を取り出してから見る。**
    */
    const 規則 = /\.prose-dashboard pre,\n\.prose-dashboard table \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(規則, 'コードブロックのスクロールバー規則が見つからない').not.toBeNull()
    expect(規則![1]).toContain('scrollbar-width: thin')
    expect(規則![1]).toContain('var(--code-thumb')
    expect(INDEX).toMatch(/::-webkit-scrollbar\s*\{[\s\S]*?height:\s*8px/)
    expect(INDEX).toMatch(/::-webkit-scrollbar-track[\s\S]*?background:\s*transparent/)
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

describe('選択の印（§5-3・2026-09-06 に器から記号へ移した）', () => {
  it('器には、縦線も地の変化も残っていない', () => {
    /*
      **【2026-09-06】利用者の指定で、器の印を外した**（「畳み込みを展開した際に
      吹き出しの色が変わる仕様は無しにしてほしい。あと左の水色の縦線もいらない」）。

      **2026-09-04 の「行から器へ移す」では足りなかった**ということである。移した先でも
      「ださい」が残ったので、**器から降ろした**。
    */
    expect(INDEX).not.toMatch(/\[data-body-open='true'\] \.row-shell \{/)
    expect(INDEX).not.toMatch(/\[data-expanded='true'\] \.row-shell \{/)
    // 行そのものへ当てる規則も無いこと（こちらは 2026-09-04 に外したまま）
    expect(INDEX).not.toMatch(/\[data-body-open='true'\] \{/)
  })

  it('Selected は、開いた行の記号が Primary Accent になることで残っている', () => {
    /*
      **消したのは置き場所であって Selected ではない。** §27.3 の候補のうち利用者が
      却下したのは「背景 Tint」と「左側の Accent」の2つで、**「状態バッジ」は残っている**
      ——記号（`›` / `⌄`）がそれにあたる。

      これが無いと `DESIGN.md` §8 の床「目に見える反応3つ」が2つに落ちる。
    */
    const 規則 =
      /\[data-testid='transcript-row'\]\[data-expanded='true'\] \.chevron-mark \{([\s\S]*?)\n\}/.exec(
        INDEX,
      )
    expect(規則, '記号へ当てる規則が見つからない').not.toBeNull()
    // 新しい色を増やしていない（`.slash-command` と同じシアン）
    expect(規則![1]).toContain('#3dd9e6')
  })

  it('記号は3箇所すべてが印を持っている', () => {
    // **1つでも付け忘れると、その種別だけ開いても印が出ない**——2026-09-04 に
    // 器へ移したときも、同じ形で「ツールコールと未知の行だけ印が出ない」を踏んでいる
    expect(ROW.match(/chevron-mark/g) ?? []).toHaveLength(3)
  })

  it('本文を持つ種別は、どれも器を持っている', () => {
    /*
      **印は器から降りたが、器そのものは残す。** ここは帯を敷く場所でもあるので、
      外すと畳みの見た目が壊れる。

      内訳：`MarkdownBody` が4（吹き出し・`body-shell`・素を字下げの有無で2度）、
      ツールコールが1、未知が1。**サブエージェントは本文を持たない**ので対象外。
    */
    expect(ROW.match(/row-shell/g) ?? []).toHaveLength(6)
    expect(ROW).toContain('speech-bubble row-shell')
    expect(ROW).toContain('body-shell row-shell')
    expect(ROW).toContain('row-shell mt-1 ml-6 space-y-2')
    expect(ROW).toMatch(/row-shell[^"]*max-h-64/)
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
