import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 回遊の定義（`roam.css`）を、**テキストとして**確かめる。
 *
 * # なぜテキストなのか
 *
 * jsdom は CSS を適用しないので、「『控えめ』で止まる」「OS が『動きを減らす』と言えば
 * 止まる」は画面を描いても1つも確かめられない（`tile.test.ts` の冒頭と同じ理由）。
 * ここで言えるのは「そう書いてある」ことまでで、**実際に効くかは E2E と実物が見る**。
 *
 * それでも書く価値があるのは、**打ち消しが効かなくなる形が構造で決まっている**ため
 * ——順序が1つ入れ替わるだけで、静けさも OS 設定も黙って効かなくなる。
 *
 * # パーサを複製している
 *
 * 下の分割は `web/src/tile.test.ts` からの**写し**である。共有ヘルパへ切り出すと
 * 台帳そのもの（あちら）に手が入るので、**削らずそのまま複製して出所を書く**
 * （ガイドライン「ヘルパを写すなら削らずそのまま＋出所をコメント」）。
 */

function 読む(name: string): string {
  return readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
}

const CSS = 読む('roam.css')
const INDEX = 読む('index.css')

/** コメントを落とす。中に `{}` が入っているので、先に消さないと分割が狂う */
function 素のCSS(): string {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '')
}

interface Rule {
  selector: string
  body: string
  /** ファイルの先頭からの位置。**打ち消しが後ろにあること**を見るのに使う */
  at: number
}

/** 素朴なブロック分割。`@media` は1段だけ展開し、`@keyframes` は塊ごと飛ばす */
function 分ける(): Rule[] {
  const src = 素のCSS()
  const rules: Rule[] = []
  let i = 0
  while (i < src.length) {
    const 開き = src.indexOf('{', i)
    if (開き === -1) break
    const セレクタ = src.slice(i, 開き).trim()
    let 深さ = 1
    let j = 開き + 1
    while (j < src.length && 深さ > 0) {
      if (src[j] === '{') 深さ += 1
      if (src[j] === '}') 深さ -= 1
      j += 1
    }
    const 中身 = src.slice(開き + 1, j - 1)
    if (セレクタ.startsWith('@media')) {
      // 条件をセレクタへ前置して、1段だけ中を開く
      let k = 0
      while (k < 中身.length) {
        const 内開き = 中身.indexOf('{', k)
        if (内開き === -1) break
        const 内閉じ = 中身.indexOf('}', 内開き)
        rules.push({
          selector: `${セレクタ} ${中身.slice(k, 内開き).trim()}`,
          body: 中身.slice(内開き + 1, 内閉じ),
          at: 開き,
        })
        k = 内閉じ + 1
      }
    } else if (!セレクタ.startsWith('@keyframes')) {
      rules.push({ selector: セレクタ, body: 中身, at: 開き })
    }
    i = j
  }
  return rules
}

const 全規則 = 分ける()

function 当たる(部分: string): Rule[] {
  return 全規則.filter((rule) => rule.selector.includes(部分))
}

describe('回遊の定義の読み込み', () => {
  it('index.css から取り込まれている', () => {
    // **書き忘れても、位置を誤っても、このファイルのテストは全部緑のまま通る。**
    // `@import` は他の規則より前でないと捨てられるので、位置まで見る
    expect(INDEX.indexOf("@import './roam.css'")).toBeGreaterThan(-1)

    const 素のINDEX = INDEX.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(素のINDEX.indexOf("@import './roam.css'")).toBeLessThan(
      素のINDEX.indexOf('{'),
    )
  })

  it('較正：分割が実物の規則を拾えている', () => {
    // 数え違いをしていれば、以下のテストは「当たらないから通る」空振りになる。
    // **規則の数そのものは見ない**——数で見ると、規則を1本消す壊し方のたびに
    // ここまで落ちて、狙ったテストが1本だけ落ちたのかが読めなくなる
    expect(当たる('.roam-layer')).not.toHaveLength(0)
    expect(当たる('.roam-line')).not.toHaveLength(0)
    expect(素のCSS()).toContain('@keyframes roam-drift')
  })
})

describe('層は場所を取らず、何も塗らない', () => {
  it('中身と一緒にスクロールし、押す邪魔をしない', () => {
    // **`absolute` でなければならない**（カード設計§9-7-5）。`fixed` だと画面に
    // 貼り付いて、スクロールしたとき線だけが取り残される——経路が枠をなぞる
    // ようになると、線が枠から外れて意味が消える。
    //
    // 基準になる「場」は `App.tsx` 側にあり、**そちらが外れると層は初期包含
    // ブロックへ静かに落ちる**。そこは E2E（層の矩形＝場の矩形）が見ている
    const 層 = 全規則.filter((rule) => rule.selector.trim() === '.roam-layer')
    expect(層).toHaveLength(1)
    expect(層[0].body).toContain('position: absolute')
    expect(層[0].body).not.toContain('position: fixed')
    expect(層[0].body).toContain('pointer-events: none')
  })

  it('層そのものを塗らない', () => {
    // 塗ると**画面いっぱいの合成テクスチャが1枚生える**。塗ってよいのは線だけ
    const 層 = 全規則.filter((rule) => rule.selector.trim() === '.roam-layer')
    for (const 禁止 of ['background', 'filter', 'opacity', 'transform', 'will-change']) {
      expect(層[0].body).not.toContain(禁止)
    }
  })

  it('z-index を書かない', () => {
    // `z-index: auto` の絶対配置は DOM 順で「中身より上」に自然に収まる。
    // 書き足すと重なりの文脈が増えるだけ（`tile.css` と同じ方針）
    expect(素のCSS()).not.toContain('z-index')
  })

  it('will-change を書かない', () => {
    // 動く変形は自動で合成層に載る。書くと副作用だけが残る（調査§6-10）
    expect(素のCSS()).not.toContain('will-change')
  })

  it('キーフレームで動かすのは、決めた4つだけ', () => {
    /*
      **黒リストから白リストへ変えた**（フェーズ9）。

      前は `width|height|top|left|margin|padding` を禁じる形だったが、**黒リストは
      書き足しに弱い**——`clip-path` でも `inset` でも素通りする。設計§9-0 が
      「動かしてよいのは回転・移動・濃さ・大きさの4つだけ」と**閉じた集合**で
      決めている以上、検査も閉じた集合で書くのが素直である。
    */
    const 許す = new Set(['translate', 'rotate', 'scale', 'opacity'])
    const 塊 = 素のCSS().match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g) ?? []
    expect(塊).not.toHaveLength(0)
    for (const keyframes of 塊) {
      for (const [, 名前] of keyframes.matchAll(/^\s*([a-z-]+)\s*:/gm)) {
        // キーフレームの中の `animation-timing-function` は区間の緩急の指定で、
        // 何かを動かす宣言ではない
        if (名前 === 'animation-timing-function') continue
        expect(許す).toContain(名前)
      }
    }
  })

  it('較正：キーフレームを塊ごと拾えている', () => {
    // 上の検査は「宣言が1つも拾えていない」と空振りする。名前で数えて確かめる
    const 塊 = 素のCSS().match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g) ?? []
    expect(塊.map((k) => /@keyframes\s+([\w-]+)/.exec(k)?.[1]).sort()).toEqual([
      'roam-drift',
      'roam-fade',
      'roam-paper',
    ])
    // 停留点10ぶんの座標を読んでいること（`lib/roam.ts` の `ROAM_STOPS` と揃う）
    for (let i = 0; i < 10; i += 1) {
      expect(素のCSS()).toContain(`var(--roam-x${i})`)
    }
    // ③の転回。**座標を止めたまま向きだけ1周する**ので、専用の変数を読む
    expect(素のCSS()).toContain('var(--roam-turn)')
  })

  it('尺取り虫を scale で作る', () => {
    // **`width` で作ると版組をやり直させる**（設計§9-0）。上の白リストが
    // `width` を弾くので二重に守られるが、**「作ってある」ことは別に見る**
    // ——キーフレームごと消しても白リストは通ってしまう
    const 紙 = /@keyframes\s+roam-paper\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    expect(紙).toContain('scale: 0 1')
  })

  it('濃さはカードから配られる。固定値を書かない', () => {
    // フェーズ8 が「同じ状態はどこでも同じ色で出る」を台帳にしたのに、回遊の線
    // だけ `--roam-peak: 0.5` の固定値で塗っていた（カード設計§9-7）
    expect(素のCSS()).not.toContain('--roam-peak')
    const 淡 = /@keyframes\s+roam-fade\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    expect(淡).toContain('var(--roam-ink)')
  })

  it('filter を1箇所も書かない', () => {
    // 同時に最大10本へ常時掛かると、この設計でいちばん高くつく（設計§9-7-3）
    expect(素のCSS()).not.toContain('filter')
  })

  it('紙片はブロックとして置く', () => {
    // **書かないと `scale` が黙って一切効かない。** CSS Transforms 1 の
    // transformable element は非置換インラインを除外する
    const 紙 = 全規則.filter((rule) => rule.selector.trim() === '.roam-paper')
    expect(紙).toHaveLength(1)
    expect(紙[0].body).toContain('display: block')
  })

  it('飛ぶ時間を CSS 側に書かない', () => {
    // **秒数の出どころは層（TSX）1箇所。** ここへ書くと、寿命のタイマと見た目の
    // 長さが別々に育って食い違う。**内側にも同じ約束が掛かる**
    for (const 名 of ['.roam-line', '.roam-paper']) {
      const 規則 = 全規則.filter((rule) => rule.selector.trim() === 名)
      expect(規則).toHaveLength(1)
      expect(規則[0].body).not.toMatch(/animation-duration/)
      expect(規則[0].body).not.toMatch(/animation:\s*[^;]*\d+m?s/)
    }
  })
})

describe('止める道', () => {
  it('控えめでも静止でも、回遊は止まる', () => {
    // **ここが `tile.css` の3段と違う。** あちらの「控えめ」は作業中の回転だけを
    // 止めて承認待ちの跳ねは残すが、画面じゅうを飛び回る動きはいちばん静めたい
    for (const 段 of ['calm', 'still']) {
      const 規則 = 当たる(`[data-quiet='${段}']`)
      expect(規則).not.toHaveLength(0)
      for (const rule of 規則) {
        expect(rule.body).toContain('animation: none')
      }
      // **内側にも当てる。** `animation` は継承しないので、外側だけ止めると
      // `.roam-paper` は回り続ける——外が透明で見えないだけで、止まっていない
      const 当たり先 = 規則.flatMap((rule) => rule.selector.split(','))
      expect(当たり先.some((s) => s.includes('.roam-line'))).toBe(true)
      expect(当たり先.some((s) => s.includes('.roam-paper'))).toBe(true)
    }
  })

  it('段の選択によらず止める', () => {
    // 要件の完了条件が無条件なので、段で覆せるようにしない（設計§9-5-2）
    const 減らす = 当たる('prefers-reduced-motion')
    expect(減らす).not.toHaveLength(0)
    for (const rule of 減らす) {
      expect(rule.body).toContain('animation: none')
      expect(rule.selector).not.toContain('data-quiet')
    }
    const 当たり先 = 減らす.flatMap((rule) => rule.selector.split(','))
    expect(当たり先.some((s) => s.includes('.roam-line'))).toBe(true)
    expect(当たり先.some((s) => s.includes('.roam-paper'))).toBe(true)
  })

  it('打ち消しが、止める対象より後ろに書いてある', () => {
    // 詳細度が並ぶので**順序だけで勝つ**。前に書くと1つも止まらない
    const 最後の動き = Math.max(
      ...全規則
        .filter(
          (rule) =>
            /animation-name:\s*roam-/.test(rule.body) &&
            !rule.selector.includes('prefers-reduced-motion'),
        )
        .map((rule) => rule.at),
    )
    const 最初の打ち消し = Math.min(
      ...当たる('prefers-reduced-motion').map((rule) => rule.at),
    )
    expect(最初の打ち消し).toBeGreaterThan(最後の動き)
  })
})
