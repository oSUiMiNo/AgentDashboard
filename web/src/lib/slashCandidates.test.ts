import { describe, expect, it } from 'vitest'
import {
  filterCandidates,
  harvestCandidates,
  type FsPort,
  type SlashCandidate,
} from './slashCandidates'
import { BUILTIN_COMMANDS } from './builtinCommands'

/**
 * 偽のディスク。**口を引数で受け取る作りなので、モックを差し込まずに済む**。
 *
 * キーは絶対パス。フォルダは配列、ファイルは文字列で置く。
 */
function fakeFs(
  tree: Record<string, string[] | string>,
  options: { home?: string; truncated?: string[] } = {},
): FsPort {
  const home = options.home ?? '/home/tester'
  const truncated = new Set(options.truncated ?? [])
  return {
    listDir: async (path?: string) => {
      const target = path ?? home
      const entry = tree[target]
      if (!Array.isArray(entry)) throw new Error(`no such dir: ${target}`)
      return {
        path: target,
        entries: entry.map((name) => ({
          name: name.replace(/\/$/, ''),
          kind: name.endsWith('/') ? ('dir' as const) : ('file' as const),
          is_project: false,
        })),
        truncated: truncated.has(target),
      }
    },
    readFile: async (path: string) => {
      const entry = tree[path]
      if (typeof entry !== 'string') throw new Error(`no such file: ${path}`)
      return { path, text: entry, truncated: false, bytes: entry.length }
    },
  }
}

const names = (candidates: SlashCandidate[]) => candidates.map((c) => c.name)
/** 組み込みを除いた、ディスク由来のぶんだけ見る */
const fromDisk = (candidates: SlashCandidate[]) =>
  candidates.filter((c) => c.source !== 'builtin')

// ---------------------------------------------------------------------------
// テスト計画フェーズ2：集める・ディスクの3種（設計§2-1）
// ---------------------------------------------------------------------------

describe('ディスクの3種を集める', () => {
  it('利用者のコマンドが、拡張子を落とした名前で出る', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['deploy.md', 'README.txt'],
      '/home/tester/.claude/commands/deploy.md': '---\ndescription: 配る\n---\n本文',
    })
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['deploy'])
    // **`.md` でないものは拾わない**
    expect(names(fromDisk(candidates))).not.toContain('README')
  })

  it('PJT のコマンドも同じように出る', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/work/proj/.claude/commands': ['build.md'],
      '/work/proj/.claude/commands/build.md': '---\ndescription: 建てる\n---\n',
    })
    const { candidates } = await harvestCandidates(fs, '/work/proj')
    expect(names(fromDisk(candidates))).toEqual(['build'])
  })

  it('スキルはフォルダ名で出る', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/skills': ['pjt_read/'],
      '/home/tester/.claude/skills/pjt_read/SKILL.md': '---\ndescription: 読む\n---\n',
    })
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['pjt_read'])
  })

  it('PJT のスキルも同じように出る', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/work/proj/.claude/skills': ['local_only/'],
      '/work/proj/.claude/skills/local_only/SKILL.md': '---\ndescription: PJT用\n---\n',
    })
    const { candidates } = await harvestCandidates(fs, '/work/proj')
    expect(names(fromDisk(candidates))).toEqual(['local_only'])
  })

  it('同じ名前が PJT と利用者スコープの両方にあれば、PJT のほうが残る', async () => {
    // **探索順がそのまま優先順**（設計§2-1）。別の順にすると画面が嘘をつく
    const fs = fakeFs({
      '/home/tester': [],
      '/work/proj/.claude/commands': ['same.md'],
      '/work/proj/.claude/commands/same.md': '---\ndescription: PJT側\n---\n',
      '/home/tester/.claude/commands': ['same.md'],
      '/home/tester/.claude/commands/same.md': '---\ndescription: 利用者側\n---\n',
    })
    const { candidates } = await harvestCandidates(fs, '/work/proj')
    const same = candidates.filter((c) => c.name === 'same')
    expect(same).toHaveLength(1)
    expect(same[0]?.source).toBe('project-command')
    expect(same[0]?.description).toBe('PJT側')
  })

  it('同じ名前がコマンドとスキルの両方にあれば、コマンドのほうが残る', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['dup.md'],
      '/home/tester/.claude/commands/dup.md': '---\ndescription: コマンド側\n---\n',
      '/home/tester/.claude/skills': ['dup/'],
      '/home/tester/.claude/skills/dup/SKILL.md': '---\ndescription: スキル側\n---\n',
    })
    const { candidates } = await harvestCandidates(fs)
    const dup = candidates.filter((c) => c.name === 'dup')
    expect(dup).toHaveLength(1)
    expect(dup[0]?.source).toBe('user-command')
  })

  it('ホームは画面が組み立てず、listDir の返り値から取る', async () => {
    // **ホームを知っているのは PC 側だけ**（設計§2-1）
    const fs = fakeFs(
      {
        '/srv/other-home': [],
        '/srv/other-home/.claude/commands': ['far.md'],
        '/srv/other-home/.claude/commands/far.md': '---\ndescription: 別のホーム\n---\n',
      },
      { home: '/srv/other-home' },
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['far'])
  })

  it('入れ子のコマンドが /sub:名前 として出る', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['sub/'],
      '/home/tester/.claude/commands/sub': ['x.md'],
      '/home/tester/.claude/commands/sub/x.md': '---\ndescription: 入れ子\n---\n',
    })
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['sub:x'])
  })

  it('1つ読めなくても、その1件だけ落ちて残りは出る', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['ok.md', 'broken.md'],
      '/home/tester/.claude/commands/ok.md': '---\ndescription: 読める\n---\n',
      // broken.md は tree に置かない＝読めない
    })
    const { candidates, unreadable } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['ok'])
    expect(unreadable).toBe(1)
  })

  it('コマンドのフォルダが無くても、異常にしない', async () => {
    // **1つも置いていない機械が普通にある**
    const fs = fakeFs({ '/home/tester': [] })
    const { candidates, unreadable } = await harvestCandidates(fs)
    expect(fromDisk(candidates)).toEqual([])
    expect(unreadable).toBe(0)
  })

  it('打ち切られたことを隠さない', async () => {
    const fs = fakeFs(
      {
        '/home/tester': [],
        '/home/tester/.claude/commands': ['a.md'],
        '/home/tester/.claude/commands/a.md': '---\ndescription: あ\n---\n',
      },
      { truncated: ['/home/tester/.claude/commands'] },
    )
    const { truncated } = await harvestCandidates(fs)
    expect(truncated).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// テスト計画フェーズ3：集める・プラグインと組み込み（設計§2-2・§2-3）
// ---------------------------------------------------------------------------

/** 実物と同じ形の索引を作る（`plugins` の値は**エントリの配列**）。 */
function pluginTree(
  extra: Record<string, string[] | string>,
  enabled: Record<string, boolean>,
  installed: Record<string, string>,
): Record<string, string[] | string> {
  return {
    '/home/tester': [],
    '/home/tester/.claude/settings.json': JSON.stringify({ enabledPlugins: enabled }),
    '/home/tester/.claude/plugins/installed_plugins.json': JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        Object.entries(installed).map(([key, path]) => [key, [{ scope: 'user', installPath: path }]]),
      ),
    }),
    ...extra,
  }
}

describe('プラグインを索引から辿る', () => {
  it('enabledPlugins が true のものだけ拾う', async () => {
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/on/0.1.15/.claude-plugin/plugin.json': JSON.stringify({ name: 'on' }),
          '/cache/on/0.1.15/skills': ['use/'],
          '/cache/on/0.1.15/skills/use/SKILL.md': '---\ndescription: 有効\n---\n',
          '/cache/off/abc/.claude-plugin/plugin.json': JSON.stringify({ name: 'off' }),
          '/cache/off/abc/skills': ['nope/'],
          '/cache/off/abc/skills/nope/SKILL.md': '---\ndescription: 無効\n---\n',
        },
        { 'on@m': true, 'off@m': false },
        { 'on@m': '/cache/on/0.1.15', 'off@m': '/cache/off/abc' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['on:use'])
  })

  it('installPath を索引から引く（末尾の版を組み立てない）', async () => {
    // **git の sha と 0.1.15 形式が混在しても引ける**（設計§2-2）
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/a/85cce0381e78/.claude-plugin/plugin.json': JSON.stringify({ name: 'a' }),
          '/cache/a/85cce0381e78/skills': ['one/'],
          '/cache/a/85cce0381e78/skills/one/SKILL.md': '---\ndescription: sha 形式\n---\n',
          '/cache/b/0.1.15/.claude-plugin/plugin.json': JSON.stringify({ name: 'b' }),
          '/cache/b/0.1.15/skills': ['two/'],
          '/cache/b/0.1.15/skills/two/SKILL.md': '---\ndescription: 版番号形式\n---\n',
        },
        { 'a@m': true, 'b@m': true },
        { 'a@m': '/cache/a/85cce0381e78', 'b@m': '/cache/b/0.1.15' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['a:one', 'b:two'])
  })

  it('plugin.json の name が名前の前半になる', async () => {
    const fs = fakeFs(
      pluginTree(
        {
          // **フォルダ名は版。名乗りと違う**
          '/cache/x/9f9f/.claude-plugin/plugin.json': JSON.stringify({ name: 'nicename' }),
          '/cache/x/9f9f/skills': ['go/'],
          '/cache/x/9f9f/skills/go/SKILL.md': '---\ndescription: 名乗り\n---\n',
        },
        { 'x@m': true },
        { 'x@m': '/cache/x/9f9f' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['nicename:go'])
  })

  it('skills を差し替えていても数えられる（追加なので既定も見る）', async () => {
    // **`skills` は「追加」**（設計§2-2）。既定の skills/ は常に見られる
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/p/1/.claude-plugin/plugin.json': JSON.stringify({
            name: 'p',
            skills: './extra/',
          }),
          '/cache/p/1/skills': ['base/'],
          '/cache/p/1/skills/base/SKILL.md': '---\ndescription: 既定\n---\n',
          '/cache/p/1/extra': ['more/'],
          '/cache/p/1/extra/more/SKILL.md': '---\ndescription: 追加\n---\n',
        },
        { 'p@m': true },
        { 'p@m': '/cache/p/1' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates)).sort()).toEqual(['p:base', 'p:more'])
  })

  it('commands は置換なので、書いてあれば既定の commands/ を見ない', async () => {
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/p/1/.claude-plugin/plugin.json': JSON.stringify({
            name: 'p',
            commands: './mycmds/',
          }),
          '/cache/p/1/commands': ['ignored.md'],
          '/cache/p/1/commands/ignored.md': '---\ndescription: 見ないはず\n---\n',
          '/cache/p/1/mycmds': ['used.md'],
          '/cache/p/1/mycmds/used.md': '---\ndescription: こちらを見る\n---\n',
        },
        { 'p@m': true },
        { 'p@m': '/cache/p/1' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['p:used'])
  })

  it('commands を持たず skills だけのプラグインを、異常として落とさない', async () => {
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/p/1/.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
          '/cache/p/1/skills': ['only/'],
          '/cache/p/1/skills/only/SKILL.md': '---\ndescription: スキルだけ\n---\n',
          // commands/ は置かない
        },
        { 'p@m': true },
        { 'p@m': '/cache/p/1' },
      ),
    )
    const { candidates, unreadable } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['p:only'])
    expect(unreadable).toBe(0)
  })

  it('MCP だけを配るプラグイン（SKILL.md が無い）を、読めなかったと数えない', async () => {
    // **正常な機械で「N 件読めませんでした」と出てはいけない**
    const fs = fakeFs(
      pluginTree(
        { '/cache/mcponly/1/.claude-plugin/plugin.json': JSON.stringify({ name: 'mcponly' }) },
        { 'mcponly@m': true },
        { 'mcponly@m': '/cache/mcponly/1' },
      ),
    )
    const { candidates, unreadable } = await harvestCandidates(fs)
    expect(fromDisk(candidates)).toEqual([])
    expect(unreadable).toBe(0)
  })

  it('ルート直下の SKILL.md だけは、フロントマターの name が正', async () => {
    // **唯一の例外**（設計§3）。フォルダ名が版になるため
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/single/0.9.9/.claude-plugin/plugin.json': JSON.stringify({ name: 'single' }),
          '/cache/single/0.9.9/SKILL.md': '---\nname: written-name\ndescription: 単一\n---\n',
        },
        { 'single@m': true },
        { 'single@m': '/cache/single/0.9.9' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['written-name'])
  })

  it('marketplaces を辿らない（.bak で二重に出ない）', async () => {
    // **取得元であって実体ではない**（設計§2-2）。索引から installPath を引くので、
    // そもそも歩く経路に入らない
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/p/1/.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
          '/cache/p/1/skills': ['one/'],
          '/cache/p/1/skills/one/SKILL.md': '---\ndescription: 実体\n---\n',
          // 取得元の複製。**辿ると二重に出る**
          '/home/tester/.claude/plugins/marketplaces': ['m/', 'm.bak/'],
          '/home/tester/.claude/plugins/marketplaces/m': ['p/'],
          '/home/tester/.claude/plugins/marketplaces/m.bak': ['p/'],
        },
        { 'p@m': true },
        { 'p@m': '/cache/p/1' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['p:one'])
  })

  it('temp_git_* を辿らない（取得の残骸）', async () => {
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/p/1/.claude-plugin/plugin.json': JSON.stringify({ name: 'p' }),
          '/cache/p/1/skills': ['one/'],
          '/cache/p/1/skills/one/SKILL.md': '---\ndescription: 実体\n---\n',
          '/home/tester/.claude/plugins/cache': ['temp_git_abc/', 'p/'],
          '/home/tester/.claude/plugins/cache/temp_git_abc': ['skills/'],
        },
        { 'p@m': true },
        { 'p@m': '/cache/p/1' },
      ),
    )
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['p:one'])
  })

  it('索引が読めないプラグインは、その1件だけ落として続ける', async () => {
    const fs = fakeFs(
      pluginTree(
        {
          '/cache/good/1/.claude-plugin/plugin.json': JSON.stringify({ name: 'good' }),
          '/cache/good/1/skills': ['ok/'],
          '/cache/good/1/skills/ok/SKILL.md': '---\ndescription: 読める\n---\n',
          // bad の plugin.json は置かない
        },
        { 'good@m': true, 'bad@m': true },
        { 'good@m': '/cache/good/1', 'bad@m': '/cache/bad/1' },
      ),
    )
    const { candidates, unreadable } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['good:ok'])
    expect(unreadable).toBe(1)
  })

  it('プラグインを1つも入れていなくても、異常にしない', async () => {
    const fs = fakeFs({ '/home/tester': [] })
    const { unreadable } = await harvestCandidates(fs)
    expect(unreadable).toBe(0)
  })
})

describe('組み込みの表', () => {
  it('表の中身が候補に混ざる', async () => {
    const fs = fakeFs({ '/home/tester': [] })
    const { candidates } = await harvestCandidates(fs)
    for (const builtin of BUILTIN_COMMANDS) {
      expect(names(candidates)).toContain(builtin.name)
    }
  })

  it('組み込みには読んだファイルが無い', async () => {
    const fs = fakeFs({ '/home/tester': [] })
    const { candidates } = await harvestCandidates(fs)
    const builtin = candidates.filter((c) => c.source === 'builtin')
    expect(builtin.length).toBe(BUILTIN_COMMANDS.length)
    expect(builtin.every((c) => c.path === undefined)).toBe(true)
  })

  it('全部に説明が付いている（名前だけでは選べない）', () => {
    expect(BUILTIN_COMMANDS.every((c) => c.description !== '')).toBe(true)
  })

  it('表の中で名前が重複していない', () => {
    const seen = new Set(BUILTIN_COMMANDS.map((c) => c.name))
    expect(seen.size).toBe(BUILTIN_COMMANDS.length)
  })

  it('ディスクに同じ名前があれば、ディスクのほうが残る', async () => {
    // **探索順で組み込みは最後**。利用者が同名を置いたらそちらが勝つ
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['model.md'],
      '/home/tester/.claude/commands/model.md': '---\ndescription: 自作\n---\n',
    })
    const { candidates } = await harvestCandidates(fs)
    const model = candidates.filter((c) => c.name === 'model')
    expect(model).toHaveLength(1)
    expect(model[0]?.source).toBe('user-command')
  })

  it('ホームが引けなくても、組み込みだけは出す', async () => {
    // **全滅させるより、出せるものを出す**
    const fs = fakeFs({})
    const { candidates, unreadable } = await harvestCandidates(fs)
    expect(candidates.length).toBe(BUILTIN_COMMANDS.length)
    expect(unreadable).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// テスト計画フェーズ4：絞る・落とす（設計§3・§4）
// ---------------------------------------------------------------------------

describe('打てない名前を候補に出さない', () => {
  it('ファイル名と name が違えば、ファイル名のほうが出る', async () => {
    // **コマンドファイルの `name` は読まれずに捨てられる**（設計§3）。
    // 拾うと「候補に出るのに送れない」になり、無いより悪い
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['real-name.md'],
      '/home/tester/.claude/commands/real-name.md':
        '---\nname: written-name\ndescription: 名前は無視される\n---\n',
    })
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['real-name'])
    expect(names(fromDisk(candidates))).not.toContain('written-name')
  })

  it('スキルもフォルダ名が正で、name は拾わない', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/skills': ['folder-name/'],
      '/home/tester/.claude/skills/folder-name/SKILL.md':
        '---\nname: written-name\ndescription: 同じ理屈\n---\n',
    })
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['folder-name'])
  })

  it('user-invocable: false は出ない', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['shown.md', 'hidden.md'],
      '/home/tester/.claude/commands/shown.md': '---\ndescription: 出る\n---\n',
      '/home/tester/.claude/commands/hidden.md':
        '---\nuser-invocable: false\ndescription: 出ない\n---\n',
    })
    const { candidates, hidden } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['shown'])
    expect(hidden).toBe(1)
  })

  it('disable-model-invocation: true は出る（落としてはいけない側）', async () => {
    // **あれは Claude の自動呼び出しを止めるもので、人が `/` で打つのを妨げない**。
    // 落とす側に入れると、打てるものが黙って消える
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['manual.md'],
      '/home/tester/.claude/commands/manual.md':
        '---\ndisable-model-invocation: true\ndescription: 人が打つ\n---\n',
    })
    const { candidates, hidden } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['manual'])
    expect(hidden).toBe(0)
  })

  it('description が無くても出る（説明が無いだけで打てる）', async () => {
    const fs = fakeFs({
      '/home/tester': [],
      '/home/tester/.claude/commands': ['bare.md'],
      '/home/tester/.claude/commands/bare.md': '本文だけ。フロントマターが無い',
    })
    const { candidates } = await harvestCandidates(fs)
    expect(names(fromDisk(candidates))).toEqual(['bare'])
    expect(fromDisk(candidates)[0]?.description).toBe('')
  })
})

describe('打った文字で絞る', () => {
  const sample: SlashCandidate[] = [
    { name: 'pjt_read', description: '読む', source: 'user-command' },
    { name: 'pjt_write', description: '書く', source: 'user-command' },
    { name: 'clear', description: '消す', source: 'builtin' },
  ]

  it('/pj で pjt_ の2つが残る', () => {
    expect(names(filterCandidates(sample, '/pj'))).toEqual(['pjt_read', 'pjt_write'])
  })

  it('スラッシュだけなら全部出る', () => {
    expect(filterCandidates(sample, '/')).toHaveLength(3)
  })

  it('スラッシュで始まらなければ、1つも出さない', () => {
    // **普通の指示を打っている最中に一覧が出ると邪魔になる**
    expect(filterCandidates(sample, 'ただの指示')).toEqual([])
    expect(filterCandidates(sample, '')).toEqual([])
  })

  it('大文字小文字を区別しない', () => {
    expect(names(filterCandidates(sample, '/PJT'))).toEqual(['pjt_read', 'pjt_write'])
  })

  it('引数まで打っても、名前は確定したまま残る', () => {
    expect(names(filterCandidates(sample, '/clear いますぐ'))).toEqual(['clear'])
  })

  it('当たらなければ空になる', () => {
    expect(filterCandidates(sample, '/zzz')).toEqual([])
  })

  it('絞り込みで並びが入れ替わらない', () => {
    // **押そうとした的が逃げない**（設計§5）。1文字打つたびに順が変わってはいけない。
    //
    // **題材は「並べ替えたら順が変わる」ものでなければならない。** 長さの揃った
    // 名前で確かめると、当たり具合で並べ替える実装を入れても通ってしまい、
    // **何も見張っていないテストになる**（実際に壊し方を当てて素通りした）。
    // ここは**探索順で先に来るほうが長い**ようにしてある
    const jagged: SlashCandidate[] = [
      { name: 'pjt_read_long', description: '長い。探索順では先', source: 'project-command' },
      { name: 'pj', description: '短い。探索順では後', source: 'user-command' },
    ]
    expect(names(filterCandidates(jagged, '/p'))).toEqual(['pjt_read_long', 'pj'])
  })

  it('絞り込みは、渡された順をそのまま保つ', () => {
    // 上と同じ主張を、部分列であることで見る
    const before = names(filterCandidates(sample, '/'))
    const after = names(filterCandidates(sample, '/p'))
    expect(after).toEqual(before.filter((n) => n.startsWith('p')))
  })
})
