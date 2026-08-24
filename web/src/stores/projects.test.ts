/**
 * 枠のストアと、枠から箱を作るところ（設計§13。テスト計画 フェーズ4「URL とストア」）。
 *
 * ここが壊れると「セッションの有無に関係なく PJT を追加できる」が成立しない——
 * カードが0枚の箱を作れるかどうかが、この工事の芯にあたる。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectView, SessionMeta } from '@/lib/protocol'
import {
  applyProjectSnapshot,
  clearProjects,
  getProjects,
  hasProject,
  removeProject,
  upsertProject,
} from '@/stores/projects'
import {
  applySessionSnapshot,
  clearSessions,
  getProjectGroups,
} from '@/stores/sessions'

function frame(id: string, path: string, host = 'local'): ProjectView {
  return { id, host, path, created_at: 1 }
}

function card(id: string, project: string, agent: string | null = null): SessionMeta {
  return {
    card_id: id,
    project,
    claude_session_id: null,
    permission_mode: null,
    model: null,
    model_label: null,
    model_requested: null,
    status: { kind: 'working' },
    subagent_active: 0,
    last_activity_at: 0,
    last_assistant_message: null,
    created_at: 1,
    hooks_seen: true,
    agent_id: agent,
    agent_connected: true,
    account: null,
    toml_account: null,
    session_title: null,
  } as SessionMeta
}

beforeEach(() => {
  // モジュールに1つのストアなので、テストごとに戻す。前のテストの状態が残ると
  // 「聞く前から入っている」テストができてしまう
  clearProjects()
  clearSessions()
})

describe('枠のストア', () => {
  it('スナップショットは作成順に並ぶ', () => {
    applyProjectSnapshot([
      { ...frame('b', '/b'), created_at: 20 },
      { ...frame('a', '/a'), created_at: 10 },
    ])
    expect(getProjects().map((entry) => entry.path)).toEqual(['/a', '/b'])
  })

  it('同じ ID は置き換わり、並びは動かない', () => {
    applyProjectSnapshot([frame('a', '/a'), frame('b', '/b')])
    upsertProject({ ...frame('a', '/a2') })
    expect(getProjects().map((entry) => entry.path)).toEqual(['/a2', '/b'])
  })

  it('消えたものは一覧から落ちる', () => {
    applyProjectSnapshot([frame('a', '/a'), frame('b', '/b')])
    removeProject('a')
    expect(getProjects().map((entry) => entry.id)).toEqual(['b'])
  })

  it('PC が違えば別の枠として数える', () => {
    // 鍵は（PC, パス）の組（設計§13）。ここが混ざると「+」の宛先が決まらない
    applyProjectSnapshot([frame('a', '/same', 'local'), frame('b', '/same', 'pc-1')])
    expect(hasProject('local', '/same')).toBe(true)
    expect(hasProject('pc-1', '/same')).toBe(true)
    expect(hasProject('pc-2', '/same')).toBe(false)
  })
})

describe('枠から箱を作る', () => {
  it('カードが0枚でも枠の箱が出る', () => {
    // これが「セッションの有無に関係なく PJT を追加できる」の実体（設計§13）
    applyProjectSnapshot([frame('a', '/dev/app')])
    const groups = getProjectGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].project).toBe('/dev/app')
    expect(groups[0].cards).toEqual([])
    expect(groups[0].projectId).toBe('a')
  })

  it('カードは枠へ流し込まれる', () => {
    applyProjectSnapshot([frame('a', '/dev/app')])
    applySessionSnapshot([card('c1', '/dev/app')])
    const groups = getProjectGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].cards).toEqual(['c1'])
  })

  it('枠に無いカードも従来どおり箱になる', () => {
    // 外から復元されたカードなど。**消す対象が無いので `projectId` は付かない**
    applySessionSnapshot([card('c1', '/dev/other')])
    const groups = getProjectGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0].project).toBe('/dev/other')
    expect(groups[0].projectId).toBeUndefined()
  })

  it('PC が違えば同じパスでも別の箱になる', () => {
    applyProjectSnapshot([frame('a', '/same', 'local'), frame('b', '/same', 'pc-1')])
    applySessionSnapshot([card('c1', '/same', 'pc-1')])
    const groups = getProjectGroups()
    expect(groups).toHaveLength(2)
    // セッションが居るほうが上（次のテストで見る規則）なので、pc-1 が先頭
    expect(groups[0].host).toBe('pc-1')
    expect(groups[0].cards).toEqual(['c1'])
    expect(groups[1].host).toBe('local')
    expect(groups[1].cards).toEqual([])
  })

  it('セッションが居る箱が上、群の中は出現順で固定', () => {
    // 群は2つだけ（設計§13）。細かい優先度を作らないので、並びが変わるのは
    // 起動と終了の瞬間だけになる
    applyProjectSnapshot([
      { ...frame('a', '/a'), created_at: 10 },
      { ...frame('b', '/b'), created_at: 20 },
      { ...frame('c', '/c'), created_at: 30 },
    ])
    applySessionSnapshot([card('c1', '/b')])

    expect(getProjectGroups().map((group) => group.project)).toEqual([
      '/b',
      '/a',
      '/c',
    ])
  })
})
