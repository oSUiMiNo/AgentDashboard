import { expect, test } from '@playwright/test'
import { BODY_FOLD_GRACE_LINES } from '../src/lib/markdown'
import {
  archiveAll,
  dequeue,
  enqueue,
  FIXTURES,
  fireHook,
  openDashboard,
  openSession,
  reply,
  say,
  setTerminalView,
  showTerminal,
  showTranscript,
  spawnSession,
  writeTranscript,
} from './helpers'

/**
 * 構造化ビューの通し確認（フェーズ3 / M3）。
 *
 * 実物のフィクスチャ（本物の claude が書いた JSONL）を擬似 claude に書かせ、
 * 「フック → パーサ → WebSocket → 画面」を端から端まで通す。単体テストは各層の中しか
 * 見ないので、経路が繋がっているかはここでしか分からない。
 */

/**
 * 履歴が届いたあとの判定に与える待ち（`積み残し_運用/要件.md` §8 の案A）。
 *
 * **`toBeVisible(届くまで)` の既定は5秒で、この画面ではそれでは足りない。** 履歴が届いた合図
 * （`data-row-count > 0`）が出た時点では**まだ行が流れ込んでいる最中**なので、重い通し
 * では後続の判定だけが間に合わない。7回落ちていて、失敗時のスナップショットには
 * **待っていた行が写っている**——出なかったのではなく、5秒を僅かに超えてから出た。
 *
 * **届く判定と同じ待ちを、行を見る判定にも与える。** 名前を付けてあるのは、次に足す人が
 * 揃えやすいようにするため。**素の `toBeVisible(届くまで)` をこのファイルへ足さないこと。**
 */
const 届くまで = { timeout: 30_000 }

test.afterEach(async ({ page }) => {
  await archiveAll(page)
})

/** セッションを起動し、トランスクリプトの場所を core に知らせるところまで。 */
async function startSession(page: Parameters<typeof openDashboard>[0]) {
  await openDashboard(page)
  const tile = await spawnSession(page)
  await openSession(page, tile)
  return tile
}

test('フィクスチャの履歴が構造化ビューに出る', async ({ page }) => {
  await startSession(page)

  // まだ何も書いていないので空
  await showTranscript(page)
  await expect(page.getByTestId('transcript-status')).toHaveAttribute('data-row-count', '0')

  // 打ち込む先は端末なので、書かせるときはターミナルへ戻す
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')

  await showTranscript(page)
  await expect
    .poll(
      async () =>
        Number(
          await page.getByTestId('transcript-status').getAttribute('data-row-count'),
        ),
      { message: '履歴が届くこと', timeout: 30_000 },
    )
    .toBeGreaterThan(0)

  // ユーザの指示とアシスタントの本文が根に並ぶ
  await expect(page.locator('[data-testid="transcript-row"][data-kind="user_message"]')).toHaveCount(
    1,
  )
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="assistant_text"]').first(),
  ).toBeVisible(届くまで)
})

/**
 * まとめ行を、畳まれているものが無くなるまで開く。
 *
 * **ツールコールは1行ずつ並んでいない**（イシューグループ_2026-0820-2129 設計§2）。
 * 発言と発言の間の活動は**まとめ行1つ**に束ねられているので、開かないと `tool_call` の
 * 行は画面に1つも出ない。**開くと中から別のまとめ行が出てくることがある**（サブエージェント
 * の中など）ので、1周では足りない——「畳まれたまとめ行が無い」を条件に回す。
 */
async function openActivities(page: Parameters<typeof openDashboard>[0]) {
  const collapsed = page.locator(
    '[data-testid="transcript-row"][data-kind="activity"][data-expanded="false"]',
  )
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="activity"]').first(),
  ).toBeVisible(届くまで)

  // 上限は青天井にしない。開いても減らない形になったら、そこで止めて落とす
  for (let guard = 0; guard < 30; guard += 1) {
    if ((await collapsed.count()) === 0) {
      return
    }
    await collapsed.first().getByRole('button').first().click()
  }
  throw new Error('まとめ行を開き切れなかった（開いても畳まれたままの行が残っている）')
}

test('ツールコールを開くとコードの差分が出る', async ({ page }) => {
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await showTranscript(page)

  // Edit のツールコールを探して開く。**まず、それを抱えているまとめ行を開く**
  await openActivities(page)
  const editRow = page
    .locator('[data-testid="transcript-row"][data-kind="tool_call"]')
    .filter({ hasText: 'Edit' })
    .first()
  await expect(editRow).toBeVisible(届くまで)
  await editRow.getByRole('button').first().click()

  await expect(editRow.getByTestId('diff-view')).toBeVisible(届くまで)
  // 差分の中身（消えた行・増えた行）が実際に描かれている
  await expect(editRow.getByTestId('diff-view')).toContainText('TODO')
})

test('サブエージェントの中まで掘れる', async ({ page }) => {
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/subagent/session.jsonl')
  await showTranscript(page)

  await openActivities(page)
  const agentRow = page
    .locator('[data-testid="transcript-row"][data-kind="tool_call"]')
    .filter({ hasText: 'Agent' })
    .first()
  await expect(agentRow).toBeVisible(届くまで)
  await agentRow.getByRole('button').first().click()

  // サブエージェントの行が現れ、開くとその中の作業が見える
  const subagent = page.locator('[data-testid="transcript-row"][data-kind="subagent"]').first()
  await expect(subagent).toBeVisible(届くまで)
  await subagent.getByRole('button').first().click()
  // **中の作業も、また束ねられている。** ここを開き直さないと `Glob` は出てこない
  await openActivities(page)
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="tool_call"]').filter({
      hasText: 'Glob',
    }),
  ).toBeVisible(届くまで)
})

test('巻き戻し前のやりとりは畳まれ、開けば読める', async ({ page }) => {
  // `/rewind` は JSONL を物理的に巻き戻さず、同じファイルに2つ目の根として追記する
  // （設計§16 の実測）。そのまま全部並べると「巻き戻したのに前のやりとりが見えている」
  // という見え方になる
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'synthetic/rewound/session.jsonl')
  await showTranscript(page)

  const rewound = page.locator('[data-testid="transcript-row"][data-kind="rewound"]')
  await expect(rewound).toBeVisible(届くまで)
  await expect(rewound).toContainText('巻き戻し前のやりとり 2件')

  // 畳んでいる間は、最新の枝の発言だけが見える
  await expect(
    page.getByText('やっぱり2つ目の TODO のほうを書き換えて。').first(),
  ).toBeVisible(届くまで)
  await expect(page.getByText('notes.md の1つ目の TODO を DONE に書き換えて。')).toHaveCount(0)

  // 開けば読める（捨ててはいない）
  await page.getByTestId('rewound-toggle').click()
  await expect(
    page.getByText('notes.md の1つ目の TODO を DONE に書き換えて。').first(),
  ).toBeVisible(届くまで)
})

/**
 * 本文の見せ方（イシューグループ_2026-0813-2208 テスト計画フェーズ5）。
 *
 * 単体では各層の中しか見ない。**パーサ → WebSocket → 画面が端から端まで繋がったこと**は
 * ここでしか分からない。使うのは狙って作った合成フィクスチャで、**切れ目が記法の途中へ
 * 来るように長さを合わせてある**（実物では境目を作れない）。
 */
async function loadBodies(page: Parameters<typeof openDashboard>[0], fixture: string) {
  await startSession(page)
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, fixture)
  await showTranscript(page)
  await expect
    .poll(
      async () =>
        Number(await page.getByTestId('transcript-status').getAttribute('data-row-count')),
      { message: '履歴が届くこと', timeout: 30_000 },
    )
    .toBeGreaterThan(0)
}

async function loadMarkdownBodies(page: Parameters<typeof openDashboard>[0]) {
  await loadBodies(page, 'synthetic/markdown-bodies/session.jsonl')
}

/**
 * 改行の形を1枚へ集めたフィクスチャ。**畳まれない長さにしてある**ので、数がぶれない
 * （畳むと切れ目の位置で `br` の数が変わる）。
 */
async function loadSoftBreaks(page: Parameters<typeof openDashboard>[0]) {
  await loadBodies(page, 'synthetic/softbreaks/session.jsonl')
}

/**
 * しきい値の境目を4本並べたフィクスチャ（実効行数 74／78／81／201）。
 *
 * **`markdown-bodies` は使えない。** あちらの最長は実効69行で、行数で測るようになってからは
 * **畳まれる側に入らない**（イシューグループ_2026-0820-2129 フェーズ2）。
 */
async function loadFoldLines(page: Parameters<typeof openDashboard>[0]) {
  await loadBodies(page, 'synthetic/fold-lines/session.jsonl')
}

/** 畳む相手の行（しきい値を超えた本文）。 */
function foldableRow(page: Parameters<typeof openDashboard>[0]) {
  return page.locator('[data-testid="transcript-row"][data-foldable="true"]').first()
}

test('長い本文は畳まれて出て、押すと全文になる', async ({ page }) => {
  await loadFoldLines(page)

  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)
  await expect(row).toHaveAttribute('data-body-open', 'false')

  const folded = (await row.innerText()).length
  await row.getByTestId('body-toggle').click()

  await expect(row).toHaveAttribute('data-body-open', 'true')
  expect((await row.innerText()).length).toBeGreaterThan(folded)
})

/*
 * 畳んだ本文の末尾に敷くフェード（設計§6 / テスト計画フェーズ5「マスク」）。
 *
 * **jsdom では確かめられない。** `mask-image` は描かれて初めて効き、帯の高さも行の高さも
 * 実際に組版しないと出ない。ここは実物のブラウザでしか通らない道である。
 *
 * 土台は `synthetic/fold-lines`。本文が
 * **74行（しきい値の下）／78行（猶予の中）／81行（畳む・残り6行）／201行（2段目・残り191行）**
 * になっており、**出ない・出ない・浅い・深い**が1枚で揃う。
 *
 * **フェーズ8 で1本足した。** 囲みコードの直後で切れる本文（設計§6-5）で、畳まれる側なので
 * フェードの数が1つ増える。**中身の無い思考は別の土台（`synthetic/empty-thinking`）にした**
 * ——ここへ足すと末尾に付き、**仮想化で窓の外へ出て DOM に現れない**。
 */
test('フェードは畳んだ行にだけ出る（猶予に入った行には出ない）', async ({ page }) => {
  await loadFoldLines(page)
  await expect(foldableRow(page)).toBeVisible(届くまで)

  // 畳んだ本文にだけ付く
  const faded = page.locator('[data-testid="row-body"][data-fade]')
  await expect(faded).toHaveCount(3)

  // **畳んでいない行には、猶予に入ったものを含めて出ない。**
  // ここが崩れると「フェードしている＝まだ続きがある」が嘘になる（設計§6-4）
  const 畳まない行 = page.locator(
    '[data-testid="transcript-row"][data-kind="assistant_text"][data-foldable="false"]',
  )
  await expect(畳まない行).toHaveCount(2)
  await expect(畳まない行.locator('[data-testid="row-body"][data-fade]')).toHaveCount(0)
})

test('残りの量で段が変わり、変わるのはかかり始める位置だけ', async ({ page }) => {
  await loadFoldLines(page)
  await expect(foldableRow(page)).toBeVisible(届くまで)

  const 帯の高さ = async (depth: string) =>
    page.locator(`[data-testid="row-body"][data-fade="${depth}"]`).evaluate((el) => {
      const probe = document.createElement('div')
      probe.style.height = 'var(--fade-band)'
      el.append(probe)
      const height = probe.getBoundingClientRect().height
      probe.remove()
      return height
    })

  const 浅い = await 帯の高さ('shallow')
  const 深い = await 帯の高さ('deep')
  expect(深い).toBeGreaterThan(浅い)

  // **濃さも色も変えていない**こと（設計§6-3）。段で変わるのは帯の高さだけである
  const 濃さと色 = async (depth: string) =>
    page
      .locator(`[data-testid="row-body"][data-fade="${depth}"]`)
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return { color: style.color, opacity: style.opacity }
      })
  expect(await 濃さと色('shallow')).toEqual(await 濃さと色('deep'))
})

test('フェードは色を持ち、地を配らずにどの地の上でも成り立つ', async ({ page }) => {
  // **この検査が守っているのは「`::after` が無いこと」ではない**（設計§6-6-5）。
  // 守っているのは**「地の色を決め打って、それに溶けようとしていないこと」**である。
  // 色を持たせた結果 `::after` は戻ったが、性質は変わっていないので、そちらを見る。
  //
  // 半透明の膜は**どんな地の上でもその地を色づけるだけ**なので、地を配る必要が無い。
  // 不透明で塗り潰すと下の地を隠し、コードブロックの上で矩形が浮く（フェーズ7 の失敗）。
  await loadFoldLines(page)
  await expect(foldableRow(page)).toBeVisible()

  const body = page.locator('[data-testid="row-body"][data-fade]').first()
  // **帯は器そのものに敷く**（フェーズ11・設計§6-7-2）。本文の箱に敷くと、吹き出しの
  // 内側余白のぶんだけ左右と下が届かず「中に貼った紙」に見える。
  // **`::before` で読む**——しっぽが `::after` を使っているので、同じ器では衝突する
  const 帯 = await body.evaluate((el) => {
    const shell = el.parentElement
    if (!shell) {
      throw new Error('帯の器が見つからない')
    }
    const band = getComputedStyle(shell, '::before')
    return {
      image: band.backgroundImage,
      events: band.pointerEvents,
      器にある: shell.classList.contains('body-fade'),
      本文の箱にない: !el.classList.contains('body-fade'),
    }
  })
  expect(帯.器にある).toBe(true)
  expect(帯.本文の箱にない).toBe(true)

  // 色が乗っていること。**畳まれていることを、色で見分けられる**
  expect(帯.image).not.toBe('none')
  // **見た目のためだけに重ねるものは、押す判定を素通しさせる**
  expect(帯.events).toBe('none')

  // **行き先が地の色ではないこと。** 塗った結果の色で見る（変数の字面ではない）
  const 塗った色 = await body.evaluate((el) => {
    const probe = document.createElement('div')
    el.append(probe)
    const read = (value: string) => {
      probe.style.background = value
      return getComputedStyle(probe).backgroundColor
    }
    const tint = read('var(--fade-tint)')
    const background = read('var(--color-background)')
    const muted = read('var(--color-muted)')
    // **書式に依存しない取り方をする。** `color-mix` の計算値は `rgba(…)` ではなく
    // `oklch(… / 0.16)` の形で返ることがあり、`rgba` 前提で読むと**不透明と誤読する**
    const alpha = Number(/[/,]\s*([\d.]+)\s*\)\s*$/.exec(tint)?.[1] ?? '1')
    probe.remove()
    return { tint, background, muted, alpha }
  })
  expect(塗った色.tint).not.toBe(塗った色.background)
  expect(塗った色.tint).not.toBe(塗った色.muted)
  // **半透明であること。** 不透明だと、下に何があっても同じ矩形になる
  expect(塗った色.alpha).toBeLessThan(1)

  // 文字を消すのは内側の層である（マスクは擬似要素も消すので、同じ要素に置けない）
  const 内側にマスク = await body.evaluate((el) => {
    const inner = el.querySelector('.body-fade-text')
    if (!inner) {
      return false
    }
    const style = getComputedStyle(inner)
    return style.maskImage !== 'none' || style.webkitMaskImage !== 'none'
  })
  expect(内側にマスク).toBe(true)
})

test('吹き出しにしっぽがあり、地が本体と一致する', async ({ page }) => {
  // **`clip-path` を使っていないこと**を、押せることで見る（設計§5-4-1）。
  // 当たり判定に効くのは `clip-path` であって `mask` ではないので、`clip-path` で
  // 形を切ると**しっぽの周りだけ反応しない吹き出し**になる。
  await loadFoldLines(page)
  const bubble = page.getByTestId('user-bubble').first()
  await expect(bubble).toBeVisible()

  const 見た目 = await bubble.evaluate((el) => {
    const self = getComputedStyle(el)
    const tail = getComputedStyle(el, '::after')
    return {
      clip: self.clipPath,
      radius: self.borderTopLeftRadius,
      tailRadius: self.borderTopRightRadius,
      tailContent: tail.content,
      tailEvents: tail.pointerEvents,
      本体の地: self.backgroundColor,
      しっぽの地: tail.backgroundColor,
    }
  })

  expect(見た目.clip).toBe('none')
  expect(見た目.tailContent).not.toBe('none')
  expect(見た目.tailEvents).toBe('none')
  // 右上だけ角丸をやめ、しっぽを立てる
  expect(見た目.tailRadius).toBe('0px')
  expect(見た目.radius).not.toBe('0px')
  // **地は1箇所から取る。** 2箇所に書くと、片方だけ直したときにずれる
  expect(見た目.しっぽの地).toBe(見た目.本体の地)
})

test('フェードは行の高さを変えない', async ({ page }) => {
  // 仮想化は行の高さを実測して覚えている。マスクが高さを動かすと、覚えた値が全部ずれる
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const 高さ = async () => (await row.boundingBox())?.height ?? 0
  const 敷いたまま = await 高さ()

  // **器から外す。** 帯は器に敷いてあるので、本文の箱から外しても何も起きない
  // （フェーズ11 以前の書き方のまま残すと、この検査は空振りになる）
  await row
    .locator('[data-testid="row-body"]')
    .evaluate((el) => el.parentElement?.classList.remove('body-fade'))
  expect(await 高さ()).toBe(敷いたまま)
})

test('Selected の印は、開いた行にだけ付く', async ({ page }) => {
  // `DESIGN.md` §27.3。**「選ばれたもの」を示さなければ Selected ではない。**
  //
  // **`data-expanded` だけを見てはいけない**——あれは**開けない行でも `true`**
  // になりうるので、単独で使うと**ほぼ全行に当たる**。実際にそうなっていて、
  // 畳んだ行と開いた行で `box-shadow` の計算値が一致していた。
  // **CSS が在ることは確かめていたが、効いているかを確かめていなかった。**
  await loadFoldLines(page)
  await expect(page.locator('[data-testid="transcript-row"]').first()).toBeVisible(届くまで)
  await page.getByTestId('body-toggle').first().click()

  // **【2026-09-04】印は行ではなく中身の器に付く**（細かい修正 設計§5-3）。
  // 行の左端に引いていた頃は、右寄せの吹き出しとの間に画面3割ぶんの空白ができ、
  // **長い発言を開くと線だけが縦に伸びて何を指した線か読めなかった**。
  // したがって**見る相手は器（`.row-shell`）**であって、行ではない。
  const 印 = await page.evaluate(() => {
    const 見る = (sel: string) => {
      const 行 = document.querySelector(sel) as HTMLElement | null
      const 器 = 行?.querySelector('.row-shell') as HTMLElement | null
      if (!行 || !器) return null
      const k = getComputedStyle(器)
      return { 影: k.boxShadow, 地: k.backgroundImage, 行の影: getComputedStyle(行).boxShadow }
    }
    return {
      開いた行: 見る('[data-testid="transcript-row"][data-body-open="true"]'),
      畳んだ行: 見る('[data-testid="transcript-row"][data-body-open="false"]'),
    }
  })

  expect(印.開いた行).not.toBeNull()
  expect(印.畳んだ行).not.toBeNull()
  // 開いた行の器には印が付く。**左辺の Accent と背景 Tint の2つ重ね**（§27.3）
  expect(印.開いた行!.影).not.toBe('none')
  expect(印.開いた行!.地).not.toBe('none')
  // **畳んだ行には付かない。**ここが本体——付いていたら「選ばれたもの」を示していない
  expect(印.畳んだ行!.影).toBe('none')
  expect(印.開いた行!.影).not.toBe(印.畳んだ行!.影)
  // **行そのものには引かない。**引くと、右寄せの吹き出しとの間に空白ができる
  expect(印.開いた行!.行の影).toBe('none')
})

test('シンプルへ寄せた5件が、実物で成り立っている', async ({ page }) => {
  // フェーズ13（要望5件・設計§12）。**変えたものはどれも「無いこと」が正しい状態**
  // （枠が無い・線が無い）なので、**壊しても静かに通る**。落ちる形にしてある。
  //
  // **jsdom では測れない**——縁も角丸も色も、解決するのはカスケードの先である。
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const 実測 = await page.evaluate(() => {
    // **色の字面を正規表現で解かないこと。** `getComputedStyle` は `oklch()` を返すことが
    // あり、`rgb()` 前提で読むと**解けずに黒として扱われる**（実際にこれで比が 1.99 と
    // 出て、10.13 のはずが床を割ったように見えた）。**キャンバスに塗って読めば**、
    // ブラウザが解ける書式はすべて同じ手で扱える
    const 画 = document.createElement('canvas')
    画.width = 1
    画.height = 1
    const 筆 = 画.getContext('2d', { willReadFrequently: true })
    const 明度 = (c: string) => {
      if (!筆) return null
      筆.clearRect(0, 0, 1, 1)
      筆.fillStyle = c
      筆.fillRect(0, 0, 1, 1)
      const [r0, g0, b0] = 筆.getImageData(0, 0, 1, 1).data
      const [r, g, b] = [r0, g0, b0].map((n) => {
        const v = n / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const 比 = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const q = (s: string) => document.querySelector(s) as HTMLElement | null

    const 行 = Array.from(
      document.querySelectorAll('[data-testid="transcript-row"]'),
    ) as HTMLElement[]
    const 器 = q('.body-shell')
    const 吹き出し = q('[data-testid="user-bubble"]')
    const 本文 = q('[data-testid="row-body"]')

    return {
      // 要望4：3種の行に境目の線が無い
      線の太さ: [...new Set(行.map((el) => getComputedStyle(el).borderBottomWidth))],
      // 要望2（案B）：器の縁と角丸が見えない。**箱そのものは残っている**
      器がある: !!器,
      器の縁: 器 ? getComputedStyle(器).borderTopWidth : null,
      器の地: 器 ? getComputedStyle(器).backgroundColor : null,
      // §8 の崩し②：左上の角丸ゼロは生きている
      器の左上: 器 ? getComputedStyle(器).borderTopLeftRadius : null,
      // 崩し①：しっぽ（吹き出しの右上）
      吹き出しの右上: 吹き出し ? getComputedStyle(吹き出し).borderTopRightRadius : null,
      // 要望3：吹き出しの地と、文字とのコントラスト
      吹き出しの地: 吹き出し ? getComputedStyle(吹き出し).backgroundColor : null,
      吹き出しの比:
        吹き出し && 本文
          ? 比(
              明度(getComputedStyle(吹き出し).backgroundColor) ?? 0,
              明度(getComputedStyle(本文).color) ?? 0,
            )
          : null,
      発言の明度: 本文 ? 明度(getComputedStyle(本文).color) : null,
    }
  })

  // 要望4：**境目の線が無い**（3種とも 0px の1種類だけ）
  expect(実測.線の太さ).toEqual(['0px'])
  // 要望2（案B）：**箱は残し、見た目だけ消す**。役目（帯の敷き場所・崩し②）が要る
  expect(実測.器がある).toBe(true)
  expect(実測.器の縁).toBe('0px')
  expect(実測.器の地).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  // §8 の崩し2つが別々の部品に生きている
  expect(実測.器の左上).toBe('0px')
  expect(実測.吹き出しの右上).toBe('0px')
  // 要望3：利用者の指定した青と、床を割らないコントラスト
  expect(実測.吹き出しの地).toBe('rgb(23, 62, 118)')
  expect(実測.吹き出しの比).toBeGreaterThanOrEqual(4.5)
  // 要望1（活動を暗く）は、**活動の行があるフィクスチャで別に測る**（下のテスト）
  expect(実測.発言の明度).not.toBeNull()
})

test('活動の行は、発言の行より暗い', async ({ page }) => {
  // 要望1・§5-3 の主従。**同じ明るさへ戻すと落ちる。**
  // このフィクスチャにしか活動の行が無いので、上のテストから分けてある
  await startSession(page)
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await showTranscript(page)
  // **活動はまとめ行の中に束ねてある**（設計§2）ので、開かないと出てこない
  await openActivities(page)
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="tool_call"]').first(),
  ).toBeVisible(届くまで)

  const 明るさ = await page.evaluate(() => {
    const 画 = document.createElement('canvas')
    画.width = 1
    画.height = 1
    const 筆 = 画.getContext('2d', { willReadFrequently: true })
    const 明度 = (c: string) => {
      if (!筆) return null
      筆.clearRect(0, 0, 1, 1)
      筆.fillStyle = c
      筆.fillRect(0, 0, 1, 1)
      const [r0, g0, b0] = 筆.getImageData(0, 0, 1, 1).data
      const [r, g, b] = [r0, g0, b0].map((n) => {
        const v = n / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const 活動 = document.querySelector(
      '[data-kind="tool_call"] span',
    ) as HTMLElement | null
    const 発言 = document.querySelector('[data-testid="row-body"]') as HTMLElement | null
    // **不透明度も見る。** 「発言より暗い」だけだと、種別の色（violet）はもともと白より
    // 暗いので、**暗くする指定を外しても通ってしまう**（実際にこれで壊し方が落ちなかった）。
    //
    // **ここも字面を正規表現で解かないこと。** Tailwind の `/60` は
    // `oklab(… / 0.6)` に解決されるので、`rgba()` 前提で読むと**不透明として扱われる**
    // （これで一度、直したはずの見張りがまた素通しした）。**キャンバスの α を読む。**
    const 不透明度 = (c: string) => {
      if (!筆) return 1
      筆.clearRect(0, 0, 1, 1)
      筆.fillStyle = c
      筆.fillRect(0, 0, 1, 1)
      return 筆.getImageData(0, 0, 1, 1).data[3] / 255
    }
    return {
      活動: 活動 ? 明度(getComputedStyle(活動).color) : null,
      発言: 発言 ? 明度(getComputedStyle(発言).color) : null,
      活動の不透明度: 活動 ? 不透明度(getComputedStyle(活動).color) : null,
    }
  })

  expect(明るさ.活動).not.toBeNull()
  expect(明るさ.発言).not.toBeNull()
  // **はっきり暗いこと。** 「少し違う」では主従にならない
  expect(明るさ.活動 ?? 1).toBeLessThan((明るさ.発言 ?? 1) * 0.75)
  // **暗くしてあること。** 種別の色はもともと白より暗いので、上だけでは
  // 「暗くする指定を外した」が捕まらない（要望1・設計§12-1）
  expect(明るさ.活動の不透明度 ?? 1).toBeLessThan(1)
})

test('狭い窓とハイコントラストでも壊れない', async ({ page }) => {
  // §4.5 が「狭い幅を一度も確かめていない」と書いている。**スマホからも触る道具である。**
  await page.setViewportSize({ width: 390, height: 780 })
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  // 横にはみ出していないこと
  const はみ出し = await page.getByTestId('transcript-tree').evaluate((el) => ({
    中身: el.scrollWidth,
    窓: el.clientWidth,
  }))
  expect(はみ出し.中身).toBeLessThanOrEqual(はみ出し.窓 + 1)

  // **`forced-colors` で消えないこと。** 色を奪われても、行と操作は残る
  await page.emulateMedia({ forcedColors: 'active' })
  await expect(row).toBeVisible()
  await expect(row.getByTestId('body-toggle')).toBeVisible()
  // 見出しは**画面の帯**が持つ（「履歴」の帯を外したため。細かい修正 設計§5-2）
  await expect(page.getByTestId('project-name')).toBeVisible()
})

test('文字のど真ん中を押しても開き、押下中に横へ動かない', async ({ page }) => {
  // 要望12（設計§12-7）。**`locator.click()` で確かめないこと**——あれは要素の位置を
  // 追いかけるので、**逃げても通ってしまう**。`page.mouse` で押して離す。
  //
  // **`transform` は取り合う。** 行のボタン共通の Pressed が `.body-toggle:active` に
  // 勝って中央寄せを消し、押した瞬間に幅の半分（35px）右へ飛んでいた。
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)
  const toggle = row.getByTestId('body-toggle')
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveText('続きを読む')

  const 前 = (await toggle.boundingBox())!
  await page.mouse.move(前.x + 前.width / 2, 前.y + 前.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(150)
  const 押下 = (await toggle.boundingBox())!
  const 変換 = await toggle.evaluate((el) => {
    const s = getComputedStyle(el)
    return { transform: s.transform, translate: s.translate }
  })
  await page.mouse.up()

  // **横へ動かない。** 1px は丸めのぶん
  expect(Math.abs(押下.x - 前.x)).toBeLessThanOrEqual(1)
  // **文字の上を押して開く**（要望12 の本体）
  await expect(toggle).toHaveText('畳む')
  // **取り合っていないこと。** 縮みは `transform`、中央寄せは `translate` が持つ
  expect(変換.transform).not.toBe('none')
  expect(変換.translate).not.toBe('none')
})

test('「畳む」も左右中央にあり、上の余白が倍', async ({ page }) => {
  // 要望11。**開閉で位置が変わらない**こと。**浮かせない**（帯が無いので重ねる相手が無い）
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)
  const toggle = row.getByTestId('body-toggle')
  await toggle.scrollIntoViewIfNeeded()

  const 畳んだとき = await toggle.evaluate((el) => ({
    上の余白: getComputedStyle(el).marginTop,
  }))
  await toggle.click()
  await expect(toggle).toHaveText('畳む')

  const 開いたとき = await toggle.evaluate((el) => {
    const s = getComputedStyle(el)
    const 箱 = el.getBoundingClientRect()
    const 親 = (el.parentElement as HTMLElement).getBoundingClientRect()
    return {
      position: s.position,
      上の余白: s.marginTop,
      左の余白: 箱.left - 親.left,
      右の余白: 親.right - 箱.right,
    }
  })

  // **浮かせない**（流れの中に居る）
  expect(開いたとき.position).not.toBe('absolute')
  // **左右中央**（丸めのぶん 1px は許す）
  expect(Math.abs(開いたとき.左の余白 - 開いたとき.右の余白)).toBeLessThanOrEqual(1)
  // **上の余白が倍。** 畳んでいるときは浮いていて余白を持たないので、絶対値で見る
  expect(parseFloat(開いたとき.上の余白)).toBeGreaterThanOrEqual(8)
  void 畳んだとき
})

test('吹き出しの中は、青基調で揃っている', async ({ page }) => {
  // 要望13。囲みコードや表が**無彩色の灰のまま**だと、青の上でそこだけ色が変わって
  // 見え、読みにくい。**色相で見る**——「灰でないこと」を数字で言うには彩度が要る
  await startSession(page)
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await showTranscript(page)
  const bubble = page.getByTestId('user-bubble').first()
  await expect(bubble).toBeVisible(届くまで)

  const 色 = await bubble.evaluate((el) => {
    const 画 = document.createElement('canvas')
    画.width = 1
    画.height = 1
    const 筆 = 画.getContext('2d', { willReadFrequently: true })!
    const rgb = (c: string) => {
      筆.clearRect(0, 0, 1, 1)
      筆.fillStyle = c
      筆.fillRect(0, 0, 1, 1)
      const d = 筆.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2]]
    }
    // 青みの強さ＝青が赤より十分に大きいこと
    const 青み = (c: string) => {
      const [r, , b] = rgb(c)
      return b - r
    }
    const 地 = getComputedStyle(el).backgroundColor
    // 吹き出しの中へ囲みコードを1つ差し込んで測る（フィクスチャに無いことがある）
    const 中 = el.querySelector('.prose-dashboard') as HTMLElement
    const 印 = document.createElement('code')
    印.textContent = 'x'
    中.append(印)
    const コード = getComputedStyle(印).backgroundColor
    印.remove()
    return { 吹き出しの青み: 青み(地), コードの青み: 青み(コード) }
  })

  // 吹き出しは青い
  expect(色.吹き出しの青み).toBeGreaterThan(40)
  // **囲みコードも青い。** 無彩色（青み ≒ 0）へ戻すと落ちる
  expect(色.コードの青み).toBeGreaterThan(15)
})

test('帯の下9割は、どこを押しても開く', async ({ page }) => {
  // **要望10 の本体**（設計§6-7-5）。「続きを読む」をピンポイントで突かなくても開く。
  // **左寄り・中央・右寄りの3点**で見る——1点だけだと、たまたま文字の上を突いていても通る
  await loadFoldLines(page)

  for (const frac of [0.2, 0.5, 0.8]) {
    const row = foldableRow(page)
    await expect(row).toBeVisible(届くまで)
    await expect(row.getByTestId('body-toggle')).toHaveText('続きを読む')
    await row.getByTestId('body-toggle').scrollIntoViewIfNeeded()

    const 点 = await row.locator('[data-testid="body-hitbox"]').evaluate((el, f) => {
      const box = el.getBoundingClientRect()
      return { x: box.left + box.width * f, y: box.top + box.height / 2 }
    }, frac)
    await page.mouse.click(点.x, 点.y)
    await expect(row.getByTestId('body-toggle')).toHaveText('畳む')

    // 次の点のために畳み直す
    await row.getByTestId('body-toggle').click()
    await expect(row.getByTestId('body-toggle')).toHaveText('続きを読む')
  }
})

test('帯の上1割を押しても開かない', async ({ page }) => {
  // **上端はほぼ透明で本文と見分けが付かない。** ここまで押せるようにすると、
  // 本文を読むためのクリックが開く操作になる（要望10・利用者の指定）
  // **深い段で測る。** いちばん浅い段は帯が1行（19.5px）しかなく、**大きくした文字の
  // ほうが背が高い**ので、除いてある1割まで文字が覆う——そこを押せば当然開く。
  // 除外が意味を持つのは、帯が文字より高い段である
  await loadFoldLines(page)
  const row = page.locator('[data-testid="transcript-row"]', {
    has: page.locator('[data-fade="deep"]'),
  }).first()
  await expect(row).toBeVisible(届くまで)
  await row.getByTestId('body-toggle').scrollIntoViewIfNeeded()

  // **点は帯基準で採ること。** 押す面を基準にすると、**面が伸びたときに点も一緒に動く**
  // ので、除外を壊しても常に面の外を測ることになる（実際にこれで壊し方②が落ちなかった）
  const 点 = await row.locator('[data-testid="body-hitbox"]').evaluate((el) => {
    const 器 = el.parentElement as HTMLElement
    const 器の箱 = 器.getBoundingClientRect()
    const 帯の高さ = parseFloat(getComputedStyle(器, '::before').height) || 20
    const 帯の上端 = 器の箱.bottom - 帯の高さ
    const 文字の箱 = (
      器.querySelector('[data-testid="body-toggle"]') as HTMLElement
    ).getBoundingClientRect()
    // 帯の上から5%の高さ（＝除いてある1割の中）で、文字にかからない横位置
    return { x: 文字の箱.left - 20, y: 帯の上端 + 帯の高さ * 0.05 }
  })
  await page.mouse.click(点.x, 点.y)

  await expect(row.getByTestId('body-toggle')).toHaveText('続きを読む')
})

test('帯の外の本文は、いままでどおり選べる', async ({ page }) => {
  // 押す面を重ねた代わりに、**その範囲だけ**文字が選べなくなる。**それ以外は失わない**
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const 選べた = await row.locator('[data-testid="row-body"]').evaluate((el) => {
    const 段落 = el.querySelector('p, li')
    if (!段落) {
      return false
    }
    const range = document.createRange()
    range.selectNodeContents(段落)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    const 取れた = (sel?.toString() ?? '').length
    sel?.removeAllRanges()
    return 取れた > 0
  })
  expect(選べた).toBe(true)
})

test('「続きを読む」はただの文字で、中央のやや下に居る', async ({ page }) => {
  // 要望10。**地・枠・影を持たない**（クラスの有無ではなく計算値で見る）。
  // **いままでより大きい**（`text-xs` = 12px より上）
  // **いちばん浅い段で測る。** 帯が1行（19.5px）しかない段が最も厳しく、ここで収まれば
  // 他の段でも収まる。**文字の行送りを詰めていないと、ここで帯からはみ出す**——
  // 既定の行送りだと箱が 20px になり、狭い窓でフェード中の最終行と重なった
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)
  await row.getByTestId('body-toggle').scrollIntoViewIfNeeded()

  const 見た目 = await row.getByTestId('body-toggle').evaluate((el) => {
    const s = getComputedStyle(el)
    const 文字 = el.getBoundingClientRect()
    const 器 = (el.parentElement as HTMLElement).getBoundingClientRect()
    const 帯 = parseFloat(getComputedStyle(el.parentElement as HTMLElement, '::before').height) || 20
    return {
      地: s.backgroundColor,
      枠: s.borderTopWidth,
      影: s.boxShadow,
      字の大きさ: parseFloat(s.fontSize),
      左の余白: 文字.left - 器.left,
      右の余白: 器.right - 文字.right,
      // 帯の上端から文字の中心までの距離が、帯の高さの半分より下か
      帯の上端から: 文字.top + 文字.height / 2 - (器.bottom - 帯),
      帯の高さ: 帯,
      文字の高さ: 文字.height,
    }
  })

  // **ただの文字**
  expect(見た目.地).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  expect(見た目.枠).toBe('0px')
  expect(見た目.影).toBe('none')
  // **いままでより大きい**（12px は `text-xs`）
  expect(見た目.字の大きさ).toBeGreaterThan(12)
  // **左右中央**（余白が等しい。丸めのぶん 1px は許す）
  expect(Math.abs(見た目.左の余白 - 見た目.右の余白)).toBeLessThanOrEqual(1)
  // **帯の中央より下**
  expect(見た目.帯の上端から).toBeGreaterThan(見た目.帯の高さ / 2)
  // **帯からはみ出さない。** いちばん浅い段（19.5px）でも収まること——
  // 行送りを詰めていないと 20px になって、ここで落ちる
  expect(見た目.文字の高さ).toBeLessThan(見た目.帯の高さ)
})

test('画面の主題を示す見出しがある', async ({ page }) => {
  // `DESIGN.md` §8 の床。**構造化ビューは UI 自身の見出しを1つも持っていなかった**
  // ——いちばん大きい文字が 14px/500 で、階層が実質2段しかなかった。
  //
  // **【2026-09-04】受け皿が「履歴」の帯から画面の帯へ移った**（細かい修正 設計§5-2）。
  // 帯は件数以外に何も出しておらず、場所を取る割に何も言っていない面だったので外し、
  // **床は既にある面で満たす**ことにした——見出しは PJT 名、物質感は電源ボタンと
  // 履歴の器の縁。**新しい帯を建てないこと**（建てると、消したかったものが戻る）。
  //
  // §8 の不合格例は「**既定のUIフォントを太字にしただけ**」なので、**大きさとウェイトの
  // 両方**を見る（§13.2 の Section Title＝15〜18px / Semibold）。
  await loadFoldLines(page)
  const 見出し = page.getByTestId('project-name')
  await expect(見出し).toBeVisible(届くまで)

  const 見た目 = await 見出し.evaluate((el) => {
    const t = getComputedStyle(el)
    const 本文 = document.querySelector('[data-testid="row-body"]') as HTMLElement
    const 電源 = document.querySelector('[data-testid="power-card"]') as HTMLElement
    const 器 = document.querySelector('.transcript-panel') as HTMLElement
    return {
      大きさ: parseFloat(t.fontSize),
      太さ: Number(t.fontWeight),
      本文の大きさ: parseFloat(getComputedStyle(本文).fontSize),
      // **物質を持つ面が2つ**（§8 の床・§12.3）。電源は「主要操作ボタン＝プレート」で
      // **ステッカー以外**にあたり、履歴の器の縁は「パネルの縁＝弱」
      電源の影: 電源 === null ? 'none' : getComputedStyle(電源).boxShadow,
      器の影: 器 === null ? 'none' : getComputedStyle(器).boxShadow,
    }
  })

  // §13.2 の Section Title
  expect(見た目.大きさ).toBeGreaterThanOrEqual(15)
  expect(見た目.大きさ).toBeLessThanOrEqual(18)
  expect(見た目.太さ).toBeGreaterThanOrEqual(600)
  // **本文より上**であること
  expect(見た目.大きさ).toBeGreaterThan(見た目.本文の大きさ)
  // **物質を持つ面が、平らな塗りではないこと**
  expect(見た目.電源の影).not.toBe('none')
  expect(見た目.器の影).not.toBe('none')
})

test('帯は器の端まで届く', async ({ page }) => {
  // **要望①の本体**（設計§6-7-2）。帯を本文の箱に敷いていた頃は、吹き出しの内側余白
  // （`px-3 py-2`）のぶんだけ左右と下が届かず、**器の中に貼った紙**に見えていた。
  //
  // **クラスが付いているかでは見ない。** この群は2度それで素通しした——実際に塗られた
  // 矩形の幅と、器の幅を突き合わせる。
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const 帯と器 = await row.locator('[data-testid="row-body"]').evaluate((el) => {
    const shell = el.parentElement
    if (!shell) {
      throw new Error('帯の器が見つからない')
    }
    const 器 = shell.getBoundingClientRect()
    const 本文 = el.getBoundingClientRect()
    return { 器の幅: 器.width, 本文の幅: 本文.width, 器の下: 器.bottom, 本文の下: 本文.bottom }
  })

  // 器は本文より広い（内側余白があるので、本文の箱に敷くと届かない）
  expect(帯と器.器の幅).toBeGreaterThan(帯と器.本文の幅)
  // 帯は器に敷いてあるので、器の幅と下端がそのまま帯の幅と下端になる
  expect(帯と器.器の下).toBeGreaterThanOrEqual(帯と器.本文の下)
})

test('「続きを読む」が帯の前面に居る', async ({ page }) => {
  // **要望②**（設計§6-7-3）。「マスクの中に書いてある感じ」にする。
  // **帯の `pointer-events: none` は動かさず、重ね順だけ上げる**ので、ボタンの上の点は
  // ボタン自身を返す——外すとここだけが落ちる。
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const toggle = row.getByTestId('body-toggle')
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveClass(/body-toggle-float/)

  const ボタンの上に居るもの = await toggle.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const found = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return found === el || el.contains(found)
  })
  expect(ボタンの上に居るもの).toBe(true)
})

test('帯は押す面になり、「続きを読む」はその上から押せる', async ({ page }) => {
  // **要望10 で前提が裏返った。** フェーズ11 までは「帯がクリックを吸わないこと」を見て
  // いたが、いまは**帯を押したら開くのが正しい**。見るのは重なりの順序である——
  // 帯の面は本文より上、「続きを読む」は面より上。
  //
  // 帯そのもの（`::before`）は擬似要素のままなので当たり判定を持たない。押しているのは
  // **その上に重ねた実要素**（`body-hitbox`）である（設計§6-7-5）。
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)
  await row.getByTestId('body-toggle').scrollIntoViewIfNeeded()

  // 帯の中の一点が、押す面を返すこと（本文ではなく）
  const 帯の上に居るもの = await row.locator('[data-testid="body-hitbox"]').evaluate((el) => {
    const box = el.getBoundingClientRect()
    const found = document.elementFromPoint(box.left + box.width * 0.2, box.top + box.height / 2)
    return found === el
  })
  expect(帯の上に居るもの).toBe(true)

  // それでも「続きを読む」は押せる（面が文字を覆っていない）
  const toggle = row.getByTestId('body-toggle')
  await expect(toggle).toHaveText('続きを読む')
  await toggle.click()
  await expect(toggle).toHaveText('畳む')

  // 開けば面は消える
  await expect(row.locator('[data-testid="body-hitbox"]')).toHaveCount(0)
})
test('畳んだ末尾に、薄れる相手が残っている', async ({ page }) => {
  await loadFoldLines(page)
  await expect(foldableRow(page)).toBeVisible(届くまで)

  // 囲みコードの直後で切れる本文（フェーズ8 で足した土台）
  const 本文 = page
    .locator('[data-testid="row-body"][data-fade]')
    .filter({ hasText: '囲みコードの直後で切れる' })
  await expect(本文).toHaveCount(1)

  // **末尾が空のコードブロックになっていない。** `closeFence` が足した閉じフェンスだけが
  // 残ると、帯はその上に乗って**ただの矩形**になる
  const 末尾 = await 本文.evaluate((el) => {
    const last = el.lastElementChild
    return { tag: last?.tagName ?? '', text: (last?.textContent ?? '').trim() }
  })
  expect(末尾.tag).not.toBe('PRE')
  expect(末尾.text).not.toBe('')
})

/**
 * 中身の無い思考は行にならず、前後の活動がひと続きになること（設計§8-2・§8-3）。
 *
 * **落とす場所が「束ねるより前」であることを、実物で見る。** 描くときに隠すだけだと
 * 行は消えるが、**まとめ行が2つに割れる**。
 */
test('中身の無い思考は出ず、前後の活動がひと続きになる', async ({ page }) => {
  // **専用の土台を使う。** `fold-lines` へ足すと末尾に付き、**仮想化で窓の外へ出て
  // DOM に現れない**——数えるものが最初から0になり、テストが何も見なくなる
  await loadBodies(page, 'synthetic/empty-thinking/session.jsonl')
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="assistant_text"]'),
  ).toHaveCount(1)

  await expect(page.locator('[data-testid="transcript-row"][data-kind="thinking"]')).toHaveCount(0)

  // 思考を挟んだ2件が、1つのまとめ行に入っている
  const まとめ行 = page.locator('[data-testid="transcript-row"][data-kind="activity"]')
  await expect(まとめ行).toHaveCount(1)
  await expect(まとめ行).toHaveAttribute('data-member-count', '2')
})

test('畳む仕掛けの高さが、猶予の行数を下回っている', async ({ page }) => {
  // **設計§4-4 の原則そのもの**——「畳んで縮む量が仕掛けの高さを上回らないなら畳まない」。
  // 猶予（`BODY_FOLD_GRACE_LINES`）は仕掛けの高さから決めた数なので、**実物を測って
  // 上回っていることを確かめないと、根拠が見込みのままになる。**
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const 実測 = await row.evaluate((el) => {
    const body = el.querySelector('[data-testid="row-body"]') as HTMLElement
    const toggle = el.querySelector('[data-testid="body-toggle"]') as HTMLElement
    const probe = document.createElement('div')
    probe.style.height = 'var(--fade-band)'
    body.append(probe)
    const band = probe.getBoundingClientRect().height
    probe.remove()
    const line = Number.parseFloat(getComputedStyle(body).lineHeight)
    const toggleStyle = getComputedStyle(toggle)
    const button =
      toggle.getBoundingClientRect().height + Number.parseFloat(toggleStyle.marginTop)
    return { band, line, button }
  })

  // 実測値をログへ残す。**次に触る人が測り直さずに済むのはこの1行**
  console.log(
    `畳む仕掛けの実測：1行=${実測.line}px 帯=${実測.band}px ボタン=${実測.button}px ` +
      `→ ${((実測.band + 実測.button) / 実測.line).toFixed(2)}行`,
  )

  const 仕掛けの行数 = (実測.band + 実測.button) / 実測.line
  expect(仕掛けの行数).toBeLessThan(BODY_FOLD_GRACE_LINES)
  // 帯そのものは、設計が言う「約2行」の一番浅い段なので1行ぶん
  expect(実測.band / 実測.line).toBeCloseTo(1, 1)
})

/**
 * `markdown-bodies` の1本目。**表・箇条書き・囲みコードを1つの本文に全部持つ。**
 *
 * **「畳む相手の行」で引いてはいけない。** 行数で測るようになってから、この本文は
 * 実効69行で**畳まれる側に入らない**（イシューグループ_2026-0820-2129 フェーズ2）。
 * 確かめたいのは整形であって折りたたみではないので、本文そのもので引く。
 */
function markdownRow(page: Parameters<typeof openDashboard>[0]) {
  return page
    .locator('[data-testid="transcript-row"][data-kind="assistant_text"]')
    .filter({ hasText: 'フォルダの決まり' })
    .first()
}

test('行のどこを押しても開く（記号だけが押せるのではない）', async ({ page }) => {
  // 記号は小さい。**スマホでは記号だけが的だと押せない**（テスト計画フェーズ5）
  await startSession(page)
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await showTranscript(page)

  const まとめ行 = page.locator('[data-testid="transcript-row"][data-kind="activity"]').first()
  await expect(まとめ行).toBeVisible(届くまで)
  await expect(まとめ行).toHaveAttribute('data-expanded', 'false')

  // **左端でも記号でもない、行の中ほどを押す**
  const box = await まとめ行.boundingBox()
  if (!box) {
    throw new Error('まとめ行の位置が取れない')
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(まとめ行).toHaveAttribute('data-expanded', 'true')
})

test('本文を選んでも、行が開いてしまわない', async ({ page }) => {
  // **押して開く**と**選んでコピーする**は両立しないといけない。本文をドラッグした
  // だけで開くと、読んだところを引用できなくなる（テスト計画フェーズ5）
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const body = row.locator('[data-testid="row-body"]')
  // **畳んでも本文は窓より高い。** 素朴に上端を取ると画面の外を指すので、
  // 窓と重なっているところから点を拾う（実際に外を指して選べなかった）
  await row.getByTestId('body-toggle').scrollIntoViewIfNeeded()
  const point = await body.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const top = Math.max(rect.top, 8)
    const bottom = Math.min(rect.bottom, window.innerHeight - 8)
    return { x: rect.left + 8, y: (top + bottom) / 2 }
  })
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 200, point.y, { steps: 8 })
  await page.mouse.up()

  expect(await page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(0)
  await expect(row).toHaveAttribute('data-body-open', 'false')
})

test('長い出力は、箱の中でスクロールする（外へ伸びない）', async ({ page }) => {
  // 伸ばすと1件のツールコールで画面が埋まる。**箱に閉じ込めて中でスクロールさせる**
  await startSession(page)
  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await writeTranscript(page, 'v2.1.220/basic-tools/session.jsonl')
  await showTranscript(page)

  await openActivities(page)
  const tool = page.locator('[data-testid="transcript-row"][data-kind="tool_call"]').first()
  await expect(tool).toBeVisible(届くまで)
  await tool.getByRole('button').first().click()

  const 箱 = await tool.locator('pre').first().evaluate((el) => ({
    client: el.clientHeight,
    scroll: el.scrollHeight,
    overflow: getComputedStyle(el).overflowY,
  }))
  expect(箱.overflow).toBe('auto')
  // 中身が箱より高いなら、外へ伸びずに中でスクロールしている
  expect(箱.client).toBeLessThanOrEqual(256)
})

test('表と箇条書きが要素として出る', async ({ page }) => {
  // 記号のまま並んでいたら、この画面の存在理由（読みやすさ）が立たない
  await loadMarkdownBodies(page)

  const body = markdownRow(page).getByTestId('row-body')
  await expect(body.locator('table')).toHaveCount(1)
  await expect(body.locator('li')).toHaveCount(3)
  await expect(body.locator('pre code')).toHaveCount(1)
  // **アシスタントの発言には見出しの行そのものが無い**（イシューグループ_2026-0820-2129
  // 設計§5-3）。要約を横に出す形が消えたので、「二重に出ていない」は
  // **見出しが無く、本文が1度だけ出る**という形で見る
  await expect(markdownRow(page).getByRole('button')).toHaveCount(0)
  await expect(markdownRow(page).getByTestId('row-body')).toHaveCount(1)
})

test('`<br/>` を含む本文でも行が消えない', async ({ page }) => {
  // このリポジトリのドキュメントの作法を引用した応答が、行ごと消えて見えないこと
  await loadMarkdownBodies(page)

  const row = page
    .locator('[data-testid="transcript-row"][data-kind="assistant_text"]')
    .filter({ hasText: '区切りの作法' })
  await expect(row.getByTestId('row-body').locator('br')).toHaveCount(2)
  await expect(row).toContainText('つぎの見出し')
})

test('行が空いていなくても、改行が改行として見える', async ({ page }) => {
  // **単体では木の形しか見ていない。** 実際に `br` として画面へ出るのは、
  // 「フック → パーサ → WebSocket → 整形」が全部繋がって初めて分かる
  await loadSoftBreaks(page)

  // 利用者の本文（`あいう` / `かきく`）
  const user = page
    .locator('[data-testid="transcript-row"][data-kind="user_message"]')
    .filter({ hasText: 'あいう' })
  await expect(user.getByTestId('row-body').locator('br')).toHaveCount(1)

  // アシスタントの本文。素の改行2つ ＋ ハード改行1つ ＋ 行頭の `<br/>` 2つ ＝ 5
  const row = page
    .locator('[data-testid="transcript-row"][data-kind="assistant_text"]')
    .filter({ hasText: '改行の見え方' })
  const body = row.getByTestId('row-body')
  await expect(body.locator('br')).toHaveCount(5)

  // **囲みコードと表の中では増えない**（`text` ノードを通らないため）
  await expect(body.locator('pre br')).toHaveCount(0)
  await expect(body.locator('table br')).toHaveCount(0)
  await expect(body.locator('table')).toHaveCount(1)
  await expect(body.locator('pre code')).toHaveCount(1)
})

test('高さの違う行が混ざっていても、末尾に居るかどうかを正しく判定する', async ({ page }) => {
  // 本文を常に出すようになって行の高さがばらけた（29px の行と 1,000px 超の行が混ざる）。
  // **数万ノードは確かめていない**（フェーズ1 の判断。数万件は `flatten` の単体で通す）
  await loadMarkdownBodies(page)
  const tree = page.getByTestId('transcript-tree')

  await tree.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.getByTestId('transcript-status')).toHaveAttribute('data-at-end', 'true')

  await tree.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.getByTestId('transcript-status')).toHaveAttribute('data-at-end', 'false')
})

test('遡っている最中に履歴が増えても、引き戻されない', async ({ page }) => {
  // 読んでいる途中で勝手に飛ぶのが、この画面でいちばん困る挙動（初期実装設計§10）
  await loadMarkdownBodies(page)
  const tree = page.getByTestId('transcript-tree')
  const status = page.getByTestId('transcript-status')

  await tree.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(status).toHaveAttribute('data-at-end', 'false')
  const before = Number(await status.getAttribute('data-row-count'))

  // **構造化ビューを見たまま**追記する。入力欄はタブの外に常設されているので、
  // ターミナルへ切り替えずに擬似 claude へ命令を送れる（切り替えると、隠れている間の
  // 追記になって「引き戻されるか」を確かめられない）
  await page.getByTestId('composer-input').fill(`jsonl ${FIXTURES}/v2.1.220/basic-tools/session.jsonl`)
  await page.keyboard.press('Control+Enter')

  await expect
    .poll(async () => Number(await status.getAttribute('data-row-count')), {
      message: '行が増えること',
      timeout: 30_000,
    })
    .toBeGreaterThan(before)
  // 増えたあとも、見ている場所は動かない
  expect(await tree.evaluate((el) => el.scrollTop)).toBe(0)
})

test('タブを往復してもターミナルの内容が残る', async ({ page }) => {
  // 切り替えのたびに端末を作り直すと、スクロールバックが消えて操作の続きができなくなる
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')

  await showTranscript(page)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'transcript')

  await showTerminal(page)
  await expect(page.getByTestId('session-view')).toHaveAttribute('data-view', 'terminal')
  // 戻ってきても、それまでの出力がそのまま残っている
  await expect(page.getByTestId('terminal-status')).toHaveAttribute('data-flow', 'running')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const container = document.querySelector('[data-testid="terminal"]') as
          | (HTMLDivElement & { __terminal?: { buffer: { active: { length: number } } } })
          | null
        return container?.__terminal?.buffer.active.length ?? 0
      }),
    )
    .toBeGreaterThan(0)
})

/*
 * 開いたら、いちばん下（最新）から見せる（設計§3・テスト計画フェーズ3）。
 *
 * **末尾追従（`followOnAppend`）では届かない。** あちらの判定は
 * `prevOptions !== undefined && this.scrollElement !== null` を通った先にあり、
 * `scrollElement` が入るのはレイアウトエフェクトの中なので、マウントの2回の
 * `setOptions` はどちらも門を通れない（設計§2-1）。加えて履歴ストアはモジュール変数で
 * unmount しても消えないため、戻ってきたときは**最初から N 件**で「増えた」ことすら
 * 観測されない（設計§2-2）。
 *
 * **位置はここでしか測れない。** jsdom は `scrollHeight` を持たないので、単体では
 * 「寄せる指示が何回出たか」しか見られない（設計§10-1）。
 */

test('開いたら、いちばん下（最新）から見せる', async ({ page }) => {
  await loadMarkdownBodies(page)
  const tree = page.getByTestId('transcript-tree')
  const status = page.getByTestId('transcript-status')

  // **材料が画面を超えていること**を先に確かめる（設計§10-2）。収まってしまうと
  // 上と下の区別が付かず、この先の判定が素通りする
  const あふれ = await tree.evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(あふれ).toBeGreaterThan(80)

  // 手でスクロールしていないのに、末尾に居る
  await expect(status).toHaveAttribute('data-at-end', 'true')
})

test('別のページへ行って戻ってきても、最新から始まる', async ({ page }) => {
  await loadMarkdownBodies(page)
  const tree = page.getByTestId('transcript-tree')
  const status = page.getByTestId('transcript-status')
  await expect(status).toHaveAttribute('data-at-end', 'true')

  // 上まで遡ってから離れる。**戻ったときにその位置が残っていない**ことを見る
  await tree.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(status).toHaveAttribute('data-at-end', 'false')

  // PJT 専用画面を経由して戻る（`dashboard.spec.ts` と同じ導線）。
  // **この経路では履歴ストアが生き残っている**ので、戻った時点で最初から N 件ある
  await page.getByTestId('zoom-toggle').click()
  const view = page.getByTestId('session-view').first()
  await view.getByTestId('zoom-toggle').click()
  await showTranscript(page)

  await expect(status).toHaveAttribute('data-at-end', 'true')
})

test('リロードしても、最新から始まる', async ({ page }) => {
  await loadMarkdownBodies(page)
  const tree = page.getByTestId('transcript-tree')
  const status = page.getByTestId('transcript-status')
  await tree.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(status).toHaveAttribute('data-at-end', 'false')

  // **こちらは履歴ストアごと作り直される**ので、本当に0件から始まる経路になる
  await page.reload()
  await showTranscript(page)
  await expect
    .poll(async () => Number(await status.getAttribute('data-row-count')), {
      message: '履歴が届くこと',
      timeout: 30_000,
    })
    .toBeGreaterThan(0)

  await expect(status).toHaveAttribute('data-at-end', 'true')
})

test('横並びでは、構造化ビューへ切り替えたときに末尾から見える', async ({ page }) => {
  await loadMarkdownBodies(page)

  // PJT 専用画面の既定はターミナル。**構造化ビューは隠れたまま履歴を受け取る**ので、
  // その間は寄せない（寄せても効かないのに印だけが立つ。設計§7）
  await page.getByTestId('zoom-toggle').click()
  const view = page.getByTestId('session-view').first()
  await expect(view).toHaveAttribute('data-view', 'terminal')

  // 切り替えて箱に高さが付いた、その描画で初めて寄せる
  await setTerminalView(view, false)
  await expect(view).toHaveAttribute('data-view', 'transcript')
  await expect(view.getByTestId('transcript-status')).toHaveAttribute('data-at-end', 'true')
})

/**
 * まだ読まれていない追加メッセージ（作業中に送った追加メッセージ テスト計画フェーズ5）。
 *
 * **単体では届かない鎖がここにある。** 擬似 claude が JSONL へ書き、フックが読ませ、
 * パーサが行列を再現して行を出し、WebSocket を通って画面へ届く——この鎖の全部が
 * 一度に通るのはここだけである。
 */
test('待っている指示が出て、読まれると消える', async ({ page }) => {
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await enqueue(page, 'あとで直して')

  await showTranscript(page)
  const 待ち = page.locator('[data-testid="transcript-row"][data-kind="queued_message"]')
  await expect(待ち).toHaveCount(1, 届くまで)
  // **利用者の発言と同じ吹き出しで出る**（設計§7-1・2026-09-05 に作り直し）。
  // 「待機中」という語は出さず、**状態は地の色だけ**で言う（要件1-4）
  await expect(待ち.getByTestId('user-bubble')).toHaveAttribute('data-queued', 'true', 届くまで)
  await expect(page.getByText('待機中')).toHaveCount(0)
  // **何が待っているのかが読めること**（設計§7-3 の床）
  await expect(page.getByText('あとで直して').first()).toBeVisible(届くまで)

  // **地の色は、吹き出しの青を灰色側へ寄せたもの**（設計§7-2・要件1-3）。
  // `oklch(from …)` の派生は jsdom が解けないので、**実物のブラウザで測るのはここだけ**。
  // 明度は動かさず彩度だけを落とすので、**文字とのコントラストの床は割れない**
  const 地 = await page.evaluate(() => {
    const 器 = document.querySelector(
      '[data-kind="queued_message"] [data-testid="user-bubble"]',
    )
    if (!器) return null
    // **文字列を自分で読まない。** 派生は `oklch(from …)` で書いてあるので、
    // Chromium は計算値を `rgb()` ではなく **`oklch()` のまま**返すことがある。
    // canvas に一度塗ると、**どんな記法でも RGBA へ正規化される**
    // ——この画面の他の色の実測（`吹き出しの地` ほか）と同じ手である
    const 画 = document.createElement('canvas')
    画.width = 1
    画.height = 1
    const 筆 = 画.getContext('2d', { willReadFrequently: true })
    const 読む = (c: string): [number, number, number] | null => {
      if (!筆) return null
      筆.clearRect(0, 0, 1, 1)
      筆.fillStyle = c
      筆.fillRect(0, 0, 1, 1)
      const [r, g, b] = 筆.getImageData(0, 0, 1, 1).data
      return [r, g, b]
    }
    // 彩度は「いちばん明るい成分と暗い成分の開き」で見る（HSL の S と同じ向き）
    const 彩度 = ([r, g, b]: [number, number, number]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255
    const 明度 = ([r, g, b]: [number, number, number]) => (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255
    const 待ち = 読む(getComputedStyle(器).backgroundColor)
    const 青: [number, number, number] = [23, 62, 118]
    return 待ち && {
      生の値: getComputedStyle(器).backgroundColor,
      待ちの彩度: 彩度(待ち),
      青の彩度: 彩度(青),
      待ちの明度: 明度(待ち),
      青の明度: 明度(青),
    }
  })
  expect(地, '待機中の吹き出しの地が読めない').not.toBeNull()
  // **青のままではない**（灰色側へ寄っている）
  expect(地!.待ちの彩度).toBeLessThan(地!.青の彩度)
  // **明度は動かしていない**（床＝文字とのコントラストを守るため）
  expect(Math.abs(地!.待ちの明度 - 地!.青の明度)).toBeLessThan(0.06)

  // 読まれた（待ち行列から出た）
  await showTerminal(page)
  await dequeue(page)

  await showTranscript(page)
  // **消える。** 単一ノードを消す経路は無いので、`taken` を立てて行から落としている
  await expect(待ち).toHaveCount(0, 届くまで)
})

test('あとから履歴が届いても、待っている指示はいちばん下に残る', async ({ page }) => {
  // **要件1-5。** 届いた順に積むと、待っているあいだに来たエージェントの発言が
  // 待ちの**下**に付いてしまう。抜いて末尾へ回しているかを、実物の鎖で見る
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await enqueue(page, 'あとで直して')

  await showTranscript(page)
  const 待ち = page.locator('[data-testid="transcript-row"][data-kind="queued_message"]')
  await expect(待ち).toHaveCount(1, 届くまで)

  // 待っているあいだに、エージェント側の発言が2件届く。
  //
  // **フィクスチャを流してはいけない。** 手持ちのフィクスチャには `queue-operation` が
  // 入っており、その `dequeue` は**行列の先頭を落とす**ので、いま待たせている
  // 「あとで直して」が巻き添えで畳まれる（`retire_front`）。発言だけを書く口を使う
  await showTerminal(page)
  await reply(page, 'まず調べています')
  await reply(page, 'つぎに直します')

  await showTranscript(page)
  const 全部 = page.locator('[data-testid="transcript-row"]')
  await expect
    .poll(async () => await 全部.count(), { message: '発言が届くこと', timeout: 30_000 })
    .toBeGreaterThanOrEqual(3)
  // **末尾に寄せてあるので、最後に描かれている行が並びの最後**である
  await expect(全部.last()).toHaveAttribute('data-kind', 'queued_message', 届くまで)
  // 待ちは1件のまま（エージェントの発言に押し出されて消えたりしない）
  await expect(待ち).toHaveCount(1, 届くまで)
})

test('読まれたあと、同じ本文が2つ並ばない', async ({ page }) => {
  // **このイシューがいちばん避けたい形。** 待ちを出したまま本物が並ぶと、送った文が
  // 画面に2回出る。パーサは同じ本文の発言が出た時点で畳む（設計§4-1 の合図(a)）
  await startSession(page)

  await showTerminal(page)
  await fireHook(page, 'SessionStart')
  await enqueue(page, 'イシューの設計を進めて')
  // **取り出しを挟まずに本物が先に来る道**を通す。実データにこの順序が実在する
  await say(page, 'イシューの設計を進めて')

  await showTranscript(page)
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="user_message"]'),
  ).toHaveCount(1, 届くまで)
  await expect(
    page.locator('[data-testid="transcript-row"][data-kind="queued_message"]'),
  ).toHaveCount(0, 届くまで)
  await expect(page.getByText('イシューの設計を進めて')).toHaveCount(1, 届くまで)
})
