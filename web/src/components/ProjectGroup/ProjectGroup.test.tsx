import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { ProjectGroup } from './ProjectGroup'
import type { SessionMeta } from '@/lib/protocol'
import { applySessionSnapshot, clearSessions } from '@/stores/sessions'
import { clearSelection, getSelection, toggleSelect } from '@/stores/selection'

/**
 * クリックの作り分け（テスト計画フェーズ5「クリック挙動」の単体側）。
 *
 * 同じ箱の中に「余白＝全員を横並び」「小窓＝1つだけ」という2つの意味を持たせているので、
 * 小窓のクリックが親へ伝わらないこと（stopPropagation）が仕様の要になる。
 * ブラウザでの確認は Playwright が担当する。
 */

const NOW = 1_700_000_000_000
const PROJECT = '/home/example/dev/app'

/** 指で触る端末の見分け方（`lib/pointer.ts` と同じ文字列）。 */
const COARSE = '(pointer: coarse) and (hover: none)'

/**
 * 指の画面を作る。**`matches` は getter にする**——プロパティで持たせると
 * `matchMedia()` を呼んだ瞬間の値で固まる。`InputDock.test.tsx` から写した。
 */
function 指の画面にする() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === COARSE
    },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => {
  clearSessions()
  clearSelection()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearSelection()
  clearSessions()
})

function meta(cardId: string): SessionMeta {
  return {
    card_id: cardId,
    project: PROJECT,
    claude_session_id: null,
    resumed_from: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    session_title: null,
    position: 0,
    nickname: null,
    branched_from: null,
    context_usage: null,
  }
}

/** いまのURLを画面に出すだけの部品。遷移先の確認に使う。 */
function ShowLocation() {
  const location = useLocation()
  return <p data-testid="current-path">{location.pathname}</p>
}

function renderGroup(sessions: SessionMeta[], projectId?: string) {
  applySessionSnapshot(sessions)
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ShowLocation />
      <Routes>
        <Route
          path="/"
          element={
            <ProjectGroup
              host="local"
              project={PROJECT}
              projectId={projectId}
              cards={sessions.map((session) => session.card_id)}
            />
          }
        />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProjectGroup', () => {
  it('PJT の名前とセッション数が出る。フルパスは説明に残る', () => {
    /*
      **フォルダ名だけにした**（細かい修正 要件14・設計§4-3）。PJT 専用画面と同じ
      `projectDisplayName` を通すので、**同じ PJT が画面によって違う名前で出ることがない**。

      **フルパスは `title` に残す。** 完全に捨てると、名前だけではどの枠か分からない
      場合が残る（同名が衝突したときだけ番号が付く作りなので、番号の無い名前は一意でない）。
    */
    renderGroup([meta('a'), meta('b')])

    const 見出し = screen.getByRole('heading', { level: 2 })
    expect(見出し).toHaveTextContent('app')
    expect(見出し.textContent).not.toContain('/home/example')
    expect(見出し).toHaveAttribute('title', PROJECT)
    expect(screen.getByText('2セッション')).toBeInTheDocument()
    expect(screen.getAllByTestId('session-tile')).toHaveLength(2)
  })

  it('余白をダブルクリックするとプロジェクトの画面へ移る', async () => {
    // **落ちたから直したのではなく、仕様が変わったので書き換えた**（設計§10-1）。
    // PC はシングルで「選ぶ」、ダブルで「開く」になった（§4-1）——掴む操作と
    // 開く操作が同じ押し方だと、並べ替えようとして開いてしまうため
    renderGroup([meta('a')])

    await userEvent.dblClick(screen.getByTestId('project-group'))
    // 鍵に PC が入る（設計§16）。パスだけでは別の PC の同名 PJT を指し分けられない
    expect(screen.getByTestId('current-path')).toHaveTextContent(
      `/p/local/${encodeURIComponent(PROJECT)}`,
    )
  })

  it('余白をシングルクリックしても開かない', async () => {
    // **開かないことを、開くことと同じだけ確かめる。** ここが緩むと、
    // 並べ替えている最中に画面が飛ぶ
    renderGroup([meta('a')])

    await userEvent.click(screen.getByTestId('project-group'))
    expect(screen.getByTestId('current-path')).not.toHaveTextContent('/p/')
  })

  it('小窓をダブルクリックしたときは余白のクリックにならない', async () => {
    renderGroup([meta('a')])

    await userEvent.dblClick(screen.getByTestId('session-tile'))
    expect(screen.getByTestId('current-path')).toHaveTextContent('/s/a')
  })

  it('カードから逆算した箱には「×」を出さない', () => {
    // 消す対象を持たないので、押せるボタンにしない（設計§13）。そちらは
    // カードが全部無くなれば自然に消える
    renderGroup([meta('a')])

    expect(screen.queryByTestId('project-remove')).toBeNull()
  })

  it('追加した枠には「×」が出て、セッションが居ると押せない', () => {
    // 走っている作業を巻き添えにしない。**押せない理由も画面に出す**（設計§13）
    renderGroup([meta('a')], 'p1')

    const remove = screen.getByTestId('project-remove')
    expect(remove).toBeDisabled()
    expect(remove).toHaveAttribute('title', expect.stringContaining('セッションが動いている'))
  })

  it('カードにも枠にも、掴み手は出さない', () => {
    /*
      **本体をそのまま掴む**（利用者の指定・2026-09-03）。「セッションの上に掴み手が
      あるのはいいが、カードと PJT枠はハンドルではなく余白やカードそのものを
      ドラッグすれば動くようにしてほしい」。

      **区画（`SessionView`）の掴み手は残る**——あちらは別の検査が見ている。
    */
    renderGroup([meta('a')], 'p1')

    expect(screen.queryByTestId('reorder-handle')).toBeNull()
  })

  it('中のボタンは、押しても掴まない', () => {
    /*
      本体で掴めるようにすると、**中のボタンを押しただけでも掴んでしまう**。
      `click` を止めるだけでは足りない——`pointerdown` は別に止める必要がある。
    */
    renderGroup([meta('a')], 'p1')

    expect(screen.getByTestId('project-remove')).toHaveAttribute('data-no-grab')
  })

  it('選ばれた枠は、地と枠線と左端の帯で分かる', async () => {
    /*
      **枠は選んでも見た目が何も変わっていなかった**（利用者の指摘 2026-09-03）。
      `data-selected` は出しているのに、それを読む className も CSS も無かった。

      枠は**状態の色を1つも持たない**ので、カードより自由に使える。
      §27.3 の候補から3つ当てる——背景・枠線の色・左端の帯。
    */
    renderGroup([meta('a')], 'p1')

    await userEvent.click(screen.getByTestId('project-group'))
    const 枠 = screen.getByTestId('project-group')
    expect(枠).toHaveAttribute('data-selected', 'true')
    expect(枠.className).toContain('bg-select-field')
    expect(枠.className).toContain('border-select')
    expect(枠.className).toMatch(/shadow-\[inset_3px/)
  })

  it('選択と Hover のクラスは、同時に出ない', async () => {
    /*
      **これは「Hover が選択を消す」事故の再発防止である。**

      Tailwind では `hover:bg-muted/20`（詳細度 0,2,0）が `bg-select-field`（0,1,0）に
      **必ず勝つ**ので、両方が並んだ瞬間に**乗せた間だけ選択の色が消える**。
      三項で排他にしてあることを、字で固定する。
    */
    renderGroup([meta('a')], 'p1')
    const 枠 = screen.getByTestId('project-group')

    expect(枠.className).toContain('hover:bg-muted/20')
    expect(枠.className).not.toContain('bg-select-field')

    await userEvent.click(枠)

    expect(枠.className).not.toContain('hover:bg-muted/20')
    expect(枠.className).toContain('hover:bg-select-field-hover')
  })

  it('指でカードを長押しすると、選ばれるのはカードで、枠ではない', () => {
    /*
      **カードの押しが枠まで届いていた。**

      `onClick` は `tile-body` で止めていたが、**`pointerdown` はどこも止めていない**。
      指で長押しすると、カードの 400ms タイマーと枠の 400ms タイマーが同時に走り、
      カードが先に選ばれた直後に枠が上書きする（`stores/selection.ts` の
      「種類が違えば選び直す」）。**結果、掴もうとしたカードではなく枠が選ばれる。**

      本体をドラッグで掴めるようにすると、同じ経路で**枠まで一緒に掴んでしまう**ので、
      先にここを塞ぐ。
    */
    指の画面にする()
    vi.useFakeTimers()
    renderGroup([meta('a')], 'p1')

    fireEvent.pointerDown(screen.getByTestId('session-tile'), {
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
  })

  it('何も選んでいなければ、枠のタップで開く', async () => {
    // **遷移が消えるのは選択中だけ。** ここが緩むと、直したつもりで枠を開けなくしてしまう
    指の画面にする()
    renderGroup([meta('a')], 'p1')

    await userEvent.click(screen.getByTestId('project-group'))

    expect(screen.getByTestId('current-path')).toHaveTextContent('/p/')
  })

  it('カードを選んでいる間は、枠をタップしても遷移せず選択だけが解ける', async () => {
    /*
      **利用者の申告そのもの**（2026-09-07）——「選択解除しようと思ってカード以外の
      ところをタップしたら、そこが PJT 枠だったので PJT 画面へ遷移してしまう」。

      `README.md` は抜ける道を「一覧の地を押すか Esc」と書いているが、**一覧の大半は
      枠で埋まっている**ので狙って外すのが難しい。**外し損ねたときの代償**（画面ごと
      失う）のほうが、外れたときの代償（選択が解ける）より大きいので、こちらへ倒した。

      **却下された「別の種類も選ぶ」案とは別物。** あちらは枠が選ばれてしまうが、
      ここでは何も選ばれない。
    */
    指の画面にする()
    renderGroup([meta('a')], 'p1')
    act(() => toggleSelect('card', 'a'))

    await userEvent.click(screen.getByTestId('project-group'))

    expect(screen.getByTestId('current-path')).not.toHaveTextContent('/p/')
    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })

  it('解いたあと、もう一度タップすれば開く', async () => {
    // 猶予は置かない（決めたこと3）。置くと今度は「押したのに開かない」が生まれる
    指の画面にする()
    renderGroup([meta('a')], 'p1')
    act(() => toggleSelect('card', 'a'))

    await userEvent.click(screen.getByTestId('project-group'))
    await userEvent.click(screen.getByTestId('project-group'))

    expect(screen.getByTestId('current-path')).toHaveTextContent('/p/')
  })

  it('記録を持たない枠も、何も選んでいなければタップで開く', async () => {
    /*
      **開く道が残っていることを、解ける道と対で見る。** `usePress.onClick` は
      `single === 'open'` の分岐が `!selectable → return` より**上**にあるおかげで
      ここへ届いている。順序が入れ替わると記録を持たない枠が丸ごと死んだ領域に
      なるが、純関数のテストも「選択中は解ける」テストもそれを捕まえない。
    */
    指の画面にする()
    renderGroup([meta('a')])

    await userEvent.click(screen.getByTestId('project-group'))

    expect(screen.getByTestId('current-path')).toHaveTextContent('/p/')
  })

  it('記録を持たない枠も、選択中は解けるだけ', async () => {
    /*
      **選べる枠と選べない枠は、画面上で見分けが付かない。** 以前はこちらだけ
      「選択モード中でもタップで開く」にしていた（死んだ領域を作らないため）が、
      **同じに見えるものがあるときは飛び、あるときは飛ばない**ほうが悪い。
      「解くだけ」は死んだ領域ではない——帯が消え、もう一度押せば開く（決めたこと1）。
    */
    指の画面にする()
    renderGroup([meta('a')])
    act(() => toggleSelect('card', 'a'))

    await userEvent.click(screen.getByTestId('project-group'))

    expect(screen.getByTestId('current-path')).not.toHaveTextContent('/p/')
    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })

  it('選ばれているカードを長押しして掴んでも、選択は外れない', () => {
    // 直す前は `toggleSelect` で外れ、**色が消えた的を運ぶ**ことになっていた
    指の画面にする()
    vi.useFakeTimers()
    renderGroup([meta('a')], 'p1')
    act(() => toggleSelect('card', 'a'))

    fireEvent.pointerDown(screen.getByTestId('session-tile'), {
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(getSelection()).toEqual({ kind: 'card', ids: ['a'] })
  })

  it('枠はキーボードで到達でき、Space で選び、Enter で開く', async () => {
    // **直す前は `<section>` に Tab が止まらず、キーボードでは枠を選べなかった**（設計§15-6）
    renderGroup([], 'p1')

    await userEvent.tab()
    expect(screen.getByTestId('project-group')).toHaveFocus()
    await userEvent.keyboard(' ')
    expect(getSelection()).toEqual({ kind: 'project', ids: ['p1'] })
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('current-path')).toHaveTextContent('/p/')
  })

  it('記録を持たない枠は、長押ししても選ばれない', () => {
    /*
      **コメントは「選べない」と書いてあるのに、選べていた。** `usePress` へ
      空文字の ID を渡しているだけで、選択を抑える分岐がどこにも無かった。
      空文字で選ばれても消す相手が見つからないので、**押しても何も起きない**
      ——壊れているのと見分けが付かない。
    */
    指の画面にする()
    vi.useFakeTimers()
    renderGroup([meta('a')])

    fireEvent.pointerDown(screen.getByTestId('project-group'), {
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(getSelection()).toEqual({ kind: null, ids: [] })
  })

  it('セッションが0本なら「×」が押せる', () => {
    renderGroup([], 'p1')

    expect(screen.getByTestId('project-remove')).toBeEnabled()
    // 0本のときは、次に何をすればよいかを出す
    expect(screen.getByText(/「\+」で起こせます/)).toBeInTheDocument()
  })
})

/**
 * 中クリック／Ctrl＋クリックで新しいタブに開く
 * （イシュー `カードと枠を、中クリックで新しいタブに開く` テスト計画フェーズ3）。
 *
 * **枠はリンクにできない**——`<section>` の中にカード・＋・× という押せるものが入って
 * いるため。だからカードと同じく自前で受ける。ここで見たいのは
 * **カードを押したときに枠まで開かないこと**である。
 */
describe('ProjectGroup の中クリック', () => {
  // **`window.open` の差し替えを、テストごとに戻す**（積み上がると「呼ばれていない」が落ちる）
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 中クリックを撃つ。`fireEvent.auxClick` は無いので素の `MouseEvent` を投げる */
  function 中クリック(element: Element, button = 1): boolean {
    return fireEvent(
      element,
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button }),
    )
  }

  it('枠の余白を中クリックすると、PJT 専用画面を新しいタブに開く', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    中クリック(screen.getByTestId('project-group'))

    expect(open).toHaveBeenCalledWith(
      `/p/local/${encodeURIComponent(PROJECT)}`,
      '_blank',
      'noopener',
    )
  })

  it('Ctrl＋左クリックでも、同じ行き先を新しいタブに開く', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    fireEvent.click(screen.getByTestId('project-group'), { button: 0, ctrlKey: true })

    expect(open).toHaveBeenCalledWith(
      `/p/local/${encodeURIComponent(PROJECT)}`,
      '_blank',
      'noopener',
    )
  })

  it('**枠の中のカードを中クリックすると、カードの行き先だけが開く**——枠は開かない', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    中クリック(screen.getByTestId('session-tile'))

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('/s/a', '_blank', 'noopener')
  })

  it('**「×」を中クリックしても開かない**——あれは別の意味を持つ', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([], 'pid-1')

    中クリック(screen.getByTestId('project-remove'))

    expect(open).not.toHaveBeenCalled()
  })

  it('**記録を持たない枠でも開く**——選べないだけで、行き先は在る', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')])

    中クリック(screen.getByTestId('project-group'))

    expect(open).toHaveBeenCalledWith(
      `/p/local/${encodeURIComponent(PROJECT)}`,
      '_blank',
      'noopener',
    )
  })

  it('**中クリックしても、いまのタブは遷移しない**', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    中クリック(screen.getByTestId('project-group'))

    expect(screen.getByTestId('current-path')).toHaveTextContent('/')
    expect(screen.getByTestId('current-path')).not.toHaveTextContent('/p/')
  })

  it('**中クリックしても、選択が変わらない**', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    中クリック(screen.getByTestId('project-group'))

    expect(getSelection().ids).toEqual([])
  })

  it('**カードの中の操作（鉛筆・ゴミ箱・電源）を中クリックしても、何も開かない**', () => {
    /*
      **ここが本物の受け皿。** 操作の群はカード本体の兄弟なので、カード単独では
      合図がどのハンドラにも届かず、テストが素通りする。枠の中に置いて初めて
      「枠まで泡立って PJT が開く」を止めているかを確かめられる。
    */
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    中クリック(screen.getByTestId('tile-ops'))

    expect(open).not.toHaveBeenCalled()
  })

  it('**名前の編集欄では、中クリックの既定を止めない**——Linux の貼り付けを殺さないため', () => {
    renderGroup([meta('a')], 'pid-1')
    fireEvent.click(screen.getByTestId('nickname-edit'))
    const 欄 = screen.getByTestId('nickname-input')

    // 既定が残っている（＝`preventDefault()` していない）
    expect(fireEvent.mouseDown(欄, { button: 1 })).toBe(true)
  })

  it('**Ctrl＋Enter で枠を新しいタブに開く。** カードと同じキーで同じ結果になる', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    fireEvent.keyDown(screen.getByTestId('project-group'), { key: 'Enter', ctrlKey: true })

    expect(open).toHaveBeenCalledWith(
      `/p/local/${encodeURIComponent(PROJECT)}`,
      '_blank',
      'noopener',
    )
    expect(screen.getByTestId('current-path')).toHaveTextContent('/')
  })

  it('素の Enter は今までどおり、いまのタブで開く', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderGroup([meta('a')], 'pid-1')

    fireEvent.keyDown(screen.getByTestId('project-group'), { key: 'Enter' })

    expect(open).not.toHaveBeenCalled()
    expect(screen.getByTestId('current-path')).toHaveTextContent('/p/')
  })

  it('中ボタンの mousedown で、ブラウザの自動スクロールを止める', () => {
    renderGroup([meta('a')], 'pid-1')

    expect(fireEvent.mouseDown(screen.getByTestId('project-group'), { button: 1 })).toBe(
      false,
    )
  })
})
