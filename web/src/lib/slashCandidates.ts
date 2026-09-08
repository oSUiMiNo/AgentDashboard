/**
 * 入力欄に出すスラッシュコマンドの候補を集めて絞る（設計§2〜§5）。
 *
 * **ここは純関数だけで出来ている。** `window` も `document` も読まない——測る側と
 * 混ざると、jsdom が矩形を固定で返すせいで**何も確かめないまま緑になる**。
 * ディスクを読む口（`listDir` / `readFile`）は**引数で受け取る**ので、テストは
 * モックを差し込まずに、ただの関数として呼べる。
 *
 * ## 向きが `slashCommandFile.ts` と逆である
 * あちらは「名前を知っていて、場所を探す」（引き当て）。こちらは「名前を知らずに、
 * 場所から列挙する」（一覧）。**同じ4箇所を、逆向きに歩く。**
 *
 * `commandCandidates` が探索順の正を持っているので、**列挙もその順に合わせる**。
 * 別の順にすると、同名のときに**画面が見せたものと実際に走るものが食い違う**。
 *
 * ## 出どころは6つ、出すのは4つ＋表
 * 1〜4 はディスクから数え、5 は手で書いた表（`builtinCommands.ts`）で補い、
 * 6（MCP プロンプト）は**出さない**（設計§2-4。繋がっているサーバに聞くしか
 * 無く、そのための口を作るのは釣り合わない）。**出さないことは画面に書く。**
 */

import { BUILTIN_COMMANDS } from './builtinCommands'
import { splitFrontMatter } from './slashCommandFile'
import type { DirListing, FileContent } from './hostfs'

/** 候補がどこから出たか。**画面に添えて「どれを読んでいるか」を言う**。 */
export type CandidateSource =
  | 'project-command'
  | 'user-command'
  | 'project-skill'
  | 'user-skill'
  | 'plugin'
  | 'builtin'

/** 候補1つ。 */
export interface SlashCandidate {
  /** `/` に続けて打つ名前。**これがそのまま送られる** */
  name: string
  /** 一覧の2行目。無ければ空文字 */
  description: string
  source: CandidateSource
  /** どのファイルから出たか。組み込みは持たない */
  path?: string
}

/** 集めた結果。**数えたことも一緒に返す**（ログと画面の文面がこれを使う）。 */
export interface CandidateHarvest {
  candidates: SlashCandidate[]
  /** `user-invocable: false` で落としたぶん */
  hidden: number
  /** 読めずに落としたぶん。**1件読めなくても一覧は諦めない**（設計§4） */
  unreadable: number
  /** 上限で打ち切られたフォルダがあったか。**隠さない**（設計§5） */
  truncated: boolean
}

/** ディスクを読む口。**引数で受け取るので、ここは `hostfs` を import しない**。 */
export interface FsPort {
  listDir: (path?: string) => Promise<DirListing>
  readFile: (path: string) => Promise<FileContent>
}

const join = (root: string, tail: string) => `${root.replace(/\/+$/, '')}/${tail}`

/**
 * フロントマターから1項目の値を取る。
 *
 * **`splitFrontMatter` を使う。** YAML パーサを足さない——要るのは「その項目が
 * あるか」と「値が真か」の2つだけで、型を復元する必要が無い。
 */
function frontValue(text: string, key: string): string | undefined {
  const { front } = splitFrontMatter(text)
  return front.find((entry) => entry.key === key)?.value.trim()
}

/**
 * `/` のメニューに出してよいか（設計§4）。
 *
 * **落とすのは `user-invocable: false` だけ。** `disable-model-invocation: true`
 * は**落とさない**——あれは Claude の自動呼び出しを止めるもので、**人が `/` で
 * 打つのを妨げない**。名前が似ているので取り違えやすいが、落とす側に入れると
 * **打てるものが黙って消える**。
 */
function isUserInvocable(text: string): boolean {
  const value = frontValue(text, 'user-invocable')
  if (value === undefined) return true
  return !/^(false|no|off|0)$/i.test(value)
}

/** 一覧の2行目に出す説明。無ければ空文字（**説明が無いだけで打てる**）。 */
function descriptionOf(text: string): string {
  return frontValue(text, 'description')?.replace(/\s+/g, ' ').trim() ?? ''
}

/**
 * `.claude/commands/` の下を歩いて、コマンドを列挙する。
 *
 * **入れ子は `/sub:名前` になる**（設計§3）。潜るのは1段だけ——CLI が受け付ける
 * のがその形までであり、それ以上潜っても打てる名前にならない。
 */
async function harvestCommands(
  fs: FsPort,
  root: string,
  source: CandidateSource,
  out: CandidateHarvest,
): Promise<void> {
  let listing: DirListing
  try {
    listing = await fs.listDir(root)
  } catch {
    // **フォルダが無いのは異常ではない。** コマンドを1つも置いていない機械が普通にある
    return
  }
  if (listing.truncated) out.truncated = true

  for (const entry of listing.entries) {
    if (entry.kind === 'dir') {
      // 入れ子。**1段だけ潜る**
      let nested: DirListing
      try {
        nested = await fs.listDir(join(root, entry.name))
      } catch {
        out.unreadable += 1
        continue
      }
      if (nested.truncated) out.truncated = true
      for (const child of nested.entries) {
        if (child.kind === 'dir' || !child.name.endsWith('.md')) continue
        await pushFile(
          fs,
          join(join(root, entry.name), child.name),
          `${entry.name}:${child.name.slice(0, -3)}`,
          source,
          out,
        )
      }
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    await pushFile(fs, join(root, entry.name), entry.name.slice(0, -3), source, out)
  }
}

/**
 * `.claude/skills/<名前>/SKILL.md` を列挙する。
 *
 * **打つ名前はフォルダ名。** フロントマターの `name` は拾わない（設計§3）。
 */
async function harvestSkills(
  fs: FsPort,
  root: string,
  source: CandidateSource,
  out: CandidateHarvest,
  prefix = '',
): Promise<void> {
  let listing: DirListing
  try {
    listing = await fs.listDir(root)
  } catch {
    return
  }
  if (listing.truncated) out.truncated = true

  for (const entry of listing.entries) {
    if (entry.kind !== 'dir') continue
    await pushFile(
      fs,
      join(join(root, entry.name), 'SKILL.md'),
      prefix === '' ? entry.name : `${prefix}:${entry.name}`,
      source,
      out,
    )
  }
}

/**
 * 1つ読んで候補へ積む。
 *
 * **読めなかったら、その1件だけ落として続ける**（設計§4）。1つ読めないだけで
 * 一覧を丸ごと諦めない。
 *
 * `optional` は「**無いのが普通**」の場所に使う。MCP サーバだけを配るプラグイン
 * には `SKILL.md` がそもそも無いので、そこを「読めなかった」と数えると、
 * **正常な機械で毎回「N 件読めませんでした」と出る**ことになる。
 */
async function pushFile(
  fs: FsPort,
  path: string,
  name: string,
  source: CandidateSource,
  out: CandidateHarvest,
  nameFromFrontMatter = false,
  optional = false,
): Promise<void> {
  let file: FileContent
  try {
    file = await fs.readFile(path)
  } catch {
    if (!optional) out.unreadable += 1
    return
  }
  if (!isUserInvocable(file.text)) {
    out.hidden += 1
    return
  }
  // **プラグインのルート直下スキルだけ、`name` が正**（設計§3。フォルダ名が版になるため）
  const resolved = nameFromFrontMatter ? (frontValue(file.text, 'name') ?? name) : name
  out.candidates.push({
    name: resolved,
    description: descriptionOf(file.text),
    source,
    path,
  })
}

/**
 * 有効なプラグインを索引から辿って列挙する（設計§2-2）。
 *
 * **キャッシュのフォルダ名からプラグイン名を引けない。** 末尾が版になっており、
 * しかも形が揃っていない（git の sha と `0.1.15` が混在する）。**当てずっぽうに
 * 組み立てず、索引を読む。**
 *
 * 読んではいけない場所が2つある。**`cache/temp_git_*`** は取得の途中の残骸で、
 * **`marketplaces/`** は取得元であって実体ではない（`.bak` が居るので**辿ると
 * 同じものが二重に出る**）。ここはどちらも**辿らない**——`installPath` を索引から
 * 引くので、そもそも歩く経路に入らない。
 */
async function harvestPlugins(
  fs: FsPort,
  home: string,
  out: CandidateHarvest,
): Promise<void> {
  let enabled: Record<string, unknown>
  let installed: Record<string, unknown>
  try {
    const settings = await fs.readFile(join(home, '.claude/settings.json'))
    enabled = (JSON.parse(settings.text) as { enabledPlugins?: Record<string, unknown> })
      .enabledPlugins ?? {}
  } catch {
    // **索引が無いのは異常ではない。** プラグインを1つも入れていない機械がある
    return
  }
  try {
    const index = await fs.readFile(join(home, '.claude/plugins/installed_plugins.json'))
    installed = (JSON.parse(index.text) as { plugins?: Record<string, unknown> }).plugins ?? {}
  } catch {
    out.unreadable += 1
    return
  }

  for (const [key, on] of Object.entries(enabled)) {
    // **`true` のものだけ拾う**（設計§2-2）
    if (on !== true) continue
    // **値はエントリの配列**（実物で確認・2026-09-07）。先頭を採る
    const entries = installed[key]
    const first = Array.isArray(entries) ? entries[0] : entries
    const installPath =
      first !== null && typeof first === 'object'
        ? (first as { installPath?: unknown }).installPath
        : undefined
    if (typeof installPath !== 'string' || installPath === '') continue

    let manifest: { name?: unknown; skills?: unknown; commands?: unknown }
    try {
      const raw = await fs.readFile(join(installPath, '.claude-plugin/plugin.json'))
      manifest = JSON.parse(raw.text) as typeof manifest
    } catch {
      // **索引1枚で全滅させない**（承認済みの判断）。この1件だけ落として続ける
      out.unreadable += 1
      continue
    }
    const pluginName = typeof manifest.name === 'string' ? manifest.name : key.split('@')[0]
    if (pluginName === undefined || pluginName === '') continue

    // **`skills` は「追加」**（設計§2-2）。既定の `skills/` は常に見たうえで、
    // 書いてあるぶんを足す。**`commands` は「置換」**なので、書いてあれば既定を見ない
    const declared = asDirList(manifest.skills)
    const skillDirs = new Set<string>(['skills', ...declared])
    let found = out.candidates.length
    for (const dir of skillDirs) {
      await harvestSkills(fs, join(installPath, dir), 'plugin', out, pluginName)
    }
    found = out.candidates.length - found

    // **ルート直下の `SKILL.md` は唯一の例外**（設計§3）。`skills/` も `skills`
    // フィールドも無いプラグインは単一スキルとして自動ロードされ、**フォルダ名が
    // 版の文字列になるので、打つ名前はフロントマターの `name` が正**である。
    if (found === 0 && declared.length === 0) {
      await pushFile(fs, join(installPath, 'SKILL.md'), pluginName, 'plugin', out, true, true)
    }

    const commandDirs = asDirList(manifest.commands)
    for (const dir of commandDirs.length > 0 ? commandDirs : ['commands']) {
      await harvestPluginCommands(fs, join(installPath, dir), pluginName, out)
    }
  }
}

/** `"./skills/"` も `["./a", "./b"]` も受ける。**片方が無いことを異常にしない**。 */
function asDirList(value: unknown): string[] {
  const one = (v: unknown) =>
    typeof v === 'string' ? v.replace(/^\.\//, '').replace(/\/+$/, '') : undefined
  if (typeof value === 'string') {
    const dir = one(value)
    return dir === undefined || dir === '' ? [] : [dir]
  }
  if (Array.isArray(value)) {
    return value.map(one).filter((v): v is string => v !== undefined && v !== '')
  }
  return []
}

/** プラグインのコマンドは `/プラグイン名:名前` で打つ。 */
async function harvestPluginCommands(
  fs: FsPort,
  root: string,
  pluginName: string,
  out: CandidateHarvest,
): Promise<void> {
  let listing: DirListing
  try {
    listing = await fs.listDir(root)
  } catch {
    return
  }
  if (listing.truncated) out.truncated = true
  for (const entry of listing.entries) {
    if (entry.kind === 'dir' || !entry.name.endsWith('.md')) continue
    await pushFile(
      fs,
      join(root, entry.name),
      `${pluginName}:${entry.name.slice(0, -3)}`,
      'plugin',
      out,
    )
  }
}

/**
 * その PC の打てるものを、探索順に列挙する（設計§2-1）。
 *
 * **`home` は呼ぶ側が渡さない。** `listDir()` を `path` 省略で呼ぶと返り値の
 * `path` にホームの絶対パスが入るので、そこから取る——**ホームを知っているのは
 * PC 側だけ**で、画面が `~` を組み立てて送ることはできない。
 *
 * **同名は先に見つけたほうが残る。** 順は PJT のコマンド → 利用者のコマンド →
 * PJT のスキル → 利用者のスキル → プラグイン → 組み込み。これは
 * `commandCandidates` の順と同じで、**別の順にすると画面が嘘をつく**。
 */
export async function harvestCandidates(
  fs: FsPort,
  project?: string,
): Promise<CandidateHarvest> {
  const out: CandidateHarvest = {
    candidates: [],
    hidden: 0,
    unreadable: 0,
    truncated: false,
  }

  let home: string
  try {
    home = (await fs.listDir()).path
  } catch {
    // ホームが引けなければ、ディスクからは1件も数えられない。
    // **それでも組み込みは出す**——全滅させるより、出せるものを出したほうがよい
    return { ...out, candidates: builtinCandidates(), unreadable: out.unreadable + 1 }
  }

  if (project !== undefined && project !== '') {
    await harvestCommands(fs, join(project, '.claude/commands'), 'project-command', out)
  }
  await harvestCommands(fs, join(home, '.claude/commands'), 'user-command', out)
  if (project !== undefined && project !== '') {
    await harvestSkills(fs, join(project, '.claude/skills'), 'project-skill', out)
  }
  await harvestSkills(fs, join(home, '.claude/skills'), 'user-skill', out)
  await harvestPlugins(fs, home, out)
  out.candidates.push(...builtinCandidates())

  return { ...out, candidates: dedupe(out.candidates) }
}

function builtinCandidates(): SlashCandidate[] {
  return BUILTIN_COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    source: 'builtin' as const,
  }))
}

/**
 * 同名は**先に来たほうを残す**。
 *
 * 探索順がそのまま優先順なので、後から来たものを捨てるだけでよい。
 * **並べ替えない**——ここで順が変わると、上の探索順の意味が消える。
 */
function dedupe(candidates: SlashCandidate[]): SlashCandidate[] {
  const seen = new Set<string>()
  const kept: SlashCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.name)) continue
    seen.add(candidate.name)
    kept.push(candidate)
  }
  return kept
}

/* ──────────────────────────────────────────────────────────────────
 * 打ち間違いを許して当てる（設計§20）
 * ────────────────────────────────────────────────────────────────── */

/**
 * 当たった層（設計§20-2）。
 *
 * **画面はこれで確定キーの扱いを変える**（§20-5）。厳密（`exact` / `prefix`）は
 * 先頭が選ばれた状態で開き、あいまい（`words` / `distance`）は**どれも選ばれて
 * いない**状態で開く——当たりを緩めるということは、**今日0件だった入力が1件以上に
 * なる**ということで、放っておくと**今日は改行できていた Enter が補完に化ける**。
 */
export type CandidateTier = 'exact' | 'prefix' | 'words' | 'distance' | 'none'

/** [`matchCandidates`] の答え。**候補と、どの層で当たったか**。 */
export interface CandidateMatch {
  candidates: SlashCandidate[]
  tier: CandidateTier
}

/** 語の区切り。**`-` と `_` と空白を同じ扱いにする**のが、語順違いを拾う要（§20-2）。 */
const 区切り = /[-_\s]+/
/** 上と同じものを、数えるときに使う。 */
const 区切りを全部 = /[-_\s]+/g

/**
 * 置換だけ重い（§20-2）。**片方でも外すと `coten` が `codex` に負ける。**
 *
 * 一律 1.0 だと `coten`→`codex` と `coten`→`context` が同点になり、
 * **名前の短いほうが勝ってしまう**。
 */
const 置換の重み = 1.2
const 出し入れの重み = 1.0

/**
 * 許すずれの量（§20-3）。**打った語の長さで決める。入力全体の長さではない。**
 *
 * 候補名は `-` `_` で区切られた複合語なので、**短い語は短いなりに厳しく**見ないと、
 * `pjt` のような3文字が、長い名前の一部だというだけで緩む。
 *
 * この形（短い語ほど厳しく・語ごとに見る）は Elasticsearch・Algolia・Typesense・
 * Meilisearch が揃って採っているもので、数字だけが各社で違う。
 */
function しきい値(長さ: number): number {
  if (長さ <= 2) return 0
  if (長さ <= 4) return 1.2
  if (長さ <= 7) return 2.4
  return 3.6
}

/**
 * 当て具合。**ずれの大きさと、噛み合わなかった長さ**（§20-3の同点の壊し方が使う）。
 *
 * `外れ` は「打った長さと、実際に噛み合った候補の長さの差」である。**同じずれでも、
 * 打った文字を捨てて短い頭にだけ当てたものより、打った長さぶんきちんと噛み合った
 * ものを上にしたい**——`coten` に対して `context`（2.00・6文字ぶん噛み合う）と
 * `config`（2.00・`con` の3文字にだけ当たり、打った `te` を捨てている）が同点に
 * なるので、ここを見ないと**名前の短い `config` が勝ってしまう。**
 */
interface 当て具合 {
  ずれ: number
  外れ: number
}

/**
 * 同点とみなす幅。**`1.2` は2進数で表せないので、同じ合計が2通りの値になる。**
 *
 * 足す順で `1.0 + 1.2 + 1.2` が `3.4000000000000004`、`1.2 + 1.2 + 1.0` が `3.4` に
 * なる（差 4.4e-16）。ずれの積み方は「打った語をどの候補語へ当てたか」で変わるので、
 * **論理的には同点なのに値が違う組が実際に出る。**
 *
 * これを厳密な等号で比べると、**同点の壊し方（噛み合わなさ→名前の短さ→探索順）へ
 * 進む前に、誤差が順位を決めてしまう**——`context` が `config` に勝つ根拠は
 * 「噛み合わなさ」なので、そこへ辿り着けないと受け入れ条件が誤差任せになる。
 *
 * 幅は、意味のある差（重みの最小は `0.2`）よりはるかに小さく取る。
 */
const 同点の幅 = 1e-9

/** ずれが同点か。**論理的な同じさを見る**（上記 [`同点の幅`]）。 */
function 同じずれ(a: number, b: number): boolean {
  return Math.abs(a - b) <= 同点の幅
}

/** 当たらなかったときの印。 */
const 届かない: 当て具合 = { ずれ: Infinity, 外れ: Infinity }

/**
 * 重みつき編集距離。**候補の末尾は無料**（§20-2）。
 *
 * 打っている最中の文字列は**書きかけの前方**なので、候補の尻尾まで一致を求めては
 * いけない——`coten` を `context` 全体と比べると遠いが、`conte` までと比べれば近い。
 * だから返すのは「打った側を使い切った行の、いちばん小さいところ」である。
 *
 * **隣り合う入れ替え（`ba`→`ab`）も1回ぶんとして数える。** 置換2回として数えると
 * 2.4 になり、4文字の語では届かなくなる。
 *
 * **長さの差だけで無理と分かることがある。** 候補が短すぎれば、その差だけ削るしか
 * 無い——無料なのは候補が長いときの尻尾だけで、足りないぶんは埋まらない。
 */
function ずれ(打った: string, 候補: string, 上限: number): 当て具合 {
  const n = 打った.length
  const m = 候補.length
  if (n === 0) return { ずれ: 0, 外れ: 0 }
  if ((n - m) * 出し入れの重み > 上限) return 届かない

  // 隣り合う入れ替えに「1つ前の前」が要るので、行を3本持つ
  let 前々: number[] = []
  let 前: number[] = new Array<number>(m + 1)
  for (let j = 0; j <= m; j += 1) 前[j] = j * 出し入れの重み

  for (let i = 1; i <= n; i += 1) {
    const 今: number[] = new Array<number>(m + 1)
    今[0] = i * 出し入れの重み
    for (let j = 1; j <= m; j += 1) {
      const 同じ = 打った[i - 1] === 候補[j - 1]
      let v = Math.min(
        前[j] + 出し入れの重み,
        今[j - 1] + 出し入れの重み,
        前[j - 1] + (同じ ? 0 : 置換の重み),
      )
      if (
        i > 1 &&
        j > 1 &&
        打った[i - 1] === 候補[j - 2] &&
        打った[i - 2] === 候補[j - 1]
      ) {
        v = Math.min(v, 前々[j - 2] + 出し入れの重み)
      }
      今[j] = v
    }
    前々 = 前
    前 = 今
  }

  // **末尾は無料。** 打った側を使い切った行の最小値を採る。
  //
  // **同じ値が複数の場所で出たときは、打った長さにいちばん近いところを採る**——
  // 「どこまで噛み合ったか」は、同点を壊すときに効く（下記 `外れ`）
  let 答え = Infinity
  let 噛み合い = 0
  for (let j = 0; j <= m; j += 1) {
    if (前[j] < 答え || (前[j] === 答え && Math.abs(j - n) < Math.abs(噛み合い - n))) {
      答え = 前[j]
      噛み合い = j
    }
  }
  return 答え === Infinity ? 届かない : { ずれ: 答え, 外れ: Math.abs(噛み合い - n) }
}

/** 名前を語に割る。**`-` `_` 空白を同じ扱いにする**（§20-2）。 */
function 語に割る(text: string): string[] {
  return text.split(区切り).filter((word) => word !== '')
}

/**
 * 打った語1つを、候補の語1つへ当てる（§20-2）。当たらなければ `null`。
 *
 * **前方一致は0として数える。** 書きかけの語がそのまま伸びただけなので、
 * ずれではない——ここを1以上にすると、打ち終えていない語が常に不利になる。
 */
function 語を当てる(打った: string, 候補: string): 当て具合 | null {
  if (候補.startsWith(打った)) return { ずれ: 0, 外れ: 0 }
  const 上限 = しきい値(打った.length)
  if (上限 === 0) return null
  const d = ずれ(打った, 候補, 上限)
  return d.ずれ <= 上限 ? d : null
}

/**
 * 打った語を候補の語へ**重複なく**割り当てる（§20-2）。当たらなければ `null`。
 *
 * **順不同で見るのがここの仕事である**——`read_pjt` と `pjt_read` を同じものとして
 * 扱えないと、利用者が挙げた実例の2つが落ちる。考え方は fzf の extended-search と
 * 同じで（空白区切りの各語を独立に照合して AND で結ぶ）、**`_` と `-` へ同じ扱いを
 * 広げるところだけ**が自前の仕事にあたる。
 *
 * 語数は実測で高々3なので、総当たりで足りる。
 */
function 語で当てる(
  打った語: readonly string[],
  候補語: readonly string[],
): 当て具合 | null {
  if (打った語.length > 候補語.length) return null
  const 使った = new Array<boolean>(候補語.length).fill(false)
  let 最小 = 届かない
  const 進む = (i: number, 積み: 当て具合): void => {
    // **刈るのは「はっきり悪い」ときだけ。** 誤差ぶん大きいだけの割り当てをここで
    // 落とすと、噛み合わせの良いほうが**比べられる前に消える**（[`同点の幅`]）
    if (積み.ずれ > 最小.ずれ + 同点の幅) return
    if (i === 打った語.length) {
      // はっきり良ければ勝ち。**同点なら、噛み合わせの良いほうを採る**
      if (
        積み.ずれ < 最小.ずれ - 同点の幅 ||
        (同じずれ(積み.ずれ, 最小.ずれ) && 積み.外れ < 最小.外れ)
      ) {
        最小 = 積み
      }
      return
    }
    for (let j = 0; j < 候補語.length; j += 1) {
      if (使った[j]) continue
      const 当たり = 語を当てる(打った語[i], 候補語[j])
      if (当たり === null) continue
      使った[j] = true
      進む(i + 1, {
        ずれ: 積み.ずれ + 当たり.ずれ,
        外れ: 積み.外れ + 当たり.外れ,
      })
      使った[j] = false
    }
  }
  進む(0, { ずれ: 0, 外れ: 0 })
  return 最小.ずれ === Infinity ? null : 最小
}

/** 並べ替えのために、候補と、その当て具合と、探索順を束ねる。 */
interface 当たり {
  candidate: SlashCandidate
   当て具合: 当て具合
  順: number
}

/**
 * **層の中でも、いちばん良かった組だけを出す。**
 *
 * 設計§20-6 は「あいまいの層の実測は最大3件」を前提に `MAX_VISIBLE` を据え置いて
 * いるが、**ずれがしきい値以内のものを全部返すと、実データで15件出た**——
 * `/coten` に `glab_issue-comment_delete`（2.20）が、`/rewnd` に `html_read`（2.20）が
 * 混ざる。**どちらも見当外れで、出るほうが出ないより悪い。**
 *
 * これは門（§20-1）と同じ考えを層の中へ下ろしたものである。**明らかに良いものが
 * あるなら、大きく劣るものは並べない**——`/rewnd` は `rewind`（1.00）が在るのに
 * `html_read`（2.20）を並べる理由が無い。
 *
 * 端数の比較なので、**わずかな誤差は同点として扱う**（`0.2 + 1.2` が `1.4` に
 * ならない世界なので、厳密な等号で比べると同点が同点にならない）。
 */
function いちばん良い組(当たりたち: 当たり[]): 当たり[] {
  if (当たりたち.length === 0) return 当たりたち
  const 最良 = Math.min(...当たりたち.map((one) => one.当て具合.ずれ))
  return 当たりたち.filter((one) => one.当て具合.ずれ <= 最良 + 同点の幅)
}

/**
 * 同点の壊し方（§20-3）：**①ずれの小ささ ②噛み合わなさ ③名前の短さ ④探索順**。
 * 層そのものは呼ぶ側が分けているので、ここが持つのは②以降である。
 *
 * **②は設計に無い段を1つ足してある。** §20-3 は①③④の3段だったが、実データでは
 * `coten` に対して `context` と `config` が**どちらも 2.00 で同点**になり、③だけでは
 * 短い `config` が勝ってしまった（`config` は §19 で組み込み表へ足したばかりで、
 * 調査時の108件には居なかった）。**受け入れ条件は「3例が1位」なので、ここを
 * 足さないと要件を満たせない。**
 *
 * ②が見ているのは「打った長さぶん、きちんと噛み合ったか」である。`config` は
 * `con` の3文字にだけ当たり、**打った `te` を捨てて**同じ 2.00 に達している——
 * 捨てずに済んだほうを上にするのは、打ち間違いの直しとして素直である。
 *
 * **最後が探索順であること**が、いまの並び（PJT → 利用者 → PJT のスキル →
 * 利用者のスキル → プラグイン → 組み込み）を最下層で守る。
 *
 * **①は幅を持たせて比べる**（[`同点の幅`]）。ここへ来る前に
 * [`いちばん良い組`] が最良から幅の内側だけへ絞っているので、**残った差は
 * ほぼ誤差である**——素の引き算で比べると、その誤差が②③④より先に順位を決めて
 * しまい、`context` が `config` に勝つ根拠（②）へ辿り着けない。
 */
function 並べる(当たりたち: 当たり[]): SlashCandidate[] {
  return [...当たりたち]
    .sort(
      (a, b) =>
        (同じずれ(a.当て具合.ずれ, b.当て具合.ずれ)
          ? 0
          : a.当て具合.ずれ - b.当て具合.ずれ) ||
        a.当て具合.外れ - b.当て具合.外れ ||
        a.candidate.name.length - b.candidate.name.length ||
        a.順 - b.順,
    )
    .map((one) => one.candidate)
}

/**
 * 打った文字を候補へ当てる（設計§20）。**層で答える。**
 *
 * # 並べ替えではなく、層を足している
 *
 * §14 は「当たり具合で並べ替えると、**押そうとした的が逃げる**」として並び順を
 * 決めずに残した。**その判断は正しいままである**（VSCode 本体も同じ理由で同じ
 * 判断をしている）。だからここが持ち込むのは並べ替えではなく**層**で、
 *
 * - 上の層の**中の相対順序は一切変えない**（探索順のまま）
 * - 下の層は、**上の層が0件のときだけ現れる**
 *
 * したがって一覧は**並び替わるのではなく、0件から数件へ増える**。Algolia の
 * `typoTolerance: 'min'`（無タイポの一致が1件でもあればタイポ一致を全て隠す）と
 * 同じ形である。
 *
 * # 門が背骨である
 *
 * T0・T1 に1件でもあれば、**あいまいの層は計算すらしない**。`/c` `/con` `/pjt` の
 * ような日常の打鍵は、今日と1文字も変わらない——**速さも今日のまま**で、
 * あいまいの費用は「今日0件だった入力」でしか払わない。
 */
export function matchCandidates(
  candidates: readonly SlashCandidate[],
  text: string,
): CandidateMatch {
  if (!text.startsWith('/')) return { candidates: [], tier: 'none' }
  // **最初の語だけを見る。** `/cmd 引数` まで打った時点では、名前は確定している
  const typed = text.slice(1).split(/\s/, 1)[0] ?? ''
  if (typed === '') return { candidates: [...candidates], tier: 'prefix' }
  const needle = typed.toLowerCase()

  // T0・T1。**探索順のまま拾い、完全一致だけを頭へ回す**
  const 完全: SlashCandidate[] = []
  const 前方: SlashCandidate[] = []
  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase()
    if (name === needle) 完全.push(candidate)
    else if (name.startsWith(needle)) 前方.push(candidate)
  }
  // **門。** ここで返るから、今日の挙動が1文字も変わらない。
  //
  // **完全一致を頭へ回すのは、今日ある不具合を1つ直す**（§20-7）——`/issue_exe` と
  // 完全に打っても、探索順では `issue_exe-phase` が先に来るので**Enter を押すと
  // 違うコマンドが入る**。これはあいまい一致とは独立した壊れ方である
  if (完全.length > 0 || 前方.length > 0) {
    return {
      candidates: [...完全, ...前方],
      tier: 完全.length > 0 ? 'exact' : 'prefix',
    }
  }

  // **2文字以下では緩めない**（§20-3）。打った文字が少ないうちに緩めると、
  // 無関係なものを大量に釣る——**見当外れが出るのは、出ないより悪い**
  if (needle.replace(区切りを全部, '').length <= 2) {
    return { candidates: [], tier: 'none' }
  }

  // T2：語ごと照合・順不同
  const 打った語 = 語に割る(needle)
  const 語の当たり: 当たり[] = []
  candidates.forEach((candidate, 順) => {
    const d = 語で当てる(打った語, 語に割る(candidate.name.toLowerCase()))
    if (d !== null) 語の当たり.push({ candidate, 当て具合: d, 順 })
  })
  if (語の当たり.length > 0) {
    return { candidates: 並べる(いちばん良い組(語の当たり)), tier: 'words' }
  }

  // T3：末尾を無料にした重みつき編集距離。**budget は語ごとのしきい値の和**
  // （§20-3。入力全体の長さから引かない）
  const 上限 = 打った語.reduce((和, word) => 和 + しきい値(word.length), 0)
  const 距離の当たり: 当たり[] = []
  if (上限 > 0) {
    candidates.forEach((candidate, 順) => {
      const d = ずれ(needle, candidate.name.toLowerCase(), 上限)
      if (d.ずれ <= 上限) 距離の当たり.push({ candidate, 当て具合: d, 順 })
    })
  }
  if (距離の当たり.length > 0) {
    return { candidates: 並べる(いちばん良い組(距離の当たり)), tier: 'distance' }
  }

  return { candidates: [], tier: 'none' }
}

/**
 * 打った文字で候補を狭める（設計§5・§20）。
 *
 * **[`matchCandidates`] の薄い包みである。** 別実装にしない——片方だけ直して
 * 食い違うのは、このイシューが既に一度踏んだ形である（設計§20-4）。層まで要る側は
 * [`matchCandidates`] を直接呼ぶこと。
 *
 * `text` は入力欄の中身をそのまま受ける。`/` で始まらなければ**候補を出さない**
 * （空配列を返す）——普通の指示を打っている最中に一覧が出ると邪魔になる。
 */
export function filterCandidates(
  candidates: readonly SlashCandidate[],
  text: string,
): SlashCandidate[] {
  return matchCandidates(candidates, text).candidates
}

/** 候補を出すべき `/` の場所（[`slashQueryAt`]）。 */
export interface SlashQuery {
  /** `/` そのものの位置。**確定はここから置き換える** */
  start: number
  /** 語の終わり（次の空白の手前）。**確定はここまでを置き換える** */
  end: number
  /** `/` を含めた語。そのまま [`filterCandidates`] へ渡せる */
  token: string
}

/**
 * いま居る場所が、候補を出すべき `/` の語の中かを見る（設計§5-2）。
 *
 * **先頭とは限らない。** `いつもの手順を踏んでから /rewind` のように文の途中で
 * 打っても出す——**名前を思い出す道具**として要る、というのが足した理由である
 * （2026-09-08）。
 *
 * **語の頭の `/` だけを見る。** 直前が「入力の先頭・空白・改行」のいずれかである
 * ことを求めるので、`http://` や `and/or` では出ない——どこでも出すと、URL を
 * 貼るたびに一覧が被さって、便利どころか邪魔になる。
 *
 * **語から出たら閉じる。** `/cmd 引数` の引数側に居る間は `null` を返す。名前は
 * もう決まっているのに開いたままだと、**素の Enter が改行でなく確定になる**時間が
 * 文の最後まで伸びる（設計§7 の押し分けは「一覧が出ているか」で切り替わる）。
 *
 * @param text 入力欄の中身そのまま
 * @param caret いまの位置（`selectionStart`）。範囲外は端へ丸める
 * @returns 出すべきなら場所、出さないなら `null`
 */
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  const 位置 = Math.max(0, Math.min(caret, text.length))
  const 空白 = (index: number) => /\s/.test(text[index] ?? '')
  // 位置から左へ、空白に当たるまで戻る。止まったところが語の頭
  let start = 位置
  while (start > 0 && !空白(start - 1)) start -= 1
  if (text[start] !== '/') return null
  // 右へ、空白に当たるまで進む。**位置より右も語のうち**——`/re|wind` で確定したら
  // `wind` が残ってはいけない
  let end = 位置
  while (end < text.length && !空白(end)) end += 1
  return { start, end, token: text.slice(start, end) }
}
