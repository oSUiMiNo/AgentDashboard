/**
 * まだ読まれていない追加メッセージが履歴に出るところ
 * （作業中に送った追加メッセージ テスト計画フェーズ4・フェーズ6）。
 *
 * # なぜ描画まで通して見るのか
 *
 * 種別を1つ足すと腕を書く場所が5つあるが、**型検査が落ちるのは2つだけ**
 * （`heading` / `summary`）。`showsHeading` / `showsBodyAlways` / `RowBody` は
 * 真偽値か `default` 付きの switch なので、**腕を書き忘れても黙って通る**。
 * だから関数を個別に呼ぶのではなく**出てきた画面**を見る（画像の行と同じ理由）。
 *
 * # 消えることが要件の半分である
 *
 * 単一ノードを消す経路は経路上のどこにも無いので、読まれた待ちは
 * **`taken` を立てて行から落とす**（設計§4）。ここが効かないと、読まれたあとに
 * **同じ本文が2つ並ぶ**——このイシューがいちばん避けたい形になる。
 *
 * # 見え方は 2026-09-05 に作り直した
 *
 * 「琥珀のラベル＋`…`＋先頭1行」という**見出しのある行**をやめ、**利用者の発言と
 * 同じ吹き出し**にした（設計§7）。ここのテストが見るものも、それに合わせて逆向きに
 * 書き直してある——**「待機中」が出ないこと**と**吹き出しであること**が要件になった。
 *
 * # 「出ない」と「まだ出ていない」を取り違えない
 *
 * ストアは `requestAnimationFrame` の周期でまとめて反映する。**rAF を潰して同期に
 * しようとしてはいけない**——仮想化の末尾追従（`TranscriptTree.tsx`）も rAF を使って
 * いるので、部品ごと壊れる（実際に一度そうした）。**無いことを言う前に、必ず
 * 出るものを1つ待つ。**
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TreeNode } from '@/lib/protocol'
import { TranscriptTree } from './TranscriptTree'
import { appendNodes, clearAllTranscripts } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'

const CARD = '11111111-2222-3333-4444-555555555555'

function 待ち(text: string, taken = false, id = 'queue:s1:0'): TreeNode {
  return {
    id,
    parent: null,
    node: { kind: 'queued_message', text, taken },
    ts: 0,
    branch: 0,
  }
}

function 発言(text: string, id = 'u1'): TreeNode {
  return {
    id,
    parent: null,
    node: { kind: 'user_message', text },
    ts: 1,
    branch: 0,
  }
}

function 応答(text: string, id = 'a1'): TreeNode {
  return {
    id,
    parent: null,
    node: { kind: 'assistant_text', text },
    ts: 2,
    branch: 0,
  }
}

beforeEach(() => {
  clearAllTranscripts()
  useWsStore.setState({ subscribeTranscript: () => () => {} } as never)
})

afterEach(() => {
  clearAllTranscripts()
})

function 置く(...nodes: TreeNode[]) {
  appendNodes(CARD, nodes)
  render(<TranscriptTree cardId={CARD} />)
}

const 行 = () =>
  Array.from(document.querySelectorAll('[data-testid="transcript-row"]')) as HTMLElement[]
const 待ちの行 = () =>
  Array.from(
    document.querySelectorAll('[data-testid="transcript-row"][data-kind="queued_message"]'),
  ) as HTMLElement[]
const 種別の並び = () => 行().map((el) => el.getAttribute('data-kind'))

describe('待機中の吹き出し（要件1-1・1-4）', () => {
  it('利用者の発言と同じ吹き出しで出る', async () => {
    置く(待ち('イシューの設計を進めて'))
    await waitFor(() => expect(待ちの行()).toHaveLength(1))
    const 吹き出し = 待ちの行()[0].querySelector('[data-testid="user-bubble"]')
    expect(吹き出し, '吹き出しの器に入っていない').not.toBeNull()
    // 形も幅もしっぽも、読まれた発言とまったく同じものを使う。
    // **`classList` で見る**——`className` の部分一致だと `speech-bubble-queued` が
    // `speech-bubble` を含んでしまい、**器を外しても緑のまま**になる
    expect(吹き出し!.classList.contains('speech-bubble')).toBe(true)
    expect(吹き出し!.classList.contains('max-w-[70%]')).toBe(true)
    // 待ちであることは**地の色だけ**で言う。その色を当てるクラスが載っていること
    expect(吹き出し!.classList.contains('speech-bubble-queued')).toBe(true)
    expect(吹き出し!.getAttribute('data-queued')).toBe('true')
  })

  it('読まれた発言の吹き出しには、待ちの印が付かない', async () => {
    // 同じ器を使う以上、**見分ける印が片方にしか付かないこと**が要件の半分になる
    置く(発言('もう読まれた'))
    const 吹き出し = await screen.findByTestId('user-bubble')
    expect(吹き出し.classList.contains('speech-bubble')).toBe(true)
    expect(吹き出し.classList.contains('speech-bubble-queued')).toBe(false)
    expect(吹き出し.getAttribute('data-queued')).toBeNull()
  })

  it('「待機中」の語も `…` の記号も出さない（要件1-4）', async () => {
    // **状態は色で伝える。** 語を出すと、吹き出しの中に見出しが同居して器が2つに見える
    置く(待ち('イシューの設計を進めて'))
    await waitFor(() => expect(待ちの行()).toHaveLength(1))
    expect(screen.queryByText('待機中')).toBeNull()
    expect(screen.queryByTestId('tool-status')).toBeNull()
    expect(待ちの行()[0].textContent).not.toContain('…')
  })

  it('開け閉めの記号を持たない', async () => {
    // 本文を常に全部出すので、**記号を押しても出るものが1つも無い**。
    // 押せる顔をしていて何も起きないものは、壊れているのと見分けが付かない
    置く(待ち('1行目の指示\n2行目'))
    await waitFor(() => expect(待ちの行()).toHaveLength(1))
    expect(待ちの行()[0].getAttribute('data-expandable')).toBe('false')
  })
})

describe('畳み方は、利用者の発言とまったく同じ（要件1-2）', () => {
  it('本文は常に全部出る（先頭1行で切らない）', async () => {
    置く(待ち('1行目の指示\n2行目も出る'))
    await waitFor(() => expect(待ちの行()).toHaveLength(1))
    const 中身 = 待ちの行()[0].textContent ?? ''
    expect(中身).toContain('1行目の指示')
    expect(中身).toContain('2行目も出る')
  })

  it('長い本文は畳んで「続きを読む」を出す', async () => {
    // **60行は吹き出しのしきい値（50＋猶予5）を超え、アシスタントのしきい値（75）は
    // 超えない。** ここが緑になることが、`foldLinesFor` で待ちを吹き出し側へ入れた証拠
    // ——アシスタント側のしきい値を使っていると、この本文は畳まれない
    const 長い = Array.from({ length: 60 }, (_, i) => `行${i}`).join('\n')
    置く(待ち(長い))
    await waitFor(() => expect(待ちの行()).toHaveLength(1))
    expect(待ちの行()[0].getAttribute('data-foldable')).toBe('true')
    const 帯 = 待ちの行()[0].querySelector('[data-testid="body-toggle"]')
    expect(帯?.textContent).toBe('続きを読む')
  })

  it('短い本文は畳まない（利用者の発言と同じ判断になる）', async () => {
    // 同じ本文を、待ちと読まれた発言の両方で出して**同じ答えになる**ことを見る。
    // どちらか片方だけにしきい値を書くと、ここで割れる
    const 短い = Array.from({ length: 40 }, (_, i) => `行${i}`).join('\n')
    置く(待ち(短い, false, 'q0'), 発言(短い, 'u0'))
    await waitFor(() => expect(行()).toHaveLength(2))
    const 待ちの畳み = 待ちの行()[0].getAttribute('data-foldable')
    const 発言の畳み = document
      .querySelector('[data-testid="transcript-row"][data-kind="user_message"]')
      ?.getAttribute('data-foldable')
    expect(待ちの畳み).toBe('false')
    expect(待ちの畳み).toBe(発言の畳み)
  })
})

describe('地の色は、青から作る（要件1-3）', () => {
  // jsdom はカスケードも `oklch(from ...)` も解決しないので、見られるのは
  // **そう書いてあること**まで。実際の見え方は E2E と実機の目で確かめる
  const 読む = (name: string) => readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
  const 素 = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '')
  const INDEX = 素(読む('index.css'))
  const 規則 = /\.speech-bubble\.speech-bubble-queued \{([\s\S]*?)\n\}/.exec(INDEX)

  it('待機中の地は、吹き出しの青から導出している', () => {
    expect(規則, '待機中の規則が見つからない').not.toBeNull()
    expect(規則![1]).toContain('--bubble-ground:')
    expect(規則![1]).toContain('var(--bubble-blue)')
  })

  it('別の色を持ち込んでいない', () => {
    // 色の値（`#rrggbb` ／ `rgb()` ／ 色名）を書いた時点で、青を動かしても付いてこなくなる
    expect(規則![1]).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(規則![1]).not.toMatch(/\brgba?\(/)
    expect(規則![1]).not.toMatch(/\b(white|black|gray|grey|silver)\b/)
  })

  it('青の実体は、いまも1箇所にしかない', () => {
    // 「地の色は1箇所で持つ」（本体としっぽで別々に書くと必ずずれる）。
    // 派生を足したことで2箇所になっていないことを数で見る
    expect(INDEX.match(/#173e76/gi) ?? []).toHaveLength(1)
    expect(INDEX).toContain('--bubble-blue: #173e76;')
  })

  it('器の中の面も、同じ派生に乗る', () => {
    // 囲みコード・表・引用は `--bubble-ground` から作ってあるので、
    // **派生元を差し替える形にしてある限り**待機中でも自動で付いてくる
    expect(INDEX).toContain('.speech-bubble .prose-dashboard code')
    expect(INDEX).toMatch(
      /\.speech-bubble \.prose-dashboard code \{\s*background: color-mix\(in oklch, var\(--bubble-ground\)/,
    )
  })

  it('特異度で並ばず、2クラスで上書きしている', () => {
    // 同じ (0,1,0) だと「あとに書いたほうが勝つ」に頼ることになり、
    // 規則を並べ替えた人が黙って壊せる
    expect(INDEX).toContain('.speech-bubble.speech-bubble-queued')
  })
})

describe('待機中は、常にいちばん下（要件1-5）', () => {
  it('あとから来たエージェントの発言が、待機中の上へ割り込む', async () => {
    置く(待ち('あとで直して', false, 'q0'), 応答('いま別のことをしています'))
    await waitFor(() => expect(行()).toHaveLength(2))
    expect(種別の並び()).toEqual(['assistant_text', 'queued_message'])
  })

  it('待機中どうしは、送った順のまま', async () => {
    置く(
      待ち('1つめ', false, 'q0'),
      応答('割り込み'),
      待ち('2つめ', false, 'q1'),
      待ち('3つめ', false, 'q2'),
    )
    await waitFor(() => expect(行()).toHaveLength(4))
    expect(種別の並び()).toEqual([
      'assistant_text',
      'queued_message',
      'queued_message',
      'queued_message',
    ])
    expect(待ちの行().map((el) => el.textContent)).toEqual([
      expect.stringContaining('1つめ'),
      expect.stringContaining('2つめ'),
      expect.stringContaining('3つめ'),
    ])
  })
})

describe('読まれたら消える（要件1-6）', () => {
  it('taken が立つと行にならない', async () => {
    // **目印を一緒に置く。** 無いことを言う前に、出るものを1つ待たないと
    // 「落とせた」と「まだ描かれていない」を取り違える
    置く(待ち('もう読まれた', true), 発言('目印'))
    await screen.findByText('目印')
    expect(待ちの行()).toHaveLength(0)
  })

  it('待ちと本物が同じ一括反映で来ても、同じ本文が2つ並ばない', async () => {
    // パーサは合図(a)（同じ本文の発言が出た）で、**同じバッチの中で**畳む（設計§4-1）。
    // 落とす判断が効いていないと、ここで2つ並ぶ
    置く(待ち('イシューの設計を進めて', true), 発言('イシューの設計を進めて'))
    await screen.findByText('イシューの設計を進めて')
    expect(screen.getAllByText('イシューの設計を進めて')).toHaveLength(1)
    expect(待ちの行()).toHaveLength(0)
  })

  it('畳んだ待ちが混ざっても、巻き戻しの見出しが出ない', async () => {
    // 落とす位置を間違えると、**中身の無い「巻き戻し」の見出し**が出る
    置く(待ち('もう読まれた', true), 発言('目印'))
    await screen.findByText('目印')
    expect(screen.queryByTestId('rewound-toggle')).toBeNull()
  })

  it('3件待って1件だけ読まれても、残りは最下部・読まれたぶんは自然な位置', async () => {
    // **利用者が名指しした壊れ方。** 追加メッセージは複数回に分けて送られることがあり、
    // そのうち1件だけが読まれる状態が普通に起きる。
    //
    // - 読まれた1件は**青い吹き出し**になって自然な位置へ出る
    // - 残り2件は**灰色寄りのまま最下部**に居続ける
    // - 順序は入れ替わらない
    置く(待ち('A', false, 'q0'), 待ち('B', false, 'q1'), 待ち('C', false, 'q2'))
    await waitFor(() => expect(待ちの行()).toHaveLength(3))

    // 「A」が読まれた——待ちは畳まれ、本物の発言とエージェントの応答が届く
    appendNodes(CARD, [応答('了解しました'), 待ち('A', true, 'q0'), 発言('A', 'u0')])
    await waitFor(() => expect(行()).toHaveLength(4))

    expect(種別の並び()).toEqual([
      'assistant_text',
      'user_message',
      'queued_message',
      'queued_message',
    ])
    // 読まれた1件は、待ちの印を持たない青い吹き出しに戻っている
    const 読まれた = document.querySelector(
      '[data-testid="transcript-row"][data-kind="user_message"] [data-testid="user-bubble"]',
    )
    expect(読まれた?.getAttribute('data-queued')).toBeNull()
    // 残り2件は、送った順のまま待ちの印を保っている
    expect(待ちの行().map((el) => el.textContent)).toEqual([
      expect.stringContaining('B'),
      expect.stringContaining('C'),
    ])
    for (const 枠 of 待ちの行()) {
      expect(
        枠.querySelector('[data-testid="user-bubble"]')?.getAttribute('data-queued'),
      ).toBe('true')
    }
  })
})

describe('続いたときは数で言う（要件1-7）', () => {
  // **実測ではほとんど出ない**（待ち行列の深さは9割方1）。これは模型が破綻したときに
  // 画面が埋まるのを止める歯止めで、普段の見え方を決めるものではない（設計§7-3 の天井）
  const 待ちを = (n: number) =>
    Array.from({ length: n }, (_, i) => 待ち(`指示${i}`, false, `queue:s1:${i}`))

  it('3件までは全部出る（床：ゼロにしない）', async () => {
    置く(...待ちを(3))
    await waitFor(() => expect(待ちの行()).toHaveLength(3))
    expect(document.querySelector('[data-kind="queued-more"]')).toBeNull()
  })

  it('4件以上は3行と「ほか N 件」になる', async () => {
    置く(...待ちを(5))
    await waitFor(() => expect(待ちの行()).toHaveLength(3))
    const 残り = document.querySelector('[data-kind="queued-more"]')
    expect(残り).not.toBeNull()
    expect(残り?.getAttribute('data-count')).toBe('2')
    expect(screen.getByText(/ほか 2 件/)).toBeTruthy()
  })

  it('束ねの行も、待ちの塊と一緒に最下部へ回る', async () => {
    // **上の行だけ末尾へ動かすと、「ほか N 件」が届いた順の位置に取り残される**
    置く(...待ちを(5), 応答('割り込み'))
    await waitFor(() => expect(待ちの行()).toHaveLength(3))
    expect(種別の並び()).toEqual([
      'assistant_text',
      'queued_message',
      'queued_message',
      'queued_message',
      'queued-more',
    ])
  })

  it('畳んだものは数に入らない', async () => {
    // 読まれたものは並びから落ちているので、束ねの数にも入らない
    置く(待ち('済1', true, 'queue:s1:0'), 待ち('済2', true, 'queue:s1:1'), ...待ちを(2))
    await waitFor(() => expect(待ちの行()).toHaveLength(2))
    expect(document.querySelector('[data-kind="queued-more"]')).toBeNull()
  })
})
