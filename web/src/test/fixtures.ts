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
import type { AgentInfo, FileViewSettings, Settings } from '@/stores/settings'

/** ローカルモードの設定（実機と同じ形）。 */
export function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    always_bypass_permissions: false,
    project_autostart_session: false,
    motion_quiet: 'lively',
    available_modes: ['default'],
    model_tables: {},
    agents: [],
    intervals: {
      sync_interval_secs: 20,
      screen_interval_ms: 20000,
      scrollback_lines: 1000,
    },
    memo_limits: { retention_days: 90, max_bytes: 1024 * 1024 * 1024 },
    lan_password: { supported: true, configured: false, editable: true },
    // **既定は空。** 書ける場所を持った状態を既定にすると、テストが
    // 「許可されていないから断られた」を確かめられなくなる
    writable_roots: [],
    // **既定は空。** 行を持った状態を既定にすると、「設定が無いときの見せ方」を
    // 確かめられなくなる（要件③の「設定無しの拡張子はエディタ」がそれ）
    file_modes: {},
    file_view: fileViewFixture(),
    ...overrides,
  }
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB

/**
 * ファイル閲覧の上限の一式（設計§6-2）。既定は**ローカルの姿**（実機と同じ形）。
 *
 * 選択肢の名前はサーバの `limit_label` が作るものと同じ綴り。サーバモード・クラウド・
 * 管理者でない人を見たいテストだけが上書きする。
 */
export function fileViewFixture(
  overrides: Partial<FileViewSettings> = {},
): FileViewSettings {
  const mib = [1, 3, 5, 10, 15, 20, 30, 50, 100, 300, 500]
  const gib = [1, 3, 5, 10, 20]
  return {
    max_bytes: 5 * GIB,
    configured: false,
    default_bytes: 5 * GIB,
    choices: [
      ...mib.map((n) => ({ bytes: n * MIB, label: `${n} MB` })),
      ...gib.map((n) => ({ bytes: n * GIB, label: `${n} GB` })),
    ],
    via_server: false,
    cloud: null,
    warn_from_bytes: null,
    editable: true,
    whole_text_bytes: 3 * MIB,
    window_bytes: 256 * 1024,
    preview_max_bytes: 32 * MIB,
    image_max_bytes: 8 * MIB,
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
