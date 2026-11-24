import type { DirListing } from '@/lib/hostfs'
import { MAX_LISTINGS, putListing, readListing, resetListings } from '@/lib/folderListings'

const P = '/home/me/dev/app/src'

function 一覧(path: string): DirListing {
  return { path, truncated: false, entries: [] }
}

function 番号(n: number): string {
  return `/home/me/dev/app/p${n}`
}

describe('lib/folderListings', () => {
  beforeEach(() => {
    resetListings()
  })

  it('入れた一覧を、同じ PC とパスで引くと同じものが返る', () => {
    const A = 一覧(P)
    putListing('local', P, A)
    expect(readListing('local', P)).toBe(A)
  })

  it('入れていないものを引くと null', () => {
    expect(readListing('local', P)).toBeNull()
  })

  it('PC が違えば、同じパスでも別の控え', () => {
    const A = 一覧(P)
    const B = 一覧(P)
    putListing('local', P, A)
    putListing('pc-2', P, B)
    expect(readListing('local', P)).toBe(A)
    expect(readListing('pc-2', P)).toBe(B)
    expect(readListing('pc-3', P)).toBeNull()
  })

  it('上限を超えたら、最後に使ってから最も古いものが落ちる', () => {
    for (let n = 0; n <= MAX_LISTINGS; n++) {
      putListing('local', 番号(n), 一覧(番号(n)))
    }
    expect(readListing('local', 番号(0))).toBeNull()
    expect(readListing('local', 番号(1))).not.toBeNull()
    expect(readListing('local', 番号(MAX_LISTINGS))).not.toBeNull()
  })

  it('引いたものは新しくなり、上限を超えても落ちない', () => {
    for (let n = 0; n < MAX_LISTINGS; n++) {
      putListing('local', 番号(n), 一覧(番号(n)))
    }
    expect(readListing('local', 番号(0))).not.toBeNull()
    putListing('local', 番号(MAX_LISTINGS), 一覧(番号(MAX_LISTINGS)))
    expect(readListing('local', 番号(0))).not.toBeNull()
    expect(readListing('local', 番号(1))).toBeNull()
  })

  it('もう一度入れると差し替わり、新しくなる', () => {
    for (let n = 0; n < MAX_LISTINGS; n++) {
      putListing('local', 番号(n), 一覧(番号(n)))
    }
    const B = 一覧(番号(0))
    putListing('local', 番号(0), B)
    putListing('local', 番号(MAX_LISTINGS), 一覧(番号(MAX_LISTINGS)))
    expect(readListing('local', 番号(0))).toBe(B)
    expect(readListing('local', 番号(1))).toBeNull()
  })

  it('空にすると、何も引けない', () => {
    putListing('local', P, 一覧(P))
    resetListings()
    expect(readListing('local', P)).toBeNull()
  })
})
