import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { Terminal } from '@xterm/xterm'

/**
 * E2E 共通の手順。
 *
 * 相手は**ビルドした core サーバ本体**と擬似 claude（`fake-claude`）。本物の CLI を使うと
 * 認証と課金が絡み、出力も毎回変わってテストにならない。実 CLI との結合はテスト計画
 * フェーズ4（`make test-cli`）が担う。
 */

/** 擬似 claude は作業ディレクトリの中身を見ないので、一時ディレクトリで足りる。 */
export const WORK_DIR = os.tmpdir()

/** ゴールデンフィクスチャの置き場所（リポジトリ直下の `fixtures/`）。 */
export const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures',
)

/**
 * 端末の内容を読む。
 *
 * WebGL や canvas で描いていると画面の文字は DOM に存在しないため、端末の要素へ
 * 生やしてある取り出し口（`__terminal`）を使う。
 */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="terminal"]') as
      | (HTMLDivElement & { __terminal?: Terminal })
      | null
    const term = container?.__terminal
    if (!term) {
      return ''
    }
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  })
}

/**
 * 端末の遡り位置を読む。
 *
 * `viewportY` が `baseY` より小さければ、そのぶん過去へ遡っている。`length` は
 * スクロールバックを含めた総行数で、**リモートでは全画面フレームが届くまで増えない**
 * （差分は可視領域を描き直すだけなので、押し出された行はどこにも残らない）。
 */
export async function terminalScroll(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="terminal"]') as
      | (HTMLDivElement & { __terminal?: Terminal })
      | null
    const buffer = container?.__terminal?.buffer.active
    return {
      viewportY: buffer?.viewportY ?? -1,
      baseY: buffer?.baseY ?? -1,
      length: buffer?.length ?? -1,
    }
  })
}

/** 端末を下端まで戻す（測り直しの前に位置を揃える用）。 */
export async function scrollTerminalToBottom(page: Page) {
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="terminal"]') as
      | (HTMLDivElement & { __terminal?: Terminal })
      | null
    container?.__terminal?.scrollToBottom()
  })
}

interface SwipeOptions {
  /** 縦の移動量（px）。**正で下へ＝過去へ遡る** */
  dy: number
  /** 横の移動量（px）。横へ払う操作を試すとき用 */
  dx?: number
  /** 何回に分けて動かすか */
  steps?: number
  /**
   * 1回ごとの間（ms）。
   *
   * **勢いはここで決まる。** 0 なら CDP の往復ぶん（数ミリ秒）で動くので慣性が乗り、
   * 空けると乗らない。慣性を始める境目は 0.25 px/ms（`lib/touch.ts` の `flingMin`）。
   */
  gapMs?: number
  /**
   * 1回目に入れる指のブレ（px）。**0 で真っ直ぐ（＝合成タッチのふるまい）。**
   *
   * 実際の指は真っ直ぐ動き出さず、1回目は「横へ2px・縦へ1px」のような値になる。
   * ここが**フェーズ7 で実機だけが死んだ道**で、真っ直ぐな合成タッチでは一度も通らない。
   */
  jitter?: number
}

/**
 * 端末の上を指でなぞる。
 *
 * **CDP でしか合成できない。** `page.dispatchEvent` はリスナーへ届きはするが、
 * 合成イベントなのでブラウザの既定動作（パン・互換のマウス操作）が一切起きず、
 * **握れているかどうかを一度も確かめないまま緑になる**（フェーズ1 の実測）。
 */
export async function swipeTerminal(page: Page, options: SwipeOptions) {
  const { dy, dx = 0, steps = 8, gapMs = 0, jitter = 0 } = options
  const box = await page.getByTestId('terminal').boundingBox()
  if (!box) {
    throw new Error('端末の位置が取れません')
  }
  const x = box.x + box.width / 2
  // 下へなぞる余地を残すため、上寄りから始める
  const y = box.y + box.height * 0.25

  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    })
    if (jitter > 0) {
      // **横のほうが大きい小さな1回目。** ここで向きを確定させると、そのなぞりは
      // 二度と握れない（フェーズ7 の実測）。真っ直ぐな合成タッチでは作れない状況
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + jitter, y: y + jitter / 2 }],
      })
    }
    for (let step = 1; step <= steps; step += 1) {
      if (gapMs > 0) {
        await page.waitForTimeout(gapMs)
      }
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x + (dx * step) / steps, y: y + (dy * step) / steps }],
      })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }
}

/**
 * なぞったときに `preventDefault()` が呼ばれたかを、あとから読めるようにする。
 *
 * `document` の側で拾うのが要点。端末の受け口は子孫にあるので**先に走り**、
 * ここへ上がってくる頃には `defaultPrevented` が決まっている。
 */
export async function watchPrevented(page: Page) {
  await page.evaluate(() => {
    const seen: boolean[] = []
    ;(window as unknown as { __prevented: boolean[] }).__prevented = seen
    document.addEventListener(
      'touchmove',
      (event) => seen.push(event.defaultPrevented),
      { passive: true },
    )
  })
}

/** [`watchPrevented`] が拾った結果を読み、次の測定のために空にする。 */
export async function takePrevented(page: Page): Promise<boolean[]> {
  return page.evaluate(() => {
    const seen = (window as unknown as { __prevented?: boolean[] }).__prevented ?? []
    return seen.splice(0, seen.length)
  })
}

/** 線の上へ出て行った1フレーム。`bytes` は `[1B kind][16B card_id][payload]` のまま。 */
export interface SentKey {
  /** 送った瞬間（`performance.now()`）。**フレームの間隔はこの差で測る** */
  at: number
  bytes: number[]
}

export interface SentFrames {
  /** `PtyInput`（`0x02`）のフレームだけ。 */
  keys: SentKey[]
  /** 入力欄の経路（`send_input`）が呼ばれた回数。 */
  sendInput: number
  /**
   * 端末の大きさを変えてくれと頼んだ回数（`resize`）。
   *
   * 桁行を固定したので、**入れ物の大きさが変わってもここは増えない**のが正しい
   * （`TerminalPane` の `TERMINAL_GRID`）。増えていれば、どこかがまた入れ物から
   * 桁行を決めている。**画面を見ても分からない**ので、線の上で数える。
   */
  resize: number
}

/** [`SentKey`] の payload（ヘッダ 17 バイトの後ろ）を取り出す。 */
export function keyPayload(key: SentKey): number[] {
  return key.bytes.slice(17)
}

/**
 * ブラウザが**線の上へ何を出したか**を、あとから読めるようにする。
 *
 * # 画面からは観測できないものがある
 *
 * 十字ボタンまわりには、描かれているかを見ても分からないことが3つある。
 *
 * | 確かめたいこと | なぜ画面では分からないか |
 * |---|---|
 * | キーが `PtyInput` を通り、`SendInput` を通っていない | どちらの道を通っても、端末の見た目は同じになりうる |
 * | 長押しで**何発**送られたか | 選択肢が2つしか無い画面では、3発目以降が画面を変えない |
 * | Esc の2発が**別のフレームで 30ms 以上空いている** | まとまって届いたかどうかは、送ったあとの画面に出ない |
 *
 * # `WebSocket.prototype.send` を包む
 *
 * Playwright の `framesent` ではなく**ページの中**で拾うのは、時刻が要るため。
 * あちらの時刻は CDP の通知が届いた時刻で、送った瞬間とは別物になる。**30ms
 * という細かい間隔を測る用途には、送り手の時計でなければ足りない。**
 *
 * **`page.goto` より前に呼ぶこと**（`addInitScript` は次の読み込みから効く）。
 * 包みは測定が本体を壊さないよう、何があっても元の `send` を呼ぶ。
 */
export async function watchSentFrames(page: Page) {
  await page.addInitScript(() => {
    const box = { keys: [] as SentKey[], sendInput: 0, resize: 0 }
    ;(window as unknown as { __sent: typeof box }).__sent = box

    const original = WebSocket.prototype.send
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
      try {
        if (typeof data === 'string') {
          // **札で数える。** `data.includes('"send_input"')` のような綴りだけの照合は、
          // **利用者が本文にその語を打っただけで増える**（指示は同じ JSON の中に文字列
          // として乗る）。数えたいのは種別なので、`"t":"…"` の形で見る
          if (data.includes('"t":"send_input"')) {
            box.sendInput += 1
          }
          // 端末の大きさを変えてくれという頼み。固定したので増えないのが正しい
          if (data.includes('"t":"resize"')) {
            box.resize += 1
          }
        } else {
          const view =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array((data as ArrayBufferView).buffer)
          // 0x02 が `KIND_PTY_INPUT`（`web/src/lib/frame.ts`）
          if (view[0] === 0x02) {
            box.keys.push({ at: performance.now(), bytes: Array.from(view) })
          }
        }
      } catch {
        // 測るために本体を止めない
      }
      return original.call(this, data)
    }
  })
}

/** [`watchSentFrames`] が拾った結果を読み、次の測定のために空にする。 */
export async function takeSentFrames(page: Page): Promise<SentFrames> {
  return page.evaluate(() => {
    const box = (window as unknown as { __sent?: SentFrames }).__sent
    if (!box) {
      return { keys: [], sendInput: 0, resize: 0 }
    }
    const keys = box.keys.splice(0, box.keys.length)
    const sendInput = box.sendInput
    const resize = box.resize
    box.sendInput = 0
    box.resize = 0
    return { keys, sendInput, resize }
  })
}

interface HoldOptions {
  /** 押しっぱなしにする長さ（ms）。 */
  holdMs: number
}

/**
 * 部品を**指で押しっぱなしにする**（連射の確認用）。
 *
 * `touchscreen.tap()` では長押しにならない（実測：`tap` のあと時間を進めても連射0回）。
 * `swipeTerminal` と同じく CDP の `Input.dispatchTouchEvent` で、`touchStart` →
 * 保持 → `touchEnd` を自分で組む。
 */
export async function holdTouch(page: Page, target: Locator, options: HoldOptions) {
  const box = await target.boundingBox()
  if (!box) {
    throw new Error('押す相手の位置が取れません')
  }
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point],
    })
    await page.waitForTimeout(options.holdMs)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } finally {
    await cdp.detach()
  }
}

export async function expectTerminalToContain(page: Page, marker: string) {
  await expect
    .poll(async () => terminalText(page), {
      message: `端末に ${marker} が現れること`,
      timeout: 60_000,
    })
    .toContain(marker)
}

/** 一覧画面を開き、接続が確立するまで待つ。 */
export async function openDashboard(page: Page) {
  await page.goto('/')
  await expect(page).toHaveTitle('AgentDashboard')
  await signInIfAsked(page)
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-status',
    'open',
  )
}

/**
 * ログイン画面が出ていたら通る（セルフホスト構成だけ。設計§8-2）。
 *
 * ローカルモードの構成では鍵が無いので、この関数は**何もせずに戻る**。
 * 呼び出し側でモードを分けないのは、どちらの構成でも同じヘルパを通したいため——
 * 分けると、片方でしか踏まない道ができる。
 */
export async function signInIfAsked(page: Page) {
  const form = page.getByTestId('login-form')
  // **「どちらかが出る」まで待ってから見る。** 画面はまず `GET /api/me` を聞いてから
  // 何を出すか決めるので、聞いている間はどちらも出ていない。待たずに数えると
  // 0 が返り、ログインを飛ばして「繋がらない」で落ちる——しかも**実行環境の速さ次第**で
  // 通ったり落ちたりする（単体では通るのに通しで落ちる形）
  await expect(form.or(page.getByTestId('project-add-open'))).toBeVisible()
  if ((await form.count()) === 0) {
    return
  }
  await page.getByTestId('login-name').fill(REMOTE_ACCOUNT)
  await page.getByTestId('login-password').fill(REMOTE_PASSWORD)
  await page.getByRole('button', { name: '入る' }).click()
  await expect(form).toHaveCount(0)
}

/** `scripts/e2e-remote` が作る管理者。**テストの中だけの値**。 */
export const REMOTE_ACCOUNT = 'e2e'
export const REMOTE_PASSWORD = 'e2eのあいことば'

/**
 * セッションを1つ起動して、その小窓を返す。
 *
 * 権限モードは選んでから起こす（設計§8）ので、ここは
 * **「スキップの指定は無し」を名指しで選んでから**押す。
 *
 * 既定に任せないのは、設定のトグルが ON のときに既定が「全承認をスキップ」へ
 * 変わるため。前のテストがトグルを戻し損ねると、**関係の無いテストが黙って
 * 全承認スキップのセッションを起こす**ことになる（実際に一度そうなった）。
 * 名指しにしておけば、トグルの状態によらず必ず安全側で起こる。
 */
export async function spawnSession(
  page: Page,
  cwd: string = WORK_DIR,
  /**
   * 起動先の PC の名前。
   *
   * **繋がっている PC が2台以上のときだけ選べる**（1台なら選択欄そのものが
   * 出ない。設計§5-1）。省略すると選ばずに押すので、2台以上の構成では
   * サーバに断られる——そうなるのが正しい（黙って1台目へ送ると、意図しない
   * PC で本物の claude が起動する）。
   */
  agentName?: string,
): Promise<Locator> {
  // **数える前に、描き終わるのを待つ。** 一覧へ移った直後は小窓がまだ1本も
  // 描かれておらず、そこで数えると 0 が返る。すると起こしたセッションを
  // `.nth(0)` で拾うことになり、**前からあったカードを掴む**。
  //
  // 症状は「起こしたばかりのセッションが、なぜか前の値を持っている」で、
  // 原因までまず辿れない。しかも実行環境の速さ次第で出たり出なかったりする
  // （E2E の土台を1つ増やしたら出た）。真実は常にサーバ側にあるので、
  // そちらの枚数に追いつくまで待ってから数える（`archiveAll` と同じ理由）
  const before = (await serverCardIds(page)).length
  await expect(page.getByTestId('session-tile')).toHaveCount(before)

  const group = await addProject(page, cwd, agentName)

  // 枠の「+」から起こす（設計§13）。**モードは名指しで選ぶ**
  await group.getByTestId('spawn-open').click()
  await group.getByTestId('spawn-mode').selectOption('')
  await group.getByTestId('spawn-button').click()
  await expect(page.getByTestId('session-tile')).toHaveCount(before + 1)
  return page.getByTestId('session-tile').nth(before)
}

/**
 * PJT の枠を足して、その枠を返す（イシューグループ_2026_0805_0514 設計§13）。
 *
 * 起動の入口が入れ替わったので、セッションを起こす前に必ずここを通る。
 * **パスは打ち込む道を使う**——辿る道は実行環境のフォルダ構成に依存するので、
 * 土台としては再現しない。辿る道そのものは専用のテストで見る。
 *
 * 既にある枠を指したときは、記録が1行のままなので**同じ枠が返る**。
 */
export async function addProject(
  page: Page,
  cwd: string = WORK_DIR,
  agentName?: string,
): Promise<Locator> {
  // **枠の鍵は（PC, パス）の組**（設計§13）。パスだけで探すと、3台構成で
  // 「1台目の /tmp」を使い回してしまい、2台目を名指ししたのに1台目で起きる
  const host = await hostIdOf(page, agentName)
  const existing = page.locator(
    `[data-testid="project-group"][data-host="${host}"][data-project="${cwd}"]`,
  )
  if ((await existing.count()) > 0) {
    return existing.first()
  }

  await page.getByTestId('project-add-open').click()
  const sheet = page.getByTestId('project-add-sheet')
  await expect(sheet).toBeVisible()
  if (agentName !== undefined) {
    await sheet.getByTestId('project-add-host').selectOption({ label: agentName })
  }
  await sheet.getByTestId('project-add-path').fill(cwd)
  await sheet.getByTestId('project-add-submit').click()

  /*
    **同時に同じ枠を作りに行くことがある。**

    上の早期返却は「枠が既にあるか」を見てから作りに行くが、**並列で走るワーカーが
    同時に「無い」を見ると、全員が作りに行く**。サーバは (PC, パス) の組で1つだけ通すので、
    **負けた側はシートが開いたまま残る**——ここで `toHaveCount(0)` を待つと落ちる。

    **普段これを踏まないのは、前回の実行が作った枠が記録に残っているからである。**
    記録を消した状態（＝毎回まっさらな CI）では必ず踏む。実測（2026-08-31）で131本落ちた。
    しかも落ちるのは「入力欄から送った指示が PTY まで届く」のような、**枠づくりと関係の
    無い名前のテスト**なので、原因から遠く見える。

    **欲しいのは「枠が在ること」**であって「自分が作ったこと」ではない。負けたらシートを
    畳んで先へ進む。**枠が本当に出来たかは、この下でサーバに聞いて確かめる**ので、
    入力が間違っていた場合はそちらで落ちる（負けと取り違えない）。
  */
  const 閉じた = await sheet
    .waitFor({ state: 'detached', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (!閉じた) {
    await sheet.getByTestId('project-add-close').click()
    await expect(sheet).toHaveCount(0)
  }

  // **入力した形で探さない。** Windows 側から貼ったパスは PC 側で読み替えられるので、
  // 枠は解決後の絶対パスで作られる（設計§13）。真実はサーバ側にあるので、そちらに聞く。
  //
  // **ただし、そのまま通る形（絶対パス）で頼んだときは、それを優先して選ぶ。**
  // 「その PC の新しい順で1件」だけだと、**並列で別の枠が作られたときに隣を掴む**
  const added = await page.evaluate(
    async ({ target, want }) => {
      const response = await fetch('/api/projects')
      const rows = (await response.json()) as {
        host: string
        path: string
        created_at: number
      }[]
      const mine = rows.filter((row) => row.host === target)
      const 完全一致 = mine.find((row) => row.path === want)
      return (
        完全一致?.path ??
        mine.sort((a, b) => b.created_at - a.created_at)[0]?.path ??
        ''
      )
    },
    { target: host, want: cwd },
  )
  const resolved = page.locator(
    `[data-testid="project-group"][data-host="${host}"][data-project="${added}"]`,
  )
  await expect(resolved).toHaveCount(1)
  return resolved
}

/**
 * 名前から PC の識別子を引く。名指しが無ければローカル（または唯一の PC）。
 *
 * 枠も URL も `agent_id` を鍵に持つので、**名前のままでは照合できない**。
 */
async function hostIdOf(page: Page, agentName?: string): Promise<string> {
  const agents = await page.evaluate(async () => {
    const response = await fetch('/api/settings')
    if (!response.ok) {
      return [] as { id: string; name: string; connected: boolean }[]
    }
    return ((await response.json()) as {
      agents: { id: string; name: string; connected: boolean }[]
    }).agents
  })
  if (agentName !== undefined) {
    const found = agents.find((agent) => agent.name === agentName)
    if (found === undefined) {
      throw new Error(`PC「${agentName}」が繋がっていません`)
    }
    return found.id
  }
  const connected = agents.filter((agent) => agent.connected)
  // ローカルモードは PC を1台として並べないので、綴りは 'local' になる（設計§10）
  return connected.length === 1 ? connected[0].id : 'local'
}

/**
 * 小窓をクリックして専用画面を開き、擬似 claude の起動を待つ。
 *
 * 専用画面の既定は構造化ビューなので、**ターミナルのタブへ切り替えてから**返す。
 * 隠れている要素はクリックできず、端末へ打ち込む手順（[`typeLine`]）が使えないため。
 */
export async function openSession(page: Page, tile: Locator) {
  // **開くのはダブルクリック**（並べ替え設計§4-1）。シングルは「選ぶ」になった
  await tile.dblclick()
  await expect(page.getByTestId('session-view')).toBeVisible()
  await showTerminal(page)
  await expectTerminalToContain(page, '[fake-claude] ready')
}

/**
 * ターミナルで見るかどうかを、狙った状態にする（帯の設計§14-3）。
 *
 * **2つのタブがトグル1つになった**ので、「押す」ではなく「**その状態にする**」形に
 * してある——既に入っているものをもう一度押すと切れてしまう。
 *
 * 受け取るのはページでも区画（`Locator`）でもよい。**横並びでは同じ画面に複数の
 * トグルが並ぶ**ので、そのときは区画で絞る。
 */
export async function setTerminalView(scope: Page | Locator, on: boolean) {
  const toggle = scope.getByTestId('terminal-toggle')
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
}

/** ターミナルで見る状態にする。 */
export async function showTerminal(page: Page) {
  await setTerminalView(page, true)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'terminal')
}

/** 構造化ビューで見る状態にする。 */
export async function showTranscript(page: Page) {
  await setTerminalView(page, false)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'transcript')
}

/**
 * 端末へ1行打ち込んで送る。
 *
 * **送信は Ctrl+Enter**（`lib/keys.ts`）。端末では Enter と Shift+Enter を改行に
 * 割り当てているので、素の Enter で送ろうとすると改行が入るだけで先へ進まない。
 */
export async function typeLine(page: Page, line: string) {
  await page.getByTestId('terminal').click()
  await page.keyboard.type(line)
  await page.keyboard.press('Control+Enter')
}

/**
 * 擬似 claude に、注入された settings のフックを実際に起動させる。
 *
 * 本物の CLI と同じ経路（settings → フックのコマンド → `hook-post` → 受信口 → 状態機械）を
 * 通るので、状態表示の確認が課金なしで毎回できる。
 */
export async function fireHook(page: Page, event: string, extra = '') {
  await typeLine(page, extra ? `hook ${event} ${extra}` : `hook ${event}`)
  await expectTerminalToContain(page, `[fake-claude] hook-sent: ${event}`)
}

/**
 * 擬似 claude に、フィクスチャの JSONL をトランスクリプトへ書かせる。
 *
 * 書き出し先はフックが運ぶ `transcript_path` と同じ場所なので、`fireHook` で
 * その場所を core へ知らせたあとに呼べば、パーサが読んで構造化ビューに出る。
 * 行数を渡すと途中まで書けるので、「書きかけの状態」も作れる。
 */
export async function writeTranscript(page: Page, fixture: string, lines?: number) {
  const source = path.resolve(FIXTURES, fixture)
  await typeLine(page, lines ? `jsonl ${source} ${lines}` : `jsonl ${source}`)
  await expectTerminalToContain(page, '[fake-claude] jsonl-appended: ')
}

/**
 * サーバが持っているカードの一覧（画面ではなくサーバに直接聞く）。
 *
 * **聞く相手は「いま見ている画面が話している相手」。** baseURL に固定すると、
 * 前段（リバースプロキシ）越しに別のインスタンスを見ているときに、画面と
 * 別のサーバへ聞くことになる。2台は記録を共有しているが**届く順は揃わない**ので、
 * 一致するまで待つ用途では、食い違ったまま永久に待つことになる。
 */
async function serverCardIds(page: Page): Promise<string[]> {
  const origin = new URL(page.url()).origin
  const response = await page.request.get(`${origin}/api/sessions`)
  const sessions = (await response.json()) as { card_id: string }[]
  return sessions.map((session) => session.card_id)
}

/**
 * 残っているカードを片付ける。
 *
 * サーバは全テストで共有されるため、片付けないと「前のテストが作ったカードがある状態」を
 * 前提にしたテストになってしまい、単体で流したときと通しで流したときで結果が変わる。
 *
 * # 片付いたかどうかは**サーバに聞く**
 *
 * 画面の小窓を数えて判断すると、「まだ描かれていないだけ」を「もう無い」と読み違える。
 * 実際、これで残ったカードが次のテストへ漏れ、**別のテストが日替わりで落ちる**という
 * 追いにくい形になっていた。真実は常にサーバ側にあるので、そちらを見る。
 *
 * 消す対象もIDで名指しする。`.first()` で選ぶと、消したい相手と押した相手がずれうる。
 */
export async function archiveAll(page: Page) {
  // **枠が消せなかったら、カードの片付けからやり直す。** アーカイブした瞬間に
  // 飛行中だった報告（statusLine の1秒周期の SessionUpsert）が着地すると、
  // 消したはずのカードが一覧へ蘇り、枠の削除が 409（セッションが動いている）で
  // 断られ続ける——2026-08-11 に compose の通しで実測（枠の DELETE の診断が
  // 409 の本文を出す）。蘇りそのものは製品側の競合（アーカイブ済みへの upsert が
  // archived を剥がす）なので、ここでは**もう一度アーカイブして**先へ進む
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 上限を切っておく。消せないカードがあったときに無限に回り続けないため
    for (let guard = 0; guard < 20; guard += 1) {
      const remaining = await serverCardIds(page)
      if (remaining.length === 0) {
        break
      }
      await page.goto(`/s/${remaining[0]}`)
      /*
        **まず止めて、それから外す**（帯の設計§14-2）。

        結合をやめたので、「終了」は**一覧から外すだけ**になった。走っているカードへ
        いきなり終了を押すと、**カードは消えるのに擬似 claude は走り続ける**——
        後片付けとしては片手落ちで、通しで流すと走ったままのものが積み上がる。

        **「在るか」ではなく「点いているか」で押す**（帯設計§15-1）。訂正その2で
        スリープと復旧が1つの電源ボタンへ畳まれたので、**ボタンは常に在る**——
        数だけ見ると必ず真になり、**寝ているカードで復旧を押す**ことになる。
        後片付けのつもりでセッションを起こすので、席が埋まって
        **無関係なテストが「起動しない」で落ちる**。
      */
      const power = page.getByTestId('power-card')
      if ((await power.getAttribute('data-power')) === 'on') {
        await power.click()
      }
      await page.getByTestId('close-card').click()
      // **消えたかはサーバに聞く**（ガイドライン「E2E の後片付けは画面ではなく
      // サーバに聞く」）。単独画面は外れたあと一覧へ移るので、以前見ていた
      // 「見つかりません」はもう出ない。
      //
      // **待ちを長めに取る。** 片付けは全テストが共有する1台のサーバの上で走るので、
      // 通しで流すと起動直後（まだ「起動中」）のカードを消しに行くことがあり、
      // 往復が既定の5秒に収まらない。単独では出ず**通しでだけ、たまに落ちる**という
      // いちばん追いにくい形になっていた（`運用の積み残し` の7・8）
      await expect
        .poll(async () => (await serverCardIds(page)).includes(remaining[0]), {
          message: 'サーバ側からもカードが消えること',
          timeout: 20_000,
        })
        .toBe(false)
    }
    // カードを片付けたら枠も外す。**製品としては枠が残るのが正しい**（設計§13）が、
    // テストの間で残ると「一覧が空であること」を見ている主張が次のテストへ漏れる
    try {
      await removeAllProjects(page)
      return
    } catch (cause) {
      if (attempt === 2) {
        throw cause
      }
    }
  }
  throw new Error('カードを片付けきれませんでした')
}

/**
 * 追加した PJT の枠を全部外す（[`archiveAll`] が最後に呼ぶ）。
 *
 * カードと同じく**サーバに聞いて、IDで名指しして消す**——画面の枠を数えると
 * 「まだ描かれていない」と「もう無い」を読み違える。
 *
 * セッションが居る枠は消せないので、**カードを片付けたあと**でなければ効かない。
 */
async function removeAllProjects(page: Page) {
  // **消すのも数えるのも1つのポーリングの中で行う。** 1回の DELETE ＋数えるだけの形は、
  // 直前のカード片付けの余韻（消した直後の枠がまだ「使用中」に見える等）を1度でも
  // 踏むと戻れない。上限は10秒——ここで粘るより、呼び手（archiveAll）が
  // **カードの片付けからやり直す**ほうが効く（蘇ったカードはこちらからは消せない）。
  //
  // 返りは**残った枠と断りの本文ごと** JSON にする——空でないとき、その中身が
  // そのまま失敗メッセージに出るので、「なぜ消せないか」を落ちた場で読める
  await expect
    .poll(
      async () => {
        const outcomes = await page.evaluate(async () => {
          const response = await fetch('/api/projects')
          if (!response.ok) {
            return [] as unknown[]
          }
          const ids = ((await response.json()) as { id: string }[]).map(
            (row) => row.id,
          )
          const results: unknown[] = []
          for (const id of ids) {
            const deleted = await fetch(`/api/projects/${id}`, {
              method: 'DELETE',
            })
            results.push({
              id,
              status: deleted.status,
              body: await deleted.text(),
            })
          }
          return results
        })
        return JSON.stringify(outcomes)
      },
      { message: 'サーバ側からも枠が消えること', timeout: 10_000 },
    )
    .toBe('[]')
}

/**
 * 自前のドロップダウンから選ぶ（帯の設計§4・案B）。
 *
 * **`selectOption` は標準の `<select>` 専用**なので、モデルとモードのピッカーには
 * 使えなくなった。開いてから選ぶ、の2段を1つに固めてある——**呼ぶ側が2段を手で
 * 書くと、開き忘れが「選べなかった」ではなく「押した相手が居ない」として出る。**
 *
 * 一覧はポータルで画面の直下へ出るので、**探す相手はページ全体**にする（ピッカーの
 * 中を探しても見つからない）。同時に2つ開くことはないので取り違えない。
 */
export async function pickOption(picker: Locator, value: string) {
  await picker.click()
  await picker
    .page()
    .locator(`[role="option"][data-value="${value}"]`)
    .click()
}

/**
 * 画像を1枚添付する（画像添付 設計§9）。
 *
 * **「＋」の口（`<input type="file">`）から入れる。** ドラッグ＆ドロップと貼り付けは
 * Playwright に素の口が無く、`DataTransfer` を自分で組み立てて撃つことになる——
 * それは**ブラウザの中でイベントを合成しているだけ**で、実際に人が落としたのとは別物
 * である。3経路が同じ入口を通ることは単体テスト（`lib/attachments.test.ts`）が
 * 見ているので、ここでは**運んで届くところ**に絞る。
 */
export async function attachImage(
  scope: Page | Locator,
  name = 'shot.png',
): Promise<void> {
  // 1×1 の PNG。**中身は見ないので最小でよい**（擬似 claude は拡張子で拾う）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await scope
    .getByTestId('composer-file')
    .setInputFiles({ name, mimeType: 'image/png', buffer: png })
}

/**
 * この機械でプロセス表を読めるか（ゾンビ設計§5-1）。
 *
 * **「読めない」と「0体」を区別する。** 潰すと Linux 以外で「ゾンビは居ません」と嘘をつく。
 */
export function プロセス表を読める(): boolean {
  return fs.existsSync('/proc')
}

/**
 * 走っているダッシュボードの PID を、ログのファイル名から読む。
 *
 * `<state_dir>/logs/dashboard-<pid>.<日付>.jsonl` という名前の約束に乗る
 * （`logs.spec.ts` と同じ作法）。**Playwright の `webServer` からは PID を取れない**
 * ——`sh -c` を挟むので、取れたとしてもそれは殻の PID になる。
 *
 * **版の入れ替えは `exec` なので PID は変わらない。** 前後で同じ値が返るのが正しい姿。
 */
export function ダッシュボードのPID(stateDir: string): number {
  const dir = path.join(stateDir, 'logs')
  const 生きている = [
    ...new Set(
      fs
        .readdirSync(dir)
        .flatMap((name) => {
          const 当たり = /^dashboard-(\d+)\./.exec(name)
          return 当たり ? [Number(当たり[1])] : []
        })
        .filter((pid) => fs.existsSync(`/proc/${pid}`)),
    ),
  ]
  if (生きている.length !== 1) {
    throw new Error(
      `走っているダッシュボードを1つに絞れない（${dir}）: ${生きている.join(',') || '該当なし'}`,
    )
  }
  return 生きている[0]
}

/**
 * その PID の子のうち、**引き取られていないもの**の数（ゾンビ設計§5-4）。
 *
 * `comm` は括弧で囲まれていて空白も括弧も含みうるので、**最後の `)` で切ってから**
 * 残りの欄を割る。先頭から空白で割ると欄がずれる。
 */
export function 引き取られていない子(pid: number): number {
  return fs
    .readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((child) => {
      let 行: string
      try {
        行 = fs.readFileSync(`/proc/${child}/stat`, 'utf8')
      } catch {
        // 読んでいる最中に消える子が居るのは普通
        return false
      }
      const 閉じ = 行.lastIndexOf(')')
      if (閉じ < 0) return false
      const [state, ppid] = 行.slice(閉じ + 1).trim().split(/\s+/)
      return state === 'Z' && Number(ppid) === pid
    }).length
}
