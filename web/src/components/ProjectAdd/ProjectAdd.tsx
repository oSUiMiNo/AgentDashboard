/**
 * PJT の枠を足す（イシューグループ_2026_0805_0514 設計§13）。
 *
 * # ここが起動の唯一の入口になった
 *
 * 以前はパスを打ち込んで直接セッションを起こしていた。いまは**枠を足し、枠の「+」で
 * 起こす**——入口が1つになるので、「どちらから起こしたか」を覚えておく必要がない。
 * 追加したその場で1本起こしたい人は、設定のトグルで叶える（§12）。
 *
 * # 打ち込む道と辿る道の両方を置く
 *
 * Windows 側から貼ったパスが最短な場面は今までどおり残す。読み替え（`\` 区切り・
 * `\\wsl.localhost\...`・`C:\...`・引用符付き）は PC 側の `session/cwd.rs` が持って
 * いるので、**画面では一切触らない**——ここで正規化すると、`\` を名前に含む実在の
 * フォルダを開けなくなる。
 *
 * # 始まりは2つ
 *
 * ホーム（PC に聞く）と、最近使った場所（**サーバの記録から組み立てる**）。後者は
 * PC が寝ていても出せるのが要点で、開いた瞬間に候補が並ぶ（設計§13）。
 */

import { useMemo, useState } from 'react'
import { FolderBrowser } from '@/components/FolderBrowser/FolderBrowser'
import { listDir } from '@/lib/hostfs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LOCAL_HOST } from '@/lib/routes'
import { getSessions } from '@/stores/sessions'
import { hasProject, useProjects } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'

interface Props {
  disabled: boolean
}

export function ProjectAdd({ disabled }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        data-testid="project-add-open"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        PJT を追加
      </Button>
      {open && <AddSheet onClose={() => setOpen(false)} />}
    </div>
  )
}

/**
 * 重ねて出す（設計§13）。
 *
 * 一覧は「押して開く」ための画面なので、**選んでいるあいだ小窓の並びが動かない**
 * ことが要る。差し込む形にすると、開いた拍子に下の一覧がずれる。
 */
function AddSheet({ onClose }: { onClose: () => void }) {
  const agents = useSettingsStore((state) => state.settings.agents)
  const projects = useProjects()
  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [start, setStart] = useState<string | undefined>(undefined)
  // **同じ行を押し直しても辿り直せるようにする。** `start` だけだと値が変わらず、
  // 一度そこへ行って別の階層を掘ったあと、もう一度押しても何も起きない
  const [startSeq, setStartSeq] = useState(0)

  /**
   * 候補は**登録されている PC 全部**（設計§17・§29）。
   *
   * 繋がっているものだけに絞ると、2つの困りごとが出る。
   *
   * - **全部寝ているとき**、宛先がローカルへ落ちる。サーバモードに「ローカル」という
   *   単位は無いので、できるのは一覧に出るだけで何もできない番兵の枠になる
   * - 起きているのが1台のとき、**寝ている PC を選ぶ道が画面から消える**。枠は寝ていても
   *   足せる必要があり（§17）、サーバ側も帰属しか見ていない。断っているのは画面だけだった
   *
   * 辿れないのは事実なので、そこは選んだあとに案内する（下記）。
   */
  const isLocal = agents.length === 0
  const needsTarget = agents.length > 1
  const [target, setTarget] = useState('')
  // 1台のときとローカルモードは選ぶ余地が無い（設計§13）
  const host = isLocal ? LOCAL_HOST : needsTarget ? target : agents[0].id
  // 選んだ PC が寝ているか。**辿る道だけを塞ぐ**（打ち込む道は残す）
  const asleep =
    !isLocal &&
    host !== '' &&
    agents.find((agent) => agent.id === host)?.connected === false

  /**
   * 最近使った場所（設計§13）。
   *
   * 材料は**サーバの記録**にある（枠と、過去に起こしたカードの作業ディレクトリ）ので、
   * PC へ問い合わせずに出せる。新しいものから並べる。
   */
  const recent = useMemo(() => {
    const seen = new Set<string>()
    const out: { path: string; added: boolean }[] = []
    const push = (path: string) => {
      if (seen.has(path)) {
        return
      }
      seen.add(path)
      out.push({ path, added: hasProject(host, path) })
    }
    for (const project of [...projects].reverse()) {
      if (project.host === host) {
        push(project.path)
      }
    }
    for (const meta of getSessions()) {
      push(meta.project)
    }
    return out.slice(0, 8)
  }, [projects, host])

  const target_path = (typed.trim() !== '' ? typed.trim() : picked) ?? ''
  const blocked = busy || target_path === '' || (needsTarget && target === '')

  const submit = async () => {
    if (blocked) {
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      // **打ち込んだ形のまま保存しない。** Windows 側から貼ったパス（`\` 区切り・
      // `C:\...` など）をそのまま枠にすると、起こしたカードは解決後の絶対パスを
      // 名乗るので、**同じフォルダなのに枠とカードが別の箱に割れる**（設計§13）。
      //
      // 読み替えを持っているのは PC 側なので、一覧の口へ一度通して着いた先を貰う。
      // 引けなければ打ち込んだ形のまま足す——**寝ている PC の枠も足せる**必要がある（§17）
      const path = await canonical(host, target_path)
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, path }),
      })
      if (!response.ok) {
        setError((await response.text()).trim() || '追加できませんでした')
        return
      }
      const added = (await response.json()) as {
        spawned: boolean
        spawn_error?: string
      }
      // **枠は足せたが起こせなかった**、を言い分ける（設計§26-1）。黙って閉じると
      // 「起きるはずだったのに起きない」の理由が誰にも分からない
      if (added.spawn_error !== undefined) {
        setNotice(`枠は追加しました。セッションは起こせませんでした：${added.spawn_error}`)
        return
      }
      onClose()
    } catch {
      setError('追加できませんでした')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/*
        暗い幕。**押しても閉じない**——打ち込んだ内容を事故で失わせないため、
        閉じるのは「閉じる」だけにしてある。ここに幕が無いと、下の画面の文字が
        シートの上に重なって読める（実際にそう見えていた）
      */}
      <div aria-hidden className="fixed inset-0 z-40 bg-black/60" />
      <div
        data-testid="project-add-sheet"
        role="dialog"
        aria-label="PJT を追加"
        /*
          **高さの決まった縦並びにする。** 以前はシート全体を `overflow-y-auto` に
          していたので、フォルダの多い場所を開くと一覧が伸び放題になり、
          「この場所を追加」が画面の外へ押し出されていた。
          いまは中の一覧だけがスクロールし、頭と脚は必ず見える。
        */
        className="bg-background fixed inset-0 z-50 flex flex-col gap-3 overflow-hidden p-4 sm:inset-x-auto sm:inset-y-8 sm:left-1/2 sm:w-[min(40rem,90vw)] sm:-translate-x-1/2 sm:rounded-xl sm:border sm:shadow-xl"
      >
      <header className="flex shrink-0 items-center gap-2">
        <h2 className="text-sm font-semibold">PJT を追加</h2>
        <Button
          type="button"
          variant="ghost"
          data-testid="project-add-close"
          className="ml-auto"
          onClick={onClose}
        >
          閉じる
        </Button>
      </header>

      {needsTarget && (
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">どの PC か</span>
          <select
            data-testid="project-add-host"
            aria-label="どの PC か"
            className="border-border rounded border px-1.5 py-1 text-xs"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {/* **既定を作らない。** 勝手に1台目を選ぶと、意図しない PC を辿ることになる */}
            <option value="">選んでください</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {/* 寝ていることは**隠さずに選ばせる**。枠は寝ていても足せる（§17） */}
                {agent.connected ? agent.name : `${agent.name}（寝ています）`}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex shrink-0 flex-col gap-1 text-xs">
        <span className="text-muted-foreground">パスを打ち込む</span>
        <Input
          data-testid="project-add-path"
          aria-label="作業ディレクトリ"
          placeholder="/home/example/dev/プロジェクト"
          title={
            'Windows 側から貼ったパスも受け取ります（\\ 区切り／先頭の区切り抜け／' +
            '\\\\wsl.localhost\\... ／ C:\\...）'
          }
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>

      {recent.length > 0 && (
        <div className="flex shrink-0 flex-col gap-1">
          <span className="text-muted-foreground text-xs">最近使った場所</span>
          {/* 8件まで並ぶので、狭い画面では一覧の場所を食い潰さないよう頭を押さえる */}
          <ul
            data-testid="project-add-recent"
            className="flex max-h-28 flex-col overflow-y-auto"
          >
            {recent.map((entry) => (
              <li key={entry.path}>
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="project-add-recent-item"
                  data-added={entry.added ? 'true' : 'false'}
                  className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left text-xs font-normal"
                  onClick={() => {
                    // **押した場所を確定の相手にもする。** 辿り着いてから
                    // `onPathChange` で入るのを待つと、押しただけでは
                    // 「この場所を追加」が効かない
                    setStart(entry.path)
                    setPicked(entry.path)
                    setStartSeq((seq) => seq + 1)
                  }}
                >
                  <span className="min-w-0 truncate">{entry.path}</span>
                  {entry.added && (
                    <span className="text-muted-foreground ml-auto shrink-0">
                      追加済み
                    </span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* **ここだけが伸び縮みする。** `min-h-0` が無いと flex の子は縮まない */}
      <div className="border-border min-h-0 flex-1 overflow-hidden rounded border p-2">
        {needsTarget && target === '' ? (
          <p className="text-muted-foreground text-xs">
            どの PC のフォルダを見るか選んでください。
          </p>
        ) : asleep ? (
          // 辿る道だけが塞がる。**打ち込んで足す道は残っている**（設計§17）
          <p data-testid="project-add-asleep" className="text-muted-foreground text-xs">
            この PC は繋がっていないので、フォルダを辿れません。パスを打ち込めば枠は足せます。
          </p>
        ) : (
          <FolderBrowser
            // 同じ場所を押し直しても辿り直す（`start` だけでは値が変わらない）
            key={`${host}:${startSeq}`}
            host={host}
            start={start}
            onPathChange={setPicked}
          />
        )}
      </div>

      {error !== null && (
        <p data-testid="project-add-error" className="shrink-0 text-xs text-red-400">
          {error}
        </p>
      )}
      {notice !== null && (
        <p data-testid="project-add-notice" className="shrink-0 text-xs text-amber-300">
          {notice}
        </p>
      )}

      <footer className="flex shrink-0 items-center gap-2">
        <span
          data-testid="project-add-target"
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
          title={target_path}
        >
          {target_path === '' ? '場所を選ぶか、パスを打ち込んでください' : target_path}
        </span>
        <Button
          type="button"
          data-testid="project-add-submit"
          disabled={blocked}
          onClick={() => void submit()}
        >
          この場所を追加
        </Button>
      </footer>
      </div>
    </>
  )
}

/** 打ち込まれた形を、PC が解決した絶対パスへ寄せる（設計§13）。 */
async function canonical(host: string, path: string): Promise<string> {
  try {
    return (await listDir(host, path)).path
  } catch {
    // 引けない理由は「無い」だけとは限らない（寝ている・権限が無い）。
    // ここで断ると枠すら足せなくなるので、打ち込まれた形をそのまま返す
    return path
  }
}
