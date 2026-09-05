import { describe, expect, it } from 'vitest'
import {
  FRONT_MATTER_FOLD_LINES,
  commandCandidates,
  commandNameOf,
  isSafeCommandName,
  splitFrontMatter,
} from './slashCommandFile'

describe('打った形から名前を取る', () => {
  it('引数は捨てる', () => {
    // 読みに行く相手はファイルで、引数はファイルの名前に関わらない
    expect(commandNameOf('/issue_doc_design 人が打っていないもの')).toBe('issue_doc_design')
  })

  it('引数が無くても取れる', () => {
    expect(commandNameOf('/pjt_read')).toBe('pjt_read')
  })

  it('スラッシュで始まらなければ取れない', () => {
    expect(commandNameOf('ただの指示')).toBeNull()
  })

  it('スラッシュだけなら取れない', () => {
    expect(commandNameOf('/')).toBeNull()
  })
})

describe('名前の関所', () => {
  // **ここが唯一の関所である。** 名前はそのままパスへ埋まるので、通した文字が
  // そのまま組み立て先を決める
  it('英数字と _ - を通す', () => {
    expect(isSafeCommandName('issue_doc_design')).toBe(true)
    expect(isSafeCommandName('be-autonomous')).toBe(true)
    expect(isSafeCommandName('pjt2')).toBe(true)
  })

  it('親へ登る綴りを通さない', () => {
    // 通すと、組み立てた2形の外へ出られる
    expect(isSafeCommandName('..')).toBe(false)
    expect(isSafeCommandName('../../etc/passwd')).toBe(false)
    expect(isSafeCommandName('a/b')).toBe(false)
  })

  it('プラグインのスキル（コロン）は通さない', () => {
    // 置き場所を当てられないので、当てずっぽうに叩くより「読めない」と言うほうが早い
    expect(isSafeCommandName('supabase:supabase')).toBe(false)
  })

  it('空を通さない', () => {
    expect(isSafeCommandName('')).toBe(false)
  })
})

describe('探す順序', () => {
  // **PJT が先、利用者スコープが後。** Claude Code の解決順と揃えないと、
  // 画面が見せたファイルと実際に走った中身が食い違う
  it('PJT のコマンド → 利用者のコマンド → PJT のスキル → 利用者のスキル', () => {
    const found = commandCandidates('x', '/home/me', '/work/app')
    expect(found.map((c) => c.path)).toEqual([
      '/work/app/.claude/commands/x.md',
      '/home/me/.claude/commands/x.md',
      '/work/app/.claude/skills/x/SKILL.md',
      '/home/me/.claude/skills/x/SKILL.md',
    ])
    expect(found[0]?.source).toBe('project-command')
    expect(found[3]?.source).toBe('user-skill')
  })

  it('PJT が分からなければ、利用者スコープだけを探す', () => {
    const found = commandCandidates('x', '/home/me')
    expect(found.map((c) => c.path)).toEqual([
      '/home/me/.claude/commands/x.md',
      '/home/me/.claude/skills/x/SKILL.md',
    ])
  })

  it('末尾のスラッシュで二重にならない', () => {
    // フォルダのコピーは `/` を付ける仕様なので、貼って渡すだけで踏める
    const found = commandCandidates('x', '/home/me/', '/work/app/')
    expect(found[0]?.path).toBe('/work/app/.claude/commands/x.md')
    expect(found[1]?.path).toBe('/home/me/.claude/commands/x.md')
  })
})

describe('フロントマターを割る', () => {
  it('1行の値を取る', () => {
    const { front, body } = splitFrontMatter(
      ['---', 'description: 網羅的に把握する', 'model: opus', '---', '', '本文'].join('\n'),
    )
    expect(front).toEqual([
      { key: 'description', value: '網羅的に把握する', lines: 1 },
      { key: 'model', value: 'opus', lines: 1 },
    ])
    expect(body).toBe('本文')
  })

  it('`|` の塊を、行数つきで取る', () => {
    // **実物がこの形である**（`~/.claude/skills/investigate/SKILL.md` の `description`）
    const text = [
      '---',
      'name: investigate',
      'description: |',
      '  フォルダ・ローカルイシュー・PJT などの調査を、司令塔フォークへ丸ごと委譲する。',
      '  読み込みで膨らむコンテキストを司令塔側に閉じ込め、メインには整理された理解だけを受け取る。',
      '  司令塔は会話を引き継いだフォークなので、背景の説明が要らない。',
      '  「把握して」「調査して」に対し、対象が大きい場合に使う。',
      'model: opus',
      '---',
      '本文',
    ].join('\n')
    const { front } = splitFrontMatter(text)
    const description = front.find((entry) => entry.key === 'description')
    expect(description?.lines).toBe(4)
    expect(description?.value.split('\n')[0]).toContain('司令塔フォークへ丸ごと委譲する')
    // 字下げは剥がして返す（読ませるために割るので、YAML の形は残さない）
    expect(description?.value.startsWith(' ')).toBe(false)
    // 塊のあとの1行の項目も、続けて取れる
    expect(front.map((entry) => entry.key)).toEqual(['name', 'description', 'model'])
  })

  it('4行以上が畳む相手になる', () => {
    // **利用者の指定は4行以上。** 3行までは畳んでも縮まない
    expect(FRONT_MATTER_FOLD_LINES).toBe(4)
    const 三行 = ['---', 'a: |', '  1', '  2', '  3', '---', ''].join('\n')
    expect(splitFrontMatter(三行).front[0]?.lines).toBe(3)
    const 四行 = ['---', 'a: |', '  1', '  2', '  3', '  4', '---', ''].join('\n')
    expect(splitFrontMatter(四行).front[0]?.lines).toBe(4)
  })

  it('`---` で始まらなければ、全部が本文', () => {
    // 当てずっぽうに剥がすと、冒頭に区切り線を書いただけの文書が壊れる
    const text = '見出し\n\n---\n\n本文'
    const { front, body } = splitFrontMatter(text)
    expect(front).toEqual([])
    expect(body).toBe(text)
  })

  it('閉じの `---` が無ければ、全部が本文', () => {
    const text = '---\ndescription: 閉じ忘れ\n\n本文'
    const { front, body } = splitFrontMatter(text)
    expect(front).toEqual([])
    expect(body).toBe(text)
  })

  it('本文の中の `---` では切らない', () => {
    // このリポジトリの文書は節の区切りに `---` を置く作法なので、実際に踏む
    const text = ['---', 'model: opus', '---', '本文の頭', '', '---', '<br/>', '', '## 節'].join('\n')
    const { front, body } = splitFrontMatter(text)
    expect(front.map((entry) => entry.key)).toEqual(['model'])
    expect(body).toContain('## 節')
    expect(body.startsWith('本文の頭')).toBe(true)
  })

  it('フロントマターが空でも壊れない', () => {
    const { front, body } = splitFrontMatter('---\n---\n本文')
    expect(front).toEqual([])
    expect(body).toBe('本文')
  })
})
