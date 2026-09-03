/// <reference types="node" />
// `src/` は**ブラウザ向けの型だけ**で検査する（`tsconfig.app.json` の `types` に `node` は
// 入れていない）。入れるとアプリのソースに `fs` を書けてしまうので、緩めずにこのファイル
// だけへ型を足す。**実物の画面を読むのはテストの中だけ**という線を、型でも保つ。
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acceptsTyping,
  isComposerSubmit,
  isSelectionPrompt,
  looksSelecting,
  NEWLINE,
  sequenceFor,
  SUBMIT,
  terminalKeyOverride,
  type EnterKeyState,
  type TerminalKey,
} from './keys'

/**
 * Enter まわりの押し分け。**端末と入力欄で同じ割り当てであること**を両方ここで固定する。
 *
 * Shift+Enter は改行、Ctrl+Enter は送信（利用者の指定）。素の Enter は**画面次第**で、
 * 選択ダイアログが出ていれば確定、そうでなければ改行になる。ここが崩れると
 * **改行したいのに送信される**、あるいは**選択肢を決定できない**という形で出る。
 * どちらも押した本人には原因が分からない。
 */

/** `KeyboardEvent` のうち、読み替えの判断に使う分だけを組み立てる。 */
function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent
}

/** 画面を渡して読み替える。既定は「選択待ちではない画面」。 */
function override(
  overrides: Partial<KeyboardEvent> = {},
  screen = '',
): string | null {
  return terminalKeyOverride(key(overrides), () => screen)
}

/**
 * フェーズ1 で本物の TUI から採った画面（`make capture-screens`）。
 *
 * **作った文字列だけで固めない。** 手で書いた入力だけでテストすると、実装とテストが
 * 同じ思い込みを共有したまま緑になる（PJTガイドライン）。実物を1回通しておけば、
 * 目印が実際の画面に当たることまで固定できる。
 */
function 実物の画面(name: string, 版 = 'v2.1.228', 棚 = 'screens'): string {
  // **`new URL(…, import.meta.url)` は使えない。** Vite がアセットとして解決しようとし、
  // `fixtures/` は `web/` の外なので `Denied ID` で弾かれる。パスを文字列として
  // 組み立てれば、Vite は介入しない
  const ここ = dirname(fileURLToPath(import.meta.url))
  const path = resolve(ここ, '../../../fixtures', 版, 棚, `${name}.txt`)
  return readFileSync(path, 'utf8')
}

/**
 * **狭い相手で採った画面**（45桁×22行。`screens-narrow`）。
 *
 * ここまでの実物はすべて **120桁×40行**で採ってあり、十字ボタンの E2E も
 * `devices['Desktop Chrome']`（1280×720）にタッチを足しただけだった——つまり
 * **判定は広い端末でしか確かめていなかった**。
 *
 * **採ったときは「スマホと同じ狭さ」だった。** その後、端末の桁行を 120×40 に
 * 固定した（`TerminalPane` の `TERMINAL_GRID`）ので、**実機も 120桁で描かれる**——
 * この 45桁は、もう実機の再現ではない。**採り直さないし、この検査も残す**：
 * 「狭い相手でも判定が同じ答えを返す」ことの担保としては、引き続き価値がある。
 *
 * 狭いと何が変わるかは、実際に採ってみるまで分からない。案内文は折り返して割れうるし、
 * フッタは幅が足りないと `+N more` で**切られて Esc の案内ごと消える**（実行ファイルの
 * 解析で確認）。**位置で窓を切る判定にとって、画面の大きさは前提そのもの**である。
 */
function 狭い画面(name: string): string {
  return 実物の画面(name, 'v2.1.232', 'screens-narrow')
}

/** 端末での表示幅。全角（East Asian Wide / Fullwidth）は2桁。 */
function 表示幅(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const 全角 =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += 全角 ? 2 : 1
  }
  return width
}

/**
 * 画面のフィクスチャは、**採取した桁数を保っていなければならない**。
 *
 * 匿名化は利用者名を長い置換先へ替えるので、詰め直さないと**行が伸びる**。実際
 * `screens-narrow/welcome.txt` は **45桁で採ったのに55桁**あった（広いほうも 120 → 130）。
 *
 * **幅を固定するために置いたフィクスチャの、幅が嘘になっている**のがまずい——
 * 折り返しに関わる後退（`joinWrapped` / `visibleLines`）を、ここでは捕まえられなくなる
 * （コードレビュー対応11）。
 */
describe('画面のフィクスチャの幅', () => {
  const 棚 = [
    { 版: 'v2.1.228', 名: 'screens', 桁: 120 },
    { 版: 'v2.1.232', 名: 'screens', 桁: 120 },
    { 版: 'v2.1.232', 名: 'screens-narrow', 桁: 45 },
  ]

  it.each(棚)('$版/$名 は $桁 桁を超えない', ({ 版, 名, 桁 }) => {
    const ここ = dirname(fileURLToPath(import.meta.url))
    const dir = resolve(ここ, '../../../fixtures', 版, 名)
    const 溢れ: string[] = []
    for (const file of readdirSync(dir).filter((n) => n.endsWith('.txt'))) {
      const text = readFileSync(resolve(dir, file), 'utf8')
      text.split('\n').forEach((line, index) => {
        const w = 表示幅(line)
        if (w > 桁) {
          溢れ.push(`${file}:${index + 1} が ${w} 桁`)
        }
      })
    }
    expect(溢れ, '匿名化で行が伸びている').toEqual([])
  })
})

/**
 * 会話の途中の画面を組み立てる。**末尾に入力欄と下の帯が来る**のが本物の形。
 *
 * 誤爆を試すには**位置が要る**——「画面のどこに在るか」で本物と偽物が分かれるので、
 * 1行だけの文字列を渡すと、その行が最終行になってしまい**試したい状況が作れない**
 * （実物の並びは `fixtures/<版>/screens/after-turn.txt` を見た）。
 */
function 会話の画面(...本文: string[]): string {
  const 区切り = '─'.repeat(60)
  return [...本文, '', 区切り, '❯ ', 区切り, '  Haiku 4.5', '  ⏸ manual mode on'].join(
    '\n',
  )
}

/**
 * その行を「最終行から `n` 行前」に置いた画面。**窓の境目を両側から見る**ために使う。
 *
 * `n = 0` なら最終行。片側だけを試すと、窓が在ることも境目の位置も確かめていない
 * ことになる（PJTガイドライン「境界を跨いで一気に進めない」と同じ話）。
 */
function 末尾から(n: number, 行: string): string {
  const 埋め = Array.from({ length: n }, () => '  なにか')
  return ['  上のほう', 行, ...埋め].join('\n')
}

/** 打ちかけの文が入力欄に載っている画面。**送信していない**状態。 */
function 打ちかけの画面(打った文: string): string {
  const 区切り = '─'.repeat(60)
  return ['  なにか作業の跡', '', 区切り, '❯ ' + 打った文, 区切り, '  Haiku 4.5'].join(
    '\n',
  )
}

describe('isSelectionPrompt', () => {
  it('本物の選択ダイアログを選択待ちと判定する', () => {
    // 実測（v2.1.228）で採った3種。ここが落ちたら、TUI の見た目が変わっている
    expect(isSelectionPrompt(実物の画面('trust'))).toBe(true)
    expect(isSelectionPrompt(実物の画面('permission'))).toBe(true)
    expect(isSelectionPrompt(実物の画面('rewind'))).toBe(true)
  })

  it('選択待ちでない本物の画面には反応しない', () => {
    // 否定側。**肯定側と対で置く**——判定が丸ごと動いていなくても、否定だけなら通る
    expect(isSelectionPrompt(実物の画面('welcome'))).toBe(false)
    expect(isSelectionPrompt(実物の画面('after-turn'))).toBe(false)
  })

  it('版が上がっても同じ答えを返す', () => {
    // **判定を単一版の観測に留めない**（設計§16-6）。フェーズ6 で同じ4枚を
    // `v2.1.232` でも採り直し、**目印（末尾の案内文・選択カーソルの字下げ）が
    // 1文字も動いていない**ことを確かめた。ここに置いておけば、次に版が上がって
    // 文言が変わったときに**この行が落ちて教えてくれる**。
    //
    // 版をまたいで置くのは**肯定と否定の両方**にする。肯定だけだと、判定が
    // 「常に true」へ壊れても version 間の比較としては通ってしまう
    expect(isSelectionPrompt(実物の画面('permission', 'v2.1.232'))).toBe(true)
    expect(isSelectionPrompt(実物の画面('rewind', 'v2.1.232'))).toBe(true)
    expect(isSelectionPrompt(実物の画面('welcome', 'v2.1.232'))).toBe(false)
    expect(isSelectionPrompt(実物の画面('after-turn', 'v2.1.232'))).toBe(false)
  })

  it('狭い相手の画面でも同じ答えを返す', () => {
    // **画面の大きさは、位置で窓を切る判定にとって前提そのもの。** それまでの実物は
    // すべて 120桁×40行で採ってあり、十字の E2E も 1280×720 だった——**狭い端末では
    // 一度も確かめていなかった**。実機で「十字が出ない」を踏んだときに、ここを
    // 容疑者から外せるようにしておく
    expect(isSelectionPrompt(狭い画面('permission'))).toBe(true)
    expect(isSelectionPrompt(狭い画面('rewind'))).toBe(true)
    expect(isSelectionPrompt(狭い画面('multi-select'))).toBe(true)
    expect(isSelectionPrompt(狭い画面('welcome'))).toBe(false)
    expect(isSelectionPrompt(狭い画面('after-turn'))).toBe(false)
    // **陰性対照。** 作業中の `esc to interrupt` は、狭くても選択待ちにしてはいけない
    expect(isSelectionPrompt(狭い画面('working'))).toBe(false)
    // 出荷済みの誤爆の実物。狭くても当たってはいけない
    expect(isSelectionPrompt(狭い画面('numbered-echo'))).toBe(false)
  })

  it('番号つきの選択肢があれば選択待ちと判定する', () => {
    // **選択肢は字下げされている。** 実物（`permission` / `trust` は1、`rewind` は2）に
    // 合わせる。字下げ0 の `❯` は入力欄と過去の発言なので、数えると誤爆になる
    expect(isSelectionPrompt('Do you want to?\n ❯ 1. Yes\n   2. No')).toBe(true)
  })

  it('番号を持たないメニューは案内文で拾う', () => {
    // `/rewind` は選択肢に番号を持たない（実測：`❯ (current)`）。形の目印だけでは
    // 取りこぼすので、案内文の目印が要る
    const rewind = '  Rewind\n❯ (current)\n\n  Enter to continue · Esc to cancel'
    expect(rewind).not.toMatch(/\d\./)
    expect(isSelectionPrompt(rewind)).toBe(true)
  })

  it('❯ を含むだけでは選択待ちにしない', () => {
    // 入力欄そのものが `❯ ` で始まり、過去の発言も履歴として `❯ …` で残る（実測）
    expect(isSelectionPrompt('❯ ')).toBe(false)
    expect(isSelectionPrompt('❯ こんにちは')).toBe(false)
    expect(isSelectionPrompt('❯ /exit')).toBe(false)
  })

  it('❯ と番号の間の空白は種類を問わない', () => {
    // 入力欄では NBSP、選択肢では半角空白だった（実測）。どちらでも読めること。
    // **NBSP はエスケープで書く**——生のまま置くと半角空白と見分けが付かず、
    // 「なぜこの2行が別のことを見ているのか」が読めなくなる
    //
    // **字下げは付ける。** 空白の種類を問わないのは**カーソルより後ろ**の話で、
    // カーソルより前の字下げのほうは意味を持つ（字下げ0 ＝ 利用者が打った行）
    expect(isSelectionPrompt(' ❯\u00a01. Yes')).toBe(true)
    expect(isSelectionPrompt(' ❯ 1. Yes')).toBe(true)
    expect(isSelectionPrompt('  ❯   1. Yes')).toBe(true)
  })

  it('案内文は大文字小文字を問わない', () => {
    expect(isSelectionPrompt('Enter to confirm · Esc to cancel')).toBe(true)
    expect(isSelectionPrompt('esc to cancel')).toBe(true)
  })

  it('作業中の esc to interrupt には反応しない', () => {
    // 綴りが違うので当たらない。**当たると打ちかけの文が送信される**側の誤判定になる
    expect(isSelectionPrompt('✻ Churned for 7s (esc to interrupt)')).toBe(false)
  })

  it('空の画面は選択待ちにしない', () => {
    // 購読の直後など、まだ何も描かれていない状態
    expect(isSelectionPrompt('')).toBe(false)
    expect(isSelectionPrompt('\n\n\n')).toBe(false)
  })

  // --- 出荷済みの誤爆（調査レポート §10-3 で実物の関数を動かして再現した） -----------
  //
  // **どれも「利用者が打った文が目印に当たる」形**である。pexpect が20年前から
  // 警告している古典的な誤検知で、当たると**そのセッション中ずっと Enter が送信になる**。

  it('過去の発言が番号で始まっていても選択待ちにしない', () => {
    // 送信済みの発言は `❯ …` として履歴に残る。**選択肢とは字下げで分かれる**
    expect(isSelectionPrompt(会話の画面('❯ 1. まずテストを直して'))).toBe(false)
  })

  it('案内文について尋ねた発言に反応しない', () => {
    // 利用者が `esc to cancel` の意味を聞いただけで、以後ずっと壊れていた
    expect(isSelectionPrompt(会話の画面('❯ esc to cancel ってどういう意味？'))).toBe(
      false,
    )
  })

  it('打ちかけの番号つきの文で確定にしない', () => {
    // **この1件がいちばん重い。** 直っていないと、改行のつもりの Enter で
    // 打ちかけの文がそのまま送信される（取り消せない）
    expect(isSelectionPrompt(打ちかけの画面('1. 手順を書く'))).toBe(false)
  })

  it('打ちかけの文に案内文の語が混ざっていても確定にしない', () => {
    expect(isSelectionPrompt(打ちかけの画面('esc to cancel って何？'))).toBe(false)
  })

  // --- 実物の画面（フェーズ1 で採った3枚） -------------------------------------

  it('複数選択のリストを選択待ちと判定する', () => {
    // `Space to select · Enter to confirm · Esc to reject all`。**番号が無く、
    // `esc to cancel` でもない**ので、いまの目印は2つとも外れる
    expect(isSelectionPrompt(実物の画面('multi-select', 'v2.1.232'))).toBe(true)
  })

  it('作業中の画面には反応しない', () => {
    // 陰性対照。**利用者の発言のエコーが残っている**ので、字下げを見ないと当たる
    expect(isSelectionPrompt(実物の画面('working', 'v2.1.232'))).toBe(false)
  })

  it('番号つきの発言が残った画面には反応しない', () => {
    // `❯ 1. 手順を書いて。…` が字下げ0・末尾から19行目に在る実物
    expect(isSelectionPrompt(実物の画面('numbered-echo', 'v2.1.232'))).toBe(false)
  })

  // --- 位置の窓（**両側から見る**。片側だけだと窓の存在を確かめていない） -------------

  it('案内は最終行から3行以内にあるときだけ当たる', () => {
    expect(isSelectionPrompt(末尾から(0, '  Esc to cancel'))).toBe(true)
    expect(isSelectionPrompt(末尾から(2, '  Esc to cancel'))).toBe(true)
  })

  it('案内が4行以上前にあると当たらない', () => {
    // 過去のダイアログの残骸に反応してキーを送る事故は、サーバ側で実測済み
    expect(isSelectionPrompt(末尾から(3, '  Esc to cancel'))).toBe(false)
    expect(isSelectionPrompt(末尾から(10, '  Esc to cancel'))).toBe(false)
  })

  it('選択カーソルは下から6行以内のときだけ数える', () => {
    expect(isSelectionPrompt(末尾から(5, ' ❯ 1. Yes'))).toBe(true)
    expect(isSelectionPrompt(末尾から(6, ' ❯ 1. Yes'))).toBe(false)
  })

  it('字下げ0 の選択カーソルは数えない', () => {
    // 窓の中に在っても数えない。**これが本物と偽物を分ける唯一の構造情報**
    expect(isSelectionPrompt(末尾から(1, '❯ 1. Yes'))).toBe(false)
    expect(isSelectionPrompt(末尾から(1, ' ❯ 1. Yes'))).toBe(true)
  })

  // --- 語の当て方 -----------------------------------------------------------

  it('Computer Use の press Esc to stop には反応しない', () => {
    expect(isSelectionPrompt('  Running… · press Esc to stop')).toBe(false)
  })

  it('to が無い自動生成のフッタにも当たる', () => {
    // 自動生成のフッタは `<キー名> <説明>` の形で「to」が入らない
    expect(isSelectionPrompt('  Esc cancel · ↑/↓ navigate')).toBe(true)
  })

  it('Esc の綴りは3通りとも当たる', () => {
    expect(isSelectionPrompt('  Esc to cancel')).toBe(true)
    expect(isSelectionPrompt('  esc to cancel')).toBe(true)
    expect(isSelectionPrompt('  ⎋ to cancel')).toBe(true)
  })
})

describe('looksSelecting', () => {
  it('厳しいほうが真なら、緩いほうも必ず真になる', () => {
    // **内包が逆転すると**「Enter は確定になるのに十字ボタンが出ない」という、
    // いちばん説明のつかない状態ができる
    const 画面 = [
      実物の画面('trust'),
      実物の画面('permission'),
      実物の画面('rewind'),
      実物の画面('multi-select', 'v2.1.232'),
      末尾から(0, '  Esc to cancel'),
      末尾から(1, ' ❯ 1. Yes'),
    ]
    for (const one of 画面) {
      expect(isSelectionPrompt(one)).toBe(true)
      expect(looksSelecting(one)).toBe(true)
    }
  })

  it('案内も番号も無く、字下げされたカーソルだけなら緩いほうだけが真', () => {
    // 横幅が足りず `+N more` で案内が切られた画面がこれにあたる
    const 案内が切れた = 末尾から(1, ' ❯ probe-alpha')
    expect(isSelectionPrompt(案内が切れた)).toBe(false)
    expect(looksSelecting(案内が切れた)).toBe(true)
  })

  it('選択待ちでない画面では、緩いほうも偽になる', () => {
    // 緩い側だけを見ていると、**常に真を返す実装でも通る**。否定側を対で置く
    expect(looksSelecting(実物の画面('after-turn'))).toBe(false)
    expect(looksSelecting(実物の画面('welcome'))).toBe(false)
    expect(looksSelecting(実物の画面('working', 'v2.1.232'))).toBe(false)
    expect(looksSelecting(打ちかけの画面('1. 手順を書く'))).toBe(false)
    expect(looksSelecting('')).toBe(false)
  })

  it('狭い相手でも、出す画面と出さない画面が分かれる', () => {
    // **十字ボタンが実際に見ているのはこちら**なので、狭い画面はここでこそ要る。
    // 実機で「十字が出ない」を踏んだとき、判定を容疑者から外せるようにしておく
    expect(looksSelecting(狭い画面('permission'))).toBe(true)
    expect(looksSelecting(狭い画面('rewind'))).toBe(true)
    expect(looksSelecting(狭い画面('multi-select'))).toBe(true)
    expect(looksSelecting(狭い画面('welcome'))).toBe(false)
    expect(looksSelecting(狭い画面('after-turn'))).toBe(false)
    expect(looksSelecting(狭い画面('working'))).toBe(false)
    expect(looksSelecting(狭い画面('numbered-echo'))).toBe(false)
  })
})

/**
 * スマホでソフトキーボードを出してよいか（設計§2・§3）。
 *
 * **倒し方は緩い。** 偽陽性は「余計に出る」＝いまの振る舞いそのもので悪化しないが、
 * 偽陰性は「打ちたいのに打てない」＝逃げ道の無い新しい退行になる。
 */
describe('acceptsTyping', () => {
  /** 罫線に挟まれた入力欄。`線` を差し替えると、罫線の種類を当てられる。 */
  function 入力欄のある画面(あと: string[] = [], 線 = '─'.repeat(60)): string {
    return ['  なにか作業の跡', '', 線, '❯ ', 線, ...あと].join('\n')
  }

  it('入力欄が出ている実物の画面では打てる', () => {
    expect(acceptsTyping(実物の画面('after-turn'))).toBe(true)
    expect(acceptsTyping(実物の画面('welcome'))).toBe(true)
    expect(acceptsTyping(実物の画面('numbered-echo', 'v2.1.232'))).toBe(true)
    expect(acceptsTyping(実物の画面('working', 'v2.1.232'))).toBe(true)
    expect(acceptsTyping(実物の画面('working-long', 'v2.1.232'))).toBe(true)
  })

  it('選択待ちの実物の画面では打てない', () => {
    // **常に真を返す実装でも上のテストは通る。** 否定側を対で置く
    expect(acceptsTyping(実物の画面('permission'))).toBe(false)
    expect(acceptsTyping(実物の画面('rewind'))).toBe(false)
    expect(acceptsTyping(実物の画面('multi-select', 'v2.1.232'))).toBe(false)
  })

  it('版が変わっても同じ答えになる', () => {
    // 1つ前の版でも構造が変わっていないことの担保
    expect(acceptsTyping(実物の画面('trust'))).toBe(false)
    expect(acceptsTyping(実物の画面('permission', 'v2.1.232'))).toBe(false)
    expect(acceptsTyping(実物の画面('after-turn', 'v2.1.232'))).toBe(true)
  })

  it('狭い相手でも同じ答えになる', () => {
    // **罫線の長さで判定していないことの担保。** 実物は 120文字と 45文字（実測）
    expect(acceptsTyping(狭い画面('after-turn'))).toBe(true)
    expect(acceptsTyping(狭い画面('welcome'))).toBe(true)
    expect(acceptsTyping(狭い画面('numbered-echo'))).toBe(true)
    expect(acceptsTyping(狭い画面('working'))).toBe(true)
    expect(acceptsTyping(狭い画面('permission'))).toBe(false)
    expect(acceptsTyping(狭い画面('rewind'))).toBe(false)
    expect(acceptsTyping(狭い画面('multi-select'))).toBe(false)
  })

  it('過去の発言のエコーを、生きている入力欄と取り違えない', () => {
    // **この1本が §3 の要。** 実物の `permission` には、利用者が打った字下げ0の `❯` が
    // 残ったまま選択待ちになっている。字下げだけを見ると、この画面が「打てる」に化ける
    const エコーだけ = ['❯ report.txt を作って', '', ' ❯ 1. Yes', ' Esc to cancel'].join(
      '\n',
    )
    expect(looksSelecting(エコーだけ)).toBe(true)
    expect(acceptsTyping(エコーだけ)).toBe(false)
  })

  it('選択待ちの区切り（`╌`）を罫線に数えない', () => {
    // 実物の `permission` は `╌`（U+254C）で区切る。数えると選択待ちが「打てる」に化ける
    const 区切りが違う = 入力欄のある画面(
      [' ❯ 1. Yes', ' Esc to cancel'],
      '╌'.repeat(60),
    )
    expect(acceptsTyping(区切りが違う)).toBe(false)
  })

  it('罫線が上にしか無ければ、入力欄とみなさない', () => {
    // **枠の下半分が画面から切れている形。** 上だけを見る実装に壊すと、ここが通ってしまう
    const 上だけ = ['  なにか', '─'.repeat(60), '❯ ', ' ❯ 1. Yes', ' Esc to cancel'].join(
      '\n',
    )
    expect(acceptsTyping(上だけ)).toBe(false)
  })

  it('罫線が下にしか無ければ、入力欄とみなさない', () => {
    // 上と対。片側だけ置くと、**もう片方の条件を消しても落ちない**
    const 下だけ = ['  なにか', '❯ ', '─'.repeat(60), ' ❯ 1. Yes', ' Esc to cancel'].join(
      '\n',
    )
    expect(acceptsTyping(下だけ)).toBe(false)
  })

  it('罫線に挟まれていても、字下げされたカーソルなら入力欄ではない', () => {
    // **字下げ0 が入力欄の印**（`isTypedLine`）。ここを緩めると、罫線で区切られた
    // メニューが入力欄に化ける
    const 字下げされている = [
      '  なにか',
      '─'.repeat(60),
      ' ❯ 1. Yes',
      '─'.repeat(60),
      ' Esc to cancel',
    ].join('\n')
    expect(acceptsTyping(字下げされている)).toBe(false)
  })

  it('起動バナーの枠を罫線に数えない', () => {
    // `╭───╮` は罫線だけの行ではない。角の文字が混ざっていれば外れる
    const バナー = ['╭' + '─'.repeat(58) + '╮', '❯ ', '╰' + '─'.repeat(58) + '╯', ' ❯ 1. Yes', ' Esc to cancel'].join('\n')
    expect(acceptsTyping(バナー)).toBe(false)
  })

  it('メニューの残骸と入力欄が同居していたら、打てる側へ倒す', () => {
    // 選択肢から「その他」を選んだ直後がこの形になりうる（§3）。**入力欄が左を勝たせる**。
    // `❯` の後ろは実物では NBSP（U+00A0）なので、半角空白を決め打っていないことも見る
    const 同居 = ['  なにか', '', '─'.repeat(60), '❯ その他の答え', '─'.repeat(60), ' ❯ 1. Yes', ' Esc to cancel'].join('\n')
    expect(looksSelecting(同居)).toBe(true)
    expect(acceptsTyping(同居)).toBe(true)
  })

  it('打ちかけの文が載っていても打てる', () => {
    expect(acceptsTyping(打ちかけの画面('1. 手順を書く'))).toBe(true)
  })

  it('空の画面では打てない', () => {
    // マウント直後の初期フォーカスがここを通る。**安全側へ倒す**
    expect(acceptsTyping('')).toBe(false)
    expect(acceptsTyping('\n\n\n')).toBe(false)
  })
})

describe('terminalKeyOverride', () => {
  it('選択待ちでない画面では Enter は改行として送る', () => {
    // 従来の振る舞い。ここが変わると、複数行の指示が打てなくなる
    expect(override()).toBe(NEWLINE)
    expect(override({}, 実物の画面('after-turn'))).toBe(NEWLINE)
  })

  it('選択待ちの画面では Enter は確定として送る', () => {
    // このイシューの主題
    expect(override({}, 実物の画面('permission'))).toBe(SUBMIT)
    expect(override({}, 実物の画面('trust'))).toBe(SUBMIT)
    expect(override({}, 実物の画面('rewind'))).toBe(SUBMIT)
  })

  it('Shift+Enter は素の Enter と同じ扱いになる', () => {
    // xterm は Shift を見ておらず、素の Enter と**同じ CR** を送る。こちらも `shiftKey` を
    // 判断材料に入れていない（見えないものは効かない）ので、意味は画面で決まる。
    //
    // 選択待ちで確定になるのは害にならない——**あの画面には入力欄が無い**ので、
    // そこで改行したい場面が存在しない
    expect(override({ shiftKey: true })).toBe(NEWLINE)
    expect(override({ shiftKey: true }, 実物の画面('permission'))).toBe(SUBMIT)
  })

  it('Ctrl+Enter は画面によらず送信する', () => {
    // 判定が外れたときの逃げ道。ここを画面に依存させてはいけない
    expect(override({ ctrlKey: true })).toBe(SUBMIT)
    expect(override({ ctrlKey: true }, 実物の画面('permission'))).toBe(SUBMIT)
    // Shift が一緒でも、押し分けているのは Ctrl のほう
    expect(override({ ctrlKey: true, shiftKey: true })).toBe(SUBMIT)
  })

  it('改行は ESC+CR、送信は CR', () => {
    // 本物の `/terminal-setup` が VS Code へ書き込む並びと同じ（バイナリから実測）
    expect(NEWLINE).toBe('\x1b\r')
    expect(SUBMIT).toBe('\r')
  })

  it('Alt や Meta が一緒なら読み替えない', () => {
    // Alt+Enter は端末の作法で既に ESC 前置になる。奪うと二重に前置する
    expect(override({ altKey: true })).toBeNull()
    expect(override({ metaKey: true })).toBeNull()
  })

  it('keydown 以外は読み替えない', () => {
    // 横取りの口は keypress でも呼ばれる。絞らないと二重に送ってしまう
    expect(override({ type: 'keypress' })).toBeNull()
    expect(override({ type: 'keyup' })).toBeNull()
  })

  it('IME の変換中は読み替えない', () => {
    // 変換確定の Enter を改行と取り違えない（Composer が見ているのと同じ理由）
    expect(override({ isComposing: true })).toBeNull()
    expect(override({ isComposing: true, ctrlKey: true })).toBeNull()
  })

  it('Enter 以外のキーは読み替えない', () => {
    expect(override({ key: 'Tab' })).toBeNull()
    expect(override({ key: 'a' })).toBeNull()
  })

  it('画面を読むのは素の Enter のときだけ', () => {
    // 横取りの口は**すべてのキー**で呼ばれる。画面（40行×120桁）を毎打鍵で組み立てると
    // 打つたびに無駄が乗るので、答えが画面によらないときは読ませない
    let 読んだ回数 = 0
    const 数える = () => {
      読んだ回数 += 1
      return ''
    }

    terminalKeyOverride(key({ key: 'a' }), 数える)
    terminalKeyOverride(key({ type: 'keyup' }), 数える)
    terminalKeyOverride(key({ isComposing: true }), 数える)
    terminalKeyOverride(key({ altKey: true }), 数える)
    terminalKeyOverride(key({ ctrlKey: true }), 数える)
    expect(読んだ回数).toBe(0)

    terminalKeyOverride(key(), 数える)
    expect(読んだ回数).toBe(1)
  })
})

/** 入力欄が見る分だけを組み立てる。 */
function composerKey(overrides: Partial<EnterKeyState> = {}): EnterKeyState {
  return {
    key: 'Enter',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...overrides,
  }
}

describe('isComposerSubmit', () => {
  it('Ctrl+Enter だけが送信になる', () => {
    expect(isComposerSubmit(composerKey({ ctrlKey: true }))).toBe(true)
  })

  it('素の Enter は送信しない', () => {
    // 入力欄には「選択して決める」場面が無いので、こちらは画面を見ない。
    // 送信の割り当て（Ctrl+Enter）が端末と揃っていることが要点
    expect(isComposerSubmit(composerKey())).toBe(false)
  })

  it('Shift+Enter は判断材料に入っていない（＝送信になりようがない）', () => {
    // Shift の有無は [`EnterKeyState`] に含めていない。見えないものは効かない
    expect(Object.keys(composerKey())).not.toContain('shiftKey')
    expect(isComposerSubmit(composerKey())).toBe(false)
  })

  it('Alt や Meta が一緒なら送信しない', () => {
    // 端末側が読み替えを避ける組み合わせと揃える。片方だけ通ると意味が画面で変わる
    expect(isComposerSubmit(composerKey({ ctrlKey: true, altKey: true }))).toBe(
      false,
    )
    expect(isComposerSubmit(composerKey({ ctrlKey: true, metaKey: true }))).toBe(
      false,
    )
  })

  it('IME の変換中は送信しない', () => {
    // 変換確定の Enter を送信と取り違えない
    expect(
      isComposerSubmit(composerKey({ ctrlKey: true, isComposing: true })),
    ).toBe(false)
  })

  it('Enter 以外のキーは送信しない', () => {
    expect(isComposerSubmit(composerKey({ key: 'Tab', ctrlKey: true }))).toBe(
      false,
    )
    expect(isComposerSubmit(composerKey({ key: 's', ctrlKey: true }))).toBe(
      false,
    )
  })
})

/**
 * キーをバイト列へ直す（テスト計画フェーズ3「部品」）。
 *
 * **バイト列を知るのはここだけ**という線を、表で固定する。橋も十字ボタンも意味
 * （`TerminalKey`）しか持たないので、ここが正しければ全部が正しい。
 */
describe('sequenceFor', () => {
  const ARROWS: [TerminalKey, string, string][] = [
    ['up', '\x1b[A', '\x1bOA'],
    ['down', '\x1b[B', '\x1bOB'],
    ['right', '\x1b[C', '\x1bOC'],
    ['left', '\x1b[D', '\x1bOD'],
  ]

  it.each(ARROWS)('%s はノーマルで CSI を送る', (key, normal) => {
    expect(sequenceFor(key, false)).toBe(normal)
  })

  it.each(ARROWS)('%s はアプリケーションで SS3 を送る', (key, _normal, app) => {
    expect(sequenceFor(key, true)).toBe(app)
  })

  it('モードを知らないときは CSI 側へ落ちる', () => {
    // `term.modes` が読めない場合。既定はノーマルなので、そちらへ倒す
    expect(sequenceFor('up', undefined)).toBe('\x1b[A')
  })

  it('決定は CR。Ctrl+Enter が送るものと同じ', () => {
    expect(sequenceFor('enter', false)).toBe(SUBMIT)
    // モードで変わらない
    expect(sequenceFor('enter', true)).toBe(SUBMIT)
  })

  it('Esc は 1 バイト', () => {
    expect(sequenceFor('esc', false)).toBe('\x1b')
    expect(sequenceFor('esc', true)).toBe('\x1b')
  })

  it('改行の並びは送らない', () => {
    // `NEWLINE`（ESC + CR）は入力欄の改行のためのもので、キーの表には無い
    for (const key of ['up', 'down', 'left', 'right', 'enter', 'esc'] as const) {
      expect(sequenceFor(key, false)).not.toBe(NEWLINE)
    }
  })
})

describe('送りの案内（実機の /rewind）', () => {
  it('「↑ N more above」だけでも、緩いほうは出す', () => {
    // `/rewind` は番号を持たず、一覧が長いと案内文もカーソルも視界から外れる。
    // 実機ではこれだけが見えている状態になった
    const 送りだけ = ['  Rewind', '  Restore the code…', '  ↑ 33 more above'].join('\n')
    expect(looksSelecting(送りだけ), '緩いほうは出す').toBe(true)
    // **厳しいほうは動かさない**——あちらの偽陽性は打ちかけの文の送信になる
    expect(isSelectionPrompt(送りだけ), '厳しいほうは変えない').toBe(false)
  })

  it('普通の会話では出さない', () => {
    expect(looksSelecting(会話の画面('  33 more とは何ですか'))).toBe(false)
    expect(looksSelecting(会話の画面('  ↑ 上を見て'))).toBe(false)
  })
})
