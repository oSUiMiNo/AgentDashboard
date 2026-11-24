import type { DirListing } from '@/lib/hostfs'

export const MAX_LISTINGS = 300

const 控え = new Map<string, DirListing>()

function 鍵(host: string, path: string): string {
  return JSON.stringify([host, path])
}

export function putListing(host: string, path: string, listing: DirListing): void {
  const key = 鍵(host, path)
  控え.delete(key)
  控え.set(key, listing)
  while (控え.size > MAX_LISTINGS) {
    const 古い = 控え.keys().next().value
    if (古い === undefined) {
      break
    }
    控え.delete(古い)
  }
}

export function readListing(host: string, path: string): DirListing | null {
  const key = 鍵(host, path)
  const listing = 控え.get(key)
  if (listing === undefined) {
    return null
  }
  控え.delete(key)
  控え.set(key, listing)
  return listing
}

export function resetListings(): void {
  控え.clear()
}
