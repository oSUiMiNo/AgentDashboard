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
  await expect(form.or(page.getByTestId('spawn-form'))).toBeVisible()
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

  await page.getByTestId('cwd-input').fill(cwd)
  if (agentName !== undefined) {
    await page.getByTestId('spawn-target').selectOption({ label: agentName })
  }
  await page.getByTestId('spawn-mode').selectOption('')
  await page.getByTestId('spawn-button').click()
  await expect(page.getByTestId('session-tile')).toHaveCount(before + 1)
  return page.getByTestId('session-tile').nth(before)
}

/**
 * 小窓をクリックして専用画面を開き、擬似 claude の起動を待つ。
 *
 * 専用画面の既定は構造化ビューなので、**ターミナルのタブへ切り替えてから**返す。
 * 隠れている要素はクリックできず、端末へ打ち込む手順（[`typeLine`]）が使えないため。
 */
export async function openSession(page: Page, tile: Locator) {
  await tile.click()
  await expect(page.getByTestId('session-view')).toBeVisible()
  await showTerminal(page)
  await expectTerminalToContain(page, '[fake-claude] ready')
}

/** ターミナルのタブへ切り替える。 */
export async function showTerminal(page: Page) {
  await page.getByTestId('view-tab-terminal').click()
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'terminal')
}

/** 構造化ビューのタブへ切り替える。 */
export async function showTranscript(page: Page) {
  await page.getByTestId('view-tab-transcript').click()
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
  // 上限を切っておく。消せないカードがあったときに無限に回り続けないため
  for (let guard = 0; guard < 20; guard += 1) {
    const remaining = await serverCardIds(page)
    if (remaining.length === 0) {
      return
    }
    await page.goto(`/s/${remaining[0]}`)
    await page.getByRole('button', { name: '削除' }).click()
    // 消えると専用画面は「見つかりません」に変わる。これを消えた合図にする
    await expect(page.getByTestId('not-found')).toBeVisible()
    await expect
      .poll(async () => (await serverCardIds(page)).includes(remaining[0]), {
        message: 'サーバ側からもカードが消えること',
      })
      .toBe(false)
  }
  throw new Error('カードを片付けきれませんでした')
}
