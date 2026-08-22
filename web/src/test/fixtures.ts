/**
 * テストが使う設定の雛形。
 *
 * # 既定値をここ1つに集める
 *
 * 設定の形（`GET /api/settings` の応答）は増える。テストごとに全部を書き並べていると、
 * 1つ足すたびに全ファイルを直すことになり、**直し漏れた側は「既定のまま」ではなく
 * 「型が合わないだけ」で落ちる**。ここへ集めておけば、足す場所も1箇所で済む。
 *
 * 既定は**鍵をかけていないローカルモード**（実機と同じ形）。他を見たいテストだけが
 * 上書きする。
 */

import type { ModelAliasSeen, ModelCatalogEntry } from '@/lib/models'
import type { AgentInfo, Settings } from '@/stores/settings'

/** ローカルモードの設定（実機と同じ形）。 */
export function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    always_bypass_permissions: false,
    project_autostart_session: false,
    available_modes: ['default'],
    model_tables: {},
    agents: [],
    intervals: {
      sync_interval_secs: 20,
      screen_interval_ms: 20000,
      scrollback_lines: 1000,
    },
    lan_password: { supported: true, configured: false, editable: true },
    ...overrides,
  }
}

/** ローカルモードのモデル表を1本だけ持つ設定。 */
export function localModelTable(
  aliases: ModelAliasSeen[] = [],
  catalog: ModelCatalogEntry[] = [],
): Partial<Settings> {
  return { model_tables: { local: { aliases, catalog } } }
}

/**
 * 別の PC のモデル表を持つ設定（PC 名バッジと per-agent 表の検証用）。
 *
 * 既定は**繋がっていて、復旧に対応している PC**（いまの版のセッションホストと同じ形）。
 * 落ちている PC・版が古い PC を作りたいテストだけが `state` で上書きする（復旧設計§3-2）。
 */
export function remoteAgent(
  id: string,
  name: string,
  table: { aliases?: ModelAliasSeen[]; catalog?: ModelCatalogEntry[] } = {},
  state: Partial<Pick<AgentInfo, 'connected' | 'supports_revive'>> = {},
): Partial<Settings> {
  const agent: AgentInfo = {
    id,
    name,
    last_seen_at: 1,
    connected: true,
    supports_revive: true,
    ...state,
  }
  return { agents: [agent], model_tables: { [id]: table } }
}
