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

import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { permissionModeInfo } from '@/lib/protocol'
import { formatScreenInterval } from '@/lib/time'
import { HOME, LOCAL_HOST } from '@/lib/routes'
import { loadStats } from '@/lib/stats'
import type { Stats } from '@/lib/stats'
import { StatsPanel } from '@/components/Stats/StatsPanel'
import { MOTION_QUIET_CHOICES, useSettingsStore } from '@/stores/settings'
import type { MotionQuiet } from '@/stores/settings'
import { RateLimitWindows } from '@/components/RateLimits/RateLimitWindows'
import { AboutCard } from '@/components/Settings/AboutCard'
import { FileModesCard } from '@/components/Settings/FileModesCard'
import { PortableSettingsCard } from '@/components/Settings/PortableSettingsCard'
import { WritableRootsCard } from '@/components/Settings/WritableRootsCard'
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
 * メモと画像を残す期間の選択肢（日。要件10・メモ設計§11）。
 *
 * # 「無期限」を入れない
 *
 * 要件が明記している——**「これはあくまで作業のための一時的なメモ機能なので無期限と
 * 無制限は必要無い」**。**上限は12か月**なので 365 で止める。
 *
 * # 自由入力にしない
 *
 * 要件の言い方が「**選択肢**に『無期限』『無制限』は含まない」なので、**選ばせる形**が
 * 筋である。打ち込ませると範囲外を入れられ、**サーバに断られてから気づく**ことになる
 * （`check()` が 1〜365 を見ているので安全ではあるが、押す前に分かるほうがよい）。
 *
 * # 上限が 365 ではなく 360 なのは、月で読める数に揃えるため
 *
 * **要件の言い方は「12カ月」である。** この道具は1か月を30日として数える
 * （`lib/memoRetention.ts`）ので、**12か月 = 360日**になる。365 にすると、
 * メモの面に「**365日**で消えます」と出て**要件の言い方と画面の言い方が食い違う**。
 * サーバの上限（365）の内側なので、選べる範囲が狭まるだけで矛盾は生まない。
 */
const MEMO_RETENTION_CHOICES = [7, 30, 90, 180, 360]

/**
 * メモの画像の合計の上限（バイト。要件10）。
 *
 * **上限は 20GB。「無制限」は入れない**（上と同じ理由）。下限を 1GB にしているのは、
 * **1枚 8 MiB なので、それより小さいと数枚で溢れる**ため。
 */
const MEMO_MAX_BYTES_CHOICES = [
  1024 * 1024 * 1024,
  5 * 1024 * 1024 * 1024,
  10 * 1024 * 1024 * 1024,
  20 * 1024 * 1024 * 1024,
]

/** 日数を人の言い方にする。**画面の「N か月で消えます」と綴りを揃える。** */
function formatRetention(days: number): string {
  return days % 30 === 0 ? `${days / 30}か月` : `${days}日`
}

/** バイトを人の言い方にする。 */
function formatMemoBytes(bytes: number): string {
  return `${bytes / 1024 / 1024 / 1024} GB`
}

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

  const [stats, setStats] = useState<Stats | null>(null)

  /*
    **活動の記録は、この機械のファイルから読む**（status 設計「引きの経路（Stats）」）。

    **ローカルモードだけで読む。** セルフホストでは PC が何台でもありうるので、
    「どの機械の記録か」が一意に決まらない——**選ばせる問いを新しく作らない**
    （設計「新しい能力も新しい問いも作らない」）。**使用上限の区画と同じ `hasRemote`
    で分けてある**ので、判定を1つ増やしていない。

    **読めなくても知らせない。** `loadStats` は投げずに `null` を返す——非公開の
    内部ファイルなので**「無いのが普通」の環境がある。**
  */
  useEffect(() => {
    if (hasRemote) return
    let 生きている = true
    void loadStats(LOCAL_HOST).then((読めた) => {
      if (生きている) setStats(読めた)
    })
    return () => {
      生きている = false
    }
  }, [hasRemote])

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
        メモの保持（要件10・メモ設計§11-2）。

        **設定はアカウントごとの記録に置く。** `always_bypass_permissions` が同じ
        判断をしており、理由も同じ——**同じ画面に並ぶ1項目だけ保存先が違うと、
        セルフホスト構成では画面から触れない**（書き戻す相手が利用者の PC のファイルで、
        サーバから手が届かない）。

        **「無期限」「無制限」は選択肢に無い**（要件10 の明記）。
      */}
      <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
        <h3 className="text-sm font-medium">メモの保持</h3>
        <Choice
          testId="memo-retention"
          label="残す期間"
          hint="最終更新からこの期間が経ったメモと画像は、自動で消えます。作業のための一時的なメモなので、無期限にはできません。"
          value={settings.memo_limits.retention_days}
          choices={MEMO_RETENTION_CHOICES}
          format={formatRetention}
          disabled={loading}
          onSelect={(value) => void update({ memo_retention_days: value })}
        />
        <Choice
          testId="memo-max-bytes"
          label="画像の容量"
          hint="メモに貼った画像の合計がこれを超えると、同意を求めたうえで古いものから消します。無制限にはできません。"
          value={settings.memo_limits.max_bytes}
          choices={MEMO_MAX_BYTES_CHOICES}
          format={formatMemoBytes}
          disabled={loading}
          onSelect={(value) => void update({ memo_max_bytes: value })}
        />
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

      {/*
        **近似の断りは、画面ごとに一箇所**（status 設計・フェーズ7）。

        **「画面の一箇所」ではない。** 近似の数字が**2つの画面に分かれている**
        （費用＝カードの区画／使用上限と活動の記録＝この画面）ので、
        画面をまたいで一箇所にすると**片方に断りが付かない**。

        **部品ごとに書くのを禁じた理由は「同じ断りが画面に何度も出る」こと**
        （`SessionView` の `SessionCostLine` の doc）。**画面が違えば同時に目に入らない**
        ので、その理由は**画面をまたぐときには当たらない**。だから「画面ごとに一箇所」。

        **`title` に頼らない。** ホバーでしか読めず、狭い窓とタッチでは読めない。
        カード側が `title` のままなのは、あちらが数字1つに対してこちらは枠が2つあるため。

        **`hasRemote` で排他**——下の2つと同じ条件にする。出ない数字に断りだけ残らない。
      */}
      {!hasRemote && (
        <p data-testid="approx-note" className="text-muted-foreground text-xs">
          下の2つは<strong>この機械のローカルセッションに基づく概算</strong>です。費用は
          定価から計算した近似なので、<strong>実際の請求とは異なります</strong>。他の端末や
          claude.ai での利用は含みません。
        </p>
      )}

      {/*
        **使用上限の出し先は構成で割れる**（status 設計「置き場所」の 2026-09-13 訂正）。
        セルフホストは PC の一覧の各行だが、**ローカルモードにはその一覧が無い**
        （`no_agents()` が「`"local"` を1台として並べたりはしない」と禁じている）。
        だからここへ出す——**`hasRemote` で排他**なので、同じ数字が2箇所に並ぶことはない。

        判定は**既にある `hasRemote` を使い回す**。「`agents` が空ならローカル」という
        判定を新しく作らない（`ProjectAdd` の `isLocal` と合わせて3つ目になる）。
      */}
      {!hasRemote && (
        <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
          <h3 className="text-sm font-medium">この機械の使用上限</h3>
          <p className="text-muted-foreground text-xs">
            claude のログインに紐づく上限です。セッションごとではなくこの機械全体の
            数字で、<code>/status</code> の Usage タブと同じものを出しています。
          </p>
          <RateLimitWindows limits={settings.machine_rate_limits ?? null} />
        </div>
      )}

      {/*
        **活動の記録は、読めたときだけ枠ごと出す**（status 設計「引きの経路（Stats）」）。

        **`stats !== null` で枠ごと囲む。** 部品も `null` のとき何も返さないが、
        **見出しと枠は部品の外に在る**ので、囲まないと空の枠だけが残る。

        **読めないことを知らせない。** 非公開の内部ファイルなので「無いのが普通」の
        環境があり、毎回「ありません」と言うと壊れているように見える。
      */}
      {!hasRemote && stats !== null && (
        <div className="border-border flex flex-col gap-2 rounded-xl border p-4">
          <h3 className="text-sm font-medium">活動の記録</h3>
          <p className="text-muted-foreground text-xs">
            claude が持っている集計です（<code>/status</code> の Stats タブと同じもの）。
            claude が数え直したときだけ変わります。
          </p>
          <StatsPanel stats={stats} />
        </div>
      )}

      <WritableRootsCard />

      <FileModesCard />

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
