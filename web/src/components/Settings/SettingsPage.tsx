/**
 * 設定画面（設計§8・セルフホスト化設計§11-2）。ダッシュボードで最初の1枚。
 *
 * # なぜ一覧とは別の画面なのか
 *
 * **一覧の主役は状態インジケータ**（初期実装§10）で、そこに設定を混ぜると見るべきものが
 * 埋もれる。設定は頻繁に触るものではないので、1クリック奥で構わない。
 *
 * # 保存先はサーバ
 *
 * トグルも間隔も**アカウントごとの記録**へ書く（持ち出し設計§1）。**別のタブで
 * 開いても、別の端末で開いても同じ値**になり、アプリを開き直しても残る（要件3-2・5-3）。
 * LAN パスワードだけはサーバ全体のもので、ローカルモード専用。
 *
 * # 意味を持たない項目は出さない
 *
 * ローカルモードには画面配信そのものが無い（§7-2）ので、画面の更新間隔と
 * スクロールバックは**別の PC が繋がっているときだけ**出す。LAN パスワードは逆に
 * ローカルモード専用で、しかも 127.0.0.1 からしか変えられない（§8-3）。
 * 変えられないものを並べると「設定したのに効かない」になる。
 */

import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { permissionModeInfo } from '@/lib/protocol'
import { formatScreenInterval } from '@/lib/time'
import { HOME } from '@/lib/routes'
import { MOTION_QUIET_CHOICES, useSettingsStore } from '@/stores/settings'
import type { MotionQuiet } from '@/stores/settings'
import { AboutCard } from '@/components/Settings/AboutCard'
import { PortableSettingsCard } from '@/components/Settings/PortableSettingsCard'
import { VersionsCard } from '@/components/Settings/VersionsCard'

/** 履歴を送る間隔の選択肢（秒。設計§13-3）。 */
const SYNC_CHOICES = [5, 10, 20, 60]
/**
 * 画面を送る間隔の選択肢（ミリ秒。設計§13-3）。
 *
 * 300 は **0.05秒 と 1秒 の谷を埋めるため**にある。50 は細かすぎ（無操作でも毎秒20回
 * 届く）、1000 はターミナルを見ながら操作するには粗い。**新しい下限ではない**——
 * いちばん細かいのは今までどおり 50 で、これはその上に入る。
 */
const SCREEN_CHOICES = [50, 300, 1000, 5000, 10000, 20000]

/**
 * 静けさの3段の見せ方（カード設計§9-5-2）。
 *
 * **一時停止ボタン1つにしなかったのは、「全部止める」しか選べないため**——止めると
 * 承認待ちまで止まり、いちばん見つけたいものの合図を静けさと引き換えに失う。
 *
 * 「控えめ」がいちばん効く。作業中は放っておいてよい状態なのに、いちばん強い合図を
 * 持っている。ここだけを止めると**動いているカード＝見に行くカード**になる。
 */
const MOTION_QUIET_LABELS: Record<MotionQuiet, string> = {
  lively: '賑やか（既定）',
  calm: '控えめ',
  still: '静止',
}

export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings)
  const loading = useSettingsStore((state) => state.loading)
  const lastError = useSettingsStore((state) => state.lastError)
  const update = useSettingsStore((state) => state.update)

  // 別の PC が繋がっている構成でだけ、画面配信の設定が意味を持つ
  const hasRemote = settings.agents.length > 0

  return (
    <section
      data-testid="settings-page"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
    >
      <header className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold">設定</h2>
        <Link to={HOME} className="text-primary ml-auto text-xs underline">
          一覧へ戻る
        </Link>
      </header>

      {lastError && (
        <p data-testid="settings-error" className="text-xs text-red-400">
          {lastError}
        </p>
      )}

      <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
        {/*
          かつては構成によって押せないことがあり、そのための淡色化と断りを置いていた。
          保存先がアカウントごとの記録になって**どの構成でも押せる**ようになったので、
          出し分けごと外してある（持ち出し設計§6）。
        */}
        <label data-testid="always-bypass-label" className="flex items-center gap-3">
          <input
            type="checkbox"
            data-testid="always-bypass-toggle"
            className="size-4 disabled:cursor-not-allowed"
            disabled={loading}
            checked={settings.always_bypass_permissions}
            onChange={(event) =>
              void update({ always_bypass_permissions: event.target.checked })
            }
          />
          <span className="text-sm font-medium">
            常に権限確認スキップモードで開く
          </span>
        </label>
        <p className="text-muted-foreground text-xs">
          オンにすると、一覧の権限モードの既定が「全承認をスキップ」になります。
          オフのときの既定は「スキップの指定は無し」です。どちらの場合も選択肢は3つのままで、
          別のモードを選んで起動できます（起動すると既定へ戻ります）。
          <strong className="text-amber-300">
            {' '}
            全承認をスキップは権限確認そのものを行いません。
          </strong>
        </p>
      </div>

      <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
        <label
          data-testid="project-autostart-label"
          className="flex items-center gap-3"
        >
          <input
            type="checkbox"
            data-testid="project-autostart-toggle"
            className="size-4 disabled:cursor-not-allowed"
            disabled={loading}
            checked={settings.project_autostart_session}
            onChange={(event) =>
              void update({ project_autostart_session: event.target.checked })
            }
          />
          <span className="text-sm font-medium">
            PJT を追加したらセッションを1本起こす
          </span>
        </label>
        <p className="text-muted-foreground text-xs">
          オンにすると、PJT を追加したその場でセッションが1本立ち上がります。
          権限モードは上の既定に従います——モードを選んで起こしたいときは、
          追加してから枠の「+」を押してください。
          オフのときは枠だけが増えます（あとから「+」で足せます）。
        </p>
      </div>

      <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
        <h3 className="text-sm font-medium">同期と表示の間隔</h3>
        <Choice
          testId="sync-interval"
          label="履歴の同期間隔"
          hint="PC が履歴をまとめて送る周期です。長くすると通信は減りますが、構造化ビューへ出るまでが遅くなります。"
          value={settings.intervals.sync_interval_secs}
          choices={SYNC_CHOICES}
          format={(seconds) => `${seconds}秒`}
          disabled={loading}
          onSelect={(value) => void update({ sync_interval_secs: value })}
        />
        {hasRemote && (
          <>
            <Choice
              testId="screen-interval"
              label="画面の更新間隔"
              hint="別の PC の端末を見ているとき、何もしていない間はこの間隔で届きます（入力した直後は細かく届きます）。"
              value={settings.intervals.screen_interval_ms}
              choices={SCREEN_CHOICES}
              format={formatScreenInterval}
              disabled={loading}
              onSelect={(value) => void update({ screen_interval_ms: value })}
            />
            <NumberField
              testId="scrollback-lines"
              label="スクロールバック行数"
              hint="別の PC の端末を開いたときに、さかのぼって渡される行数です。"
              value={settings.intervals.scrollback_lines}
              disabled={loading}
              onSubmit={(value) => void update({ scrollback_lines: value })}
            />
          </>
        )}
      </div>

      {/*
        一覧の動き（カード設計§9-5-2）。

        **OS の「動きを減らす」設定だけでは足りない。** 規範は「5秒を超えて自動的に
        動くものには、一時停止・停止・非表示の手段」を要求しており、その達成手段の
        一覧に OS 設定は1つも入っていない。しかも入力待ちの明滅は、規格の用語では
        そもそも「動き」に当たらない（大きさ・形・位置が変わらないため）ので、
        **OS 設定では原理的に片付かない**。

        この道具は配る前提なので、「自分は該当しないから要らない」は成り立たない。
      */}
      <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
        <h3 className="text-sm font-medium">一覧の動き</h3>
        <Choice
          testId="motion-quiet"
          label="静けさ"
          hint="一覧のカードをどこまで静めるかです。「控えめ」は作業中の回転と、画面を回遊する線を止めます（どちらも放っておいてよいものなので、止めると「動いている＝見に行く」になります）。承認待ちのカードは跳ね続けます。「静止」はすべて止めますが、状態の色と記号と文字は残ります。"
          value={settings.motion_quiet}
          choices={MOTION_QUIET_CHOICES}
          format={(value) => MOTION_QUIET_LABELS[value]}
          disabled={loading}
          onSelect={(value) => void update({ motion_quiet: value })}
        />
        <p className="text-muted-foreground text-xs">
          OS の「動きを減らす」設定を入れている間は、ここで何を選んでいても止まります。
        </p>
      </div>

      {settings.lan_password.supported && <LanPasswordCard />}

      <PortableSettingsCard />

      <AboutCard />

      <VersionsCard />

      <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
        <h3 className="text-sm font-medium">この CLI が受け付けるモード</h3>
        <p className="text-muted-foreground text-xs">
          起動時に <code>claude --help</code> から読んだ一覧です。読めなかった場合は
          ダッシュボードが知っているモードを出します。
        </p>
        <ul data-testid="available-modes" className="flex flex-col gap-1 text-xs">
          {settings.available_modes.map((mode) => {
            const info = permissionModeInfo(mode)
            return (
              <li key={mode} className="flex gap-2">
                <span className="w-32 shrink-0 font-medium">{info.label}</span>
                <span className="text-muted-foreground">{info.description}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

/**
 * LAN 開放のパスワード（設計§8-3）。
 *
 * **登録できるのは 127.0.0.1 のブラウザからだけ。** LAN の向こうから変えられると、
 * いま入っている誰かが鍵を掛け替えられることになる。
 */
function LanPasswordCard() {
  const lan = useSettingsStore((state) => state.settings.lan_password)
  const update = useSettingsStore((state) => state.update)
  const [password, setPassword] = useState('')
  const [saved, setSaved] = useState(false)

  return (
    <div
      data-testid="lan-password"
      data-configured={lan.configured}
      className="border-border flex flex-col gap-2 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">LAN 開放のパスワード</h3>
      <p className="text-muted-foreground text-xs">
        待ち受けアドレス（<code>bind_addr</code>）をこの PC の外へ広げるときに要ります。
        <strong className="text-amber-300">
          {' '}
          通信は暗号化されません。信頼できるネットワークの中だけで使ってください。
        </strong>
      </p>
      <p className="text-muted-foreground text-xs">
        いまの状態：{lan.configured ? '登録済み' : '未登録（広げると起動しません）'}
      </p>

      {lan.editable ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void update({ lan_password: password }).then((ok) => {
              if (ok) {
                setPassword('')
                setSaved(true)
              }
            })
          }}
        >
          <Input
            type="password"
            data-testid="lan-password-input"
            className="max-w-64"
            placeholder="8文字以上"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              setSaved(false)
            }}
          />
          <Button type="submit" size="sm" disabled={password.length === 0}>
            {lan.configured ? '変更する' : '登録する'}
          </Button>
          {saved && (
            <span data-testid="lan-password-saved" className="text-xs text-emerald-400">
              保存しました（入っていた端末は入り直しになります）
            </span>
          )}
        </form>
      ) : (
        <p data-testid="lan-password-readonly" className="text-muted-foreground text-xs">
          変更できるのは、この PC のブラウザ（127.0.0.1）で開いたときだけです。
        </p>
      )}
    </div>
  )
}

/**
 * 選択肢から選ぶ設定。
 *
 * **数値でも文字列でも使える。** `<select>` の値は必ず文字列になるので、選ばれた
 * 文字列から**元の値へ戻す**——数値へ決め打ちで変換すると、文字列の選択肢
 * （静けさの3段）で `NaN` になる。
 */
function Choice<T extends string | number>({
  testId,
  label,
  hint,
  value,
  choices,
  format,
  disabled,
  onSelect,
}: {
  testId: string
  label: string
  hint: string
  value: T
  choices: T[]
  format: (value: T) => string
  disabled: boolean
  onSelect: (value: T) => void
}) {
  // いまの値が選択肢に無いことがある（設定ファイルや別の版で入った値）。
  // **黙って別の値を選んだ顔をしない**ので、無ければ先頭に足す
  const options = choices.includes(value) ? choices : [value, ...choices]
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-sm">
        {label}
        <select
          data-testid={`${testId}-select`}
          className="border-border rounded border px-1.5 py-0.5 text-xs"
          disabled={disabled}
          value={value}
          onChange={(event) => {
            const picked = options.find(
              (choice) => String(choice) === event.target.value,
            )
            // 選択肢の外は届かない（`<select>` は自分が出した option しか返さない）が、
            // **見つからないときに何もしない**ぶんだけは書いておく
            if (picked !== undefined) {
              onSelect(picked)
            }
          }}
        >
          {options.map((choice) => (
            <option key={choice} value={choice}>
              {format(choice)}
            </option>
          ))}
        </select>
      </span>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </label>
  )
}

/** 数値を打ち込む設定。 */
function NumberField({
  testId,
  label,
  hint,
  value,
  disabled,
  onSubmit,
}: {
  testId: string
  label: string
  hint: string
  value: number
  disabled: boolean
  onSubmit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        const parsed = Number(draft)
        if (Number.isFinite(parsed) && parsed > 0) {
          onSubmit(Math.floor(parsed))
        }
      }}
    >
      <span className="flex items-center gap-2 text-sm">
        {label}
        <Input
          type="number"
          min={1}
          data-testid={`${testId}-input`}
          className="h-7 max-w-28 text-xs"
          disabled={disabled}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={disabled}>
          保存
        </Button>
      </span>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </form>
  )
}
