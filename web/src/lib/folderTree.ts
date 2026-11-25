import { childOf, crumbsOf, isUnder, type DirListing } from '@/lib/hostfs'

export const MAX_EXPANDED = 100

export type Branch =
  | { state: 'loading'; listing: DirListing | null }
  | { state: 'ready'; listing: DirListing }
  | { state: 'failed'; reason: string }

export function listingOf(branch: Branch | undefined): DirListing | null {
  if (branch === undefined || branch.state === 'failed') {
    return null
  }
  return branch.listing
}

export function ancestorsOf(root: string, path: string): string[] {
  if (!isUnder(root, path)) {
    return []
  }
  return crumbsOf(path)
    .map((crumb) => crumb.path)
    .filter((each) => isUnder(root, each) && !isUnder(each, root))
}

function 見えていない(root: string, 並び: ReadonlySet<string>, path: string): boolean {
  const 段 = ancestorsOf(root, path)
  if (段.length === 0) {
    return true
  }
  return 段.slice(0, -1).some((each) => !並び.has(each))
}

export function capExpanded(
  expanded: readonly string[],
  cap: number,
  root: string,
  keep: readonly string[],
): string[] {
  const 超え = expanded.length - cap
  if (超え <= 0) {
    return [...expanded]
  }
  const 並び = new Set(expanded)
  const 守る = new Set(keep)
  const 落とす = new Set<string>()
  for (const path of expanded) {
    if (落とす.size >= 超え) {
      break
    }
    if (!守る.has(path) && 見えていない(root, 並び, path)) {
      落とす.add(path)
    }
  }
  for (const path of expanded) {
    if (落とす.size >= 超え) {
      break
    }
    if (!守る.has(path)) {
      落とす.add(path)
    }
  }
  return expanded.filter((path) => !落とす.has(path))
}

export function toggleExpanded(
  expanded: readonly string[],
  path: string,
  cap: number,
  root: string,
): string[] {
  const 祖先 = ancestorsOf(root, path)
  if (祖先.length === 0) {
    return [...expanded]
  }
  if (expanded.includes(path)) {
    return expanded.filter((each) => each !== path)
  }
  return capExpanded([...expanded, path], cap, root, 祖先)
}

export function visibleBranches(
  root: string,
  expanded: readonly string[],
  branches: ReadonlyMap<string, Branch>,
): string[] {
  if (root === '') {
    return []
  }
  const 展開 = new Set(expanded)
  const out = [root]
  for (let i = 0; i < out.length; i++) {
    const 親 = out[i]
    const 一覧 = listingOf(branches.get(親))
    if (一覧 === null) {
      continue
    }
    for (const entry of 一覧.entries) {
      const 子 = childOf(親, entry.name)
      if (entry.kind === 'dir' && 展開.has(子) && !out.includes(子)) {
        out.push(子)
      }
    }
  }
  return out
}

export function branchesToRefresh(
  visible: readonly string[],
  branches: ReadonlyMap<string, Branch>,
  inFlight: ReadonlySet<string>,
): string[] {
  return visible.filter(
    (path) => branches.get(path)?.state !== 'failed' && !inFlight.has(path),
  )
}

export async function runLimited<T>(
  jobs: readonly (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(jobs.length)
  let next = 0
  const 流す = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next
      next += 1
      try {
        results[i] = { status: 'fulfilled', value: await jobs[i]() }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  const 本数 = Math.min(Math.max(1, limit), jobs.length)
  await Promise.all(Array.from({ length: 本数 }, () => 流す()))
  return results
}

export function visibleRowCount(
  visible: readonly string[],
  branches: ReadonlyMap<string, Branch>,
): number {
  let 数 = 0
  for (const path of visible) {
    数 += listingOf(branches.get(path))?.entries.length ?? 0
  }
  return 数
}

export const 送り直しを見張る間 = 2_000

export function rowScrollFor(
  器: { 高さ: number; いまの位置: number },
  行: { 上: number; 高さ: number },
): number {
  const 上端 = 器.いまの位置
  const 下端 = 器.いまの位置 + 器.高さ
  if (行.上 >= 上端 && 行.上 + 行.高さ <= 下端) {
    return 器.いまの位置
  }
  if (行.上 < 上端 || 行.高さ > 器.高さ) {
    return Math.max(0, 行.上)
  }
  return Math.max(0, 行.上 + 行.高さ - 器.高さ)
}
