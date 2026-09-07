/**
 * クリップボードへ写す手。**呼ぶ側は「写せたか」だけを受け取る**（設計§4）。
 *
 * # なぜ非推奨の `document.execCommand` を使うのか
 *
 * 要件が「入れるなら理由をコードに書き残すこと」と定めているので、3点を残す。
 *
 * 1. **代わりが存在しない。** `navigator.clipboard` は**安全なオリジン**（HTTPS ／
 *    `localhost`）にしか無い。素の HTTP で別ホストを開いた場合、あれは `undefined`
 *    であって「失敗する」のではなく**そもそも居ない**。この道具はスマホから
 *    `http://<LAN の IP>:8787` で使うことを正式に案内している（`docs/setup/local.md`）
 *    ので、**その構成でコピーを成立させる手段は他に無い**
 * 2. **MDN は「もはやどのブラウザでも動く保証も、利用できる保証も無い」と書いている。**
 *    だから[`copyToClipboard`] が偽を返したときの**逃げ道（値を画面に出して選ばせる）を
 *    呼ぶ側が必ず持つ**——それが無いと、消えた日に手詰まりへ戻る
 * 3. **消えてもいきなり壊れない。** 逃げ道がある限り、症状は「押せば入る」から
 *    「選んで取る」へ落ちるだけである
 *
 * # 見せ方を持たない
 *
 * 文言も、どこへ出すかも持たない。**置かれ方が違う2箇所**（一覧の行と、ファイルの画面）
 * から呼ばれるためで、見せ方まで揃えると行が壊れる（設計§5）。
 */

/**
 * 値をクリップボードへ写し、**写せたかどうかを返す**。
 *
 * **例外を投げない。** 投げる形にすると呼ぶ側が `try/catch` を書くことになり、
 * いま解消しようとしている「写しが2箇所にある」状態がまた生まれる。
 *
 * # 分かれ道は `await` の前に、同期で1回だけ（設計§3）
 *
 * `async` 関数は**最初の `await` に達するまで同期実行される**。したがって
 * `navigator.clipboard` が無い枝は、**`await` を1度も跨がずに**
 * [`copyWithExecCommand`] へ着く——押した合図はまだ生きている。
 *
 * **「新しい方法が失敗したら古い方法へ落とす」形にしてはいけない。** 古い方法は
 * 「利用者が押した合図がまだ生きていること」を要求するが、**`await` を跨いだあとに
 * 合図が生きているかはブラウザ任せで保証されていない**。採ると、同じコードが同じ
 * ブラウザで動いたり動かなかったりする——**環境にも時間にも依存する差が主経路に入る。**
 *
 * 手放すのは「安全なオリジンなのに新しい方法が失敗した場面」で古い方法なら拾えた
 * かもしれないものだけで、そこは呼ぶ側の逃げ道が受ける。
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // ここで古い方法へ落とさない（上の注釈）。呼ぶ側の逃げ道が受ける
      return false
    }
  }

  // **ここまで `await` を1つも跨いでいない。** 押した合図はまだ生きている
  return copyWithExecCommand(value)
}

/**
 * 古い方法。**非 async のまま保つ**——`await` が1つも入らないことを、注釈ではなく
 * 関数の形で示すため（入れた瞬間に型が変わるので、レビューで見落とせない）。
 *
 * # 焦点を当てにしない（2026-09-07・利用者の報告から）
 *
 * **かつては隠した `textarea` を `focus()` して `select()` していた。** あれは
 * **焦点を持てる場所から呼ばれることを前提**にしており、**右クリックのメニューの中から
 * 呼ぶと成立しない**——`radix-ui` のメニューは焦点の檻を張っていて、こちらが当てた焦点を
 * **その場で奪い返す**。結果、選択が空のまま `execCommand` へ入っていた。
 *
 * **選択は焦点と別物**なので、`Range` で文書の選択そのものを作れば檻をくぐらずに済む。
 * ついでに `textarea` を焦点する必要が消えたので、スマホでキーボードが立つ心配も無くなった。
 *
 * # 戻り値を信じない
 *
 * **`execCommand('copy')` は、何も選ばれていなくても `true` を返す**（実測）。
 * これを信じたせいで、**写っていないのに「コピーしました」と出る**状態になっていた——
 * 呼ぶ側の逃げ道は「偽が返ったとき」に出る作りなので、**嘘の真は逃げ道ごと潰す**。
 * だから**自分で選べた文字数を数え、0なら偽を返す。**
 */
function copyWithExecCommand(value: string): boolean {
  // **jsdom はこれを持っていない。** 確かめる形にしておけば、無い環境は
  // 「写せなかった」として素直に扱える（呼んで例外にすると、テストが
  // 「環境に無い」で落ちて、判定の話と区別が付かなくなる）
  if (typeof document.execCommand !== 'function') {
    return false
  }

  const selection = window.getSelection()
  if (selection === null) {
    return false
  }

  // 押す前に選んでいたものを覚えておく。写し終えたら返す
  const 元の選択: Range[] = []
  for (let i = 0; i < selection.rangeCount; i += 1) {
    元の選択.push(selection.getRangeAt(i))
  }

  const box = document.createElement('span')
  box.textContent = value
  // **`display:none` にしない。** 隠れた要素は選べず、古い方法は「選ばれている
  // もの」を写す口なので、**黙って写せなくなる**。視界の外へ出すだけにとどめる
  box.style.position = 'fixed'
  box.style.top = '0'
  box.style.left = '-9999px'
  // 改行や続く空白をそのまま写す
  box.style.whiteSpace = 'pre'
  // 上の階層が選択を禁じていても、ここだけは選べるようにする
  box.style.userSelect = 'text'
  document.body.appendChild(box)

  try {
    const range = document.createRange()
    range.selectNodeContents(box)
    selection.removeAllRanges()
    selection.addRange(range)
    // **選べていなければ写らない。** 戻り値は当てにならないので、ここで自分で見る
    if (selection.toString().length === 0) {
      return false
    }
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // **失敗した経路でも必ず外す。** 残ると押すたびに増える
    selection.removeAllRanges()
    box.remove()
    for (const range of 元の選択) {
      try {
        selection.addRange(range)
      } catch {
        // 戻せなければ諦める。写せたかどうかの答えは、ここで変えない
      }
    }
  }
}
