/**
 * 大きいファイルを窓で読む面（`ファイル閲覧の上限を設定から変え、大きいものは流し読みする` 設計§10-3）。
 *
 * 一括で読む線（いまは 3 MiB）を超えたファイルは、サーバが先頭の窓だけを返す
 * （`truncated: true`）。ここはその続きを**位置を指定して少しずつ**読み、見ている前後の
 * 数枚だけを持つ。離れた窓は捨てるので、20 GB のファイルを末尾まで辿ってもブラウザに
 * 積み上がらない。
 *
 * # 決める側と測る側
 *
 * 次に何を頼むか・届いた窓をどう並べるかは `lib/fileWindow.ts`（純関数）が決める。
 * ここはスクロールの位置と要素の位置を測り、頼んで、描くだけ。
 *
 * # 本文は1つの `<pre>` に窓ごとの `<span>` を並べる
 *
 * 窓の継ぎ目は行の途中にある。窓ごとに塊（block）を分けると、そこで行が割れて見える。
 *
 * # 見ている行を動かさない
 *
 * 前へ足す・先頭を落とすと、上にある中身の高さが変わる。並べ替える直前に**残る窓**の
 * 位置を控え、描いた後に同じ窓の位置との差だけスクロールを戻す（錨）。描く前後の
 * `scrollHeight` の差では、前に足すのと同時に後ろを落としたときにずれる（設計からの外れ。
 * 実行レポートに理由を書いた）。
 */

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/format'
import {
  type FileChunk,
  type FileContent,
  HostFsError,
  readFileRange,
} from '@/lib/hostfs'
import {
  append,
  isChanged,
  jumpRange,
  nextRange,
  position,
  prepend,
  prevRange,
  type WindowRequest,
} from '@/lib/fileWindow'

/** 読み足し・飛ぶ・読み直すのどれか。答えの扱いが分かれる。 */
type LoadKind = 'after' | 'before' | 'jump' | 'reload'

/** 端で読めなくなった理由。 */
type Stop =
  | { kind: 'unreadable'; at: number }
  | { kind: 'error'; message: string; retry: WindowRequest; mode: LoadKind }
  | { kind: 'limit' }

export interface FileWindowViewProps {
  host: string
  path: string
  /** 先頭の窓（`truncated: true` で届いた `FileContent`） */
  initial: FileContent
  /** 続きを頼む長さ（サーバの設定の `file_view.window_bytes`） */
  windowBytes: number
  /** スクロールする箱（ファイルビュアの `file-body`） */
  scrollRef: RefObject<HTMLDivElement | null>
  /** 窓の並びが変わるたびに増える数で呼ぶ（探し直しの合図） */
  onGeneration?: (generation: number) => void
  /** 上限で断られたときに出す導線（ファイルビュアと同じもの） */
  limitHint?: ReactNode
}

const encoder = new TextEncoder()

/** 先頭の窓を、窓の形にする。`end` は字の数ではなく UTF-8 のバイト数。 */
function firstChunk(initial: FileContent): FileChunk {
  return {
    path: initial.path,
    start: 0,
    end: encoder.encode(initial.text).length,
    bytes: initial.bytes,
    text: initial.text,
    stamp: initial.stamp ?? '',
    at_line_start: true,
  }
}

function stopOf(error: unknown, request: WindowRequest, mode: LoadKind): Stop {
  if (error instanceof HostFsError && error.status === 415) {
    return { kind: 'unreadable', at: request.offset }
  }
  if (error instanceof HostFsError && error.status === 413) {
    return { kind: 'limit' }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'error', message, retry: request, mode }
}

export function FileWindowView({
  host,
  path,
  initial,
  windowBytes,
  scrollRef,
  onGeneration,
  limitHint,
}: FileWindowViewProps) {
  const [windows, setWindows] = useState<FileChunk[]>(() => [firstChunk(initial)])
  const [bytes, setBytes] = useState(initial.bytes)
  const [changed, setChanged] = useState(false)
  const [stopBefore, setStopBefore] = useState<Stop | null>(null)
  const [stopAfter, setStopAfter] = useState<Stop | null>(null)
  const [ratio, setRatio] = useState(0)
  const [seek, setSeek] = useState<number | null>(null)

  /** 非同期の答えが読む「いまの値」。描くための状態と同じものを持つ。 */
  const windowsRef = useRef(windows)
  const baseRef = useRef(initial.stamp ?? '')
  const changedRef = useRef(false)
  const stopsRef = useRef<{ before: Stop | null; after: Stop | null }>({ before: null, after: null })
  /** 飛ぶ・読み直すたびに増える。古い世代の答えは捨てる */
  const genRef = useRef(0)
  /** 読み足しの頼みが走っているか。**同時に1つだけ** */
  const busyRef = useRef(false)
  /** 並べ替える直前に控えた、残る窓の位置（描いた後にスクロールを戻すため） */
  const anchorRef = useRef<{ start: number; top: number } | null>(null)
  /** 飛んだ後に送る先 */
  const pendingScrollRef = useRef<'top' | 'bottom' | null>(null)
  const generationRef = useRef(0)
  /** 親が毎回新しい関数を渡しても、効果を回し直さない（回すと合図が止まらない） */
  const onGenerationRef = useRef(onGeneration)
  onGenerationRef.current = onGeneration
  /** いま描いている先頭の窓の元。同じものなら作り直さない */
  const initialRef = useRef(initial)

  const putWindows = useCallback((next: FileChunk[]) => {
    windowsRef.current = next
    setWindows(next)
  }, [])

  const putStop = useCallback((side: 'before' | 'after', stop: Stop | null) => {
    stopsRef.current = { ...stopsRef.current, [side]: stop }
    if (side === 'before') {
      setStopBefore(stop)
    } else {
      setStopAfter(stop)
    }
  }, [])

  // 別のファイル（または読み直した先頭）が渡されたら、並びを作り直す
  useEffect(() => {
    if (initialRef.current === initial) {
      return
    }
    initialRef.current = initial
    genRef.current += 1
    busyRef.current = false
    anchorRef.current = null
    baseRef.current = initial.stamp ?? ''
    changedRef.current = false
    putWindows([firstChunk(initial)])
    setBytes(initial.bytes)
    setChanged(false)
    putStop('before', null)
    putStop('after', null)
  }, [initial, putWindows, putStop])

  /** 残る窓の、いまの画面上の位置を控える。 */
  const keepAnchor = useCallback(
    (start: number | undefined) => {
      const box = scrollRef.current
      if (start === undefined || box === null) {
        return
      }
      const element = box.querySelector(`span[data-start="${start}"]`)
      if (element !== null) {
        anchorRef.current = { start, top: element.getBoundingClientRect().top }
      }
    },
    [scrollRef],
  )

  const load = useCallback(
    async (kind: LoadKind, request: WindowRequest, retried = false): Promise<void> => {
      if (kind === 'after' || kind === 'before') {
        if (busyRef.current) {
          return
        }
      } else {
        genRef.current += 1
      }
      const gen = genRef.current
      busyRef.current = true
      let chunk: FileChunk
      try {
        chunk = await readFileRange(host, path, request)
      } catch (error) {
        if (gen !== genRef.current) {
          return
        }
        busyRef.current = false
        putStop(kind === 'before' ? 'before' : 'after', stopOf(error, request, kind))
        return
      }
      if (gen !== genRef.current) {
        return
      }
      busyRef.current = false

      if (kind === 'jump' || kind === 'reload') {
        // **並びを丸ごと入れ替える**ので、前の窓と混ざらない。印と大きさはこの窓に合わせる
        baseRef.current = chunk.stamp
        changedRef.current = false
        setChanged(false)
        setBytes(chunk.bytes)
        anchorRef.current = null
        putWindows([chunk])
        return
      }

      if (isChanged(baseRef.current, chunk)) {
        // **混ぜない。** 変わる前の窓と後の窓を並べると、継ぎ目で中身が食い違う
        changedRef.current = true
        setChanged(true)
        return
      }

      const current = windowsRef.current
      if (kind === 'after') {
        const got = append(current, chunk)
        if (got === null) {
          return
        }
        if (got.dropped === 'head') {
          keepAnchor(current[1]?.start)
        }
        putWindows(got.windows)
        return
      }

      const got = prepend(current, chunk)
      if (got === null) {
        // 行頭へ寄せた先が今の先頭だった（空の窓）。同じ範囲を寄せずに1回だけ頼み直す
        if (chunk.start === chunk.end && request.alignLine && !retried) {
          await load('before', { ...request, alignLine: false }, true)
        }
        return
      }
      keepAnchor(current[0]?.start)
      putWindows(got.windows)
    },
    [host, path, keepAnchor, putStop, putWindows],
  )

  /** 端に近ければ読み足す。スクロールのたびと、並べ替えた後に1回。 */
  const check = useCallback(() => {
    const box = scrollRef.current
    if (box === null || changedRef.current) {
      return
    }
    const room = box.scrollHeight - box.clientHeight
    setRatio(room > 0 ? box.scrollTop / room : 0)
    const current = windowsRef.current
    if (
      stopsRef.current.after === null &&
      box.scrollHeight - box.scrollTop - box.clientHeight < box.clientHeight
    ) {
      const request = nextRange(current, current[current.length - 1]?.bytes ?? 0, windowBytes)
      if (request !== null) {
        void load('after', request)
        return
      }
    }
    if (stopsRef.current.before === null && box.scrollTop < box.clientHeight) {
      const request = prevRange(current, windowBytes)
      if (request !== null) {
        void load('before', request)
      }
    }
  }, [scrollRef, windowBytes, load])

  useEffect(() => {
    const box = scrollRef.current
    if (box === null) {
      return
    }
    let frame: number | null = null
    const onScroll = () => {
      if (frame !== null) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = null
        check()
      })
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      box.removeEventListener('scroll', onScroll)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [scrollRef, check])

  // 描いた後：見ている行を戻す・飛んだ先へ送る
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box === null) {
      return
    }
    const anchor = anchorRef.current
    anchorRef.current = null
    if (anchor !== null) {
      const element = box.querySelector(`span[data-start="${anchor.start}"]`)
      if (element !== null) {
        box.scrollTop += element.getBoundingClientRect().top - anchor.top
      }
    }
    const pending = pendingScrollRef.current
    if (pending !== null && windows.length > 0) {
      pendingScrollRef.current = null
      box.scrollTop = pending === 'top' ? 0 : box.scrollHeight
    }
  }, [windows, scrollRef])

  const checkRef = useRef(check)
  checkRef.current = check

  // 並びが変わったら：探し直しの合図と、画面が埋まっていなければ続きを読む
  useEffect(() => {
    generationRef.current += 1
    onGenerationRef.current?.(generationRef.current)
    checkRef.current()
  }, [windows])

  const jump = useCallback(
    (target: 'top' | 'end' | number) => {
      const request =
        target === 'top'
          ? { offset: 0, length: windowBytes, alignLine: false }
          : jumpRange(target, bytes, windowBytes)
      pendingScrollRef.current = target === 'end' ? 'bottom' : 'top'
      putStop('before', null)
      putStop('after', null)
      anchorRef.current = null
      putWindows([])
      void load('jump', request)
    },
    [bytes, windowBytes, load, putStop, putWindows],
  )

  const reload = useCallback(() => {
    const from = windowsRef.current[0]?.start ?? 0
    pendingScrollRef.current = 'top'
    putStop('before', null)
    putStop('after', null)
    void load('reload', { offset: from, length: windowBytes, alignLine: from > 0 })
  }, [windowBytes, load, putStop])

  const commitSeek = useCallback(() => {
    if (seek === null) {
      return
    }
    const target = Math.floor((bytes * seek) / 1000)
    setSeek(null)
    jump(target)
  }, [seek, bytes, jump])

  const here = position(windows, ratio)
  const percent = bytes > 0 ? Math.round((here / bytes) * 100) : 0
  const first = windows[0]
  const last = windows[windows.length - 1]

  const stopView = (stop: Stop) => {
    if (stop.kind === 'unreadable') {
      return (
        <p data-testid="file-window-stop" className="text-xs text-amber-300">
          {stop.at.toLocaleString('en-US')} バイト目からはテキストとして読めません
        </p>
      )
    }
    if (stop.kind === 'limit') {
      return limitHint ?? null
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p data-testid="file-window-error" className="text-xs break-words text-red-400">
          {stop.message}
        </p>
        <Button
          data-testid="file-window-retry"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (stop.mode === 'jump' || stop.mode === 'reload') {
              putStop('after', null)
              void load(stop.mode, stop.retry)
              return
            }
            putStop(stop.mode === 'before' ? 'before' : 'after', null)
            void load(stop.mode, stop.retry)
          }}
        >
          もう一度
        </Button>
      </div>
    )
  }

  return (
    <div data-testid="file-window" data-path={path}>
      <div
        data-testid="file-window-bar"
        data-file-find-skip
        className="bg-background sticky top-0 z-10 flex flex-wrap items-center gap-2 py-1 text-xs"
      >
        <span data-testid="file-window-position" className="tabular-nums">
          {formatBytes(here)} / {formatBytes(bytes)}（{percent}%）
        </span>
        <Button data-testid="file-window-top" variant="ghost" size="sm" onClick={() => jump('top')}>
          先頭へ
        </Button>
        <Button data-testid="file-window-end" variant="ghost" size="sm" onClick={() => jump('end')}>
          末尾へ
        </Button>
        <input
          data-testid="file-window-seek"
          type="range"
          min={0}
          max={1000}
          aria-label="読む位置"
          value={seek ?? (bytes > 0 ? Math.round((here / bytes) * 1000) : 0)}
          onChange={(event) => setSeek(Number(event.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          onBlur={commitSeek}
          className="min-w-24 flex-1"
        />
        <span className="text-muted-foreground">Ctrl+F は読み込んだ範囲だけを探します</span>
      </div>
      {changed && (
        <div data-file-find-skip className="flex flex-wrap items-center gap-2 py-1">
          <p data-testid="file-window-changed" className="text-xs text-amber-300">
            読んでいる間にファイルが変わりました
          </p>
          <Button data-testid="file-window-reload" variant="ghost" size="sm" onClick={reload}>
            読み直す
          </Button>
        </div>
      )}
      {(stopBefore !== null || (first !== undefined && first.start > 0)) && (
        <div data-testid="file-window-before" data-file-find-skip className="text-muted-foreground py-1 text-xs">
          {stopBefore !== null ? stopView(stopBefore) : 'ここより前を読み込み中…'}
        </div>
      )}
      <pre data-testid="file-window-text" className="file-raw text-muted-foreground whitespace-pre-wrap">
        {windows.map((chunk) => (
          <span key={chunk.start} data-start={chunk.start} data-end={chunk.end}>
            {chunk.text}
          </span>
        ))}
      </pre>
      {(stopAfter !== null || (last !== undefined && last.end < bytes)) && (
        <div data-testid="file-window-after" data-file-find-skip className="text-muted-foreground py-1 text-xs">
          {stopAfter !== null ? stopView(stopAfter) : 'ここより後を読み込み中…'}
        </div>
      )}
    </div>
  )
}
