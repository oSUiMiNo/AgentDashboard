import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROAM_STOPS, roamSpans } from '@/lib/roam'
import { ROAM_LIFE_MS } from '@/stores/roam'

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
      'roam-birth',
      'roam-drift',
      'roam-fade',
      'roam-flutter',
    ])
    // 停留点ぶんの座標を読んでいること（`lib/roam.ts` の `ROAM_STOPS` と揃う）
    for (let i = 0; i < ROAM_STOPS; i += 1) {
      expect(素のCSS()).toContain(`var(--roam-x${i})`)
    }
    // **1つ多く読んでいない。** 停留点を減らしたときに、存在しない変数を読む
    // キーフレームが残っていると、その区間だけ原点へ飛ぶ
    expect(素のCSS()).not.toContain(`var(--roam-x${ROAM_STOPS})`)
    // **③の転回の変数は消えた。** 経路そのものが回るので要らない（設計§9-7-7 B）
    expect(素のCSS()).not.toContain('var(--roam-turn)')
  })

  it('線の太さがほぼ一定＝塊ではなく線に見える', () => {
    /*
      **これが「楕円に見える」を塞いでいる検査である**（設計§9-7-7 A）。

      前の版は中央が太く両端が細い**木の葉型**で、拡大するとそのまま楕円に見えていた
      ——ひらひらで縦に潰すと蝶ネクタイに、転回で回すと手裏剣になり、**どの瞬間も
      「線」ではなく「塊」だった**（0.1.39 を実物で見た利用者の指摘）。

      形は「上辺を左から右へ、下辺を右から左へ」の順に並べてあるので、**i 番目と
      末尾から i 番目が同じ x を持つ**。その隔たりが太さになる。**先細りへ戻すと
      両端の太さが落ちて**ここが落ちる。

      **中心線のたわみは、この検査では捕まらない**（上下が同位相で動くので太さは
      変わらない）。たわみは次の検査が別に見る。
    */
    for (const 形 of [0, 1, 2]) {
      const [規則] = 当たる(`[data-shape='${形}']`)
      expect(規則).toBeDefined()
      const 点 = [...規則.body.matchAll(/(-?[\d.]+)%\s+(-?[\d.]+)%/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
      }))
      // 較正：上下が対になる形で並んでいる（奇数だと下の突き合わせが嘘になる）
      expect(点.length % 2).toBe(0)
      expect(点.length).toBeGreaterThanOrEqual(8)

      const 太さ: number[] = []
      for (let i = 0; i < 点.length / 2; i += 1) {
        const 上 = 点[i]
        const 下 = 点[点.length - 1 - i]
        expect(下.x).toBe(上.x)
        太さ.push(下.y - 上.y)
      }
      /*
        **床は「インクの太さの 0.75 倍」から引いてある。** 箱は 30×7px でインクは
        3.5px（＝50%）なので 37.5%。端は 40% まで細めてあり（ペン先の入りと抜き）、
        **それ以上細めると「線」ではなく「木の葉」へ戻る**。

        マジックナンバーを置かない——前の版の 45 はインクが 5px（71.4%）だった頃の値で、
        **なぜ 45 なのかがどこにも書かれていなかった**。
      */
      const インク = 50
      expect(Math.min(...太さ)).toBeGreaterThan(インク * 0.75)
      expect(Math.max(...太さ) / Math.min(...太さ)).toBeLessThan(1.4)

      // **端は丸い**（ペン先の入りと抜き。要件6）。真ん中より細くなっていること
      // ——一定の太さで切りっぱなしにすると、ここが落ちる
      const 真ん中 = 太さ[Math.floor(太さ.length / 2)]
      expect(太さ[0]).toBeLessThan(真ん中)
      expect(太さ[太さ.length - 1]).toBeLessThan(真ん中)
    }
  })

  it('中心線がたわむ＝つたない手書きに見える', () => {
    /*
      **これが「デジタル手書きペンのつたない線」を守っている検査である**（要件6・
      参考画像 `効果線の書体.png`）。

      前の版は上辺と下辺が**独立に**揺れており、**太さだけが変わって中心線はほぼ
      真っ直ぐ**——だから「定規で引いた帯」に見えていた（0.1.40 を実物で見た
      利用者の指摘）。**上下を同位相でずらす**と、太さが一定のまま中心線が波打つ。

      **上下独立の揺れへ戻すと、中心線の振れが小さくなって落ちる。**
    */
    for (const 形 of [0, 1, 2]) {
      const [規則] = 当たる(`[data-shape='${形}']`)
      const 点 = [...規則.body.matchAll(/(-?[\d.]+)%\s+(-?[\d.]+)%/g)].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
      }))
      const 中心: number[] = []
      for (let i = 0; i < 点.length / 2; i += 1) {
        中心.push((点[i].y + 点[点.length - 1 - i].y) / 2)
      }
      // 箱は 7px なので、% の振れ × 7 ÷ 100 が px の振れ。**1〜2px たわませる**指定
      const 振れ = ((Math.max(...中心) - Math.min(...中心)) * 7) / 100
      expect(振れ).toBeGreaterThan(2)
      expect(振れ).toBeLessThan(4)
    }
  })

  it('3種は、たわみ方が違う', () => {
    // **同じ線が3本並ぶと手描きに見えない**（設計§9-7-6）。太さは揃えたので、
    // 見分けが付く唯一の手掛かりが中心線の形になった
    const 形たち = [0, 1, 2].map((形) => {
      const [規則] = 当たる(`[data-shape='${形}']`)
      const 点 = [...規則.body.matchAll(/(-?[\d.]+)%\s+(-?[\d.]+)%/g)].map((m) => Number(m[2]))
      const 中心: number[] = []
      for (let i = 0; i < 点.length / 2; i += 1) 中心.push((点[i] + 点[点.length - 1 - i]) / 2)
      return 中心.map((v) => v.toFixed(1)).join(',')
    })
    expect(new Set(形たち).size).toBe(3)
  })

  it('キーフレームの % が、区間の道のりに比例している', () => {
    /*
      **これが「角で減速しない」を CSS 側で守っている検査である**（設計§9-7-9）。

      経路の停留点は**等距離ではない**——飛散と回遊は 56px、巻きは 6〜17px。
      % を等間隔に置くと**巻きだけ 4倍遅く**なるので、% は道のりに比例させてある。

      **`lib/roam.ts` の `roamSpans()` が唯一の出どころ**で、ここはそれを写した
      静的な表が実物と合っているかを見る。**寿命・区間長・巻きの形のどれを変えても、
      CSS を引き直すまでここが落ちる**——手で書いた61ブロックを守る唯一の道である。
    */
    const 塊 = /@keyframes\s+roam-drift\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    const 実際 = [...塊.matchAll(/^\s*([\d.]+)%\s*\{/gm)].map((m) => Number(m[1]))
    expect(実際).toHaveLength(ROAM_STOPS)

    const 道のり = roamSpans()
    const 総 = 道のり.reduce((和, x) => 和 + x, 0)
    let 積 = 0
    const 狙い = [0, ...道のり.map((x) => ((積 += x) / 総) * 100)]
    for (const [i, v] of 実際.entries()) {
      expect(Math.abs(v - 狙い[i])).toBeLessThan(0.01)
    }
  })

  it('コマ送りは毎秒12コマに揃っている', () => {
    /*
      **うごくメモ帳のような手描きアニメの質感**を、なめらかさを削って出す
      （利用者の指定・2026-08-26。設計§9-7-7）。

      `steps()` は**キーフレームの区間ごと**に効く。**% が弧長比例になったので区間の
      実時間は2種類ある**（設計§9-7-9）——56px の区間は 0.96秒、巻きの区間は
      0.10〜0.28秒。**1つの段数では揃わない**ので、既定を `.roam-line` に置き、
      巻きの区間だけキーフレームの側で上書きしてある。

      見るのは2つ。**全体のコマ数**（総和 ÷ 寿命）と、**区間ごとの段数が道のりから
      引いた値と一致すること**。後者があるので、**寿命や区間長を変えたら引き直すまで
      落ちる**。
    */
    const [線] = 当たる('.roam-line')
    const 既定 = Number(/steps\((\d+)\)/.exec(線.body)?.[1])
    expect(既定).toBeGreaterThan(0)

    const 塊 = /@keyframes\s+roam-drift\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    // 停留点ごとの塊へ割って、そこに上書きの段数があれば拾う（無ければ既定）
    const 区切り = 塊.split(/^\s*[\d.]+%\s*\{/gm).slice(1)
    expect(区切り).toHaveLength(ROAM_STOPS)
    const 段たち = 区切り
      .slice(0, ROAM_STOPS - 1)
      .map((塊) => Number(/steps\((\d+)\)/.exec(塊)?.[1] ?? 既定))

    const 道のり = roamSpans()
    const 速さ = 道のり.reduce((和, x) => 和 + x, 0) / (ROAM_LIFE_MS / 1000)
    for (const [i, 段] of 段たち.entries()) {
      expect(段).toBe(Math.max(1, Math.round((12 * 道のり[i]) / 速さ)))
    }

    const コマ = 段たち.reduce((和, x) => 和 + x, 0) / (ROAM_LIFE_MS / 1000)
    expect(コマ).toBeGreaterThan(10)
    expect(コマ).toBeLessThan(15)
  })

  it('尺取り虫を scale で作る', () => {
    // **`width` で作ると版組をやり直させる**（設計§9-0）。上の白リストが
    // `width` を弾くので二重に守られるが、**「作ってある」ことは別に見る**
    // ——キーフレームごと消しても白リストは通ってしまう
    const 生 = /@keyframes\s+roam-birth\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    expect(生).toContain('scale: 0 1')
  })

  it('ひらひらは停留点の数から切り離してある', () => {
    /*
      **前の版はひらひらの谷を停留点の中間へ置いており、% が `ROAM_STOPS` に紐づいて
      いた**（設計§9-7-9）。停留点が 32→61 に増え、さらに % が弧長比例になったので、
      同じ書き方だと**61ブロックへ膨らみ、しかも「区間の中間」の意味が失われる**。

      ひらひらは道のりではなく**時間**の話なので、自分の周期を持たせてある。
      **停留点の数へ紐づけ直すと、ここが落ちる。**
    */
    const 翻 = /@keyframes\s+roam-flutter\s*\{[\s\S]*?\n\}/.exec(素のCSS())?.[0] ?? ''
    expect(翻).toContain('scale: 1 0.65')
    // 谷は1つだけ。停留点ぶん刻んであれば、ここが桁で増える
    expect([...翻.matchAll(/scale:/g)]).toHaveLength(3)
    // **後ろが勝つ。** 生まれの間だけ尺取り虫が翻りを上書きする
    const [紙] = 当たる('.roam-paper')
    expect(紙.body).toContain('animation-name: roam-flutter, roam-birth')
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
