/**
 * ダッシュボード自身の版を切り替えるカード（CICD設計§14・§15）。
 *
 * # 選ぶことと効かせることを分けて見せる
 *
 * ドロップダウンで選ぶのは**次に起こす版**で、押した瞬間には何も落ちない。
 * 落ちるのは「いま入れ替える」を押したときだけなので、両者を並べず、
 * 予約が入っている間だけ入れ替えの導線を出す。
 *
 * # いま走っている版と、次に起こす版は別々に出す
 *
 * 切替のあと再起動の前は、この2つがずれる。選択中の印だけだと
 * 「押しても何も起きない」ように見える。
 *
 * # 同じ版名の行が並ぶのは異常ではない
 *
 * ソースからビルドした版と配った版は同じ番号を名乗るので、**開発者の機械では
 * 初日から同名の行が3つ並ぶ**。名前だけでは選びようがないので実パスを併記する。
 */

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/format'
import {
  installLabel,
  isNewer,
  useVersionsStore,
  type VersionEntry,
} from '@/stores/versions'

export function VersionsCard() {
  const versions = useVersionsStore((state) => state.versions)
  const loading = useVersionsStore((state) => state.loading)
  const busy = useVersionsStore((state) => state.busy)
  const lastError = useVersionsStore((state) => state.lastError)
  const unverified = useVersionsStore((state) => state.unverified)
  const load = useVersionsStore((state) => state.load)
  const select = useVersionsStore((state) => state.select)
  const unselect = useVersionsStore((state) => state.unselect)
  const install = useVersionsStore((state) => state.install)
  const remove = useVersionsStore((state) => state.remove)
  const restart = useVersionsStore((state) => state.restart)
  const dismissUnverified = useVersionsStore((state) => state.dismissUnverified)

  useEffect(() => {
    void load()
  }, [load])

  // **走っている版は、一覧の行から探さない**（設計§3）。
  //
  // 以前はここで `entries.find((entry) => entry.running)` していた。ソースビルドの機械では
  // 走ってきた実体が `make build` に消されていて**どの行とも一致しない**ので、
  // いつも「不明」と出ていた——**サーバは答えを持っているのに、画面が使っていなかった。**
  const running = versions.running
  const runningPath = versions.running_path ?? null

  // 予約に出せるのは保管庫の版だけ。**ビルドした版を選ばせない**（下の「なぜ増やさないか」）
  const stored = versions.entries.filter((entry) => entry.origin === 'stored')
  const usage = stored.reduce((total, entry) => total + entry.size_bytes, 0)

  // 「新着か」はサーバが決めない。**走っている版より新しいか**で画面が決める（設計§8）。
  // **これは「外に出た」の知らせ**で、取ってくる相手が居ることを意味する
  const update =
    versions.latest &&
    versions.latest.has_artifact &&
    running !== '' &&
    isNewer(versions.latest.version, running)
      ? versions.latest
      : null

  // **こちらは「手元が新しい」**（設計§5）。外を見に行かず、自分の足元だけを見る。
  // ソースビルドの機械に要るのはこちらだけ——取ってくる相手が居ないため
  const diskUpdate = versions.next_differs === true

  // **押す一式は1つにまとめる。** 予約から出るときと手元から出るときで文言が
  // 食い違うと、同じ操作が別物に見える
  const restartControls = (
    <>
      <p data-testid="versions-stranded" className="text-muted-foreground text-xs">
        {versions.stranded_cards === 0
          ? 'いま入れ替えても、失われるセッションはありません。'
          : `いま入れ替えると ${versions.stranded_cards} 枚が抜け殻になります（履歴は残りますが、操作はできなくなります）。`}
      </p>
      {versions.zombie_children !== null && versions.zombie_children > 0 && (
        // **警報の色を使わない。** 押せるボタンが無いので、琥珀を当てると「対処できる差分」
        // （版が遅れている等）と見分けが付かなくなる。0体のときは段落ごと出さない
        <p data-testid="versions-zombies" className="text-muted-foreground text-xs">
          これまでの入れ替えで、OS 上に {versions.zombie_children}{' '}
          体のゾンビ（終了状態を引き取れていない子プロセス）が残っています。実害はありません。
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        入れ替えると画面は一度切れます。<strong>同じプロセスのまま</strong>
        新しい版で起き直るので、戻ってきたらタブを読み込み直してください。
        戻ってこない場合は、端末で <code>agentdashboard</code> を実行してください。
      </p>
      <div className="flex gap-2">
        <Button
          data-testid="versions-restart"
          size="sm"
          disabled={busy || !versions.editable}
          onClick={() => void restart()}
        >
          いま入れ替える
        </Button>
      </div>
    </>
  )

  if (!versions.supported) {
    // できないことをボタンにしない（設計§14）
    return (
      <div
        data-testid="versions"
        data-supported="false"
        className="border-border flex flex-col gap-2 rounded-xl border p-4"
      >
        <h3 className="text-sm font-medium">ダッシュボードの版</h3>
        <p className="text-muted-foreground text-xs">
          この構成では版を切り替えられません。箱で動かしている場合は、献立表
          （<code>docker/compose.yml</code>）の <code>image:</code> の版を書き換えて
          取り直してください。
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid="versions"
      data-supported="true"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h3 className="text-sm font-medium">ダッシュボードの版</h3>

      {lastError && (
        <p data-testid="versions-error" className="text-xs text-red-400">
          {lastError}
        </p>
      )}

      {versions.outcome?.failed_reason && (
        <p data-testid="versions-outcome" className="text-xs text-amber-300">
          {versions.outcome.attempted ?? '選んだ版'} で起動できなかったので、
          {versions.outcome.running} で立ち上げました（
          {versions.outcome.failed_reason}）
        </p>
      )}

      <p data-testid="versions-running" className="text-xs">
        <span className="text-muted-foreground">いま動いている版</span>{' '}
        {running === '' ? '不明' : running}
        {runningPath !== null && (
          <span className="text-muted-foreground ml-2">{runningPath}</span>
        )}
      </p>

      <label className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground shrink-0">次に起こす版</span>
        <select
          data-testid="versions-picker"
          data-selected={versions.selected ?? ''}
          aria-label="次に起こす版"
          value={versions.selected ?? ''}
          disabled={loading || busy || !versions.editable}
          onChange={(event) => {
            const value = event.target.value
            void (value === '' ? unselect() : select(value))
          }}
          className="border-border min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs"
        >
          {/* **選択肢は増やさない。** ビルドした版をここへ足すと利用者が予約を作れて
              しまい、**予約を入れると以後の `make build` が効かなくなる**（起動のたび
              ポインタの先へ乗り換わる）。既定の選択肢が**まさにその版**なので、
              何番なのかを添えるだけでよい */}
          <option value="">
            入れる側が置いた版のまま
            {versions.next_version != null && versions.selected == null
              ? `（${versions.next_version}）`
              : ''}
          </option>
          {stored.map((entry) => (
            <option key={entry.path} value={entry.version} title={entry.path}>
              {optionLabel(entry)}
            </option>
          ))}
        </select>
      </label>

      {/*
        **「効かせる」を予約から切り離した**（設計§6）。

        以前はこの一式が `versions.selected`（予約があるか）だけで出ていた。だが
        **中身はプロセスを入れ替えるだけで、予約は要らない**——そして
        **ソースビルドの機械は予約を使わない**（予約を入れると以後の `make build` が
        効かなくなる）ので、**押すボタンが永久に出てこなかった。**

        いまは「**走っている版 ≠ 次に起きる版**」で出す。予約はその条件を満たす
        手段の1つに格下げされ、予約ゼロのままでもボタンが出る。
      */}
      {versions.selected && (
        <div
          data-testid="versions-reservation"
          className="border-border flex flex-col gap-2 rounded-lg border p-3"
        >
          <p className="text-xs">
            <strong className="text-amber-300">{versions.selected}</strong>{' '}
            を予約しています。次に起こしたときから効きます。
          </p>
          {restartControls}
          <Button
            data-testid="versions-cancel"
            variant="ghost"
            size="sm"
            disabled={busy || !versions.editable}
            onClick={() => void unselect()}
          >
            予約を取り消す
          </Button>
        </div>
      )}

      {/*
        **予約が無くても、手元が新しければ出す。** これがこのイシューの本体である。
        外（GitHub）を見に行かないので、`make build` した直後にすぐ出る
      */}
      {!versions.selected && diskUpdate && (
        <div
          data-testid="versions-disk-update"
          className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="text-xs">
            <strong className="text-amber-300">ディスクに新しい版があります</strong>
            {versions.next_version != null ? `（${versions.next_version}）` : ''}
            。いま入れ替えられます。
          </p>
          {versions.next_path != null && (
            <p className="text-muted-foreground text-xs">{versions.next_path}</p>
          )}
          {restartControls}
        </div>
      )}

      {unverified && (
        <div
          data-testid="versions-confirm"
          className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="text-xs">{unverified.reason}</p>
          <p className="text-muted-foreground text-xs">
            この版には版を選ぶ画面がありません。
            <strong className="text-amber-300">
              戻ると、画面からは戻ってこられなくなります。
            </strong>{' '}
            手で戻すには次の2行を実行してください。
          </p>
          <pre
            data-testid="versions-confirm-escape"
            className="text-muted-foreground overflow-x-auto text-[11px]"
          >
            {`cat  ${versions.pointer_path}\nrm   ${versions.pointer_path}`}
          </pre>
          <div className="flex gap-2">
            <Button
              data-testid="versions-confirm-ok"
              size="sm"
              disabled={busy}
              onClick={() => void select(unverified.version, true)}
            >
              承知のうえで {unverified.version} を選ぶ
            </Button>
            <Button
              data-testid="versions-confirm-cancel"
              variant="ghost"
              size="sm"
              onClick={dismissUnverified}
            >
              やめる
            </Button>
          </div>
        </div>
      )}

      {update && (
        <p data-testid="versions-update" className="flex items-center gap-2 text-xs">
          <span>新しい版があります（{update.version}）</span>
          <Button
            size="sm"
            disabled={busy || !versions.editable || !!versions.install_unavailable}
            onClick={() => void install(update.version)}
          >
            取ってくる
          </Button>
        </p>
      )}

      {versions.install && (
        <p
          data-testid="versions-install"
          data-phase={versions.install.phase}
          className="text-muted-foreground text-xs"
        >
          {versions.install.version}：{installLabel(versions.install.phase)}
          {versions.install.reason && `（${versions.install.reason}）`}
        </p>
      )}

      {versions.install_unavailable && (
        <p data-testid="versions-install-unavailable" className="text-muted-foreground text-xs">
          {versions.install_unavailable}
        </p>
      )}

      {/*
        **一覧には `installed` の行も出す。** 以前は保管庫の版だけを出しており、
        ソースビルドが置いた版が**どこにも現れなかった**。パスと大きさが見えることには
        意味がある——同じ版名の行が並んだとき、どれが何かを見分ける材料になる。

        **ただし消させない。** あそこは自分が走ってきた場所で、保管庫のように
        「要らなくなった控え」ではない
      */}
      {versions.entries.length > 0 && (
        <ul data-testid="versions-stored" className="flex flex-col gap-1">
          {versions.entries.map((entry) => (
            <li key={entry.path} className="flex items-center gap-2 text-xs">
              <span className="shrink-0">{entry.version}</span>
              {entry.origin === 'installed' && (
                <span
                  data-testid="versions-installed-mark"
                  className="text-muted-foreground shrink-0"
                >
                  入れる側
                </span>
              )}
              <span className="text-muted-foreground min-w-0 flex-1 truncate">
                {entry.path}
              </span>
              <span className="text-muted-foreground shrink-0">
                {formatBytes(entry.size_bytes)}
              </span>
              {entry.origin === 'stored' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !versions.editable || entry.running}
                  onClick={() => void remove(entry.version)}
                >
                  消す
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p data-testid="versions-usage" className="text-muted-foreground text-xs">
        保管庫の使用量：{formatBytes(usage)}（{stored.length} 版）
      </p>

      {!versions.editable && (
        <p data-testid="versions-readonly" className="text-muted-foreground text-xs">
          版の切り替えは、管理者のアカウント（複数人で使う構成）または合言葉を
          通った相手だけができます。合言葉を置いていない構成では、この PC の
          ブラウザ（127.0.0.1）からだけになります。
        </p>
      )}
    </div>
  )
}

/**
 * 選択肢の文言。
 *
 * **選べない版も選択肢から消さない。** 消すと「なぜ出てこないのか」が分からなく
 * なるので、括弧書きで理由を添える（`PermissionModePicker` と同じ扱い）。
 */
function optionLabel(entry: VersionEntry): string {
  if (entry.usable) {
    return entry.version
  }
  return `${entry.version}（${entry.reason ?? '選べません'}）`
}
