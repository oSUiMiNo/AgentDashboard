/**
 * パスの組み立てと、内側かどうかの判定（イシューグループ_2026_0805_0514 設計§15・§29）。
 *
 * **区切りの扱いは1箇所に閉じてある**（`childOf` / `relativeOf` / `isUnder`）ので、
 * ここが崩れると、貼られた相対パスが別の場所を指したり、起点の外へ抜ける段が
 * 押せるようになったりする。画面越しでは気づきにくいので、直接固定する。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  childOf,
  crumbsOf,
  isUnder,
  readBlob,
  relativeOf,
  uploadAttachment,
} from '@/lib/hostfs'

describe('内側かどうか', () => {
  it('自分自身と、その下は内側', () => {
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app')).toBe(true)
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app/src')).toBe(true)
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app/src/main.rs')).toBe(true)
  })

  it('名前の頭が同じだけの兄弟は内側ではない', () => {
    // **これが素の前方一致で通ってしまう。** 押せる段が1つずれ、起点の外へ抜ける
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app-old')).toBe(false)
    expect(isUnder('/home/me/dev/app', '/home/me/dev/app2')).toBe(false)
  })

  it('上の階層も外側', () => {
    expect(isUnder('/home/me/dev/app', '/home/me/dev')).toBe(false)
    expect(isUnder('/home/me/dev/app', '/')).toBe(false)
  })

  it('起点の末尾に区切りが付いていても同じ答えになる', () => {
    expect(isUnder('/home/me/dev/app/', '/home/me/dev/app/src')).toBe(true)
    expect(isUnder('/home/me/dev/app/', '/home/me/dev/app-old')).toBe(false)
    // ルート自身は落とさない（`//src` を作らない）
    expect(isUnder('/', '/home')).toBe(true)
  })
})

describe('相対パス', () => {
  it('起点そのものは `.`', () => {
    expect(relativeOf('/home/me/dev/app', '/home/me/dev/app')).toBe('.')
    expect(relativeOf('/home/me/dev/app/', '/home/me/dev/app')).toBe('.')
  })

  it('内側は起点からの道のりになる', () => {
    expect(relativeOf('/home/me/dev/app', '/home/me/dev/app/MyDocs/計画.md')).toBe(
      'MyDocs/計画.md',
    )
  })

  it('外側は絶対パスのまま返す', () => {
    // 相対にできないものを `../` で表すと、貼られた側が別の場所を指す
    expect(relativeOf('/home/me/dev/app', '/home/me/dev/app-old/計画.md')).toBe(
      '/home/me/dev/app-old/計画.md',
    )
    expect(relativeOf('/home/me/dev/app', '/etc/hosts')).toBe('/etc/hosts')
  })
})

describe('子のパスとパンくず', () => {
  it('区切りが重ならない', () => {
    expect(childOf('/home/me', 'dev')).toBe('/home/me/dev')
    expect(childOf('/', 'home')).toBe('/home')
  })

  it('パンくずはルートから順に積み上がる', () => {
    expect(crumbsOf('/home/me/dev')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'me', path: '/home/me' },
      { label: 'dev', path: '/home/me/dev' },
    ])
  })
})

describe('断り文', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 本文の無い失敗を返す `fetch`。**空だからこそ既定の文が出る。** */
  function 本文なしで断る(status: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status })),
    )
  }

  it('画像の取得が失敗したとき、フォルダの話にしない', async () => {
    // `reason()` の既定は「フォルダを読めませんでした」。`readBlob` が既定のまま
    // 呼ぶと、**画像の行の上にフォルダの話が出る**（コードレビュー対応8）。
    //
    // **`readBlob` を差し替えずに `fetch` を差し替える。** 差し替える先を間違えると、
    // 直した当の関数を1行も通らないテストになる（実際に一度そう書いた）
    本文なしで断る(500)
    await expect(readBlob('local', '/x.png')).rejects.toThrow(
      '画像を読めませんでした',
    )
  })

  it('404 は場所の話になる（引く側と共通）', async () => {
    // ここは既定を渡していても変わらない。**404 だけは呼ぶ側によらず同じ**
    本文なしで断る(404)
    await expect(readBlob('local', '/x.png')).rejects.toThrow(
      'その場所は見つかりません',
    )
  })
})

describe('応答が1つも返らなかったとき', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * **`fetch` は、届かなかったことを `TypeError` でしか言わない。**
   *
   * その `message` は `Failed to fetch` という英語の1行で、状態コードも理由も無い。
   * 素通しすると**日本語の画面に読めない字が出るだけ**で、押した人には何もできない
   * ——利用者のスマホの画面へ実際にそのまま出た（2026-09-03）。
   */
  it('英語の1行をそのまま画面へ出さない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(
      uploadAttachment('local', 'card', new Blob([new Uint8Array(4)])),
    ).rejects.toThrow('画像をサーバへ送れませんでした')
  })

  it('元の文言は捨てない', async () => {
    // **消してしまわない。** 原因を追う人には `Failed to fetch` が手掛かりになる
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(
      uploadAttachment('local', 'card', new Blob([new Uint8Array(4)])),
    ).rejects.toThrow('Failed to fetch')
  })

  it('応答が返った失敗は、これまでどおりサーバの言い分を出す', async () => {
    // **投げられた失敗だけを包む。** ここで一緒に包むと、サーバが言い分けている
    // 理由（権限・大きすぎ・種別違い）が全部同じ文になる
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('画像が大きすぎます', { status: 413 })),
    )
    await expect(
      uploadAttachment('local', 'card', new Blob([new Uint8Array(4)])),
    ).rejects.toThrow('画像が大きすぎます')
  })
})
