import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropDraft,
  MAX_DRAFTS,
  putDraft,
  readDraft,
  useDraft,
  WRITE_DEBOUNCE_MS,
} from './drafts'

/**
 * 入力欄の書きかけ（テスト計画フェーズ3「部品」）。
 *
 * # 送信の成否は、この層では分からない
 *
 * 「送信に成功したら消える／失敗したら残る」は、**空を渡したら忘れる／渡さなければ残る**
 * として確かめる。押したときにどちらを呼ぶかは入力欄の側の判断で、そちらはフェーズ4 で
 * 見る（テスト計画フェーズ4「入力欄」）。
 */

const ALICE = 'alice'

beforeEach(() => {
  globalThis.localStorage.clear()
})

describe('表としての持ち方', () => {
  it('カードごとに分かれ、混ざらない', () => {
    putDraft('a', ALICE, 'あちらの文')
    putDraft('b', ALICE, 'こちらの文')
    expect(readDraft('a', ALICE)).toBe('あちらの文')
    expect(readDraft('b', ALICE)).toBe('こちらの文')
  })

  it('覚えていないカードは空', () => {
    expect(readDraft('none', ALICE)).toBe('')
  })

  it('空を渡したら忘れる（送信に成功したとき）', () => {
    putDraft('a', ALICE, '書きかけ')
    putDraft('a', ALICE, '')
    expect(readDraft('a', ALICE)).toBe('')
  })

  it('渡さなければ残る（送信に失敗したとき）', () => {
    putDraft('a', ALICE, '送れなかった文')
    // 送信が失敗した回は、消す側を呼ばない。**消えるのがいちばん困る形**
    expect(readDraft('a', ALICE)).toBe('送れなかった文')
  })

  it('カードを外したら、その行も落ちる', () => {
    putDraft('a', ALICE, '書きかけ')
    dropDraft('a', ALICE)
    expect(readDraft('a', ALICE)).toBe('')
  })

  it('アカウントが違えば表が分かれる', () => {
    putDraft('a', ALICE, 'alice の文')
    putDraft('a', 'bob', 'bob の文')
    expect(readDraft('a', ALICE)).toBe('alice の文')
    expect(readDraft('a', 'bob')).toBe('bob の文')
  })

  it('アカウントが無い（ローカルモード）でも持てる', () => {
    putDraft('a', null, 'ローカルの文')
    expect(readDraft('a', null)).toBe('ローカルの文')
    // 番兵を使っているので、名前つきの表とは混ざらない
    expect(readDraft('a', ALICE)).toBe('')
  })

  it('上限を超えたら、最後に書いてから最も古いものから落ちる', () => {
    for (let i = 0; i < MAX_DRAFTS; i += 1) {
      putDraft(`card-${i}`, ALICE, `文 ${i}`)
    }
    // いちばん古いものを書き直して末尾へ送る
    putDraft('card-0', ALICE, '書き直した')
    putDraft('溢れさせる', ALICE, '新しい文')

    expect(readDraft('溢れさせる', ALICE)).toBe('新しい文')
    expect(readDraft('card-0', ALICE)).toBe('書き直した')
    // 落ちたのは、書き直さなかったうちのいちばん古いもの
    expect(readDraft('card-1', ALICE)).toBe('')
    expect(readDraft(`card-${MAX_DRAFTS - 1}`, ALICE)).toBe(`文 ${MAX_DRAFTS - 1}`)
  })

  it('壊れた中身は空として扱い、落ちない', () => {
    globalThis.localStorage.setItem('agentdashboard.drafts.alice', '{壊れている')
    expect(readDraft('a', ALICE)).toBe('')
    expect(() => putDraft('a', ALICE, '書けること')).not.toThrow()
    expect(readDraft('a', ALICE)).toBe('書けること')
  })

  it('置けない環境でも落ちない', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('置けない')
      },
      setItem: () => {
        throw new Error('置けない')
      },
    })
    expect(readDraft('a', ALICE)).toBe('')
    expect(() => putDraft('a', ALICE, '書きかけ')).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('useDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('覚えていた文から始まる', () => {
    putDraft('a', ALICE, '前に書いた文')
    const view = renderHook(() => useDraft('a', ALICE))
    expect(view.result.current[0]).toBe('前に書いた文')
    view.unmount()
  })

  it('打った文はその場で画面に出る', () => {
    const view = renderHook(() => useDraft('a', ALICE))
    act(() => view.result.current[1]('打っている途中'))
    expect(view.result.current[0]).toBe('打っている途中')
    view.unmount()
  })

  it('書き出しは窓でまとめる（1文字ごとに書かない）', () => {
    const view = renderHook(() => useDraft('a', ALICE))
    act(() => view.result.current[1]('あ'))
    act(() => view.result.current[1]('あい'))
    expect(readDraft('a', ALICE)).toBe('')

    act(() => {
      vi.advanceTimersByTime(WRITE_DEBOUNCE_MS)
    })
    expect(readDraft('a', ALICE)).toBe('あい')
    view.unmount()
  })

  it('消えるときに書き切る', () => {
    const view = renderHook(() => useDraft('a', ALICE))
    act(() => view.result.current[1]('画面を移る直前の文'))
    // 窓を待たずに消える（別のページへ移った）
    view.unmount()
    expect(readDraft('a', ALICE)).toBe('画面を移る直前の文')
  })

  it('離れるときに書き切る（pagehide）', () => {
    const view = renderHook(() => useDraft('a', ALICE))
    act(() => view.result.current[1]('タブを閉じる直前の文'))
    act(() => {
      globalThis.dispatchEvent(new Event('pagehide'))
    })
    expect(readDraft('a', ALICE)).toBe('タブを閉じる直前の文')
    view.unmount()
  })

  it('相手が変わったら読み直す', () => {
    putDraft('a', ALICE, 'A の文')
    putDraft('b', ALICE, 'B の文')
    const view = renderHook(({ id }) => useDraft(id, ALICE), {
      initialProps: { id: 'a' },
    })
    expect(view.result.current[0]).toBe('A の文')

    view.rerender({ id: 'b' })
    // 入れ物を使い回して前のカードの文が出る、を防ぐ
    expect(view.result.current[0]).toBe('B の文')
    view.unmount()
  })
})
