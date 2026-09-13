import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { DELTA_LINE } from '@/lib/railPan'
import { useRailPan } from '@/lib/useRailPan'

/**
 * ホイールをレールの横送りへ渡す配線（テスト計画フェーズ3）。
 *
 * ここで確かめるのは**測る側の振る舞い**——誰から奪い、誰から奪わないか、どの段で
 * 張っているか、既定動作を止めているか、後始末をしているか。
 *
 * **どれだけ送るかは見ない。** あれは `railPan.test.ts` が字で確かめている。
 *
 * ここで確かめられないもの：**端末が実際に横へ動かなくなること**。xterm の内部購読は
 * jsdom には居ないので、二重に動かないことは e2e と実機でしか言えない。
 */

/** 端末に置いたバブル段の購読が見たもの。 */
interface 端末が見たもの {
  /** 呼ばれた回数。**0 なら伝播が断たれている** */
  呼ばれた: number
  /** 最後に見た `defaultPrevented`。**真ならキャプチャ段が先に走っている** */
  既定が止まっていた: boolean | null
}

const 記録: 端末が見たもの = { 呼ばれた: 0, 既定が止まっていた: null }

afterEach(() => {
  記録.呼ばれた = 0
  記録.既定が止まっていた = null
})

/*
  **この器だけは英字で名づける。**

  `oxlint` の `rules-of-hooks` は、フックを呼んでよい相手を**名前の1文字目**で判定する。
  **日本語の名前は大文字始まりになりようがない**ので、`器` と名づけると `make ci` が落ちる
  （`lib/useGrip.test.tsx` に同じ断り書きがある）。
*/
function Harness() {
  const railRef = useRef<HTMLDivElement>(null)
  useRailPan(railRef)
  return (
    <div ref={railRef} data-testid="group-rail">
      <div
        data-testid="terminal"
        onWheel={(event) => {
          記録.呼ばれた += 1
          記録.既定が止まっていた = event.defaultPrevented
        }}
      >
        端末の中身
      </div>
      <pre data-testid="file-raw">生テキスト</pre>
    </div>
  )
}

/** レールを取り出す。`clientWidth` は jsdom では 0 なので、送り量は px 単位で確かめる。 */
function 置く() {
  const { unmount } = render(<Harness />)
  return { rail: screen.getByTestId('group-rail'), unmount }
}

describe('端末の上のホイールを、レールへ渡す', () => {
  it('横へ回すと、レールが動く', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaX: 120 })
    expect(rail.scrollLeft, 'レールが横へ送られる').toBe(120)
  })

  it('**Shift ＋ 縦**でも、レールが動く', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaY: 100, shiftKey: true })
    expect(rail.scrollLeft, 'Shift 経路も横として送る').toBe(100)
  })

  it('行で届いた移動量も、px へ畳んでから送る', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaX: 3, deltaMode: DELTA_LINE })
    expect(rail.scrollLeft, '3行ぶんが px へ畳まれる').toBe(48)
  })

  it('**修飾なしの縦では、レールが動かない**', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaY: 100 })
    expect(rail.scrollLeft, '遡りに残すので横へは送らない').toBe(0)
  })
})

describe('横取りしてよい相手だけを名指ししている', () => {
  it('**生テキストの上では、レールが動かない**', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('file-raw'), { deltaX: 120 })
    expect(rail.scrollLeft, '内側が自分で消費すべきものは奪わない').toBe(0)
  })

  it('レールの余白の上でも、レールが動かない', () => {
    const { rail } = 置く()
    fireEvent.wheel(rail, { deltaX: 120 })
    /*
      **余白はブラウザの既定に任せる。** レール自身が `overflow-x-auto` を持つので、
      横取りしなくてもブラウザが動かす。ここで足すと二重になる
    */
    expect(rail.scrollLeft, '横取りするのは端末の上だけ').toBe(0)
  })
})

describe('どう張っているか', () => {
  it('**キャプチャ段で張っている**（端末の購読より先に走る）', () => {
    置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaX: 120 })
    expect(記録.既定が止まっていた, '内側が見る時点で既に止まっている').toBe(true)
  })

  it('**パッシブでない**（既定動作を止められている）', () => {
    置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaX: 120 })
    /*
      パッシブで張ると `preventDefault()` が黙って無視され、`defaultPrevented` は
      偽のままになる。**端末の箱が自分でも横へ動いて二重になる**
    */
    expect(記録.既定が止まっていた, 'preventDefault が効いている').toBe(true)
  })

  it('**伝播は断っていない**（`stopPropagation` を呼んでいない）', () => {
    置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaX: 120 })
    expect(記録.呼ばれた, '内側の購読はそのまま呼ばれる').toBe(1)
  })

  it('送らなかったときは、既定動作を止めない', () => {
    置く()
    fireEvent.wheel(screen.getByTestId('terminal'), { deltaY: 100 })
    expect(記録.既定が止まっていた, '遡りをブラウザに残す').toBe(false)
  })
})

describe('後始末', () => {
  it('外したあとのホイールでは、レールが動かない', () => {
    const { rail, unmount } = 置く()
    const 端末 = screen.getByTestId('terminal')
    unmount()
    fireEvent.wheel(端末, { deltaX: 120 })
    expect(rail.scrollLeft, '購読が外れている').toBe(0)
  })
})
