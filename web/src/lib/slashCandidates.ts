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

/**
 * 打った文字で候補を狭める（設計§5）。
 *
 * **並びを入れ替えない。** 当たり具合で並べ替えると、**押そうとした的が逃げる**
 * ——1文字打つたびに順が変わると、目で追っている行が別のものになる。
 * 並べ替えを足すかどうかは決めていない（設計§14）ので、ここは探索順のまま残す。
 *
 * `text` は入力欄の中身をそのまま受ける。`/` で始まらなければ**候補を出さない**
 * （空配列を返す）——普通の指示を打っている最中に一覧が出ると邪魔になる。
 */
export function filterCandidates(
  candidates: readonly SlashCandidate[],
  text: string,
): SlashCandidate[] {
  if (!text.startsWith('/')) return []
  // **最初の語だけを見る。** `/cmd 引数` まで打った時点では、名前は確定している
  const typed = text.slice(1).split(/\s/, 1)[0] ?? ''
  if (typed === '') return [...candidates]
  const needle = typed.toLowerCase()
  return candidates.filter((candidate) => candidate.name.toLowerCase().startsWith(needle))
}
