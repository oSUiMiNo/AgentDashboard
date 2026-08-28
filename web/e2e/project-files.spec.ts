import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  addProject,
  archiveAll,
  FIXTURES,
  openDashboard,
  spawnSession,
  WORK_DIR,
} from './helpers'

/** リポジトリの根。`fixtures/` の1つ上に居る。 */
const REPO_ROOT = path.resolve(FIXTURES, '..')

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
/**
 * 改行の見え方を確かめる材料（`構造化ビューでメッセージの改行が反映されない` 設計§5）。
 *
 * **このリポジトリのドキュメントの作法をそのまま写してある**——節の区切りに `<br/>` を
 * 2行、本文は折り返しのために行を分ける。**利用者が実際に開くのはこの形**なので、
 * ここが変わることが今回いちばん大きい見え方の変化になる。
 */
const BREAKS = '改行.md'

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
  // このテストの効き目になる。**上限（`MAX_FILE_BYTES` ＝ 3 MiB）の内側**に収める——
  // 超えると読まずに断られるので、遡りを1度も測れないまま緑になる
  const lines = Array.from({ length: 3_000 }, (_, at) => `- ${at + 1} 行目\n`)
  fs.writeFileSync(
    path.join(docs, LONG),
    `# 長い文書\n\n${lines.join('')}\n## ${TAIL}\n`,
    'utf8',
  )

  fs.writeFileSync(
    path.join(docs, BREAKS),
    '# 改行の見え方\n\n---\n<br/>\n<br/>\n\n## 節\nこの行と\nつぎの行は、折り返しのために分けてあるだけです。\n\n```\nコードの中\nここは触らない\n```\n',
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

  // 切り替えボタンでサイドバーが開く
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
 * **新しい口が無くても、古い方法が実物のブラウザで写す**
 * （イシュー `フォルダとファイル一覧のコピーボタンが効かない` §2 の層②）。
 *
 * # 設計は「E2E では言えない」としていたが、言えた
 *
 * 設計は「テストは `127.0.0.1` で走り、そこは常に安全なオリジンとして扱われるので
 * ②の経路を実物のブラウザで通す道が無い」と書いていた。**前半は正しいが、結論は
 * 違った**——`navigator.clipboard` を**こちらで外せば**、②はそのまま走る。
 *
 * # それでも実機が要る
 *
 * ここで言えるのは「**この Chromium で、この DOM の作りなら `execCommand` が写す**」
 * まで。**本当に安全でないオリジンで開いたときの挙動**と、**iOS Safari ／ Android
 * Chrome** は別物なので、そこは実機で見る（テスト計画【要人間】）。
 */
test('新しい口が無いとき、古い方法が実物のブラウザで写す', async ({ page }) => {
  // **`goto` より先に置く。** これは次の読み込みから効くので、あとからでは遅い
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
  })

  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)
  await group.click({ position: { x: 5, y: 5 } })
  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  await panel.getByTestId('folder-copy').first().click()

  // **写せている。** 直す前はここが「コピーできません」だった
  await expect(panel.getByTestId('folder-copy').first()).toHaveText(
    'コピーしました',
  )
  // 写せたのに逃げ道が出ると、押せていないように見える
  await expect(panel.getByTestId('folder-copy-failed')).toHaveCount(0)
})

/**
 * **どちらの口も無いとき、値を選べる形が実物のブラウザに出る**（同§5 の層③）。
 *
 * ②の寿命は保証されていない（MDN が明言）ので、**消えた日に手詰まりへ戻らない**
 * ことをここで押さえる。直す前の一覧は値が `title` の中にしか無く、
 * **`title` を読む操作が無いスマホでは取る手段が1つも残らなかった**。
 */
test('どちらの口も無いとき、一覧とファイルの両方で値を選べる形が出る', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(window.document, 'execCommand', {
      configurable: true,
      value: undefined,
    })
  })

  await openDashboard(page)
  const group = await addProject(page, PROJECT_DIR)
  await group.click({ position: { x: 5, y: 5 } })
  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await expect(panel).toBeVisible()

  // ① 一覧——**ここが今回の本体**
  await panel.getByTestId('folder-copy').first().click()
  await expect(panel.getByTestId('folder-copy-failed')).toBeVisible()
  // 起点は枠そのものなので、最初の行は枠直下のフォルダ。**末尾に `/` が付く**
  await expect(panel.getByTestId('folder-copy-fallback')).toHaveText('MyDocs/')

  // ② ファイルの画面——今までどおり出ること（片方だけ直っていないこと）
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: PLAN }).click()
  const view = page.getByTestId('file-view')
  await view.getByTestId('file-copy').click()
  await expect(view.getByTestId('file-copied')).toContainText('コピーできません')
  await expect(view.getByTestId('file-copy-fallback')).toHaveText(
    `MyDocs/${PLAN}`,
  )
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
test('ファイルでも、素の改行と `<br/>` が改行として出る', async ({ page }) => {
  // **履歴と同じ配列を使っている**ことの現れ（`構造化ビューでメッセージの改行が
  // 反映されない` 設計§5）。`skipHtml` は rehype の**あと**に効くので、`<br/>` は
  // 先に `br` 要素へ変わって残る——**このリポジトリの文書が意図した行間が戻る**
  await 開いて選ぶ(page, BREAKS)

  const view = page.getByTestId('file-markdown')
  await expect(view).toBeVisible()
  // 行頭の `<br/>` が2つ ＋ 折り返しの改行が1つ
  await expect(view.locator('br')).toHaveCount(3)
  // 囲みコードの中では増えない
  await expect(view.locator('pre br')).toHaveCount(0)
  // `skipHtml` は効いたまま（字面としては出ない）
  await expect(view).not.toContainText('<br')

  // **見え方の良し悪しは目でしか言えない**（設計§10 の【要人間】）。判断できるよう
  // 1枚だけ残す。置き場所は git 管理外なので、配るものには混ざらない
  await view.screenshot({
    path: path.join(
      REPO_ROOT,
      'MyDocs/ローカルイシュー/構造化ビューでメッセージの改行が反映されない/見え方-改行あり.png',
    ),
  })
})

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

/*
  ここから下は `イシューグループ_2026-0826-1146`（ファイルのパネルの置き場所と幅。
  テスト計画フェーズ4）。**縁で幅が変わること**と、**狭い画面で縁を出さないこと**を通す。

  上の既存分と合わせて、この1ファイルが「移設で壊していないこと」と「新しくできること」
  の両方を持つ。
*/

/** 幅を測る。**`getBoundingClientRect` で実際の見た目を見る**（クラス名では言えない）。 */
async function 幅(box: Locator): Promise<number> {
  const rect = await box.boundingBox()
  if (!rect) {
    throw new Error('位置が取れません')
  }
  return rect.width
}

/** 位置ごと欲しいとき。**押しのけているかは、幅ではなく左端で分かる。** */
async function 矩形(box: Locator) {
  const rect = await box.boundingBox()
  if (!rect) {
    throw new Error('位置が取れません')
  }
  return rect
}

/** 左端。押しのけの前後で比べるためだけに使う。 */
async function 左端(box: Locator): Promise<number> {
  return (await 矩形(box)).x
}

/** 縁をマウスで掴んで動かす。**しきい値（3px）を必ず超える刻みで運ぶ。** */
async function 縁を引く(page: Page, edge: 'folder' | 'file', dx: number) {
  const 縁 = page.locator(`[data-testid="files-resizer"][data-edge="${edge}"]`)
  const box = await 縁.boundingBox()
  if (!box) {
    throw new Error('縁の位置が取れません')
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(x + (dx * step) / 8, y)
  }
  await page.mouse.up()
}

/**
 * 縁を**指で**掴んで動かす。
 *
 * **CDP でしか合成できない**（`swipeTerminal` と同じ理由）。`page.dispatchEvent` は
 * リスナーへ届きはするが既定動作が一切起きないので、**握れているかを一度も確かめない
 * まま緑になる**。
 *
 * `jitter` を入れるのは、**実機の指が真っ直ぐ動かない**ため。真っ直ぐな合成タッチ
 * だけだと、壊した状態でも通ることが既存イシューで実測されている（2px と 12px では
 * 通り、30px で初めて落ちた）。
 */
async function 縁を指で引く(
  page: Page,
  edge: 'folder' | 'file',
  dx: number,
  jitter = 30,
) {
  const 縁 = page.locator(`[data-testid="files-resizer"][data-edge="${edge}"]`)
  const box = await 縁.boundingBox()
  if (!box) {
    throw new Error('縁の位置が取れません')
  }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y }],
    })
    // **縦にも振れる小さな1回目。** ここで向きを取り違える実装だと、そのなぞりは
    // 二度と握れない
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 4, y: y + jitter }],
    })
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x + (dx * step) / 8, y: y + (step % 2 === 0 ? jitter : -jitter) },
        ],
      })
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
  } finally {
    await cdp.detach()
  }
}

test('縁を掴むと、フォルダの幅が実際に変わる', async ({ page }) => {
  await openDashboard(page)
  await openLongFile(page)
  const panel = page.getByTestId('project-files-panel')

  const 前 = await 幅(panel)
  expect(前, '既定は 20rem').toBeCloseTo(320, 0)

  await 縁を引く(page, 'folder', 80)

  const 後 = await 幅(panel)
  expect(後, '引いたぶん広がること').toBeGreaterThan(前)
  expect(後).toBeCloseTo(400, 0)
})

test('縁を掴むと、ファイルの中身の列の幅も変わる', async ({ page }) => {
  await openDashboard(page)
  await openLongFile(page)
  const column = page.getByTestId('file-column')

  const 前 = await 幅(column)
  await 縁を引く(page, 'file', -100)

  expect(await 幅(column), '左へ引けば縮むこと').toBeLessThan(前)
})

test('広い窓では、サイドバーが被さらずに右のものを押しのける', async ({
  page,
}) => {
  /*
    **計画フェーズ7 の本体。** 0.1.41 までは広い窓でも被せていたが、サイドバーは
    ファイルを選んでも畳まないので**開いたまま読む時間が長い**——被さっている限り、
    その裏のファイルの中身は読めない。

    **「見えているか」では言えない。** ずれずに被さっていても、手前のパネルは普通に
    描かれるので画面は破綻しない。**左端を数字で測り、重なっていないことまで見る。**

    レールはセッションが1本も無いと描かれないので、ここだけは起こしてから測る。
  */
  await openDashboard(page)
  await spawnSession(page, PROJECT_DIR)
  const group = page.locator(
    `[data-testid="project-group"][data-project="${PROJECT_DIR}"]`,
  )
  await group.click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: LONG }).click()
  const column = page.getByTestId('file-column')
  const rail = page.getByTestId('group-rail')
  await expect(column).toBeVisible()

  // **畳んだ状態を基準にする。** 開いた側だけ見ても、寄ったのかどうかは言えない
  await page.getByTestId('project-files-toggle').click()
  await expect(panel).toBeHidden()
  const 畳んだときの列 = await 左端(column)
  const 畳んだときのレール = await 左端(rail)

  await page.getByTestId('project-files-toggle').click()
  await expect(panel).toBeVisible()

  /*
    **滑り終わるまで待つ**（220ms のスライド）。「増えたか」で待つと**1フレーム目で
    条件が満たされ、途中の値を掴む**——実際に踏んだ（336 のところで 285 を測った）。
    **落ち着いた値そのもので待つ。**

    寄る量は**フォルダの幅（既定 320）＋ 列のあいだの間隔（`gap-4` ＝ 16）**。
    場所取りがフォルダと同じ幅を取るので、この足し算で決まる
  */
  await expect
    .poll(async () => Math.round((await 左端(column)) - 畳んだときの列), {
      message: '中身の列が、フォルダの幅ぶん右へ寄ること',
    })
    .toBe(336)
  expect(
    (await 左端(rail)) - 畳んだときのレール,
    'セッションのレールも同じだけ寄ること',
  ).toBeCloseTo(336, -1)

  // **被さっていないこと。** 寄ったうえで、なお重なっていたら押しのけていない
  const サイドバー = await 矩形(panel)
  expect(
    サイドバー.x + サイドバー.width,
    'サイドバーの右端が、中身の列の左端を越えないこと',
  ).toBeLessThanOrEqual((await 左端(column)) + 1)
})

test('下限より狭くも、上限より広くもできない', async ({ page }) => {
  await openDashboard(page)
  await openLongFile(page)
  const panel = page.getByTestId('project-files-panel')

  // 思い切り左へ。**0 にはならない**——畳むのは切り替えボタンの仕事（設計§4）
  await 縁を引く(page, 'folder', -2000)
  const 狭いとき = await 幅(panel)
  expect(狭いとき, '下限（10rem）で止まること').toBeCloseTo(160, 0)

  // 思い切り右へ。上限は絶対値（40rem）と画面比（40%）の狭いほう
  await 縁を引く(page, 'folder', 4000)
  const 広いとき = await 幅(panel)
  expect(広いとき).toBeGreaterThan(狭いとき)
  expect(広いとき, '上限を超えないこと').toBeLessThanOrEqual(640)

  // **ページ全体が横へはみ出さないこと。** 幅を広げても破れない
  const overflows = await page.evaluate(() => {
    const de = document.documentElement
    return de.scrollWidth > de.clientWidth
  })
  expect(overflows, '上限が効いていればページは横へ広がらない').toBe(false)
})

test('変えた幅は、読み込み直しても残る', async ({ page }) => {
  await openDashboard(page)
  await openLongFile(page)
  const panel = page.getByTestId('project-files-panel')

  await 縁を引く(page, 'folder', 120)
  const 変えた幅 = await 幅(panel)
  expect(変えた幅).toBeGreaterThan(400)

  await page.reload()
  await page.getByTestId('project-files-toggle').click()
  await expect(page.getByTestId('project-files-panel')).toBeVisible()

  // **離した時点の値が正**（設計§5）。読み込み直しても同じ幅で始まる
  expect(await 幅(page.getByTestId('project-files-panel'))).toBeCloseTo(
    変えた幅,
    0,
  )
})

test('縁は指でも掴める', async ({ page }) => {
  // **`touch-action: none` と「1回目で握る」が両方効いていないと、ここで落ちる。**
  // 単体テストは「そう書いてある」までしか言えない
  await openDashboard(page)
  await openLongFile(page)
  const panel = page.getByTestId('project-files-panel')

  const 前 = await 幅(panel)
  await 縁を指で引く(page, 'folder', 90)

  expect(await 幅(panel), '指でも広がること').toBeGreaterThan(前)
})

test('狭い画面では、サイドバーは左端の帯で、裏が見えている', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  await openLongFile(page)

  /*
    **2026-08-28 に期待が変わった。** それまでは「両方が全幅の層になる」ことを
    見ていたが、実機で触って3つの不具合になった——裏が何も見えない・アプリの
    ヘッダごと覆うので切り替えボタンへ届かない・被さっているのか画面が切り替わった
    のか分からない。利用者が示した参考（ChatGPT のウェブアプリ）に合わせた。

    **縁は出ない**のは変わらない。`md` を JS から読まない約束（`lib/pointer.ts` の
    「画面幅では判定しない」）なので、出し分けは CSS（`hidden md:block`）がやる
    ——DOM には居たまま `display: none` になる
  */
  for (const 縁 of await page.getByTestId('files-resizer').all()) {
    await expect(縁).toBeHidden()
  }

  const panel = page.getByTestId('project-files-panel')
  const 帯 = await 矩形(panel)
  expect(帯.width, 'サイドバーは 20rem の帯（全画面にしない）').toBeCloseTo(320, 0)
  /*
    **これが「裏が見えている」の本体。** 幅だけ見ても足りない——左端から出ているので、
    **右端が画面の端に届いていないこと**まで見て初めて言える
  */
  expect(帯.x + 帯.width, '右端が画面の端に届いていないこと').toBeLessThan(390)

  await expect(page.getByTestId('project-files-close')).toBeInViewport()

  /*
    **膜が画面全体を覆っていること。** 裏がそのままの明るさだと、被さっているのか
    画面が切り替わったのか分からない（参考の実測：ヘッダも本文も入力欄も、同じ比で
    約半分の明るさへ落ちていた）
  */
  const 膜 = await 矩形(page.getByTestId('sidebar-scrim'))
  expect(膜.width, '膜は画面いっぱい').toBeCloseTo(390, 0)
  expect(膜.height, '膜は画面いっぱい').toBeCloseTo(780, 0)

  // **膜を押しても畳める。** 押しても何も起きない膜は行き止まりになる
  await page.mouse.click(370, 400)
  await expect(panel).toBeHidden()
})

test('狭い画面でファイルを開いても、切り替えボタンへ届く', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  await openLongFile(page)

  /*
    **中身の列が全画面の層だったとき、ここが塞がっていた**（2026-08-28 に実機で踏んだ）。
    列がアプリのヘッダごと覆うので、サイドバーを開き直す道が無くなる。

    **「在ること」では言えない。** 覆われていても DOM には居るので、`toBeVisible` は
    通ってしまう。**実際に押して**、Playwright の届くかどうかの判定に任せる
  */
  await page.getByTestId('project-files-close').click()
  await expect(page.getByTestId('project-files-panel')).toBeHidden()
  await expect(page.getByTestId('file-column')).toBeVisible()

  await page.getByTestId('project-files-toggle').click({ timeout: 3000 })
  await expect(page.getByTestId('project-files-panel')).toBeVisible()
})

test('狭い画面でも、中身の列はセッションの札と同じ幅で流れる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await openDashboard(page)
  await openLongFile(page)
  await page.getByTestId('project-files-close').click()

  /*
    **窓の幅で作りを分けない**（2026-08-28）。セッションの札は狭い窓でも 672px 固定の
    まま横スクロールするので、中身の列も同じにする——**列だけ全画面になるのが
    おかしかった。**
  */
  const column = page.getByTestId('file-column')
  expect(await 幅(column), '札と同じ 42rem').toBeCloseTo(672, 0)

  // 札より広いのに、**ページは横へ広がらない**（レールの中で流れる）
  const overflows = await page.evaluate(() => {
    const de = document.documentElement
    return de.scrollWidth > de.clientWidth
  })
  expect(overflows, '狭い画面でもページは横へ広がらない').toBe(false)

  const rail = page.getByTestId('group-rail')
  const 流した = await rail.evaluate((el) => {
    el.scrollLeft = 9999
    return el.scrollLeft
  })
  expect(流した, 'レールの中で実際に流せること').toBeGreaterThan(0)
})

test('セッションを横へ流すと、中身の列も一緒に流れる', async ({ page }) => {
  /*
    **計画フェーズ8 の本体。** 0.1.44 までは中身の列だけレールの外に固定してあり、
    セッションを横へ流しても**その場に残っていた**。列もセッションの札と同じ扱いに
    する、というのが今回の要望である。

    **手放したものがある。** 「流しても見えたままなので、どのセッションへでもパスを
    貼れる」という利点を**意図して捨てた**（利用者の判断）。**不具合ではない。**

    レールが実際に溢れる必要があるので、セッションを起こしてから測る。
  */
  await openDashboard(page)
  await spawnSession(page, PROJECT_DIR)
  const group = page.locator(
    `[data-testid="project-group"][data-project="${PROJECT_DIR}"]`,
  )
  await group.click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: LONG }).click()
  const column = page.getByTestId('file-column')
  await expect(column).toBeVisible()

  // サイドバーを畳む——被さったままだと測る対象が隠れる
  await page.getByTestId('project-files-toggle').click()
  await expect(panel).toBeHidden()

  const rail = page.getByTestId('group-rail')
  const 流す前 = await 左端(column)

  /*
    **流せる量は決め打ちできない。** 列（既定 672）と札（672）が窓に対してどれだけ
    溢れるかは窓の幅で決まる（実測で 96px だった）。**大きい値を入れて、ブラウザが
    実際に止まった位置を読み直す。**
  */
  const 流した = await rail.evaluate((el) => {
    el.scrollLeft = 9999
    return el.scrollLeft
  })
  expect(流した, 'レールが実際に溢れていること（溢れていないと何も言えない）').toBeGreaterThan(0)

  /*
    **レールの中に居れば、流した量だけ左へ動く。** 外に固定してあると
    **1ピクセルも動かない**——そこがこのテストの見張っているところ。
  */
  await expect
    .poll(async () => Math.round(流す前 - (await 左端(column))), {
      message: '中身の列が、セッションと一緒に流れること',
    })
    .toBe(流した)
})

test('セッションが0本でも、ファイルを開けば中身が出る', async ({ page }) => {
  /*
    **列をレールの中へ入れたことで生まれた穴を塞ぐ**（計画フェーズ8）。レールは
    以前「セッションが1本も無ければ描かない」作りだったので、そのままだと**0本の
    PJT でファイルを開いても何も出なくなる。**

    セッションを1本も起こさずに開く、というのがこの PJT のふつうの初期状態なので、
    塞ぎ損ねると**いちばん最初に触った人が壊れた画面を見る。**
  */
  await openDashboard(page)
  await openLongFile(page)

  await expect(page.getByTestId('group-rail')).toBeVisible()
  await expect(page.getByTestId('file-column')).toBeVisible()
  await expect(page.getByTestId('file-view')).toBeVisible()
  // セッションは1枚も無い。それでも中身は読める
  await expect(page.getByTestId('session-tile')).toHaveCount(0)
})

test('中身の列の上で横へ回すと、セッションのレールが動く', async ({ page }) => {
  // **列はレールの兄弟**なので、ブラウザのスクロール連鎖（祖先だけを辿る）では
  // ここへ届かない。自分で渡している（設計§8）。
  //
  // **レールはセッションが1本も無いと描かれない**ので、ここだけは起こしてから測る。
  // 横並び1区画は 42rem 固定なので、中身の列（既定 42rem）と並べば必ず溢れる
  await openDashboard(page)
  await spawnSession(page, PROJECT_DIR)
  const group = page.locator(
    `[data-testid="project-group"][data-project="${PROJECT_DIR}"]`,
  )
  await group.click({ position: { x: 5, y: 5 } })
  await expect(page.getByTestId('group-view')).toBeVisible()

  await page.getByTestId('project-files-toggle').click()
  const panel = page.getByTestId('project-files-panel')
  await panel.getByTestId('folder-entry').filter({ hasText: 'MyDocs' }).click()
  await panel.getByTestId('folder-entry').filter({ hasText: LONG }).click()
  await expect(page.getByTestId('file-column')).toBeVisible()
  // フォルダを畳む——被さったままだと列の上を押せない
  await page.getByTestId('project-files-toggle').click()
  await expect(panel).toBeHidden()

  const rail = page.getByTestId('group-rail')
  const 前 = await rail.evaluate((el) => el.scrollLeft)

  await page.getByTestId('file-column').hover()
  await page.mouse.wheel(200, 0)

  await expect
    .poll(async () => rail.evaluate((el) => el.scrollLeft), {
      message: '横ホイールがレールへ届くこと',
    })
    .toBeGreaterThan(前)
})

test('生テキストの上では、その中が横へ動く', async ({ page }) => {
  // 列の中に横スクロールを持つのはここだけ。**素通しにすると、読みたい行の続きが
  // 読めないままレールが流れる**（設計§8）
  await openDashboard(page)
  await openLongFile(page)
  await page.getByTestId('file-toggle-raw').click()

  const pre = page.getByTestId('file-raw')
  await expect(pre).toBeVisible()

  const 横へ動けるか = await pre.evaluate(
    (el) => getComputedStyle(el).overflowX,
  )
  expect(横へ動けるか, '生テキストは自分で横へ動く').toMatch(/auto|scroll/)
})
