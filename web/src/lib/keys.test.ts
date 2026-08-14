/// <reference types="node" />
// `src/` は**ブラウザ向けの型だけ**で検査する（`tsconfig.app.json` の `types` に `node` は
// 入れていない）。入れるとアプリのソースに `fs` を書けてしまうので、緩めずにこのファイル
// だけへ型を足す。**実物の画面を読むのはテストの中だけ**という線を、型でも保つ。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isComposerSubmit,
  isSelectionPrompt,
  looksSelecting,
  NEWLINE,
  SUBMIT,
  terminalKeyOverride,
  type EnterKeyState,
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
function 実物の画面(name: string, 版 = 'v2.1.228'): string {
  // **`new URL(…, import.meta.url)` は使えない。** Vite がアセットとして解決しようとし、
  // `fixtures/` は `web/` の外なので `Denied ID` で弾かれる。パスを文字列として
  // 組み立てれば、Vite は介入しない
  const ここ = dirname(fileURLToPath(import.meta.url))
  const path = resolve(ここ, '../../../fixtures', 版, 'screens', `${name}.txt`)
  return readFileSync(path, 'utf8')
}

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
