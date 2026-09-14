import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dropEdit, editKey, MAX_EDITS, putEdit, readEdit, readEditDetails } from '@/lib/fileEdits'

/**
 * ファイルビュアの書きかけ（`ファイルビュアにエディタ機能を追加` 設計§7）。
 *
 * **守っているのは「消えないこと」である。** この PJT の流儀は確認ダイアログで止める
 * のではなく、**写しておいて、どの経路で画面が消えても無害にする**こと。
 */

beforeEach(() => {
  globalThis.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('書きかけの置き場', () => {
  it('置いたものが読める', () => {
    putEdit('local', '/home/me/a.md', '書きかけ', null)
    expect(readEdit('local', '/home/me/a.md', null)).toBe('書きかけ')
  })

  it('触っていなければ null。**空文字列と区別する**', () => {
    // **全部消したのも編集である。** null と混ぜると、消した状態が復元されない
    expect(readEdit('local', '/home/me/a.md', null)).toBeNull()
    putEdit('local', '/home/me/a.md', '', null)
    expect(readEdit('local', '/home/me/a.md', null)).toBe('')
  })

  it('ホストとパスの両方で分かれる', () => {
    putEdit('local', '/home/me/a.md', 'こちら', null)
    putEdit('別のPC', '/home/me/a.md', 'あちら', null)
    putEdit('local', '/home/me/b.md', 'べつ', null)

    expect(readEdit('local', '/home/me/a.md', null)).toBe('こちら')
    expect(readEdit('別のPC', '/home/me/a.md', null)).toBe('あちら')
    expect(readEdit('local', '/home/me/b.md', null)).toBe('べつ')
  })

  it('口座が違えば混ざらない', () => {
    putEdit('local', '/home/me/a.md', 'あ', 'ひとり目')
    expect(readEdit('local', '/home/me/a.md', 'ふたり目')).toBeNull()
    expect(readEdit('local', '/home/me/a.md', 'ひとり目')).toBe('あ')
  })

  it('捨てると消える', () => {
    putEdit('local', '/home/me/a.md', 'あ', null)
    dropEdit('local', '/home/me/a.md', null)
    expect(readEdit('local', '/home/me/a.md', null)).toBeNull()
  })

  it('無いものを捨てても落ちない', () => {
    expect(() => {
      dropEdit('local', '/home/me/無い.md', null)
    }).not.toThrow()
  })
})

describe('上限', () => {
  it('超えたら、最後に書いてから最も古いものが落ちる', () => {
    for (let at = 0; at < MAX_EDITS; at += 1) {
      putEdit('local', `/home/me/${at}.md`, String(at), null)
    }
    // **いちばん古いものを書き直して、末尾へ送る**
    putEdit('local', '/home/me/0.md', '書き直した', null)
    // 1つ増やすと、落ちるのは「最後に書いてから最も古いもの」＝ 1.md
    putEdit('local', '/home/me/新しい.md', 'あたらしい', null)

    expect(readEdit('local', '/home/me/0.md', null)).toBe('書き直した')
    expect(readEdit('local', '/home/me/1.md', null)).toBeNull()
    expect(readEdit('local', '/home/me/新しい.md', null)).toBe('あたらしい')
  })
})

describe('壊れていても落ちない', () => {
  it('置けない設定のブラウザでも、その回の編集は成立する', () => {
    const 壊す = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('拒まれた')
    })
    expect(putEdit('local', '/home/me/a.md', 'あ', null)).toBe(false)
    expect(readEdit('local', '/home/me/a.md', null)).toBeNull()
    壊す.mockRestore()
  })

  it('中身が壊れていたら、空として扱う', () => {
    globalThis.localStorage.setItem('agentdashboard.file-edits.local', '{壊れている')
    expect(readEdit('local', '/home/me/a.md', null)).toBeNull()
  })
})

describe('元の版を保つ', () => {
  const path = '/home/me/a.md'
  const storageKey = 'agentdashboard.file-edits.local'

  it('元のstampを本文と一緒に戻し、文字列だけ読む既存の口も保つ', () => {
    expect(putEdit('local', path, '書きかけ', null, '元の版')).toBe(true)
    expect(readEditDetails('local', path, null)).toEqual({ text: '書きかけ', baseStamp: '元の版' })
    expect(readEdit('local', path, null)).toBe('書きかけ')
    const restored = readEditDetails('local', path, null)!
    restored.baseStamp = '変更してはいけない'
    expect(readEditDetails('local', path, null)?.baseStamp).toBe('元の版')
  })

  it('旧形式の文字列とメタデータ付きの行が同居できる', () => {
    globalThis.localStorage.setItem(storageKey, JSON.stringify({
      [editKey('local', path)]: '旧形式',
      [editKey('local', '/b.txt')]: { text: '新形式', baseStamp: 's1' },
    }))
    expect(readEditDetails('local', path, null)).toEqual({ text: '旧形式', baseStamp: null })
    expect(readEditDetails('local', '/b.txt', null)).toEqual({ text: '新形式', baseStamp: 's1' })
    putEdit('local', '/c.txt', '別の編集', null, 's2')
    expect(readEdit('local', path, null)).toBe('旧形式')
    expect(readEdit('local', '/b.txt', null)).toBe('新形式')
  })

  it('stampなしで呼ぶ既存のputEditは基準不明として保持する', () => {
    putEdit('local', path, '', null)
    expect(readEditDetails('local', path, null)).toEqual({ text: '', baseStamp: null })
  })

  it.each([undefined, null, '', 42])('壊れたstampを確認済みの版として扱わない（%s）', (baseStamp) => {
    globalThis.localStorage.setItem(storageKey, JSON.stringify({
      [editKey('local', path)]: { text: '失くせない文', baseStamp },
    }))
    expect(readEditDetails('local', path, null)).toEqual({ text: '失くせない文', baseStamp: null })
  })

  it('読めない表へ書き戻して他の下書きを失くさない', () => {
    putEdit('local', path, '元の編集', null, 's1')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('読めない')
    })
    expect(putEdit('local', '/b.txt', '新しい編集', null, 's2')).toBe(false)
    expect(dropEdit('local', path, null)).toBe(false)
    expect(set).not.toHaveBeenCalled()
    get.mockRestore()
    set.mockRestore()
    expect(readEdit('local', path, null)).toBe('元の編集')
  })

  it('削除を書き戻せないときも失敗を返す', () => {
    putEdit('local', path, '残る文', null, 's1')
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('容量不足')
    })
    expect(dropEdit('local', path, null)).toBe(false)
    set.mockRestore()
    expect(readEdit('local', path, null)).toBe('残る文')
  })
})

describe('置き場を分けてある', () => {
  /*
    **`lib/filesPlace.ts` と同居させない**（設計§7-1）。あちらは「開いていたタブの並び」を
    覚える表で、**上限を超えると古いものから捨てる**。

    **捨ててよいもの（どのタブを開いていたか）と、捨てると編集が消えるものを、同じ表に
    置かない。** 置くと、タブを 20 個開いた人の書きかけが黙って消える。
  */
  it('タブの置き場とは別の鍵を使う', () => {
    const 置き場 = readFileSync(
      resolve(process.cwd(), 'src/lib/filesPlace.ts'),
      'utf8',
    )
    const 書きかけ = readFileSync(
      resolve(process.cwd(), 'src/lib/fileEdits.ts'),
      'utf8',
    )
    const 鍵を取る = (src: string): string => {
      const 宣言 = /const PREFIX = '([^']+)'/.exec(src)
      return 宣言?.[1] ?? ''
    }
    const あちら = /'(agentdashboard\.[^']+)'/.exec(置き場)?.[1] ?? ''
    const こちら = 鍵を取る(書きかけ)

    expect(こちら, '書きかけの鍵が読めない').not.toBe('')
    expect(あちら, 'タブの置き場の鍵が読めない').not.toBe('')
    expect(こちら).not.toBe(あちら)
  })

  it('鍵にプロジェクトを混ぜない', () => {
    /*
      同じファイルを PJT 専用画面から開いてもセッション専用画面から開いても、**同じ編集**で
      あるべきである。混ぜると、片方で打った文がもう片方から見えない。
    */
    expect(editKey('local', '/home/me/a.md')).toBe('local\n/home/me/a.md')
  })
})
