import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from './clipboard'

/**
 * **毎回、両方とも消してから始める。**
 *
 * 後片付けを `afterEach` に任せると、消し忘れた1本が後続のテストへ漏れて
 * 「置いたつもりの環境」と違うものを測ることになる。jsdom はどちらも本来
 * 持っていないので、消した状態こそが素の姿である。
 */
beforeEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard
  delete (document as { execCommand?: unknown }).execCommand
})

/** 新しい方法を置く。`writeText` の中身は呼ぶ側が決める */
function 新しい方法(writeText: (text: string) => Promise<void>) {
  const spy = vi.fn(writeText)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: spy },
  })
  return spy
}

/**
 * 古い方法を置く。**同期関数で書く**——`async` にすると戻り値が Promise（＝常に
 * truthy）になり、`false` を返す場合を書いたつもりで通ってしまう。
 */
function 古い方法(copy: () => boolean) {
  const spy = vi.fn(copy)
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: spy,
  })
  return spy
}

describe('クリップボードへ写す手', () => {
  it('新しい方法が在って成功すれば、写せる', async () => {
    const writeText = 新しい方法(async () => undefined)

    await expect(copyToClipboard('MyDocs/')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('MyDocs/')
  })

  it('新しい方法が失敗したとき、古い方法へ落ちない（設計§3の要）', async () => {
    // **ここが設計の中心。** 落ちる形にすると、古い方法が要求する「押した合図」が
    // `await` を跨いだあとも生きているかに結果が左右され、**同じコードが同じ
    // ブラウザで動いたり動かなかったりする**。拾えたかもしれないものは、
    // 呼ぶ側の逃げ道が受ける
    新しい方法(async () => {
      throw new Error('拒まれました')
    })
    const execCommand = 古い方法(() => true)

    await expect(copyToClipboard('MyDocs/')).resolves.toBe(false)
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('新しい方法が無ければ、古い方法で写せる', async () => {
    const execCommand = 古い方法(() => true)

    await expect(copyToClipboard('MyDocs/計画.md')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('古い方法が「写せなかった」と答えたら、写せていない', async () => {
    古い方法(() => false)

    await expect(copyToClipboard('MyDocs/')).resolves.toBe(false)
  })

  it('古い方法が例外を投げても、落ちずに「写せなかった」を返す', async () => {
    古い方法(() => {
      throw new Error('この場所では使えません')
    })

    await expect(copyToClipboard('MyDocs/')).resolves.toBe(false)
  })

  it('どちらも無ければ、写せなかったと答える', async () => {
    // jsdom の素の状態がこれ。**安全でないオリジンで開いたスマホと同じ形**
    await expect(copyToClipboard('MyDocs/')).resolves.toBe(false)
  })

  it('写す値がそのまま渡る（フォルダの末尾の `/` を落とさない）', async () => {
    // **写す瞬間に、選ばれている要素へ何が入っているか**を見る
    const 写した: string[] = []
    古い方法(() => {
      写した.push(document.querySelector('textarea')?.value ?? '')
      return true
    })

    await copyToClipboard('MyDocs/server/')

    expect(写した).toEqual(['MyDocs/server/'])
  })

  describe('後片付け', () => {
    // **成功しても失敗しても、一時的な要素を残さない。** 残ると押すたびに増える
    it.each([
      ['写せたとき', () => true],
      ['写せなかったとき', () => false],
      [
        '例外が出たとき',
        () => {
          throw new Error('だめ')
        },
      ],
    ])('%s、一時的な要素が残らない', async (_名, ふるまい) => {
      古い方法(ふるまい as () => boolean)

      await copyToClipboard('MyDocs/')

      expect(document.querySelectorAll('textarea')).toHaveLength(0)
    })

    it('古い方法そのものが無い環境では、要素を作りもしない', async () => {
      await copyToClipboard('MyDocs/')

      expect(document.querySelectorAll('textarea')).toHaveLength(0)
    })

    it('押す前に触っていた場所へ、フォーカスを返す', async () => {
      古い方法(() => true)
      const 押した相手 = document.createElement('button')
      document.body.appendChild(押した相手)
      押した相手.focus()

      await copyToClipboard('MyDocs/')

      expect(document.activeElement).toBe(押した相手)
      押した相手.remove()
    })
  })
})
