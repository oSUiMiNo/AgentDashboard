import { useCallback, useEffect, useRef, useState } from 'react'
import { putListing, readListing } from '@/lib/folderListings'
import {
  MAX_EXPANDED,
  branchesToRefresh,
  listingOf,
  toggleExpanded,
  visibleBranches,
  type Branch,
} from '@/lib/folderTree'
import { HostFsError, listDir, sameListing } from '@/lib/hostfs'
import { usePoll, 一覧を引き直す間隔 } from '@/lib/poll'

export const 同時に読む数 = 4

type 読み方 = '人' | '覚え' | 'ルート'

interface Options {
  host: string
  root: string
  loadExpanded: () => string[]
  onExpandedChange: (expanded: string[]) => void
}

function 初めの形(host: string, root: string, loadExpanded: () => string[]) {
  const 並び = root === '' ? [] : loadExpanded()
  const 表 = new Map<string, Branch>()
  if (root !== '') {
    for (const path of [root, ...並び]) {
      const 控え = readListing(host, path)
      if (控え !== null) {
        表.set(path, { state: 'ready', listing: 控え })
      }
    }
  }
  return { 並び, 表 }
}

export function useFolderTree({ host, root, loadExpanded, onExpandedChange }: Options) {
  const [初め] = useState(() => 初めの形(host, root, loadExpanded))
  const [expanded, setExpanded] = useState<string[]>(初め.並び)
  const [branches, setBranches] = useState<Map<string, Branch>>(初め.表)
  const 並びの今 = useRef(初め.並び)
  const 表の今 = useRef(初め.表)
  const 番号 = useRef(new Map<string, number>())
  const 飛んでいる = useRef(new Set<string>())
  const 見えていた = useRef(new Set<string>())
  const 取り外した = useRef(false)
  const 列 = useRef<{ 走っている: number; 待ち: { 始める: () => void; 捨てる: () => void }[] }>({
    走っている: 0,
    待ち: [],
  })
  const 覚える = useRef(onExpandedChange)

  useEffect(() => {
    覚える.current = onExpandedChange
  })

  useEffect(() => {
    取り外した.current = false
    const 今の列 = 列.current
    return () => {
      取り外した.current = true
      見えていた.current = new Set()
      for (const 待っていた of 今の列.待ち.splice(0)) {
        待っていた.捨てる()
      }
    }
  }, [])

  const 並びを変える = useCallback((next: string[]) => {
    並びの今.current = next
    setExpanded(next)
    覚える.current(next)
  }, [])

  const 枝を置く = useCallback((path: string, 枝: Branch | null) => {
    const next = new Map(表の今.current)
    if (枝 === null) {
      next.delete(path)
    } else {
      next.set(path, 枝)
    }
    表の今.current = next
    setBranches(next)
  }, [])

  const 並べる = useCallback((仕事: () => Promise<void>): Promise<void> => {
    return new Promise<void>((resolve) => {
      const 始める = () => {
        列.current.走っている += 1
        void 仕事().finally(() => {
          列.current.走っている -= 1
          列.current.待ち.shift()?.始める()
          resolve()
        })
      }
      if (列.current.走っている < 同時に読む数) {
        始める()
      } else {
        列.current.待ち.push({ 始める, 捨てる: resolve })
      }
    })
  }, [])

  const 読む = useCallback(
    async (path: string, 読み方: 読み方): Promise<void> => {
      const mine = (番号.current.get(path) ?? 0) + 1
      番号.current.set(path, mine)
      飛んでいる.current.add(path)
      if (listingOf(表の今.current.get(path)) === null) {
        const 控え = readListing(host, path)
        枝を置く(path, 控え === null ? { state: 'loading', listing: null } : { state: 'ready', listing: 控え })
      }
      try {
        const result = await listDir(host, path)
        if (番号.current.get(path) !== mine) {
          return
        }
        putListing(host, path, result)
        const 前 = 表の今.current.get(path)
        const 前の一覧 = listingOf(前)
        const 同じ = 前の一覧 !== null && sameListing(前の一覧, result)
        if (同じ && 前?.state === 'ready') {
          return
        }
        枝を置く(path, { state: 'ready', listing: 同じ && 前の一覧 !== null ? 前の一覧 : result })
      } catch (err) {
        if (番号.current.get(path) !== mine) {
          return
        }
        if (取り外した.current) {
          return
        }
        if (読み方 === '覚え' && err instanceof HostFsError && err.status === 404) {
          枝を置く(path, null)
          並びを変える(並びの今.current.filter((each) => each !== path))
          return
        }
        枝を置く(path, { state: 'failed', reason: err instanceof Error ? err.message : '読めませんでした' })
      } finally {
        if (番号.current.get(path) === mine) {
          飛んでいる.current.delete(path)
        }
      }
    },
    [host, 枝を置く, 並びを変える],
  )

  const 読み直す = useCallback(
    async (path: string): Promise<void> => {
      const mine = 番号.current.get(path) ?? 0
      try {
        const result = await listDir(host, path)
        if ((番号.current.get(path) ?? 0) !== mine) {
          return
        }
        const 前 = 表の今.current.get(path)
        const 前の一覧 = listingOf(前)
        if (前 === undefined || 前.state === 'failed' || 前の一覧 === null) {
          return
        }
        putListing(host, path, result)
        if (sameListing(前の一覧, result)) {
          return
        }
        枝を置く(path, { state: 'ready', listing: result })
      } catch {
        return
      }
    },
    [host, 枝を置く],
  )

  const 読み直しの回 = useCallback(async (): Promise<void> => {
    if (root === '') {
      return
    }
    const 見える = visibleBranches(root, 並びの今.current, 表の今.current)
    const 相手 = branchesToRefresh(見える, 表の今.current, 飛んでいる.current).filter((path) =>
      表の今.current.has(path),
    )
    await Promise.all(相手.map((path) => 並べる(() => 読み直す(path))))
  }, [root, 並べる, 読み直す])

  usePoll(読み直しの回, 一覧を引き直す間隔)

  useEffect(() => {
    if (root === '') {
      return
    }
    const 見える = visibleBranches(root, expanded, branches)
    const 前 = 見えていた.current
    見えていた.current = new Set(見える)
    for (const path of 見える) {
      if (前.has(path) || 飛んでいる.current.has(path)) {
        continue
      }
      void 並べる(() => 読む(path, path === root ? 'ルート' : '覚え'))
    }
  }, [root, expanded, branches, 並べる, 読む])

  const toggle = useCallback(
    (path: string) => {
      const next = toggleExpanded(並びの今.current, path, MAX_EXPANDED, root)
      並びを変える(next)
      if (next.includes(path)) {
        void 読む(path, '人')
      }
    },
    [root, 並びを変える, 読む],
  )

  return { expanded, branches, toggle }
}
