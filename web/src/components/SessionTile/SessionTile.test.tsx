import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { clearSelection, getSelection } from '@/stores/selection'
import { MemoryRouter, Route, Routes } from 'react-router'
import { SessionTile } from './SessionTile'
import type { SessionMeta, SessionStatus } from '@/lib/protocol'
import {
  statusAccentColor,
  statusGlyph,
  statusInk,
  statusLabel,
} from '@/lib/protocol'
import {
  applySessionSnapshot,
  clearSessions,
  markReviving,
  setCardError,
  upsertSession,
} from '@/stores/sessions'
import {
  ROAM_ACCENT,
  ROAM_DELAY_MAX_MS,
  resetRoam,
  setRoamDice,
  useRoamStore,
} from '@/stores/roam'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'
import { settingsFixture } from '@/test/fixtures'

/**
 * 小窓の表示（テスト計画フェーズ5「小窓」）。
 *
 * 一覧の主役は状態インジケータなので、6つの状態それぞれが区別できること、人の対処が
 * 要る状態が見分けられること、経過時間が出ることを確かめる。
 *
 * 小窓は中身をストアから購読するので、描く前にストアへ置く。経過時間は共有の時計
 * （[`useNow`]）が返す**実時刻**から求まるので、確かめるときは実時刻を起点に置く。
 */

const NOW = 1_700_000_000_000
const CARD = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  clearSessions()
  // **選択はテストをまたいで残る**（画面の一時的な状態なので、店じまいはこちらの仕事）
  clearSelection()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearSessions()
})

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    card_id: CARD,
    project: '/home/example/dev/app',
    claude_session_id: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: NOW,
    last_assistant_message: null,
    created_at: NOW - 60_000,
    hooks_seen: true,
    agent_id: null,
    agent_connected: true,
    account: null,
    toml_account: null,
    session_title: null,
    position: 0,
    nickname: null,
    ...overrides,
  }
}

function renderTile(session: SessionMeta, options: { dragging?: boolean } = {}) {
  applySessionSnapshot([session])
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <SessionTile cardId={session.card_id} dragging={options.dragging} />
          }
        />
        <Route path="/s/:cardId" element={<p>専用画面</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SessionTile', () => {
  it.each<[SessionStatus, string]>([
    [{ kind: 'starting' }, '起動中'],
    [{ kind: 'working' }, '作業中'],
    [{ kind: 'waiting_permission' }, '権限確認待ち'],
    [{ kind: 'waiting_input' }, '入力待ち'],
    [{ kind: 'stalled' }, '停滞'],
    // **どちらも「スリープ」**（設計§6）。終了ボタンで終わらせたカードは一覧から
    // 外れるので、小窓に `ended` として残るのは頼んでいない終わり方をしたものだけ。
    // `ok` の別は記号（`✓` と `✕`）と `title` に残っている
    [{ kind: 'ended', ok: true }, 'スリープ'],
    [{ kind: 'ended', ok: false }, 'スリープ'],
    [{ kind: 'unknown' }, '不明'],
  ])('状態 %o は「%s」と表示される', (status, label) => {
    renderTile(meta({ status }))

    // 文言が1つ以上ある。**停滞は2つ**（走る人のハイコントラスト退避と、止めたとき
    // 出る休みのタグ。フェーズ17）なので、1つに限らない
    expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    expect(screen.getByTestId('session-tile')).toHaveAttribute(
      'data-status',
      status.kind,
    )
  })

  it('状態ごとに輪の色が変わる', () => {
    // ●をやめ、カード全体の枠線で状態を表す（カード設計§8）。色は器の変数に入り、
    // CSS はそれを読むだけ——**対応表を2箇所に分けないため**
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    const working = screen.getByTestId('tile-shell').style.getPropertyValue(
      '--tile-accent',
    )
    expect(working).not.toBe('')
    unmount()

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(
      screen.getByTestId('tile-shell').style.getPropertyValue('--tile-accent'),
    ).not.toBe(working)
  })

  it('繋がっていない印が、中身だけでなく器にも出る', () => {
    // 輪と効果線は中身の**兄弟**なので、中身にだけ印を付けても CSS が届かない
    // （カード設計§7-4-4）。**繋がっていないカードでも枠だけ元の明るさで出ていた**
    const { unmount } = renderTile(meta({ agent_connected: false }))
    expect(screen.getByTestId('tile-shell')).toHaveAttribute(
      'data-connected',
      'false',
    )
    unmount()

    renderTile(meta({ agent_connected: true }))
    expect(screen.getByTestId('tile-shell')).toHaveAttribute(
      'data-connected',
      'true',
    )
  })

  it('人の対処が要る状態は、他と違う動きで出る', () => {
    // 権限確認待ちを見落とすと、セッションがそこで止まったままになる。**唯一
    // 位置を動かしてよい状態**なので、他と同じ見せ方にしない（カード設計§9-6）
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    expect(screen.getByTestId('tile-shell')).toHaveAttribute(
      'data-motion',
      'spin-fast',
    )
    unmount()

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('tile-shell')).toHaveAttribute(
      'data-motion',
      'shake',
    )
  })

  it('終了と異常終了を、印で選び分けられる', () => {
    // `data-status` はどちらも `ended` なので、これだけでは8つの姿を選べない
    // （カード設計§7-2）。**値は変えず、属性を1つ足した**
    const 正常 = renderTile(meta({ status: { kind: 'ended', ok: true } }))
    const tile = screen.getByTestId('session-tile')
    expect(tile).toHaveAttribute('data-status', 'ended')
    expect(tile).toHaveAttribute('data-status-ok', 'true')
    正常.unmount()

    const 異常 = renderTile(meta({ status: { kind: 'ended', ok: false } }))
    expect(screen.getByTestId('session-tile')).toHaveAttribute(
      'data-status-ok',
      'false',
    )
    異常.unmount()

    // 終わっていない状態には出さない（`ok` の概念そのものが無い）
    renderTile(meta({ status: { kind: 'working' } }))
    expect(screen.getByTestId('session-tile')).not.toHaveAttribute(
      'data-status-ok',
    )
  })

  it('経過時間だけが出る。「最終活動」の語は説明に残る', () => {
    // 細かい修正 要件22。**語ごと消すと何の時刻なのか読めなくなる**ので、
    // 画面からは落として、マウスを乗せたときには出す（設計§4-4）
    renderTile(meta({ last_activity_at: Date.now() - 3 * 60_000 }))
    const 経過 = screen.getByTestId('elapsed')
    expect(経過).toHaveTextContent('3分前')
    expect(経過.textContent).not.toContain('最終活動')
    expect(経過).toHaveAttribute('title', '最終活動 3分前')
  })

  it('サブエージェントが動いている間だけバッジが出る', () => {
    const { unmount } = renderTile(meta({ subagent_active: 0 }))
    expect(screen.queryByTestId('subagent-badge')).not.toBeInTheDocument()
    unmount()

    renderTile(meta({ subagent_active: 2 }))
    expect(screen.getByTestId('subagent-badge')).toHaveTextContent(
      'サブエージェント 2',
    )
  })

  it('直前の応答は、常時は出さない', () => {
    // いちばん下はセッション名（カード設計§11）。応答を常に2行取ると、縦が詰まらない。
    // **型からは消していない**——別の場所に出したくなったとき、運ぶ経路から作り直しになる
    renderTile(meta({ last_assistant_message: 'テストが通りました' }))
    expect(screen.queryByTestId('session-echo')).not.toBeInTheDocument()
    expect(screen.queryByTestId('last-message')).not.toBeInTheDocument()
  })

  it('フックが1件も来ていない不明には理由が出る', () => {
    // ただの「不明」では利用者は打つ手が分からない（設計§11）
    const { unmount } = renderTile(
      meta({ status: { kind: 'unknown' }, hooks_seen: false }),
    )
    expect(screen.getByTestId('hook-warning')).toHaveTextContent('フック未受信')
    unmount()

    // フックは届いているのに不明、という別の理由のときは名指ししない
    renderTile(meta({ status: { kind: 'unknown' }, hooks_seen: true }))
    expect(screen.queryByTestId('hook-warning')).not.toBeInTheDocument()
  })

  it('小窓をダブルクリックすると専用画面へ移る', async () => {
    // **落ちたから直したのではなく、仕様が変わったので書き換えた**（設計§10-1）。
    // PC はシングルで「選ぶ」、ダブルで「開く」（§4-1）
    renderTile(meta())
    await userEvent.dblClick(screen.getByTestId('session-tile'))
    expect(screen.getByText('専用画面')).toBeInTheDocument()
  })

  it('小窓をシングルクリックすると、開かずに選ばれる', async () => {
    renderTile(meta())
    await userEvent.click(screen.getByTestId('session-tile'))
    expect(screen.queryByText('専用画面')).toBeNull()
    expect(screen.getByTestId('session-tile')).toHaveAttribute('data-selected', 'true')
  })

  it('ダブルクリックのあと、選んだものは残らない', async () => {
    // **ブラウザは `dblclick` の前に `click` を2回発火する**ので、シングルが
    // 「選ぶ」なら2回で打ち消し合って元へ戻る。**開いたうえに選ばれたまま**に
    // ならないことを、開いた先で見る（小窓そのものは外れている）
    renderTile(meta())
    await userEvent.dblClick(screen.getByTestId('session-tile'))
    expect(screen.getByText('専用画面')).toBeInTheDocument()
    expect(getSelection().ids).toEqual([])
  })
})

/**
 * カードの骨格（カード設計§7）。
 *
 * 層はそれぞれ役割が1つずつで、兼ねさせない。**見た目そのものは捕まらないが、
 * どの層に何が付いているかは捕まる**——そしてそこが崩れると、鎮まりも効果線も
 * フォーカスも一緒に壊れる。
 */
describe('SessionTile の骨格', () => {
  it('器・切る枠・輪・中身・効果線の順に入れ子になっている', () => {
    renderTile(meta({ status: { kind: 'waiting_permission' } }))

    const shell = screen.getByTestId('tile-shell')
    const body = screen.getByTestId('session-tile')
    const lines = screen.getByTestId('tile-lines')
    const frame = body.parentElement
    const ring = frame?.firstElementChild

    expect(frame).toHaveClass('tile-frame')
    expect(shell).toContainElement(frame)
    expect(ring).toHaveClass('tile-ring')
    expect(body).toHaveClass('tile-body')

    // **効果線は切る枠の外。** 中に置くと、いちばん見せたい部分が丸角で切られる
    expect(frame).not.toContainElement(lines)
    expect(shell).toContainElement(lines)
  })

  it('揺れの印は器に出るが、揺れるのは切る枠から内側', () => {
    // 判定の枠（器）が揺れると、鎮めるための的そのものが逃げる。**器は揺れない**
    // ことを CSS 側が守れるよう、印だけを器に出して内側を名指しさせる
    renderTile(meta({ status: { kind: 'waiting_permission' } }))

    expect(screen.getByTestId('tile-shell')).toHaveAttribute(
      'data-motion',
      'shake',
    )
    // 器そのものに動きのクラスを持たせない（CSS が `.tile-frame` を名指しする）
    expect(screen.getByTestId('tile-shell').className).toBe('tile-shell relative')
  })

  it('復旧ボタンは、押しても掴まない', () => {
    /*
      カードは本体をそのまま掴むので、**中のボタンを押しただけでも掴んでしまう**。
      `click` を止めるだけでは `pointerdown` が素通りする。
    */
    renderTile(meta({ status: { kind: 'ended', ok: true } }))

    // **群がまとめて持つ。** `useGrip` は `closest('[data-no-grab]')` で見るので、
    // 中の3つはこれ1枚で覆われる（細かい修正 設計§4-1）
    expect(screen.getByTestId('tile-ops')).toHaveAttribute('data-no-grab')
    expect(screen.getByTestId('power-tile').closest('[data-no-grab]')).not.toBeNull()
  })

  it('選ばれたカードに、印は出さない', async () => {
    /*
      **利用者の指定**（2026-09-03）——「白い点はいらない。選択は背景の色だけで表す」。

      **消したことを検査で残す。** 次に触る人が「選択が分かりにくい」と読んで、
      親切のつもりで点を戻すのを止めるため。戻すなら、まずこの検査を消すことになる。

      もとの点は**復旧ボタンの矩形の内側**に居て、ボタンのほうが後ろの DOM にあるため
      **復旧ボタンが出るカードでは1ピクセルも見えていなかった**。
    */
    renderTile(meta())
    await userEvent.click(screen.getByTestId('session-tile'))

    expect(screen.getByTestId('session-tile')).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(screen.queryByTestId('tile-selected-mark')).toBeNull()
  })

  it('選ばれたカードの地は、className が持たない', async () => {
    /*
      **地は `tile.css` の持ち物。** ここへ書き戻すと、作業中のカードで黙って
      効かなくなる（レイヤ外の規則に勝てない）。**浮きだけはここに残す**
      ——`:active` の 0.98 に負けるのが正しい。
    */
    renderTile(meta())
    await userEvent.click(screen.getByTestId('session-tile'))

    const 中身 = screen.getByTestId('session-tile')
    expect(中身.className).not.toMatch(/\bbg-(primary|select)/)
    expect(中身.className).toContain('scale-[1.01]')
  })

  it('選ばれたことを、見た目以外でも伝える', async () => {
    // 印を外して**合図が 100% 色になった**ので、ここが唯一の非視覚の道になった
    renderTile(meta())
    await userEvent.click(screen.getByTestId('session-tile'))

    expect(screen.getByTestId('session-tile')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('選択の印は、器にも複製される', async () => {
    /*
      切る枠は中身の**親**なので、中身に付けた印では CSS が届かない。
      **色が消える環境で選択を伝えるのは、その枠の線種だけ**である。
    */
    renderTile(meta())
    await userEvent.click(screen.getByTestId('session-tile'))

    expect(screen.getByTestId('tile-shell')).toHaveAttribute(
      'data-selected',
      'true',
    )
  })

  it('掴んでいるカードの倍率と傾きは、CSS だけが持つ', async () => {
    /*
      **クラスで傾けない。** Tailwind の `scale-[1.02]` は個別プロパティ（`scale:`）を
      出すので、`reorder.css` の `scale` と**二重に掛かって 1.0404倍・2度**になっていた
      （設計§15-2）。`transformTemplate` で `transform` を奪い返す形もやめ、`transform` は
      `motion`（入場の `y`）に返す。

      ここで見るのは「クラスに無い」「印が出ている」「`transform` を自分で触っていない」
      まで。実際の倍率と傾きは E2E が計算値で読む（jsdom は CSS を適用しない）。
    */
    renderTile(meta(), { dragging: true })
    const 器 = screen.getByTestId('tile-shell')
    expect(器.className).not.toMatch(/scale-|rotate-/)
    expect(器.dataset.reorderKind).toBe('card')

    // 入場アニメが着くと `motion` が `transform` を自分の値（`none`）へ戻す。
    // **型紙が無いので、こちらの変形は `transform` に混ざらない**
    await waitFor(() => {
      expect(器.style.transform).not.toContain('translateY')
    })
    expect(['', 'none']).toContain(器.style.transform)
  })

  it('効果線は承認待ちのときだけ描く', () => {
    // 常時置くと12枚×6要素になる。近づいた1回だけ走らせるもの（カード設計§9-4）
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    expect(screen.queryByTestId('tile-lines')).not.toBeInTheDocument()
    unmount()

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('tile-lines').children).toHaveLength(6)
  })

  it('ステッカーは権限確認待ちのときだけ貼る', () => {
    // `DESIGN.md` §23.3「ステッカーは例外だから効く」——全行に付くと表の1カラムへ
    // 退化し、貼ってある感じも目を引く力も消える。禁止事項にも「状態ステッカーを
    // 全行に付けて列にする」がある。**数で縛らず、扱いで縛った**（§8.4）
    for (const kind of ['working', 'stalled', 'waiting_input', 'starting'] as const) {
      const { unmount } = renderTile(meta({ status: { kind } }))
      expect(screen.queryByTestId('tile-sticker')).not.toBeInTheDocument()
      unmount()
    }

    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('tile-sticker')).toBeInTheDocument()
  })

  it('状態は右下のタグに出る。①行には残っていない', () => {
    // 要件2-1。**上部に真面目に書く必要は無い**（0.1.41 を実物で見た利用者の指定）。
    // ①行へ戻すとここが落ちる
    // **停滞はここに居ない**（フェーズ17 で走る人になった。下の専用のテストで見る）
    for (const kind of ['waiting_input', 'starting', 'unknown'] as const) {
      const { unmount } = renderTile(meta({ status: { kind } }))
      expect(screen.getByTestId('tile-tag')).toHaveTextContent(statusLabel({ kind }))
      // ①行の先頭に居た記号のスロットは無くなっている
      expect(screen.queryByTestId('status-glyph')).not.toBeInTheDocument()
      unmount()
    }
  })

  it('停滞は走る人とタグの両方を持ち、タグは休みの印を持つ', () => {
    // 設計§22-3。動いている間は走る人、**止めたときはタグへ戻す**。どちらを見せるかは
    // CSS が決める（§9-5-3）ので、ここでは両方が置かれ、印が付いていることを見る。
    // 走る人だけにすると、止めたとき作業中と見分けが濃さだけになる（要件の完了条件を割る）
    renderTile(meta({ status: { kind: 'stalled' } }))
    const 走る人 = screen.getByTestId('tile-run')
    expect(走る人).toHaveClass('tile-run-rest')
    expect(走る人).toHaveAttribute('aria-label', statusLabel({ kind: 'stalled' }))
    const タグ = screen.getByTestId('tile-tag')
    expect(タグ).toHaveClass('tile-tag-rest')
    expect(タグ).toHaveTextContent(statusLabel({ kind: 'stalled' }))
    expect(タグ.querySelector('.tile-glyph')?.textContent).toBe(
      statusGlyph({ kind: 'stalled' }),
    )
    // 読み上げは走る人が担う。同じ状態名を二度読ませない
    expect(タグ).toHaveAttribute('aria-hidden', 'true')
    // ①行から記号が消えたままであること（上のループから停滞を外したぶんの回帰）
    expect(screen.queryByTestId('status-glyph')).not.toBeInTheDocument()
  })

  it('記号はタグの中にある', () => {
    // 要件2-2。**ラベルの直前（①行の先頭）へ戻すと落ちる**
    renderTile(meta({ status: { kind: 'waiting_input' } }))
    const タグ = screen.getByTestId('tile-tag')
    expect(タグ.querySelector('.tile-glyph')?.textContent).toBe(
      statusGlyph({ kind: 'waiting_input' }),
    )
  })

  it('作業中だけタグを持たず、走るアニメーションになる', () => {
    // 要件2-3。**文字も `↻` も出さない**——放っておいてよい状態なので、読ませるより
    // 「動いている」ことだけが伝わればよい
    renderTile(meta({ status: { kind: 'working' } }))
    expect(screen.queryByTestId('tile-tag')).not.toBeInTheDocument()
    // **休みの印は持たない**（据え置き。止めたときは1枚目で静止する。設計§22-3）
    expect(screen.getByTestId('tile-run')).not.toHaveClass('tile-run-rest')

    // 走る人を持たない状態は逆（停滞は両方持つので、ここでは使わない）
    cleanup()
    renderTile(meta({ status: { kind: 'waiting_input' } }))
    expect(screen.getByTestId('tile-tag')).toBeInTheDocument()
    expect(screen.getByTestId('tile-tag')).not.toHaveClass('tile-tag-rest')
    expect(screen.queryByTestId('tile-run')).not.toBeInTheDocument()
  })

  it('権限確認待ちだけ、ANSWER と状態タグが2枚出る', () => {
    // 利用者の判断（2026-08-27）。**ANSWER は状態名ではなく「押して答える」を促す語**
    // なので、状態タグと役割が違うものとして両方出す。重ならないよう1段上へ逃がす
    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('tile-sticker')).toBeInTheDocument()
    expect(screen.getByTestId('tile-tag')).toHaveClass('tile-tag-raised')
  })

  it('ステッカーは切る枠の中に置く', () => {
    // 器（`tile-shell`）の直下だと、**器は行の高さまで伸びる**ので、カードが行内で
    // いちばん高くないときにステッカーだけ下へ取り残される（目視で実測）。
    // 枠は中身ぴったりの高さなので、そこが正しい居場所になる
    renderTile(meta({ status: { kind: 'waiting_permission' } }))

    const frame = screen.getByTestId('session-tile').parentElement
    expect(frame).toHaveClass('tile-frame')
    expect(screen.getByTestId('tile-sticker').parentElement).toBe(frame)
    // 効果線とは逆（あちらは枠の外）。**切る対象と切らない対象を取り違えない**
    expect(screen.getByTestId('tile-lines').parentElement).not.toBe(frame)
  })

  it('切る角の角丸だけを外している', () => {
    // 切りと丸めが同じ角を削り合うと**斜辺が見えない**——14px の切りが 12px の
    // 角丸に埋もれ、白黒にすると特徴が何も残らなかった（`DESIGN.md` §34.5 の判定に
    // 自分で当てて分かった）。残り3つは §10.3 の Panel（10〜14px）のまま
    renderTile(meta())

    const frame = screen.getByTestId('session-tile').parentElement
    expect(frame).toHaveClass('rounded-[0_12px_12px_12px]')
  })

  it('輪と効果線はクリックを通さない', () => {
    // 押す邪魔をしてはいけない。中身のボタンより手前に居るので、素通しでないと届かない
    renderTile(meta({ status: { kind: 'waiting_permission' } }))

    const frame = screen.getByTestId('session-tile').parentElement
    for (const element of [frame?.firstElementChild, screen.getByTestId('tile-lines')]) {
      expect(element).toHaveAttribute('aria-hidden')
    }
  })

  it('中身は button のままで、キーボードから到達できる', async () => {
    // 器を `div` にすると、いま `<button>` だけが担っている Tab / Enter / Space の
    // 到達性を失う（カード設計§7）
    renderTile(meta())

    const body = screen.getByTestId('session-tile')
    expect(body.tagName).toBe('BUTTON')
    await userEvent.tab()
    expect(body).toHaveFocus()
  })

  it('静けさの段を印として出す（賑やかのときは出さない）', () => {
    // **止める分岐は CSS 側に置き、JavaScript へ散らさない**（カード設計§9-5-3）。
    // 既定は属性ごと出さないので、CSS は素の規則をそのまま使える
    const 賑やか = renderTile(meta())
    expect(screen.getByTestId('tile-shell')).not.toHaveAttribute('data-quiet')
    賑やか.unmount()

    useSettingsStore.setState({
      settings: settingsFixture({ motion_quiet: 'still' }),
      loading: false,
    })
    renderTile(meta())
    expect(screen.getByTestId('tile-shell')).toHaveAttribute('data-quiet', 'still')
  })

  it('器も小窓と同じカードIDを名乗る', () => {
    // 復旧ボタンは器の直下に居て、小窓の兄弟ではなくなった。**器から辿れないと、
    // E2E が「0件で通る」空振りに戻る**（`revive.spec.ts` の `reviveButtonOf`）
    renderTile(meta())

    expect(screen.getByTestId('tile-shell')).toHaveAttribute('data-card-id', CARD)
    expect(screen.getByTestId('session-tile')).toHaveAttribute('data-card-id', CARD)
  })
})

/**
 * いちばん下の行（カード設計§11）。
 *
 * `--resume` で呼び戻す相手を見分けるために名前を出す。**名前が無くても行を残す**
 * のが要点で、消すと名前が付いた瞬間に横のカードまで動く。
 */
describe('SessionTile のセッション名', () => {
  it('名前があればそのまま出る', () => {
    renderTile(meta({ session_title: 'TODOを完了に変更し作業内容をまとめる' }))

    const title = screen.getByTestId('session-title')
    expect(title).toHaveTextContent('TODOを完了に変更し作業内容をまとめる')
    expect(title).toHaveAttribute('data-named', 'true')
  })

  it('名前が無いときは、文字を1つも出さない', () => {
    // 名前は最初のターンのあとに付くので、**起こした直後は必ずこの状態を通る**。
    // 「名前はまだありません」と書いても**利用者にできることが1つも無い**ので、
    // 場所だけ残して空けておく（利用者の指定・2026-08-26）
    renderTile(meta({ session_title: null }))

    const title = screen.getByTestId('session-title')
    // 改行しない空白しか入っていない＝目に見える文字は0
    expect(title.textContent?.replace(/[\s\u00a0]/g, '')).toBe('')
    expect(title).toHaveAttribute('data-named', 'false')
  })

  it('名前の有無で行が消えない', () => {
    // 行ごと消すと、名前が付いた瞬間にカードが1行ぶん伸び、**横に並ぶ他のカードまで動く**
    const { unmount } = renderTile(meta({ session_title: null }))
    expect(screen.getByTestId('session-title')).toBeInTheDocument()
    unmount()

    renderTile(meta({ session_title: '名前' }))
    expect(screen.getByTestId('session-title')).toBeInTheDocument()
  })

  it('長い名前は1行に収め、全体はマウスで読ませる', () => {
    // ホバーは補助にとどめる（タッチには存在しない）。全体を読む道はカードを開けばある
    const 長い名前 = 'あ'.repeat(120)
    renderTile(meta({ session_title: 長い名前 }))

    const title = screen.getByTestId('session-title')
    expect(title).toHaveClass('truncate')
    expect(title).toHaveAttribute('title', 長い名前)
  })
})

/**
 * 直前の応答の1行（カード設計§11-2）。
 *
 * 利用時間を予測した唯一の変数は「好奇心」で、カードで好奇心を作っている要素は
 * これ1つだけだった。**やめるのではなく、変わった直後だけ戻す。**
 */
describe('SessionTile の直前の応答', () => {
  beforeEach(() => {
    // **偽装するのは `setTimeout` だけ。** 既定の `useFakeTimers()` は
    // `requestAnimationFrame` も差し替えるが、ストアはカードの更新を rAF で束ねている
    // （`stores/sessions.ts` の `schedule`）ので、丸ごと偽装すると**上の
    // `beforeEach` が置いた rAF の代役ごと消え、`upsertSession` が画面へ届かなくなる**
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('応答が変わった直後だけ、名前の上に1行が出る', () => {
    renderTile(meta({ last_assistant_message: '最初の応答' }))
    // **初回マウントでは出さない**——一覧を開くたびに全カードが4行になる
    expect(screen.queryByTestId('session-echo')).not.toBeInTheDocument()

    act(() => upsertSession(meta({ last_assistant_message: 'テストが通りました' })))
    expect(screen.getByTestId('session-echo')).toHaveTextContent(
      'テストが通りました',
    )
  })

  it('変わっていなければ出直さない', () => {
    renderTile(meta({ last_assistant_message: '同じ応答' }))
    act(() =>
      upsertSession(
        meta({ last_assistant_message: '同じ応答', subagent_active: 1 }),
      ),
    )

    expect(screen.queryByTestId('session-echo')).not.toBeInTheDocument()
  })

  it('しばらくすると行ごと消える', () => {
    renderTile(meta({ last_assistant_message: null }))
    act(() => upsertSession(meta({ last_assistant_message: '出ました' })))
    expect(screen.getByTestId('session-echo')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(12_000)
    })

    // 消えたら普段の姿（名前だけ）へ戻る
    expect(screen.queryByTestId('session-echo')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-title')).toBeInTheDocument()
  })

  it('長い応答は1行に畳む', () => {
    // 改行をそのまま出すと、条件付きの1行が何行にもなる
    renderTile(meta({ last_assistant_message: null }))
    act(() =>
      upsertSession(meta({ last_assistant_message: '1行目\n2行目\n3行目' })),
    )

    const echo = screen.getByTestId('session-echo')
    expect(echo).toHaveTextContent('1行目 2行目 3行目')
    expect(echo).toHaveClass('truncate')
  })

  it('条件付きの行は、対処の必要性が高い順に積む', () => {
    // 警告 → 断り → 応答（カード設計§10-1）。同時に出ることはありうる
    renderTile(
      meta({ status: { kind: 'unknown' }, hooks_seen: false, last_assistant_message: null }),
    )
    act(() => setCardError(CARD, 'この PC が繋がっていません'))
    act(() =>
      upsertSession(
        meta({
          status: { kind: 'unknown' },
          hooks_seen: false,
          last_assistant_message: '応答',
        }),
      ),
    )

    const 並び = ['hook-warning', 'card-error', 'session-echo', 'session-title']
    const 実際 = Array.from(
      screen.getByTestId('session-tile').querySelectorAll('[data-testid]'),
      (element) => element.getAttribute('data-testid'),
    ).filter((testId) => testId !== null && 並び.includes(testId))
    expect(実際).toEqual(並び)
  })
})

describe('SessionTile の権限モード', () => {
  it('モードが分かっていれば小窓にも出る', () => {
    // 要件「各小窓と各セッション画面に表示してほしい」の小窓側
    renderTile(meta({ permission_mode: 'bypassPermissions' }))

    const badge = screen.getByTestId('permission-mode')
    expect(badge).toHaveTextContent('全承認をスキップ')
    expect(badge.dataset.mode).toBe('bypassPermissions')
  })

  it('危険なモードは既定のモードより目立つ', () => {
    // 全承認をスキップしているセッションが並んでいるのに気づかない、を作らない
    renderTile(meta({ permission_mode: 'bypassPermissions' }))
    const danger = screen.getByTestId('permission-mode').className
    cleanup()

    renderTile(meta({ permission_mode: 'default' }))
    const calm = screen.getByTestId('permission-mode').className

    expect(danger).not.toBe(calm)
    expect(danger).toContain('red')
  })

  it('モードが分からないうちは何も出さない', () => {
    // 状態の「不明」と並ぶと、どちらが不明なのか読み取れなくなる
    renderTile(meta({ permission_mode: null }))
    expect(screen.queryByTestId('permission-mode')).not.toBeInTheDocument()
  })
})

describe('SessionTile のモデル', () => {
  it('モデルが分かっていれば小窓にも出る', () => {
    // 要件「切り替えた結果が一覧の小窓にも反映される」の小窓側
    renderTile(meta({ model: 'claude-opus-5', model_label: 'Opus 5' }))

    const badge = screen.getByTestId('model')
    expect(badge).toHaveTextContent('Opus 5')
    expect(badge.dataset.model).toBe('claude-opus-5')
  })

  it('モデルが分からないうちは何も出さない', () => {
    renderTile(meta({ model: null }))
    expect(screen.queryByTestId('model')).not.toBeInTheDocument()
  })

  it('モデルが不明でも権限モードのバッジは出る', () => {
    // モデルは起動から最初の statusLine まで必ず不明で、`inject_status_line = false`
    // の間はずっと不明。片方だけ出る時間は短くない
    renderTile(meta({ model: null, permission_mode: 'default' }))

    expect(screen.getByTestId('permission-mode')).toBeInTheDocument()
    expect(screen.getByTestId('permission-mode').parentElement).toBe(
      screen.getByTestId('tile-badges'),
    )
  })

  it('両方あるときも同じ入れ物に並ぶ', () => {
    // **②行として独立させた**ので、①行の右端へ寄せる指定はもう要らない
    // （カード設計§10-1）
    renderTile(
      meta({
        model: 'claude-opus-5',
        model_label: 'Opus 5',
        permission_mode: 'default',
      }),
    )

    const badges = screen.getByTestId('tile-badges')
    expect(badges).not.toHaveClass('ml-auto')
    expect(badges).toContainElement(screen.getByTestId('model'))
    expect(badges).toContainElement(screen.getByTestId('permission-mode'))
  })

  it('モードのバッジにも幅の上限が付いている', () => {
    // **モデルにだけ上限があってモードには無い、という非対称を無くす**
    // （カード設計§10-2）。押し出された側が切れていたのはこれが原因
    renderTile(
      meta({
        model: 'claude-opus-5',
        model_label: 'Opus 5',
        permission_mode: 'bypassPermissions',
      }),
    )

    for (const testId of ['model', 'permission-mode']) {
      const badge = screen.getByTestId(testId)
      expect(badge).toHaveClass('max-w-28')
      expect(badge).toHaveClass('truncate')
    }
  })

  it('どちらも分からなければ入れ物ごと出さない', () => {
    // 空の要素を残すと、そのぶん余白（gap）が1つ増える
    renderTile(meta({ model: null, permission_mode: null }))
    expect(screen.queryByTestId('tile-badges')).not.toBeInTheDocument()
  })
})

describe('どの PC のセッションかと、その鮮度（セルフホスト化設計§11-2）', () => {
  const PC = '11111111-1111-1111-1111-111111111111'

  it('PC 名を出し、繋がっていなければ印を付ける', () => {
    // **状態そのものは書き換えない。** 「作業中（接続断）」が要件2-3 の充足形で、
    // 最後に知っていた状態を消してしまうと、何をしていたかが分からなくなる
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC, name: '仕事用ノート', last_seen_at: 1, connected: false },
        ],
      }),
      loading: false,
    })
    renderTile(
      meta({ agent_id: PC, agent_connected: false, status: { kind: 'working' } }),
    )

    expect(screen.getByTestId('agent-badge')).toHaveTextContent('仕事用ノート')
    expect(screen.getByTestId('disconnected-badge')).toBeInTheDocument()
    // 状態は最後に知っていたまま
    expect(screen.getByTestId('session-tile').dataset.status).toBe('working')
    expect(screen.getByTestId('session-tile').dataset.connected).toBe('false')
  })

  it('接続断は①行（最終活動と同じ行）に出る', () => {
    // 要件2-6。**②行へ戻すと落ちる。** 設計§10-1-3 は実測で「①行に入らない」と
    // 決めていたが、状態が右下のタグへ抜けたので**要る幅が 290px → 166px になった**
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC, name: '仕事用ノート', last_seen_at: 1, connected: false },
        ],
      }),
      loading: false,
    })
    renderTile(meta({ agent_id: PC, agent_connected: false }))

    const 接続断 = screen.getByTestId('disconnected-badge')
    const 最終活動 = screen.getByTestId('elapsed')
    expect(接続断.parentElement).toBe(最終活動.parentElement)
    // ②行（モデル・モードが並ぶ行）には居ない
    expect(screen.queryByTestId('tile-badges')?.contains(接続断)).not.toBe(true)
  })

  it('繋がっていれば接続断の印は出ない', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC, name: '仕事用ノート', last_seen_at: 1, connected: true },
        ],
      }),
      loading: false,
    })
    renderTile(meta({ agent_id: PC, agent_connected: true }))

    expect(screen.queryByTestId('disconnected-badge')).toBeNull()
  })

  it('toml が名乗った名前を出す', () => {
    // 帰属（`account`）とは別物。**申告として**そのまま出す（設計§8-5）
    renderTile(meta({ toml_account: 'しごと' }))

    expect(screen.getByTestId('toml-account-badge')).toHaveTextContent('@しごと')
  })
})

/**
 * 小窓の復旧ボタン（復旧設計§9-1・§9-4・§9-5）。
 *
 * ここで見るのは3つ——**器を変えていないこと**（キーボードで到達も起動もできる）、
 * **押しても専用画面へ移らないこと**（伝播を止めている）、**押せない理由が読めること**。
 *
 * 器を `div` にすると `<button>` が担っている Tab / Enter / Space の到達性を失う。
 * それを避けるために「包んで兄弟として重ねる」形にしてあるので、**到達性そのものを
 * 1本押さえておく**。
 */
describe('SessionTile の復旧', () => {
  const PC2 = '77777777-7777-7777-7777-777777777777'
  /** 接続断で、呼び戻し先を持っているカード（＝復旧の本命） */
  function stale(overrides: Partial<SessionMeta> = {}): SessionMeta {
    return meta({
      agent_connected: false,
      claude_session_id: '22222222-2222-2222-2222-222222222222',
      ...overrides,
    })
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loading: false })
    useWsStore.setState({ revive: vi.fn() })
  })

  it('実体があるカードには、点灯した電源（＝スリープ）が出る', () => {
    // **止めることと起こすことを1つのボタンで言う**（細かい修正 要件11）。
    // 以前は「実体があるならボタンを出さない」だったが、いまは同じ位置に点いて出る
    renderTile(meta({ agent_connected: true, status: { kind: 'working' } }))
    const 電源 = screen.getByTestId('power-tile')
    expect(電源).toHaveAttribute('data-power', 'on')
    expect(電源).toHaveAttribute('data-action', 'sleep')
    expect(電源).toHaveAttribute('aria-label', 'スリープ')
  })

  it('接続断のカードには押せるボタンが出る', () => {
    renderTile(stale())
    const button = screen.getByTestId('power-tile')
    expect(button).toBeEnabled()
    expect(button.dataset.state).toBe('ready')
  })

  it('終了したカードにも出る', () => {
    renderTile(stale({ agent_connected: true, status: { kind: 'ended', ok: true } }))
    expect(screen.getByTestId('power-tile')).toBeEnabled()
  })

  it('押すと、そのカードを起こし直すよう頼む', async () => {
    const revive = vi.fn()
    useWsStore.setState({ revive })
    renderTile(stale())

    await userEvent.click(screen.getByTestId('power-tile'))

    expect(revive).toHaveBeenCalledWith(CARD)
  })

  it('押しても画面が切り替わらない', async () => {
    /*
      **伝播の相手は器（小窓）ではなく、その外側の枠である。** ボタンは器の「中」では
      なく `relative` の入れ物の中に**兄弟として**置いてあるので（設計§9-1）、器へは
      構造上そもそも届かない。届くのは `ProjectGroup` の `<section>` で、あそこは
      **余白のクリックで PJT 専用画面へ移る**（同じ場所に2つの意味がある）。

      したがって枠の中に置いて確かめる。**小窓を単体で描いて確かめると、止めるのを
      やめても落ちない**——最初にそう書いて空振りした。
    */
    applySessionSnapshot([stale()])
    const onGroupClick = vi.fn()
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              // ProjectGroup の <section>（余白クリックで PJT 専用画面へ）の役
              <section onClick={onGroupClick}>
                <SessionTile cardId={CARD} />
              </section>
            }
          />
          <Route path="/s/:cardId" element={<p>専用画面</p>} />
        </Routes>
      </MemoryRouter>,
    )

    await userEvent.click(screen.getByTestId('power-tile'))

    expect(onGroupClick).not.toHaveBeenCalled()
    expect(screen.queryByText('専用画面')).toBeNull()
  })

  it('小窓はいままでどおりキーボードで到達でき、Enter で開く', async () => {
    // 器を `div` に変えていないことの担保（設計§9-1）
    renderTile(stale())

    await userEvent.tab()
    expect(screen.getByTestId('session-tile')).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    expect(screen.getByText('専用画面')).toBeInTheDocument()
  })

  it('小窓は Space で選ぶだけで、開かない', async () => {
    // **キーボードで帯へ辿り着くため**（並べ替え設計§15-6）。Enter は上のとおり開く
    renderTile(stale())

    await userEvent.tab()
    await userEvent.keyboard(' ')
    expect(screen.getByTestId('session-tile')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('専用画面')).not.toBeInTheDocument()
  })

  it('押せないときも、ボタンは出て理由が読める', () => {
    // 出さないと「なぜこのカードにだけ無いのか」を推測させることになる
    renderTile(stale({ claude_session_id: null }))

    const button = screen.getByTestId('power-tile')
    expect(button).toBeDisabled()
    expect(button.dataset.state).toBe('no-target')
    expect(button).toHaveAttribute('title', '呼び戻す先が記録されていません')
  })

  it('PC が繋がっていなければ、そう言って押させない', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          {
            id: PC2,
            name: '仕事用ノート',
            last_seen_at: 1,
            connected: false,
            supports_revive: true,
          },
        ],
      }),
      loading: false,
    })
    renderTile(stale({ agent_id: PC2 }))

    const button = screen.getByTestId('power-tile')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'この PC が繋がっていません')
  })

  it('名乗らない PC では、版が古いと言う', () => {
    useSettingsStore.setState({
      settings: settingsFixture({
        agents: [
          { id: PC2, name: '仕事用ノート', last_seen_at: 1, connected: true },
        ],
      }),
      loading: false,
    })
    renderTile(stale({ agent_id: PC2 }))

    expect(screen.getByTestId('power-tile')).toHaveAttribute(
      'title',
      'この PC の版が古くて対応していません',
    )
  })

  it('押している間は「復旧中…」になり、二度押せない', async () => {
    // 席が空くまでカードは1バイトも変わらない（設計§9-4）。印が無いと手応えが出ない
    const revive = vi.fn(() => markReviving(CARD))
    useWsStore.setState({ revive })
    renderTile(stale())

    await userEvent.click(screen.getByTestId('power-tile'))

    const button = screen.getByTestId('power-tile')
    // 文字を出す場所が無いので、進んでいることは data 属性と説明が伝える
    expect(button).toHaveAttribute('data-busy', 'true')
    expect(button).toHaveAttribute('title', '起こしています…')
    expect(button).toBeDisabled()
  })

  it('サーバ由来の状態が届いたら、印が消える', () => {
    renderTile(stale())
    act(() => markReviving(CARD))
    expect(screen.getByTestId('power-tile')).toHaveAttribute('data-busy', 'true')

    // 起こし直しが始まると、そのカードの `session_upsert` が流れてくる
    act(() =>
      upsertSession(stale({ status: { kind: 'starting' }, agent_connected: true })),
    )

    // ボタンは消えない（点灯した電源＝スリープへ変わる）。**印だけが消える**
    expect(screen.getByTestId('power-tile')).not.toHaveAttribute('data-busy')
  })

  it('断りはそのカードに出る', () => {
    // 画面全体の帯ではなく名指しの場所へ（設計§9-5）
    renderTile(stale())
    act(() => setCardError(CARD, 'この PC が繋がっていません'))

    expect(screen.getByTestId('card-error')).toHaveTextContent(
      'この PC が繋がっていません',
    )
    // 断られたのに印が残ると、二度と押せないカードになる
    expect(screen.getByTestId('power-tile')).not.toHaveAttribute('data-busy')
  })

  it('印は押したカードだけに立つ', () => {
    // 全体に持つと、6枚を並べたときに一覧が丸ごと描き直される（設計§9-4）
    const other = '33333333-3333-3333-3333-333333333333'
    applySessionSnapshot([stale(), stale({ card_id: other })])
    render(
      <MemoryRouter initialEntries={['/']}>
        <SessionTile cardId={other} />
      </MemoryRouter>,
    )
    act(() => markReviving(CARD))

    // 印は data 属性で持つので、文言の部分一致で空振りする心配がなくなった
    expect(screen.getByTestId('power-tile')).not.toHaveAttribute('data-busy')
  })
})

describe('跳ねるたびに、画面を回遊する線を放つ', () => {
  /**
   * 跳ねの周期が1周した合図。名前を渡せるので、選り分けの検査に使える。
   *
   * **`fireEvent.animationIteration` では届かない。** jsdom に `AnimationEvent` が
   * 無いので React の合成イベントまで通らず、**何を投げても0回しか鳴らない**
   * （＝書いても常に通る空振りのテストになる）。素のイベントを直接投げる。
   */
  function 折り返す(name: string): void {
    const frame = screen.getByTestId('tile-shell').querySelector('.tile-frame')
    expect(frame).not.toBeNull()
    const event = new Event('animationiteration')
    Object.defineProperty(event, 'animationName', { value: name })
    act(() => {
      ;(frame as Element).dispatchEvent(event)
    })
  }

  /**
   * **場ごと描く。** 線は場（`data-roam-field`）に対する座標で飛ぶので、
   * カードだけを描くと `measureField` が場を見つけられず**1本も飛ばない**
   * ——`App.tsx` の形を写しておかないと、ここの4本が全部「飛ばない」で緑になる。
   */
  function 待つカードを描く(): void {
    applySessionSnapshot([meta({ status: { kind: 'waiting_permission' } })])
    render(
      <MemoryRouter initialEntries={['/']}>
        <div data-roam-field>
          <SessionTile cardId={CARD} />
        </div>
      </MemoryRouter>,
    )
  }

  /**
   * 跳ねてから撃たれるまでを進める。
   *
   * **合図と放出は別の時刻になった**（2026-08-28）。`scheduleRoam` が籤で半分見送り、
   * 残りも 1.2〜3.6秒 遅らせて撃つ。**進めないと、この describe の全部が「0本」で
   * 揃ってしまう**——`toHaveLength(0)` を見ている4本は、それでも緑になる。
   */
  function 撃たれるまで進める(): void {
    act(() => {
      vi.advanceTimersByTime(ROAM_DELAY_MAX_MS + 1)
    })
  }

  beforeEach(() => {
    resetRoam()
    // **籤を「必ず出す」側へ固定する。** 固定しないと、`toHaveLength(0)` を見ている
    // 4本が「門が効いた」のか「籤で見送った」のか区別できず、**門が壊れても緑になる**
    setRoamDice(() => 1)
    // **`toFake` を絞る。** 既定の偽装は `requestAnimationFrame` も差し替えるが、
    // ストアはカードの更新を rAF で束ねている。さらに `lib/roam.ts` が控えの寿命に
    // `performance.now()` を使っているので、**丸ごと止めると控えが永久に新鮮になり、
    // 場の測り直しが起きなくなる**
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'lively' },
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRoam()
  })

  it('跳ねの折り返しを合図に、間を置いてから放つ', () => {
    待つカードを描く()
    折り返す('tile-shake')
    // **合図の瞬間には出ていない。** ここで出ていたら、揺れと連動したままである
    expect(useRoamStore.getState().lines).toHaveLength(0)
    撃たれるまで進める()
    expect(useRoamStore.getState().lines.length).toBeGreaterThan(0)
  })

  it('場が無ければ、跳ねても放たない', () => {
    // 一覧の外にカードが置かれたときに、**無い場所へ線を放たない**。
    // 上の1本と対で置く——**「飛ばない」だけを見ていると、場を見つけられなく
    // なった事故を「仕様どおり」と読んでしまう**
    applySessionSnapshot([meta({ status: { kind: 'waiting_permission' } })])
    render(
      <MemoryRouter initialEntries={['/']}>
        <SessionTile cardId={CARD} />
      </MemoryRouter>,
    )
    折り返す('tile-shake')
    撃たれるまで進める()
    expect(useRoamStore.getState().lines).toHaveLength(0)
  })

  it('鎮まっている間は放たない', () => {
    // 近づいている間は既存の短い線（`tile-lines`）の担当。**名前が別物になる**ので、
    // 見分けを落とすとマウスを乗せたまま線が飛び続ける
    待つカードを描く()
    折り返す('tile-shake-calm')
    撃たれるまで進める()
    expect(useRoamStore.getState().lines).toHaveLength(0)
  })

  it('輪の回転では放たない', () => {
    // 弧も呼吸も無限に折り返すので、**名前を見ないと全部の状態で鳴る**
    待つカードを描く()
    折り返す('tile-spin')
    撃たれるまで進める()
    expect(useRoamStore.getState().lines).toHaveLength(0)
  })

  it('「控えめ」では放たない', () => {
    // 「控えめ」は仕様上カードの跳ねを残すので、**折り返し自体は鳴り続ける**。
    // 止めているのは門（`emitRoam`）のほうで、ここが外れると画面だけ静かで
    // 在庫が溜まり続ける形になる
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, motion_quiet: 'calm' },
    }))
    待つカードを描く()
    折り返す('tile-shake')
    撃たれるまで進める()
    expect(useRoamStore.getState().lines).toHaveLength(0)
  })

  it('放つ線は、状態から切り離した専用の色を持つ', () => {
    // **フェーズ8 の成果を、効果線についてだけ覆す**（2026-08-28・要件14-6）。
    // 輪・バー・タグは状態の色のままで、**外れるのは効果線だけ**である
    待つカードを描く()
    折り返す('tile-shake')
    撃たれるまで進める()
    const lines = useRoamStore.getState().lines
    // **長さを見る。** これが無いと、線が0本のとき `for` が0回まわって緑になる
    // ——**この工事の最頻出の罠そのもの**（2026-08-28 に実地で踏んだ）
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.accent).toBe(ROAM_ACCENT)
      // **状態の色ではないこと。** ここが「切り離した」ことの番人である
      expect(line.accent).not.toBe(statusAccentColor({ kind: 'waiting_permission' }))
    }
  })

  it('状態が変わっても、線の色は変わらない', () => {
    // **切り離しの本体はここ。** 上の1本だけだと「たまたま琥珀と違う色を書いた」
    // でも緑になる——**状態を振っても動かないこと**で見る
    const 色たち = new Set<string>()
    for (const kind of ['waiting_permission', 'working', 'stalled'] as const) {
      resetRoam()
      setRoamDice(() => 1)
      cleanup()
      applySessionSnapshot([meta({ status: { kind } as SessionStatus })])
      render(
        <MemoryRouter initialEntries={['/']}>
          <div data-roam-field>
            <SessionTile cardId={CARD} />
          </div>
        </MemoryRouter>,
      )
      折り返す('tile-shake')
      撃たれるまで進める()
      for (const line of useRoamStore.getState().lines) 色たち.add(line.accent)
    }
    expect(色たち.size).toBe(1)
    expect([...色たち][0]).toBe(ROAM_ACCENT)
  })

  it('線の色は、4つの役割色のどれとも一致しない', () => {
    // `DESIGN.md` §11.2 の役割表は書き換えない。**表の外の装飾色を1つだけ立てた**
    // ——役割色を奪っていないことの番人（設計§20-4-3）
    for (const 役割 of ['#3DD9E6', '#F5A623', '#8FD14F', '#FF5A5F']) {
      expect(ROAM_ACCENT.toUpperCase()).not.toBe(役割)
    }
  })

  it('線は常に不透明で出る', () => {
    // **輪と濃さを揃えるのをやめた**（2026-08-28・要件14-4）。フェーズ8 が揃えた
    // 成果を効果線についてだけ覆す
    待つカードを描く()
    折り返す('tile-shake')
    撃たれるまで進める()
    const lines = useRoamStore.getState().lines
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.ink).toBe('100%')
      expect(line.ink).not.toBe(statusInk({ kind: 'waiting_permission' }))
    }
  })

  it('繋がっていなくても、線は沈まない', () => {
    // **フェーズ12 の成果を「一旦」覆す**（2026-08-28・要件14-7）。
    // あちらは 0.1.41 の壊れ方——減光が `tile.css` の `[data-connected='false']` に
    // しか無く、**輪とバーだけが沈んで線が取り残されていた**——を直したものである。
    //
    // **戻すときはこの1本を戻す。** 定数（`DISCONNECTED_INK_SCALE`）は消していない
    // ので、`SessionTile.tsx` が渡す `ROAM_INK` へ掛け直せばよい
    applySessionSnapshot([
      meta({ status: { kind: 'waiting_permission' }, agent_connected: false }),
    ])
    render(
      <MemoryRouter initialEntries={['/']}>
        <div data-roam-field>
          <SessionTile cardId={CARD} />
        </div>
      </MemoryRouter>,
    )
    折り返す('tile-shake')
    撃たれるまで進める()
    const lines = useRoamStore.getState().lines
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      // **繋がっているときと同じ。** 沈んでいたら、掛け直しが残っている
      expect(line.ink).toBe('100%')
      expect(line.ink).not.toBe(statusInk({ kind: 'waiting_permission' }, false))
    }
  })
})

/**
 * ②行の札と復旧ボタンの物質（フェーズ20）。
 *
 * **jsdom は Tailwind を適用しない**ので、ここで見られるのは「そう書いてある」まで。
 * **そう出ているか**は `tile.spec.ts` が実物のブラウザで見る——フェーズ12 は
 * 「地と内側ハイライトを付けた」と記録しながら**落ち影が1つも無かった**ので、
 * 「書いた」と「効いた」を別々に見張る。
 */
describe('札と復旧ボタンが物質を持つ（フェーズ20）', () => {
  /** その要素の class から `shadow-[...]` の中身を取り出す */
  function 影(testId: string): string {
    const el = screen.getByTestId(testId)
    const 見つけた = /shadow-\[([^\]]+)\]/.exec(el.className)
    expect(見つけた, `${testId} に shadow-[...] が無い`).not.toBeNull()
    return (見つけた as RegExpExecArray)[1]
  }

  it('札が落ち影を持つ。inset だけへ戻すと落ちる', () => {
    // **この段の本体。** 「浮いている」を作るのは落ち影で、そこが無い面は
    // 枠線を引いただけの矩形にしか見えない（`DESIGN.md` §27.3）
    renderTile(
      meta({
        model: 'claude-haiku-4-5-20251001',
        permission_mode: 'bypassPermissions',
        agent_connected: false,
      }),
    )
    for (const testId of ['model', 'permission-mode', 'disconnected-badge']) {
      const 指定 = 影(testId)
        .split(',')
        .map((s) => s.trim())
      // inset でない影が1つ以上ある
      expect(
        指定.some((s) => !s.startsWith('inset')),
        `${testId} が落ち影を持たない`,
      ).toBe(true)
      // 上のハイライトと下の暗い縁で、厚みの側面を作る
      expect(指定.filter((s) => s.startsWith('inset'))).toHaveLength(2)
    }
  })

  it('群は3つまでで、取り返しの付く順に並ぶ', () => {
    /*
      左から**編集 → ゴミ箱 → 電源**（細かい修正 設計§4-1）。逆にすると、押し間違えた
      ときにいちばん痛いものが指の近くに来る。

      **3つまで**（`DESIGN.md` §15.3「群は2〜3個までにする」）。4つ目を足さない。
    */
    renderTile(meta({ agent_connected: false }))
    const 群 = screen.getByTestId('tile-ops')
    const 並び = [...群.querySelectorAll('[data-testid]')].map((e) =>
      e.getAttribute('data-testid'),
    )
    expect(並び).toEqual(['nickname-edit', 'archive-card', 'power-tile'])
  })

  it('ゴミ箱はカードを外す（履歴は残る）', async () => {
    const archive = vi.fn()
    useWsStore.setState({ archive })
    renderTile(meta({ agent_connected: false }))

    await userEvent.click(screen.getByTestId('archive-card'))

    expect(archive).toHaveBeenCalledWith(CARD)
  })

  it('操作の群には物質を足していない（塗るのは電源だけ）', () => {
    /*
      **復旧ボタン（板）は電源ボタンへ置き換わった**ので、「札と同じ物質」という
      対はもう成り立たない（細かい修正 設計§4-1）。

      いま守るのは逆側——`DESIGN.md` §12.3「一覧の行に物質を持たせない」と
      §15.1「主要操作は1つだけ塗る」。**編集とゴミ箱に板を作らない。**
      電源だけは §12.3 の表に「主要操作ボタン」として載っているので別枠である。
    */
    renderTile(meta({ model: 'claude-haiku-4-5-20251001', agent_connected: false }))
    for (const id of ['nickname-edit', 'archive-card']) {
      const cls = screen.getByTestId(id).className
      expect(cls, `${id} に落ち影がある`).not.toMatch(/shadow-\[/)
      expect(cls, `${id} に枠がある`).not.toMatch(/\bborder\b/)
    }
    // 電源は自前の物質を持つ（`controls.css` の `.power`）
    expect(screen.getByTestId('power-tile').className).toBe('power')
  })

  it('札はステッカーにならない。傾けない・型抜きしない', () => {
    // `DESIGN.md` §23.3「全行に出したい情報は、ステッカーではない」と §33 の禁止
    // 「状態ステッカーを全行に付けて列にする」。**属性なので、貼ると必ず列になる**
    renderTile(
      meta({
        model: 'claude-haiku-4-5-20251001',
        permission_mode: 'bypassPermissions',
        agent_connected: false,
      }),
    )
    for (const testId of ['model', 'permission-mode', 'disconnected-badge']) {
      const className = screen.getByTestId(testId).className
      expect(className, `${testId} が傾いている`).not.toMatch(/\brotate-/)
      expect(className, `${testId} が型抜きされている`).not.toMatch(/\bmask-/)
    }
    // 傾きと型抜きを持ってよいのはステッカーだけ（`tile.css` の `.tile-sticker`）
    cleanup()
    renderTile(meta({ status: { kind: 'waiting_permission' } }))
    expect(screen.getByTestId('tile-sticker')).toBeInTheDocument()
  })
})

describe('スリープの zzz（帯の設計§14-4）', () => {
  it('スリープのカードでは、札ではなく zzz が出る', () => {
    // **作業中と停滞が「札ではなく人が走る」のと同じ扱い**（利用者の指定）
    renderTile(meta({ status: { kind: 'ended', ok: true } }))

    expect(screen.getByTestId('tile-zzz')).toBeInTheDocument()
    // 札は**置いてある**が、休みの印が付いていて CSS が畳む（判定を JS へ散らさない）
    expect(screen.getByTestId('tile-tag')).toHaveClass('tile-tag-rest')
  })

  it('zzz は文字として置く（地を画像で作らない）', () => {
    // `forced-colors: active` は背景画像を消すので、焼き込むとあの環境で状態が
    // 読めなくなる（走る人が同じ理由で `tile-run-fallback` を持っている）
    renderTile(meta({ status: { kind: 'ended', ok: false } }))

    const zzz = screen.getByTestId('tile-zzz')
    expect(Array.from(zzz.querySelectorAll('i')).map((i) => i.textContent)).toEqual([
      'z',
      'z',
      'z',
    ])
    expect(zzz).toHaveAttribute('aria-label', 'スリープ')
  })

  it('走る人とは同時に出ない', () => {
    // 状態は1つしか持てないので、`ended` と `working`/`stalled` は重ならない
    const { unmount } = renderTile(meta({ status: { kind: 'working' } }))
    expect(screen.queryByTestId('tile-zzz')).toBeNull()
    expect(screen.getByTestId('tile-run')).toBeInTheDocument()
    unmount()

    renderTile(meta({ status: { kind: 'ended', ok: true } }))
    expect(screen.queryByTestId('tile-run')).toBeNull()
    expect(screen.getByTestId('tile-zzz')).toBeInTheDocument()
  })

  it('スリープ以外では出ない', () => {
    for (const kind of ['starting', 'waiting_input', 'unknown'] as const) {
      const { unmount } = renderTile(meta({ status: { kind } }))
      expect(screen.queryByTestId('tile-zzz'), kind).toBeNull()
      unmount()
    }
  })
})

describe('SessionTile の名前（利用者が付けたもの）', () => {
  /**
   * 名前は CLI が付ける `session_title` とは別物（名前付け設計§9-1）。
   *
   * **薄さは CSS の話なので jsdom からは見えない。** 見分けは `data-nickname` の
   * 3つの値（`user` ／ `cli` ／ `none`）で行う。
   */

  it('利用者の名前があれば、それが出る', () => {
    renderTile(
      meta({ nickname: 'あとで直すやつ', session_title: 'CLI が付けた名前' }),
    )
    const row = screen.getByTestId('session-title')
    expect(row.textContent).toBe('あとで直すやつ')
    expect(row.dataset.nickname).toBe('user')
  })

  it('名前が無ければ CLI の名前が出る', () => {
    renderTile(meta({ nickname: null, session_title: 'CLI が付けた名前' }))
    const row = screen.getByTestId('session-title')
    expect(row.textContent).toBe('CLI が付けた名前')
    // **薄く出す側**。利用者から見て「まだ自分では付けていない」が伝わる
    expect(row.dataset.nickname).toBe('cli')
  })

  it('どちらも無ければ、行の場所だけが残る', () => {
    renderTile(meta({ nickname: null, session_title: null }))
    const row = screen.getByTestId('session-title')
    expect(row.textContent).toBe(' ')
    expect(row.dataset.nickname).toBe('none')
  })

  it('鉛筆は器の直下に居て、カードの中には居ない', () => {
    // カードの本体は `<button>` なので、中に別のボタンを入れられない
    // （復旧ボタンと同じ理由・設計§9-2）
    renderTile(meta())
    const pencil = screen.getByTestId('nickname-edit')
    const body = screen.getByTestId('session-tile')
    expect(body.contains(pencil)).toBe(false)
    expect(screen.getByTestId('tile-shell').contains(pencil)).toBe(true)
  })

  it('鉛筆を押してもカードを掴まない', () => {
    // **`click` を止めるだけでは足りない**（`pointerdown` が素通りする）。
    // カードは本体で掴む作りなので、印が無いと押しただけで持ち上がる
    renderTile(meta())
    expect(screen.getByTestId('nickname-edit').hasAttribute('data-no-grab')).toBe(
      true,
    )
  })

  it('押すと編集に入り、確定すると口が呼ばれる', async () => {
    const setNickname = vi.fn()
    useWsStore.setState({ setNickname })
    renderTile(meta({ nickname: null, session_title: 'CLI が付けた名前' }))

    await userEvent.click(screen.getByTestId('nickname-edit'))
    const input = screen.getByTestId('nickname-input') as HTMLInputElement
    // **下書きの初期値は利用者の名前だけ。** CLI の名前を入れると、触っていないのに
    // 「自分で付けた」ことになる
    expect(input.value).toBe('')

    await userEvent.type(input, '  あとで直すやつ  ')
    await userEvent.keyboard('{Enter}')

    // 前後の空白は落ちる
    expect(setNickname).toHaveBeenCalledWith(CARD, 'あとで直すやつ')
  })

  it('楽観更新しない', async () => {
    // 手元を先に書き換えず、サーバの `session_upsert` が戻るまで名前は変わらない
    // （`setModel` と同じ流儀）
    useWsStore.setState({ setNickname: vi.fn() })
    renderTile(meta({ nickname: null, session_title: 'CLI が付けた名前' }))

    await userEvent.click(screen.getByTestId('nickname-edit'))
    await userEvent.type(screen.getByTestId('nickname-input'), '新しい名前')
    await userEvent.keyboard('{Enter}')

    expect(screen.getByTestId('session-title').textContent).toBe('CLI が付けた名前')
  })

  it('空で確定すると消す', async () => {
    const setNickname = vi.fn()
    useWsStore.setState({ setNickname })
    renderTile(meta({ nickname: 'あとで直すやつ' }))

    await userEvent.click(screen.getByTestId('nickname-edit'))
    await userEvent.clear(screen.getByTestId('nickname-input'))
    await userEvent.keyboard('{Enter}')

    expect(setNickname).toHaveBeenCalledWith(CARD, null)
  })

  it('改行は入力の時点で弾く', async () => {
    // カードは1行で「…」に切る作りなので、切った先が読めなくなる（設計§10）
    useWsStore.setState({ setNickname: vi.fn() })
    renderTile(meta())

    await userEvent.click(screen.getByTestId('nickname-edit'))
    const input = screen.getByTestId('nickname-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '上の行\n下の行' } })

    expect(input.value).toBe('上の行下の行')
  })

  it('Escape でやめられる', async () => {
    const setNickname = vi.fn()
    useWsStore.setState({ setNickname })
    renderTile(meta({ nickname: 'もとの名前' }))

    await userEvent.click(screen.getByTestId('nickname-edit'))
    await userEvent.type(screen.getByTestId('nickname-input'), 'まちがえた')
    await userEvent.keyboard('{Escape}')

    expect(setNickname).not.toHaveBeenCalled()
    expect(screen.queryByTestId('nickname-input')).toBeNull()
  })
})
