/**
 * 枠からセッションを1本起こす（イシューグループ_2026_0805_0514 設計§13・§14）。
 *
 * 起動の入口が「PJT を追加」へ移ったので、**危険度の判断が要る瞬間はここだけ**に
 * なった。追加は「枠を置く」操作で、そこにモードの選択は要らない（§12）。
 *
 * # 権限モードは選んでから起こす（初期実装 設計§8）
 *
 * 選択肢は3つで、下へ行くほど危険度が上がる。**選び直さないかぎり既定のまま**で、
 * 既定は設定のトグルが決める。
 *
 * ## 選んだ値は起動のたびに捨てる
 *
 * 持つのは「利用者が選んだ値」だけで、選んでいない間（`undefined`）は既定に従う。
 * この1つの規則で2つが同時に成り立つ。
 *
 * - 設定は `GET /api/settings` の応答で**後から**届くので、初期値を焼き込むと反映されない
 * - 起動したら選択を捨てるので、**前回の選択が残って意図しないモードで起こす**ことがない
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PlusGlyph } from '@/components/ui/glyphs'
import {
  permissionModeTone,
  type PastSession,
  type PermissionMode,
} from '@/lib/protocol'
import { LOCAL_HOST } from '@/lib/routes'
import { useSettingsStore } from '@/stores/settings'
import { useWsStore } from '@/stores/ws'

/** 「新しく起こす」を表す値。過去のセッションのIDと混ざらない綴りにする。 */
const FRESH = ''

interface Props {
  /** `agent_id` かローカルを表す `'local'` */
  host: string
  /** 起こす作業ディレクトリ（その枠のパス） */
  project: string
  /** 小さく出すか（一覧の枠のヘッダ用） */
  compact?: boolean
}

/** 起動時に選べる権限モード。`mode` が `null` なら CLI へ何も渡さない。 */
interface LaunchMode {
  mode: PermissionMode | null
  label: string
  /** 選んだときに何が起きるかを、押す前に伝える */
  hint: string
}

const LAUNCH_MODES: LaunchMode[] = [
  {
    mode: null,
    label: 'スキップの指定は無し',
    hint: '利用者の設定（permissions.defaultMode）どおりに起動します',
  },
  {
    mode: 'acceptEdits',
    label: '編集の承認のみスキップ',
    hint: 'ファイル編集の確認だけを飛ばして起動します',
  },
  {
    mode: 'bypassPermissions',
    label: '全承認をスキップ',
    hint: '権限確認そのものを行いません',
  },
]

/** 設定のトグルが ON のときの既定。 */
const BYPASS_VALUE = 'bypassPermissions'

export function SessionAdd({ host, project, compact = false }: Props) {
  const [open, setOpen] = useState(false)
  const spawn = useWsStore((state) => state.spawn)
  const recall = useWsStore((state) => state.recall)
  const status = useWsStore((state) => state.status)
  // 過去のセッション（名前付け設計§9-4）。**開いたときに1回だけ引く**——
  // 実在を確かめるのに PC へ問い合わせが出るので、開くたびに何度も引かない
  const [past, setPast] = useState<PastSession[] | null>(null)
  const [pickedSession, setPickedSession] = useState<string>(FRESH)
  const alwaysBypass = useSettingsStore(
    (state) => state.settings.always_bypass_permissions,
  )
  // `undefined` は「まだ選んでいない」＝既定に従う（上のドキュメント参照）
  const [picked, setPicked] = useState<string | undefined>(undefined)

  // 開いた瞬間に1回だけ引く。閉じても捨てない（開き直しても再取得しないため）
  useEffect(() => {
    if (!open || past !== null) return
    let alive = true
    // **枠はサーバへ渡す。手元では絞らない。** 「どの枠か」の規則が2箇所に在ると
    // 片方だけ直したときに食い違う。実際に食い違っていた——件数の上限がサーバ側で
    // 枠を跨いで先に効き、そのあと画面が絞るので、枠あたり数件しか残らなかった
    const 問い = new URLSearchParams({ host, project })
    void fetch(`/api/sessions/past?${問い.toString()}`)
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: PastSession[]) => {
        if (!alive) return
        setPast(rows)
      })
      .catch(() => {
        // **引けなかったことを「無い」にしない。** 空配列を置くと「過去のセッションは
        // ありません」と出てしまう
        if (alive) setPast([])
      })
    return () => {
      alive = false
    }
  }, [open, past, project, host])

  const value = picked ?? (alwaysBypass ? BYPASS_VALUE : '')
  const mode: PermissionMode | null = value === '' ? null : value
  const selected =
    LAUNCH_MODES.find((entry) => (entry.mode ?? '') === value) ?? LAUNCH_MODES[0]

  const launch = () => {
    const target = host === LOCAL_HOST ? null : host
    if (pickedSession === FRESH) {
      // 宛先は枠が持っている。**ローカルは指名しない**（サーバが選ぶ余地の無いときだけ通す）
      spawn(project, mode, target)
    } else {
      // 作業ディレクトリは運ばない。**サーバの記録が持っている**（設計§7-1）。
      // 権限モードはここで選び直せる（記録の値は既定でしかない）
      recall(pickedSession, mode, target)
    }
    // 選択を捨てて既定へ戻す。次の1本を前回のモードで起こさないため
    setPicked(undefined)
    setPickedSession(FRESH)
    setOpen(false)
  }

  if (!open) {
    return (
      <Button
        type="button"
        data-testid="spawn-open"
        variant={compact ? 'ghost' : 'default'}
        disabled={status !== 'open'}
        aria-label="この PJT でセッションを起こす"
        title="この PJT でセッションを起こす"
        size={compact ? 'icon-sm' : undefined}
        className={compact ? 'shrink-0' : undefined}
        onClick={(event) => {
          // 枠の余白のクリック（＝画面を開く）と取り違えない
          event.stopPropagation()
          setOpen(true)
        }}
      >
        {/*
          **全角の `＋` という文字をやめ、記号にする**（帯設計§16-4）。✕・ゴミ箱・
          電源と同じ作りに揃える。

          **器や立体は持たせない。** この形は**一覧の枠のヘッダでも出る**ので、
          `DESIGN.md` §12.3「一覧の行に物質を持たせない」が効く。**形だけを直す。**
        */}
        {compact ? <PlusGlyph /> : '＋'}
      </Button>
    )
  }

  return (
    <div
      data-testid="spawn-panel"
      className="flex flex-wrap items-center gap-2"
      onClick={(event) => event.stopPropagation()}
    >
      <label className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">権限モード</span>
        <select
          data-testid="spawn-mode"
          data-mode={mode ?? ''}
          aria-label="権限モード"
          title={selected.hint}
          value={value}
          onChange={(event) => setPicked(event.target.value)}
          // 危険なモードほど目立たせる（設計§8）。バッジと同じ色づかいを使う
          className={`rounded border px-1.5 py-1 text-xs ${permissionModeTone(mode)}`}
        >
          {LAUNCH_MODES.map((entry) => (
            <option key={entry.mode ?? 'none'} value={entry.mode ?? ''}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {past !== null && past.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">どれを</span>
          <select
            data-testid="spawn-past"
            aria-label="起こすセッション"
            value={pickedSession}
            onChange={(event) => setPickedSession(event.target.value)}
            className="max-w-56 rounded border px-1.5 py-1 text-xs"
          >
            <option value={FRESH}>新しく起こす</option>
            {past.map((row) => (
              <option
                key={row.claude_session_id}
                value={row.claude_session_id}
                // **確かめていないものも選べる**（設計§8-5）。PC が寝ているだけで
                // 無いとは限らないので、印を添えて残す
                title={
                  row.exists === null
                    ? 'この PC が繋がっていないので、まだ実在を確かめていません'
                    : undefined
                }
              >
                {pastLabel(row)}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button
        type="button"
        data-testid="spawn-button"
        disabled={status !== 'open'}
        title={`${selected.label}：${selected.hint}`}
        className="px-2 py-0.5 text-xs"
        onClick={launch}
      >
        {pickedSession === FRESH ? 'セッションを起動' : '呼び戻す'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        data-testid="spawn-cancel"
        className="px-2 py-0.5 text-xs"
        onClick={() => {
          setPicked(undefined)
          setOpen(false)
        }}
      >
        やめる
      </Button>
    </div>
  )
}

/**
 * 過去のセッション1本の見出し（名前付け設計§9-1・§9-4）。
 *
 * **利用者が付けた名前があればそれ、無ければ CLI の名前**。どちらも無ければIDの頭。
 * 確かめていないものには印を添える——「確かめていない」を「無い」と混同させない。
 */
function pastLabel(row: PastSession): string {
  const name =
    row.nickname ?? row.session_title ?? `${row.claude_session_id.slice(0, 8)}…`
  return row.exists === null ? `${name}（未確認）` : name
}
