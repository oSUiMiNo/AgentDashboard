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
 */
function copyWithExecCommand(value: string): boolean {
  // **jsdom はこれを持っていない。** 確かめる形にしておけば、無い環境は
  // 「写せなかった」として素直に扱える（呼んで例外にすると、テストが
  // 「環境に無い」で落ちて、判定の話と区別が付かなくなる）
  if (typeof document.execCommand !== 'function') {
    return false
  }

  // 選ぶためにフォーカスを奪うので、押す前に居た場所を覚えておく
  const before = document.activeElement
  const box = document.createElement('textarea')
  box.value = value
  // **`readOnly` を付ける。** 付けないとスマホでキーボードが立ち上がる——
  // 写すだけなのに画面が跳ねる
  box.readOnly = true
  // **`display:none` にしない。** 隠れた要素は選べず、古い方法は「選ばれている
  // もの」を写す口なので、**黙って写せなくなる**。視界の外へ出すだけにとどめる
  box.style.position = 'fixed'
  box.style.top = '0'
  box.style.left = '-9999px'
  document.body.appendChild(box)

  try {
    box.focus()
    box.select()
    box.setSelectionRange(0, value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // **失敗した経路でも必ず外す。** 残ると押すたびに増える
    box.remove()
    if (before instanceof HTMLElement) {
      // 押す前に触っていた場所へ返す。返さないと、キーボードで操作していた人の
      // 居場所が消える
      before.focus()
    }
  }
}
