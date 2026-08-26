import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { addProject, archiveAll, openDashboard, WORK_DIR } from './helpers'

/**
 * PJT 専用画面の左パネル（イシューグループ_2026_0805_0514 設計§14・§15。
 * テスト計画フェーズ5）。
 *
 * ここでしか確かめられないのは「**画面 → REST → セッションホスト → 実ファイル**」が
 * 1本に繋がっていること。単体テストは応答を作り物にしているので、実物のフォルダを
 * 読めるかどうかについては何も言っていない。
 *
 * 目的は要件のいちばん短い言い方に沿って「**左でパスをコピーして、右の入力欄へ貼る**」
 * が成立すること。
 */

/** 実物を読ませるための小さな PJT。中身が決まっていないと主張が書けない。 */
const PROJECT_DIR = path.join(WORK_DIR, 'adash-e2e-files')
const PLAN = '計画.md'
/** 画面に収まらない長さの文書（`ファイルの中身をスクロールできない` 設計§8）。 */
const LONG = '長い文書.md'
/** 末尾に置く目印。**辿り着けたこと**は、数ではなくこれが見えることで言う。 */
const TAIL = 'いちばん最後の行'
/** 一覧のほうも溢れさせる数。同じ器の中で高さを取り合うので、両方を見る。 */
const FILLERS = 60

/** 1x1 の PNG。**実物**（`<img>` が実際に描けることを幅で見る）。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PICTURE = '撮った.png'
/** 拡張子は画像・中身は違う。**壊れていても画面が壊れないこと**を見る。 */
const BROKEN = '嘘.png'
const DOCUMENT = '理解.html'
const DANGEROUS = '危ない.html'
const VECTOR = '図.svg'
/** 上限を超える画像。**その場で作ってその場で消す**（置きっぱなしにしない）。 */
const HUGE = '大きい.png'

/**
 * 材料に埋めておく、外への宛先の印。
 *
 * **本物の番号はテストの中で決まる**（受け口を立ててみるまで分からない）ので、
 * ここでは差し替えられる形だけを置く。固定の番号を焼き込むと、その番号が埋まって
 * いる機械で**嘘の緑**になる。
 */
const OUTSIDE_MARK = 'http://外の宛先/beacon.png'

/**
 * 理解doc と同じ作りの HTML。**利用者が実際に読みたいものの形**を写してある
 * （自己完結型・インライン `<style>`・`data:` の画像・インライン SVG）。
 */
const RICH_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>#塗り { color: rgb(1, 2, 3); }</style></head><body>
<h1 id="見出し">理解ドキュメント</h1>
<p id="塗り">色が付く</p>
<img id="埋め込み" src="data:image/png;base64,${TINY_PNG_BASE64}">
<svg id="図形" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>
</body></html>`

/**
 * script と外部への読み込みを持つ材料。**この2つが止まることがこの工事の要**。
 *
 * 「書き換えるはずの文字」を置いてあるのは、**動かなかったことを字で言える**ようにするため。
 */
const DANGEROUS_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<p id="印">元のまま</p>
<img id="外" src="${OUTSIDE_MARK}">
<script>document.getElementById('印').textContent = '書き換えられた'</script>
</body></html>`

const TINY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect id="四角" width="20" height="20" fill="green"/></svg>'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeAll(() => {
  const docs = path.join(PROJECT_DIR, 'MyDocs')
  fs.mkdirSync(docs, { recursive: true })
  fs.writeFileSync(
    path.join(docs, PLAN),
    '# 計画\n\n- [x] 済んだこと\n- [ ] まだのこと\n',
    'utf8',
  )

  // **短いファイルでは症状が出ない**（収まってしまう）ので、材料の長さがそのまま
  // このテストの効き目になる。**上限（`MAX_FILE_BYTES` ＝ 256 KiB）の内側**に収める——
  // 超えると読まずに断られるので、遡りを1度も測れないまま緑になる
  const lines = Array.from({ length: 3_000 }, (_, at) => `- ${at + 1} 行目\n`)
  fs.writeFileSync(
    path.join(docs, LONG),
    `# 長い文書\n\n${lines.join('')}\n## ${TAIL}\n`,
    'utf8',
  )

  for (let at = 0; at < FILLERS; at += 1) {
    fs.writeFileSync(
      path.join(docs, `埋め草-${String(at).padStart(2, '0')}.txt`),
      'x\n',
      'utf8',
    )
  }

  // --- 画像と HTML（`ファイル閲覧で画像とHTMLも表示する` テスト計画フェーズ5）------
  //
  // **`fixtures/` へは1枚も置かない**（公開リポジトリ・壊れた材料を含むため）。
  // その場で書いて、`afterAll` でフォルダごと消える
  fs.writeFileSync(path.join(docs, PICTURE), Buffer.from(TINY_PNG_BASE64, 'base64'))
  // 拡張子は画像・中身は違う。**画面が壊れないこと**を見るための材料
  fs.writeFileSync(path.join(docs, BROKEN), 'これは画像ではありません\n', 'utf8')
  // 理解doc と同じ作り（インライン `<style>`・`data:` の画像・インライン SVG）
  fs.writeFileSync(path.join(docs, DOCUMENT), RICH_HTML, 'utf8')
  // script と外部への読み込みを持つ材料。**隔離が効いているかを言うのはこれ**
  fs.writeFileSync(path.join(docs, DANGEROUS), DANGEROUS_HTML, 'utf8')
  fs.writeFileSync(path.join(docs, VECTOR), TINY_SVG, 'utf8')
})

/**
 * その箱が「遡れる状態か」を実測する。
 *
 * **要素が在ることを見ても分からない。** 高さが決まっていない箱は中身と一緒に伸びるので、
 * `overflow-auto` が付いていても `scrollHeight` と `clientHeight` が並んだままになる
 * （`ファイルの中身をスクロールできない` 設計§2）。jsdom には配置が無いので、
 * これを測れるのは実物のブラウザだけである。
 */
async function scrollState(box: Locator) {
  return box.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
  }))
}

/** 下端まで遡らせる。**溢れているだけでは、動くとは限らない**ので実際に動かす。 */
async function scrollToBottom(box: Locator) {
  await box.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
}

/** 溢れていること・実際に動くことを、まとめて見る。 */
async function expectScrollable(box: Locator) {
  await box.evaluate((el) => {
    el.scrollTop = 0
  })
  const before = await scrollState(box)
  expect(
    before.scrollHeight,
    '中身が箱より高いこと（高さが決まっていないと、ここが並ぶ）',
  ).toBeGreaterThan(before.clientHeight)

  await scrollToBottom(box)
  expect((await scrollState(box)).scrollTop, '実際に遡れること').toBeGreaterThan(0)
}

test.afterAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true })
})

test.afterEach(async ({ page }) => {
  // **開閉の記憶を既定へ戻してから片付ける**（設計§14 で覚える作りにしてある）。
  // 開いたまま終わると、狭い画面ではドロワーが全面を覆い、**このテストの後片付けも
  // 無関係な次のテストも押せなくなる**。ガイドライン「E2E が設定を書き換えるとき」
  // と同じ扱いで、残る側の状態は必ず戻す
  await page.evaluate(() => {
    globalThis.localStorage?.removeItem('agentdashboard.project-files-open')
    // **幅も戻す。** 足さないと、幅を変えたテストが後続へ漏れる——症状は
    // 「別のテストがランダムに落ちる」で、原因からいちばん遠いところに出る
    globalThis.localStorage?.removeItem('agentdashboard.project-files-width')
  })
  await page.reload()
  await archiveAll(page)
})

test('左パネルを開き、ファイルを読み、相対パスをコピーできる', async ({
  page,
}) => {
  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)

  // 枠の余白から PJT 専用画面へ（セッションは1本も起こしていない）
  await group.click({ position: { x: 5, y: 5 } })
  await expect(page).toHaveURL(`/p/local/${encodeURIComponent(PROJECT_DIR)}`)
  await expect(page.getByTestId('group-view')).toBeVisible()

  // セッションが0本でも「+」は出る（設計§14）
  await expect(page.getByTestId('spawn-open')).toBeVisible()

  // ハンバーガーで左パネルが開く
  await expect(page.getByTestId('project-files-panel')).toHaveCount(0)
  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  // 起点は枠のパス。**実物のフォルダが読めている**ことがここで分かる
  await expect(panel.getByTestId('folder-browser')).toHaveAttribute(
    'data-path',
    PROJECT_DIR,
  )
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: PLAN }).click()

  // 整形されて、進捗（チェックボックス）がそのまま読める
  const view = page.getByTestId('file-view')
  await expect(view).toBeVisible()
  const boxes = view.getByRole('checkbox')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.first()).toBeChecked()
  await expect(boxes.last()).not.toBeChecked()

  // 相対パスと、その基準が出ている
  await expect(view.getByTestId('file-relative-path')).toHaveText(
    `MyDocs/${PLAN}`,
  )
  await expect(view.getByTestId('file-relative-base')).toContainText(PROJECT_DIR)

  // コピーした値が、そのまま貼れる形で入る
  await view.getByTestId('file-copy').click()
  await expect(view.getByTestId('file-copied')).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toBe(`MyDocs/${PLAN}`)

  // 開いたことは覚えている（設計§14）。一覧へ出て戻っても畳まれていない
  await page.goto('/')
  await page.goto(`/p/local/${encodeURIComponent(PROJECT_DIR)}`)
  await expect(page.getByTestId('project-files-panel')).toBeVisible()
})

/**
 * 狭い画面で**ページが横にはみ出さない**こと（設計§28）。
 *
 * # なぜ E2E でしか捕まらないのか
 *
 * jsdom には配置が無いので、単体テストでは幅を測れない。しかもこの壊れ方は
 * **画面が崩れて見えない**——はみ出すのはヘッダの右端で、普通に見ると何も
 * おかしくない。表に出るのは**左パネルのドロワーの右端が画面の外へ出る**形で、
 * モバイルの `fixed` が「広がったページ幅」を基準にするために起きる。
 *
 * 実機のスマホで2度報告された（閉じるボタンとコピーが見えない）。
 */
test('狭い画面で、セッション専用画面が横にはみ出さない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  await addProject(page, PROJECT_DIR)

  await page.getByTestId('spawn-open').click()
  await page.getByTestId('spawn-button').click()
  await page.getByTestId('session-tile').first().click()
  await expect(page.getByTestId('session-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  // **ページが画面より広くなっていないこと。** これが破れると、
  // 閉じるボタンもコピーも画面の外へ出る
  const overflows = await page.evaluate(() => {
    const de = document.documentElement
    return de.scrollWidth > de.clientWidth
  })
  expect(overflows).toBe(false)

  // 実際に押せる位置に在ること（幅の計算だけでは「在るが届かない」を見逃す）
  await expect(panel.getByTestId('project-files-close')).toBeInViewport()
  await expect(panel.getByTestId('folder-copy').first()).toBeInViewport()

  // 閉じられること自体もここで見る（狭い画面ではこれが唯一の畳む手）
  await panel.getByTestId('project-files-close').click()
  await expect(panel).toBeHidden()
})

/**
 * ファイルの中身を末尾まで辿れること（`ファイルの中身をスクロールできない` 設計§8）。
 *
 * # なぜ E2E でしか捕まらないのか
 *
 * 壊れていたのは**高さの鎖**で、要素も `overflow-auto` も最初から在った。したがって
 * 「在ること」を見るテストは**壊れている側でも通る**。jsdom には配置が無く
 * `scrollHeight` も `clientHeight` も 0 を返すので、単体では原理的に測れない。
 *
 * しかも症状は「上のほうしか出ない」——**短い文書を開いたときと見分けが付かない**ので、
 * 目で見てもすぐには壊れていると分からない。
 */
test('長い文書を末尾まで辿れる（整形と生テキストの両方）', async ({ page }) => {
  await openDashboard(page)
  const panel = await openLongFile(page)

  // **一覧のほうも遡れること。** 同じ器の中で高さを取り合うので、片方を直した
  // 拍子にもう片方が伸び放題になっていないかを、同じ場所で見る
  await expectScrollable(panel.getByTestId('folder-browser').locator('ul'))

  const body = page.getByTestId('file-body')

  // 整形して見るとき
  await expect(page.getByTestId('file-markdown')).toBeVisible()
  await expectScrollable(body)
  // **数だけでは「遡れた」と言い切れない。** 末尾の目印が実際に見えるところまで見る
  await expect(page.getByRole('heading', { name: TAIL })).toBeInViewport()

  // 生テキストで見るとき（**同じ箱の中で中身だけが入れ替わる**ので、片方だけ直る
  // 形にはならない。ただし「なるはず」で済ませずに、両方で測る）
  await page.getByTestId('file-toggle-raw').click()
  await expect(page.getByTestId('file-raw')).toBeVisible()
  await expectScrollable(body)
})

/**
 * 狭い画面（全幅のドロワー）でも遡れること。
 *
 * 高さの決まり方が変わる（`fixed inset-0` になる）ので、広い画面で直っていても
 * こちらが直っている保証は無い。**そして、この画面はスマホで使うほうが本番**である。
 */
test('狭い画面でも、ファイルの中身を遡れる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  await openLongFile(page)

  const body = page.getByTestId('file-body')
  await expect(page.getByTestId('file-markdown')).toBeVisible()
  await expectScrollable(body)
  // 下端が画面の外へ出ていないこと。**在るが届かない**を、位置まで見て否定する
  await expect(page.getByRole('heading', { name: TAIL })).toBeInViewport()
})

/**
 * 左パネルを開き、`MyDocs` へ入って長い文書を開く（上の2本で共有する手順）。
 *
 * 広い画面と狭い画面で**同じ手順**を通すのが要点——手順が分かれると、
 * 片方でしか踏まない道ができる。
 */
async function openLongFile(page: Page) {
  const group = await addProject(page, PROJECT_DIR)
  await group.click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: LONG }).click()
  await expect(page.getByTestId('file-view')).toBeVisible()
  return panel
}

// ---------------------------------------------------------------------------
// 画像と HTML（`ファイル閲覧で画像とHTMLも表示する` テスト計画フェーズ5）
//
// ここでしか言えないのは「**本当に描かれるか**」と「**本当に外へ出ないか**」である。
// 細かい見え方は前のフェーズで済ませてある。
// ---------------------------------------------------------------------------

/** 左パネルを開いて、`MyDocs` の中の1件を選ぶところまで。 */
async function 開いて選ぶ(page: Page, name: string) {
  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)
  await group.click({ position: { x: 5, y: 5 } })
  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: name }).click()
  return panel
}

test('画像が実際に描かれる', async ({ page }) => {
  await 開いて選ぶ(page, PICTURE)

  const image = page.getByTestId('file-image')
  await expect(image).toBeVisible()
  // **要素が在ることを見ても足りない。** 描けていない画像も要素としては在る
  await expect
    .poll(async () => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0)
  await expect(page.getByTestId('file-meta')).toContainText('image/png')
})

test('理解doc と同じ作りの HTML が、箱の中で読める', async ({ page }) => {
  await 開いて選ぶ(page, DOCUMENT)

  const frame = page.getByTestId('file-frame')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('sandbox', '')

  const inside = page.frameLocator('[data-testid="file-frame"]')
  await expect(inside.locator('#見出し')).toHaveText('理解ドキュメント')
  // インライン `<style>` が効いていること（CSP の `style-src 'unsafe-inline'`）
  await expect
    .poll(async () =>
      inside.locator('#塗り').evaluate((el) => getComputedStyle(el).color),
    )
    .toBe('rgb(1, 2, 3)')
  // `data:` の画像とインライン SVG が出ること
  await expect
    .poll(async () =>
      inside.locator('#埋め込み').evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0)
  await expect
    .poll(async () =>
      inside.locator('#図形').evaluate((el) => el.getBoundingClientRect().width),
    )
    .toBeGreaterThan(0)
})

test('SVG も箱の中で描かれる', async ({ page }) => {
  await 開いて選ぶ(page, VECTOR)

  await expect(page.getByTestId('file-frame')).toHaveAttribute('sandbox', '')
  const inside = page.frameLocator('[data-testid="file-frame"]')
  await expect
    .poll(async () =>
      inside.locator('#四角').evaluate((el) => el.getBoundingClientRect().width),
    )
    .toBeGreaterThan(0)
})

/**
 * 外への読み込みを、**受け取る側で**数える。
 *
 * # なぜブラウザ側の出来事では言えないのか
 *
 * 実測で2通り踏んだ。**`request` は CSP に止められた要求でも上がり**（＝出たように
 * 見える）、**`requestfailed` は上がらない**（＝止めた証拠にもならない）。どちらも
 * 「網へ出たか」という問いに答えていない。
 *
 * **本物の受け口を立てて、そこへ1件でも届いたかを数える。** 届いていなければ
 * 出ていない、で議論の余地が無い。
 */
async function 外の受け口() {
  const http = await import('node:http')
  const 届いた: string[] = []
  const server = http.createServer((request, response) => {
    届いた.push(request.url ?? '(パスなし)')
    response.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('受け口の番号が分かりません')
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    届いた,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

test('隔離が効く——script が動かず、外へも出ない', async ({ page }) => {
  const 外 = await 外の受け口()
  // **宛先はここで焼き込む。** 受け口の番号は立ててみないと分からないので、
  // 材料もこの場で書く（固定の番号にすると、埋まっている機械で嘘の緑になる）
  const html = DANGEROUS_HTML.replace(OUTSIDE_MARK, `${外.origin}/beacon.png`)
  const 材料 = path.join(PROJECT_DIR, 'MyDocs', DANGEROUS)
  fs.writeFileSync(材料, html, 'utf8')

  try {
    await 開いて選ぶ(page, DANGEROUS)
    await expect(page.getByTestId('file-frame')).toBeVisible()

    const inside = page.frameLocator('[data-testid="file-frame"]')
    await expect(inside.locator('#印')).toHaveText('元のまま')
    // 描き終わってから数える。**先に数えると、まだ出ていないだけの0を見る**
    await expect
      .poll(async () =>
        inside.locator('#外').evaluate((el: HTMLImageElement) => el.complete),
      )
      .toBe(true)
    expect(外.届いた, '網へは1バイトも出ていないこと').toHaveLength(0)

    // **肯定側の裏取り。** 同じ材料が、隔離の外でなら動いて外へも出る。
    // これが無いと、材料の script が最初から壊れていても上は通る
    const control = await page.evaluate(async (source) => {
      const frame = document.createElement('iframe')
      frame.srcdoc = source
      document.body.appendChild(frame)
      await new Promise((done) => {
        frame.addEventListener('load', done, { once: true })
        setTimeout(done, 2000)
      })
      return frame.contentDocument?.getElementById('印')?.textContent ?? '(読めず)'
    }, html)
    expect(control, '隔離の外でなら、この材料の script は動く').toBe('書き換えられた')
    await expect
      .poll(() => 外.届いた.length, {
        message: '隔離の外でなら、この材料は外へ出る',
      })
      .toBeGreaterThan(0)
  } finally {
    await 外.close()
    // 材料を元へ戻す（次のテストが同じファイルを開く）
    fs.writeFileSync(材料, DANGEROUS_HTML, 'utf8')
  }
})

test('sandbox 属性を外しても、ヘッダだけで script は止まる', async ({ page }) => {
  // **二重の鍵の、片方ずつ。** 属性を外して初めて、CSP の `sandbox` 指令が
  // 効いているかを言える（設計§6-1）
  await 開いて選ぶ(page, DANGEROUS)
  await expect(page.getByTestId('file-frame')).toBeVisible()

  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      '[data-testid="file-frame"]',
    )
    if (frame === null) {
      throw new Error('箱が見つかりません')
    }
    frame.removeAttribute('sandbox')
    // 属性を外しただけでは読み込み直されない。同じ宛先へ入れ直す
    frame.src = `${frame.src}&再読み込み=1`
  })

  const inside = page.frameLocator('[data-testid="file-frame"]')
  await expect(inside.locator('#印')).toHaveText('元のまま')
})

test('壊れた画像でも画面は壊れない', async ({ page }) => {
  await 開いて選ぶ(page, BROKEN)

  // **断られたのとは別の言い方**（サーバは読めているので断っていない）
  await expect(page.getByTestId('file-broken')).toContainText('画像として読めません')
  await expect(page.getByTestId('file-error')).toHaveCount(0)
  // 画面そのものは生きている（パスのコピーは今までどおり押せる）
  await expect(page.getByTestId('file-copy')).toBeVisible()
})

test('上限を超える画像は、理由と大きさが出る', async ({ page }) => {
  // **開く前に置く。** 一覧はパネルを開いたときに1回読むだけなので、
  // 開いたあとに置いたファイルは行として現れない（押す相手が永久に出てこない）
  const huge = path.join(PROJECT_DIR, 'MyDocs', HUGE)
  fs.writeFileSync(huge, Buffer.alloc(8 * 1024 * 1024 + 1))
  try {
    await 開いて選ぶ(page, HUGE)
    const error = page.getByTestId('file-error')
    await expect(error).toBeVisible()
    await expect(error, '大きさが読めること').toContainText('8388609')
    // 描こうとしていないこと（断られた側の道を通っている）
    await expect(page.getByTestId('file-image')).toHaveCount(0)
  } finally {
    // **その場で消す。** 8 MiB を置きっぱなしにしない
    fs.rmSync(huge, { force: true })
  }
})

test('HTML でも生テキストと整形を行き来できる', async ({ page }) => {
  await 開いて選ぶ(page, DOCUMENT)
  await expect(page.getByTestId('file-frame')).toBeVisible()

  await page.getByTestId('file-toggle-raw').click()
  await expect(page.getByTestId('file-raw')).toContainText('<h1 id="見出し">')
  await expect(page.getByTestId('file-frame')).toHaveCount(0)

  await page.getByTestId('file-toggle-raw').click()
  await expect(page.getByTestId('file-frame')).toBeVisible()
})

test('狭い幅でも、画像と箱がページを横へはみ出させない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await 開いて選ぶ(page, PICTURE)
  await expect(page.getByTestId('file-image')).toBeVisible()

  const widths = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    window: window.innerWidth,
  }))
  expect(widths.body, 'ページ全体が横へはみ出さないこと').toBeLessThanOrEqual(
    widths.window,
  )
})

test('一覧の印が、種別ごとに分かれている', async ({ page }) => {
  // **単体テストは「印を引ける」までしか言えない。** 実際に行へ出ているかは、
  // 一覧を描いてみないと分からない
  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)
  await group.click({ position: { x: 5, y: 5 } })
  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()

  const 印 = async (name: string) =>
    panel
      .locator(`[data-testid="folder-entry"][data-name="${name}"]`)
      .getByTestId('folder-entry-icon')
      .textContent()

  const 画像 = await 印(PICTURE)
  const 文書 = await 印(DOCUMENT)
  const 計画 = await 印(PLAN)
  const 図 = await 印(VECTOR)

  expect(画像, '画像は画像の印').toBe('🖼️')
  expect(文書, 'HTML はそれと分かる印').toBe('🌐')
  expect(計画, 'Markdown はそれと分かる印').toBe('📝')
  expect(図, 'SVG は画像と同じ印').toBe(画像)
  // **3つが互いに違うこと。** 片方だけ変えて同じに戻すのを防ぐ
  expect(new Set([画像, 文書, 計画]).size).toBe(3)
})
