import { expect, test } from '@playwright/test'
import { BODY_FOLD_GRACE_LINES } from '../src/lib/markdown'
import {
  archiveAll,
  FIXTURES,
  fireHook,
  openDashboard,
  openSession,
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

test('帯が押す判定を食わない', async ({ page }) => {
  // **設計§6-1 が名指しした落とし穴。** 帯は本文に重なっているので、素通しさせないと
  // その面がクリックを吸って行が開けなくなる。
  //
  // **見るのは「押したら開くか」そのものである。**
  //
  // **`pointer-events: none` を外しても、この検査は落ちない。** 帯は擬似要素（`::before`）
  // なので、その箱は `elementFromPoint` の返り先にならない——**そもそもクリックを吸えない**
  // （フェーズ11 で実測。計算値が `none` → `auto` へ変わっても、帯の中の点は本文を返す）。
  // したがって設計§6-1 が名指しした「帯がクリックを吸う」失敗は、**帯が本物の要素だった
  // ときの話**である。`pointer-events: none` は将来そう変えたときのための安い保険として残す。
  await loadFoldLines(page)
  const row = foldableRow(page)
  await expect(row).toBeVisible(届くまで)

  const body = row.locator('[data-testid="row-body"]')
  // **畳んでも本文は窓より高い。** 帯は末尾にかかるので、末尾を窓の中へ入れてから測る
  await row.getByTestId('body-toggle').scrollIntoViewIfNeeded()

  // **帯は「続きを読む」に重なっている**（フェーズ11 で前面へ載せた）。帯が押す判定を
  // 食っていれば、Playwright の実行可能性検査がここで「他の要素が邪魔している」と言って
  // 落ちる。**押して開くところまでを見る**——これが利用者に見える性質そのものである
  const toggle = row.getByTestId('body-toggle')
  await expect(toggle).toHaveText('続きを読む')
  await toggle.click()
  await expect(toggle).toHaveText('畳む')

  // 帯の上の一点が本文自身であること（重なりの向きが逆転していないこと）。
  // **`--fade-band` を `parseFloat` で読まないこと**——値は `calc(1 * calc(.75rem * 1.625))`
  // のまま返って `NaN` になり、点が器の下端ちょうどへ落ちて**帯の外を測る**
  await toggle.click()
  await expect(toggle).toHaveText('続きを読む')
  const 帯の上に居るもの = await body.evaluate((el) => {
    const shell = el.parentElement
    if (!shell) {
      throw new Error('帯の器が見つからない')
    }
    const 器 = shell.getBoundingClientRect()
    const 帯 = parseFloat(getComputedStyle(shell, '::before').height) || 20
    const y = Math.min(器.bottom - 帯 / 2, window.innerHeight - 4)
    const found = document.elementFromPoint(器.left + 器.width * 0.25, y)
    return found?.closest('[data-testid="row-body"]') === el
  })
  expect(帯の上に居るもの).toBe(true)
})
/**
 * 切った末尾に、フェードする相手が残っていること（設計§6-5）。
 *
 * **クラスが付いているかでは見ない。** フェーズ7 まで `data-fade` は付いていたのに、
 * **帯の下に文字が1つも無かった**——マスクが正しく敷けていても、消す相手が無ければ
 * 何も起きない。ここは**実際に文字が末尾まで届いているか**で見る。
 */
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
  await page.getByTestId('to-project').click()
  const view = page.getByTestId('session-view').first()
  await view.getByTestId('to-session').click()
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
  await page.getByTestId('to-project').click()
  const view = page.getByTestId('session-view').first()
  await expect(view).toHaveAttribute('data-view', 'terminal')

  // 切り替えて箱に高さが付いた、その描画で初めて寄せる
  await setTerminalView(view, false)
  await expect(view).toHaveAttribute('data-view', 'transcript')
  await expect(view.getByTestId('transcript-status')).toHaveAttribute('data-at-end', 'true')
})
