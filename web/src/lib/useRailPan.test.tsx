import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { DELTA_LINE } from '@/lib/railPan'
import { NO_GRAB_ATTR } from '@/lib/useGrip'
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
  const rootRef = useRef<HTMLElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  useRailPan(rootRef, railRef)
  return (
    <section ref={rootRef} data-testid="group-view">
      {/*
        **レールの外にあるもの。** ここが効かないという報告から、購読先を
        レールから外枠へ広げた
      */}
      <header data-testid="group-header">
        <h2>PJT の名前</h2>
        {/* **横へ動ける内側**（ファイルのタブ帯に相当）。幅は各試験で細工する */}
        <div data-testid="tab-strip" style={{ overflowX: 'auto' }}>
          タブの帯
        </div>
      </header>
      <div ref={railRef} data-testid="group-rail">
        <div data-testid="session-view">
        <div
          data-testid="terminal"
          onWheel={(event) => {
            記録.呼ばれた += 1
            記録.既定が止まっていた = event.defaultPrevented
          }}
        >
          端末の中身
          {/*
            **xterm が自分で作る隠しの入力欄**（`xterm-helper-textarea`）。
            `isTextEntry` はこれを真と判定するので、**端末を先に見ているかどうか**が
            この要素の上で分かれる
          */}
          <textarea data-testid="xterm-helper" className="xterm-helper-textarea" />
        </div>
        <input data-testid="composer" defaultValue="入力欄" />
        <button type="button" data-testid="control" {...{ [NO_GRAB_ATTR]: '' }}>
          押せるもの
        </button>
      </div>
        <pre data-testid="file-raw">生テキスト</pre>
      </div>
      {/* **レールより下の余白。** 利用者が「効かない」と言ったもう一方 */}
      <div data-testid="below-rail">下の余白</div>
    </section>
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

/**
 * jsdom は幅を全部 0 で返すので、**横へ動ける箱**は自分で作る。
 *
 * `scrollWidth > clientWidth` と `overflow-x` の**両方**が要る——片方だけでは
 * 「溢れていない `auto` の箱」と見分けが付かない。
 */
function 横へ動けるようにする(element: Element): void {
  Object.defineProperty(element, 'scrollWidth', { value: 400, configurable: true })
  Object.defineProperty(element, 'clientWidth', { value: 100, configurable: true })
}

describe('レールの外でも、横ホイールが効く', () => {
  it('**タイトルの帯の上で、レールが動く**', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('group-header'), { deltaX: 120 })
    expect(rail.scrollLeft, '帯はレールの外だが、画面の中である').toBe(120)
  })

  it('**レールより下の余白でも、レールが動く**', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('below-rail'), { deltaX: 120 })
    expect(rail.scrollLeft, '下の余白も画面の中である').toBe(120)
  })

  it('外枠そのものの上でも、レールが動く', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('group-view'), { deltaX: 120 })
    expect(rail.scrollLeft, '祖先を辿り切っても横へ動ける箱が無い').toBe(120)
  })

  it('**修飾なしの縦では動かない**（レールの外でも同じ）', () => {
    const { rail } = 置く()
    fireEvent.wheel(screen.getByTestId('group-header'), { deltaY: 100 })
    expect(rail.scrollLeft, '横だけを渡すのは、どこでも変わらない').toBe(0)
  })
})

describe('横へ動ける内側が居るときは、そちらに譲る', () => {
  it('**タブの帯の上では、レールが動かない**', () => {
    const { rail } = 置く()
    const 帯 = screen.getByTestId('tab-strip')
    横へ動けるようにする(帯)
    fireEvent.wheel(帯, { deltaX: 120 })
    expect(rail.scrollLeft, '自分の中を横へ動かせるものが先').toBe(0)
  })

  it('**溢れていない箱には譲らない**（`overflow-x` だけでは足りない）', () => {
    const { rail } = 置く()
    // `overflow-x: auto` は持つが、溢れていない（jsdom の既定のまま 0 対 0）
    fireEvent.wheel(screen.getByTestId('tab-strip'), { deltaX: 120 })
    expect(rail.scrollLeft, '動けない箱へ譲ると、誰も動かさないまま終わる').toBe(120)
  })

  it('譲るのは、その箱の子孫の上だけ', () => {
    const { rail } = 置く()
    横へ動けるようにする(screen.getByTestId('tab-strip'))
    fireEvent.wheel(screen.getByTestId('below-rail'), { deltaX: 120 })
    expect(rail.scrollLeft, '祖先に居ない箱は関係ない').toBe(120)
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

/** マウスの中ボタン。 */
const 中ボタン = 1

/** 中ドラッグを、掴むところまで進めておく。**送り量は 40px。** */
function 掴んでおく() {
  const { rail } = 置く()
  const 端末 = screen.getByTestId('terminal')
  fireEvent.pointerDown(端末, { pointerId: 1, button: 中ボタン, clientX: 300 })
  fireEvent.pointerMove(端末, { pointerId: 1, clientX: 260 })
  return { rail, 端末 }
}

describe('区画の中の中ドラッグで、レールを送る', () => {
  it('中ドラッグすると、レールが動く', () => {
    const { rail } = 掴んでおく()
    expect(rail.scrollLeft, 'ポインタを左へ40動かすと、中身が右へ40流れる').toBe(40)
  })

  it('**レールの余白では効かない**', () => {
    const { rail } = 置く()
    fireEvent.pointerDown(rail, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(rail, { pointerId: 1, clientX: 260 })
    expect(rail.scrollLeft, '区画の外では掴まない').toBe(0)
  })

  it('**生テキストの上でも効かない**（区画の外だから）', () => {
    const { rail } = 置く()
    const 生テキスト = screen.getByTestId('file-raw')
    fireEvent.pointerDown(生テキスト, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(生テキスト, { pointerId: 1, clientX: 260 })
    expect(rail.scrollLeft, '中身の列はレールの中だが、区画の中ではない').toBe(0)
  })

  it('**入力欄の上では掴まない**', () => {
    const { rail } = 置く()
    const 入力欄 = screen.getByTestId('composer')
    fireEvent.pointerDown(入力欄, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(入力欄, { pointerId: 1, clientX: 260 })
    expect(rail.scrollLeft, 'Linux の中クリック貼り付けを残す').toBe(0)
  })

  it('**押せるものの上では掴まない**', () => {
    const { rail } = 置く()
    const 押せるもの = screen.getByTestId('control')
    fireEvent.pointerDown(押せるもの, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(押せるもの, { pointerId: 1, clientX: 260 })
    expect(rail.scrollLeft, '鉛筆やゴミ箱の上で器の操作を発火させない').toBe(0)
  })

  it('**主ボタンでは掴まない**', () => {
    const { rail } = 置く()
    const 端末 = screen.getByTestId('terminal')
    fireEvent.pointerDown(端末, { pointerId: 1, button: 0, clientX: 300 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 260 })
    expect(rail.scrollLeft, '左ドラッグは文字を選ぶ操作のまま').toBe(0)
  })
})

describe('掴み始めるのは、しきい値に届いてから', () => {
  it('**2px では掴まない**', () => {
    const { rail } = 置く()
    const 端末 = screen.getByTestId('terminal')
    fireEvent.pointerDown(端末, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 298 })
    expect(rail.scrollLeft, 'しきい値に届いていない').toBe(0)
  })

  it('**3px で掴む**（境界の対）', () => {
    const { rail } = 置く()
    const 端末 = screen.getByTestId('terminal')
    fireEvent.pointerDown(端末, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 297 })
    expect(rail.scrollLeft, '届いたら始まる').toBe(3)
  })

  it('**押して離すだけでは、レールが動かない**', () => {
    const { rail } = 置く()
    const 端末 = screen.getByTestId('terminal')
    fireEvent.pointerDown(端末, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerUp(端末, { pointerId: 1, clientX: 300 })
    /*
      **貼り付けのつもりの中クリックが素通りすることの代理。** 貼り付けそのものは
      OS の作法なので、ここでは「こちらが何もしなかった」ことまでしか言えない
    */
    expect(rail.scrollLeft, '動かしていないので掴んでいない').toBe(0)
  })
})

describe('自動スクロールの丸いアイコンを止める', () => {
  it('**区画の中で中ボタンを押すと、既定動作を止める**', () => {
    置く()
    const 止めた = !fireEvent.mouseDown(screen.getByTestId('terminal'), { button: 中ボタン })
    // **丸いアイコンが出ないことを、自動で確かめられる唯一の代理**
    expect(止めた, '押した瞬間に抑止する').toBe(true)
  })

  it('**入力欄の上では止めない**（貼り付けを残す）', () => {
    置く()
    const 止めた = !fireEvent.mouseDown(screen.getByTestId('composer'), { button: 中ボタン })
    expect(止めた, '字を打つところでは OS の作法を優先する').toBe(false)
  })

  it('**端末の中の隠し `<textarea>` の上でも止める**', () => {
    置く()
    const 止めた = !fireEvent.mouseDown(screen.getByTestId('xterm-helper'), { button: 中ボタン })
    /*
      xterm は自分の中に `<textarea>` を作るので、入力欄の判定を先に見ると
      **端末の上だけ抑止が抜ける**。端末を先に見ていることがここで分かる
    */
    expect(止めた, '端末は入力欄より先に見る').toBe(true)
  })

  it('**主ボタンでは止めない**', () => {
    置く()
    const 止めた = !fireEvent.mouseDown(screen.getByTestId('terminal'), { button: 0 })
    expect(止めた, '止めると焦点が動かなくなる').toBe(false)
  })
})

describe('掴んでいる間の見せ方と捕捉', () => {
  it('掴んでいる間だけ、カーソルが `grabbing` になる', () => {
    const { rail } = 置く()
    const 端末 = screen.getByTestId('terminal')
    fireEvent.pointerDown(端末, { pointerId: 1, button: 中ボタン, clientX: 300 })
    expect(rail.style.cursor, '押しただけでは変わらない').toBe('')
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 260 })
    expect(rail.style.cursor, '掴んでいる間は grabbing').toBe('grabbing')
    fireEvent.pointerUp(端末, { pointerId: 1, clientX: 260 })
    expect(rail.style.cursor, '離すと戻る').toBe('')
  })

  it('**捕捉はレール自身に取る**（区画ではない）', () => {
    const { rail } = 置く()
    const 区画要素 = screen.getByTestId('session-view')
    const 取った: string[] = []
    // jsdom では読み取り専用なので、差し替えは `defineProperty` で
    Object.defineProperty(rail, 'setPointerCapture', {
      configurable: true,
      value: () => 取った.push('rail'),
    })
    Object.defineProperty(区画要素, 'setPointerCapture', {
      configurable: true,
      value: () => 取った.push('session-view'),
    })
    const 端末 = screen.getByTestId('terminal')
    fireEvent.pointerDown(端末, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 260 })
    /*
      **区画に取ってはいけない。** 区画は並べ替えで外して差し直される側なので、
      差し直された瞬間に捕捉が落ちて掴みが解ける
    */
    expect(取った, 'レールに取る').toEqual(['rail'])
  })
})

describe('中ドラッグを止める契機は3つ', () => {
  it('`pointerup` で止まる', () => {
    const { rail, 端末 } = 掴んでおく()
    fireEvent.pointerUp(端末, { pointerId: 1, clientX: 260 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 200 })
    expect(rail.scrollLeft, '離したあとは追いかけない').toBe(40)
  })

  it('`pointercancel` で止まる', () => {
    const { rail, 端末 } = 掴んでおく()
    fireEvent.pointerCancel(端末, { pointerId: 1, clientX: 260 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 200 })
    expect(rail.scrollLeft, '中断されたら追いかけない').toBe(40)
  })

  it('`lostpointercapture` で止まる', () => {
    const { rail, 端末 } = 掴んでおく()
    fireEvent.lostPointerCapture(端末, { pointerId: 1, clientX: 260 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 200 })
    expect(rail.scrollLeft, '捕捉を失ったら追いかけない').toBe(40)
  })
})

describe('中ドラッグの後始末', () => {
  it('外したあとの中ドラッグでは、レールが動かない', () => {
    const { rail, unmount } = 置く()
    const 端末 = screen.getByTestId('terminal')
    unmount()
    fireEvent.pointerDown(端末, { pointerId: 1, button: 中ボタン, clientX: 300 })
    fireEvent.pointerMove(端末, { pointerId: 1, clientX: 260 })
    expect(rail.scrollLeft, '購読が外れている').toBe(0)
  })
})
