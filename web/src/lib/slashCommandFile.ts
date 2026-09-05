/**
 * 打ったスラッシュコマンドの**実ファイル**を引き当て、読める形に割る
 * （`人が打っていないものを、人の発言として出さない` 設計§11）。
 *
 * # なぜ吹き出しが持っている展開を使わないのか
 *
 * **展開レコードにフロントマターは入っていない**（実測。設計§11-1）。あれは
 * CLI が本文を展開したあとの姿で、`---` の囲みは落ちている。利用者が見たいのは
 * 「**ファイルに書かれてる内容**」なので、ファイルそのものを読むしかない。
 *
 * # なぜ新しい口を作らないのか
 *
 * **`cli_surface.toml` は「画面に口を足したら CLI へ写す」約束の台帳**である。
 * 引き当ては既にある2つの口（`listDir` と `readFile`）の組み合わせで足りるので、
 * 口を1つ増やすと**台帳と CLI の側にも一生ぶんの持ち物が増える**。
 *
 * **届く範囲は1バイトも広がらない。** `readFile` は元から場所を選ばない口で
 * （辿れる範囲を PJT の下に限るのは**画面の作法**であって口の制限ではない）、
 * ここが組み立てるのは `.claude/commands/<名前>.md` と
 * `.claude/skills/<名前>/SKILL.md` の2形だけである。
 *
 * **代償は往復の数**——初回だけ最大5回（ホーム1回＋候補4回）叩く。ホームは
 * 覚えるので2回目からは4回以下になる。押したときにだけ走るので、待ちは人の
 * 操作の内側に収まる。
 */

import { type FileContent, HostFsError, listDir, readFile } from './hostfs'

/**
 * フロントマターの項目のうち、**畳んで出す行数の下限**（利用者の指定）。
 *
 * **4行以上を畳む。** 3行までは畳んでも縮まないので、畳む仕掛けのほうが背が高くなる。
 * 根拠のある数ではないので**実物を見て決め直せるようここに置く**（`MACHINE_FOLD_LINES`
 * と同じ扱い）。
 */
export const FRONT_MATTER_FOLD_LINES = 4

/** 引き当てた1件。 */
export interface CommandFile {
  /** 実際に読めた場所 */
  path: string
  /** どの箱から出たか。画面に添えて「どれを読んでいるか」を言う */
  source: 'project-command' | 'user-command' | 'project-skill' | 'user-skill'
  /** フロントマターを剥がした本文 */
  body: string
  /** フロントマターの項目。無ければ空 */
  front: FrontMatterEntry[]
  /** 上限の内側で切られたか。**隠さない** */
  truncated: boolean
}

/** フロントマターの1項目。 */
export interface FrontMatterEntry {
  key: string
  /** 値。複数行はそのまま改行を含む */
  value: string
  /** 値の行数。**畳むかどうかはこれで決まる** */
  lines: number
}

/**
 * 打った形から名前だけを取る（`/名前 引数` → `名前`）。
 *
 * **引数は捨てる。** 読みに行く相手はファイルであって、引数はファイルの名前に
 * 関わらない。
 */
export function commandNameOf(typed: string): string | null {
  const head = typed.trim().split(/\s+/, 1)[0] ?? ''
  if (!head.startsWith('/')) {
    return null
  }
  const name = head.slice(1)
  return name === '' ? null : name
}

/**
 * 名前として受け付ける形か。
 *
 * **ここが唯一の関所である。** 引き当ては名前をそのままパスへ埋めるので、
 * `..` や `/` を通すと**組み立てた2形の外へ出られる**。英数字と `_` `-` だけに
 * 限れば、埋めた先は必ず `.claude/commands/` か `.claude/skills/` の直下になる。
 *
 * **プラグインのスキル（`plugin:skill`）は通さない。** `:` を許すと箱の数だけ
 * 候補が増え、しかも置き場所を当てられない——読めないものを「読めない」と
 * 言うほうが、当てずっぽうに4回叩くより早い。
 */
export function isSafeCommandName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/**
 * 探す順序（設計§11-2）。
 *
 * **PJT が先、利用者スコープが後。** Claude Code の解決順がそうなっており、
 * ここだけ別の順にすると「画面が見せたファイル」と「実際に走った中身」が
 * 食い違う——**嘘をつく画面になる**。
 *
 * **コマンドが先、スキルが後。** 同じ名前が両方にある場合、`/名前` で起きるのは
 * コマンドのほうである。
 */
export function commandCandidates(
  name: string,
  home: string,
  project?: string,
): { path: string; source: CommandFile['source'] }[] {
  const found: { path: string; source: CommandFile['source'] }[] = []
  const join = (root: string, tail: string) => `${root.replace(/\/+$/, '')}/${tail}`
  if (project) {
    found.push({ path: join(project, `.claude/commands/${name}.md`), source: 'project-command' })
  }
  found.push({ path: join(home, `.claude/commands/${name}.md`), source: 'user-command' })
  if (project) {
    found.push({ path: join(project, `.claude/skills/${name}/SKILL.md`), source: 'project-skill' })
  }
  found.push({ path: join(home, `.claude/skills/${name}/SKILL.md`), source: 'user-skill' })
  return found
}

/**
 * フロントマターを割る（設計§11-3）。
 *
 * **YAML を丸ごと解釈しない。** ここが要るのは「項目の名前」と「値の見た目」と
 * 「何行あるか」の3つだけで、型を復元する必要が無い。**読ませるために割るので
 * あって、使うために解くのではない。**
 *
 * 受ける形は3つ。
 *
 * - 1行の値（`model: opus`）
 * - 塊の値（`description: |` のあとに字下げが続く）
 * - 字下げで継ぐ値（キーの次の行から字下げが始まる）
 *
 * **`---` で始まらなければフロントマターは無い**とみなし、全部を本文として返す。
 * 当てずっぽうに剥がすと、本文の冒頭に区切り線を書いただけの文書が壊れる。
 */
export function splitFrontMatter(text: string): { front: FrontMatterEntry[]; body: string } {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { front: [], body: text }
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) {
    return { front: [], body: text }
  }

  const front: FrontMatterEntry[] = []
  let current: { key: string; parts: string[] } | null = null
  const close = () => {
    if (!current) {
      return
    }
    // 末尾の空行は数に入れない——`|` の塊は空行で終わることがあり、
    // 数えると「4行」の線が見た目とずれる
    while (current.parts.length > 1 && current.parts[current.parts.length - 1]?.trim() === '') {
      current.parts.pop()
    }
    const value = current.parts.join('\n')
    front.push({ key: current.key, value, lines: current.parts.length })
    current = null
  }

  for (const line of lines.slice(1, end)) {
    const head = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line)
    if (head && !/^[ \t]/.test(line)) {
      close()
      const [, key = '', inline = ''] = head
      // `|` と `>` は「次から塊が来る」という合図なので、値そのものには出さない
      const opener = inline.trim()
      const parts = opener === '|' || opener === '>' || opener === '' ? [] : [inline.trim()]
      current = { key, parts }
      continue
    }
    if (current) {
      current.parts.push(line.replace(/^ {2}|^\t/, ''))
    }
  }
  close()

  return { front, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') }
}

/**
 * 引き当てて読む（設計§11-2）。
 *
 * **見つからなかったことを、黙って空で返さない。** どこを探したかを添えて投げる
 * ——「押しても何も出ない」と「そもそも置き場所に無い」は、読む側にとって別物である。
 */
export async function loadCommandFile(
  host: string,
  typed: string,
  project?: string,
): Promise<CommandFile> {
  const name = commandNameOf(typed)
  if (name === null || !isSafeCommandName(name)) {
    throw new HostFsError(400, `「${typed}」からコマンドの名前を取れませんでした。`)
  }

  const home = (await listDir(host)).path
  const candidates = commandCandidates(name, home, project)

  let last: unknown = null
  for (const candidate of candidates) {
    let content: FileContent
    try {
      content = await readFile(host, candidate.path)
    } catch (error) {
      last = error
      continue
    }
    const { front, body } = splitFrontMatter(content.text)
    return {
      path: content.path,
      source: candidate.source,
      body,
      front,
      truncated: content.truncated,
    }
  }

  const where = candidates.map((candidate) => candidate.path).join('\n')
  const why = last instanceof HostFsError && last.status !== 404 ? `\n（最後の断り：${last.message}）` : ''
  throw new HostFsError(404, `/${name} のファイルが見つかりませんでした。探した場所：\n${where}${why}`)
}
