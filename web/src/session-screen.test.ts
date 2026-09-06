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

  it('横スクロールバーは参考どおりの寸法で、軌道は透明', () => {
    /*
      **参考の実測どおりに当てる**（2026-09-06）。画面写しは2倍で撮られており、
      つまみは純色10px・ぼけ込み14px ＝ **CSS で6px**。帯12px の中へ縁3pxぶん
      透かして置くと、この見え方になる。

      **`INDEX` 全体に対して探さないこと。** 同じ字は `.slash-card` にもあるので、
      **コードブロックから消しても文字列は残る**——実際それで壊し方が空振りした
      （2026-09-06）。**規則の中身を取り出してから見る。**
    */
    // **ここも規則の中身を取り出す。** `[\s\S]*?` で `{` の先を探すと、規則の外へ
    // 滑って `.slash-card` 側の同じ字に当たる——**実際それで空振りした**（2026-09-06）
    const 帯 =
      /\.prose-dashboard pre::-webkit-scrollbar,\n\.prose-dashboard table::-webkit-scrollbar \{([\s\S]*?)\n\}/.exec(
        INDEX,
      )
    expect(帯, 'コードブロックの帯の規則が見つからない').not.toBeNull()
    expect(帯![1]).toContain('height: 12px')
    const つまみ =
      /\.prose-dashboard pre::-webkit-scrollbar-thumb,\n\.prose-dashboard table::-webkit-scrollbar-thumb \{([\s\S]*?)\n\}/.exec(
        INDEX,
      )
    expect(つまみ, 'コードブロックのつまみの規則が見つからない').not.toBeNull()
    expect(つまみ![1]).toContain('var(--code-thumb')
    // 帯12px から見えるつまみ6px を作るのは、この2行の組（片方だけでは効かない）
    expect(つまみ![1]).toContain('border: 3px solid transparent')
    expect(つまみ![1]).toContain('background-clip: content-box')
    expect(INDEX).toMatch(/::-webkit-scrollbar-track[\s\S]*?background:\s*transparent/)
  })

  it('標準プロパティは、擬似要素を持たないブラウザにだけ渡す', () => {
    /*
      **これが「太さが足りない」の原因だった**（2026-09-06）。`scrollbar-width` /
      `scrollbar-color` を初期値以外にすると、**Chromium は `::-webkit-scrollbar` を
      丸ごと無視する**。前は両方を素で書いていたので `height` が1度も効かず、
      Chromium が決めた `thin` の細さがそのまま出ていた。

      **数えるのは「素で書かれた `scrollbar-width` が0個」。** 規則を1つ直しても
      別の規則に残っていれば意味が無いので、**ファイル全体で数える**——ここだけは
      全体を見るのが正しい（上の空振りとは向きが逆で、**残っていたら落とす**）。
    */
    const 素 = INDEX.replace(/\/\*[\s\S]*?\*\//g, '')
    const 全部 = [...素.matchAll(/scrollbar-width:/g)]
    expect(全部.length, 'scrollbar-width が1つも無い（較正が外れている）').toBeGreaterThan(0)
    for (const 当たり of 全部) {
      const 手前 = 素.slice(0, 当たり.index)
      const 直前の門 = 手前.lastIndexOf('@supports not selector(::-webkit-scrollbar)')
      expect(直前の門, `素で書かれた scrollbar-width がある（位置 ${当たり.index}）`).toBeGreaterThan(-1)
      // その門の中に居ること——門より後に閉じ括弧だけの行が来ていたら外へ出ている
      expect(手前.slice(直前の門)).not.toMatch(/\n\}\n\}/)
    }
  })
})

describe('APIのエラーの地（§13-2）', () => {
  it('エラーの器だけが地を持ち、地は薄いまま', () => {
    /*
      **赤い字だけでは「もう少し目立たせて」に届かない**（利用者の指定）。この器は
      普段 `--shell-ground` が透明で字が浮いているので、エラーのときだけ地を1枚持たせる。

      **`INDEX` 全体に対して探さないこと。** `--shell-ground` は `.body-shell` 側にも
      あるので、**エラーの規則から消しても文字列は残る**——同じ空振りを2度踏んでいる
      （2026-09-06）。**規則の中身を取り出してから見る。**
    */
    const 規則 = /\.body-shell-error \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(規則, 'エラーの器の規則が見つからない').not.toBeNull()
    // 色は既にこの画面がエラーへ当てているもの。新しい色を増やしていない
    expect(規則![1]).toContain('var(--color-red-400)')
    // **地は薄いまま。** 濃くすると赤い字とのコントラストが 4.5:1 へ寄り、
    // 目立たせるはずが読めなくなる
    const 濃さ = /var\(--color-red-400\)\s+(\d+)%/.exec(規則![1])
    expect(濃さ, '地の濃さが読み取れない').not.toBeNull()
    expect(Number(濃さ![1])).toBeLessThanOrEqual(20)
    // 地を持たせたぶん、字が縁に貼り付かないよう縦の余白を足す
    expect(規則![1]).toContain('padding:')
  })

  it('縁も影も足していない（§33 を踏まない）', () => {
    // 器そのものが装飾として立ち上がると「情報より装飾が目立つ」へ寄る。
    // **地1枚と字の色の2つで足りる**
    const 規則 = /\.body-shell-error \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(規則![1]).not.toMatch(/border:|box-shadow:|outline:/)
  })
})

describe('読まれる前の取り消し（§14-2）', () => {
  it('地は待ちと同じで、区別は打ち消し線という形で付ける', () => {
    /*
      **同じ言葉で説明できる状態は同じ色にする**（`DESIGN.md` §11.2）。待ちも取り消しも
      「claude に読まれていない」の一言で説明できるので、地は同じ。**分けるのは形。**
    */
    const 地 = /\.speech-bubble\.speech-bubble-cancelled \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(地, '取り消しの地の規則が見つからない').not.toBeNull()
    expect(地![1]).toContain('calc(c * 0.3)')
    const 待ち = /\.speech-bubble\.speech-bubble-queued \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(地![1].trim(), '待ちと同じ地であること').toBe(待ち![1].trim())
  })

  it('打ち消し線は、クラスではなく data-testid の本文へ当てる', () => {
    /*
      **`row-body` はクラスではない。** `.row-body` と書くと**永久に当たらず**、型検査も
      素通りする——実際に一度そう書いた（同じ空振りをスクロールバーで2度踏んでいる）。
    */
    const 線 = /\.speech-bubble-cancelled \[data-testid='row-body'\] \{([\s\S]*?)\n\}/.exec(INDEX)
    expect(線, '打ち消し線の規則が見つからない（セレクタが当たっていない）').not.toBeNull()
    expect(線![1]).toContain('line-through')
    // **字は読めるまま。** 線で潰さない
    expect(線![1]).toContain('text-decoration-color')
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
