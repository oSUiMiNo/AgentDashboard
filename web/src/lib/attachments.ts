/**
 * 入力欄に付けた画像を、運ぶ前にふるいにかける（画像添付 設計§8・§9）。
 *
 * # なぜ画面側でも断るのか
 *
 * サーバも同じ線で断る（415／413）ので、**ここは二重の検査である**。それでも置くのは、
 * **断るまでに画像を1枚まるごと運ばせない**ため。8 MiB を投げてから「大きすぎます」と
 * 言われるのでは、待たされたぶんが丸ごと無駄になる。
 *
 * **緩める側には倒さない。** ここが通してサーバが断る形は「押せたのに置けない」で、
 * 逆（ここが断ってサーバなら通る）よりも読み解きにくい。表はサーバ側の
 * `protocol::fs` の対応表と**同じ顔ぶれ**に揃える。
 */

/** 運べる1枚の上限。**サーバの `MAX_ATTACHMENT_BYTES`（8 MiB）と同じ値**。 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/**
 * 受け取る媒体型。**`image/svg+xml` は入れない**（設計§17）。
 *
 * claude 側の貼り付け処理が svg を拾わないので、置いても添付にならない。
 * 「置けたのに届かない」が最も読み解きにくい形なので、入口で断る。
 */
export const ACCEPTED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

/** `<input type="file">` の `accept` に渡す文字列。 */
export const ACCEPT_ATTRIBUTE = ACCEPTED_MEDIA_TYPES.join(',')

/**
 * 画面の中だけで使う鍵を採る。
 *
 * # なぜ `crypto.randomUUID()` を使わないのか
 *
 * **安全なオリジンでないと存在しない。** スマホから `http://<LAN の IP>:8787` で開くと
 * `window.isSecureContext` が `false` になり、`crypto.randomUUID` は `undefined` になる
 * （実測。`navigator.clipboard` が無いのと同じ理由で、README「既知の制約」が書いている
 * 形そのもの）。呼ぶと例外になり、**画像を1枚拾った瞬間に添付の道が丸ごと死ぬ**——
 * 押しても貼っても何も起きない、という形で表に出た。
 *
 * **通し番号で足りる。** ここで要るのは「この画面の中で重ならないこと」だけで、
 * 別の端末や再読み込みをまたいで一意である必要は無い（React の鍵と、外すときの
 * 目印にしか使わない）。`Math.random()` も使わない——テストが揺れる（`roam.ts` と同じ判断）。
 */
let 通し番号 = 0
export function 鍵を採る(): string {
  通し番号 += 1
  return `a${通し番号}`
}

/** 入力欄に付いた1枚。**送信を押すまでブラウザの外へ出ない**（設計§2）。 */
export interface Attachment {
  /** 画面での付け外しに使う鍵。`file` の中身とは無関係 */
  id: string
  file: File
  /** 小窓に出す絵。`URL.createObjectURL` の値なので、外すときに捨てる */
  preview: string
}

/** ふるいの結果。**断ったものも返す**——黙って消えると、付けたつもりのまま送られる。 */
export interface Picked {
  accepted: Attachment[]
  /** 断った理由。画面にそのまま出す */
  rejected: string[]
}

/** 人が読める大きさ。 */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/**
 * 落ちてきた／貼られた／選ばれたファイルを、添付にできるものだけへ絞る。
 *
 * **3つの経路で同じ形の添付ができる**ことが要件なので、判定はこの1つを通す
 * （設計§9）。経路ごとに書き分けると、片方だけ svg が通るような食い違いが生まれる。
 */
export function pickImages(files: readonly File[]): Picked {
  const accepted: Attachment[] = []
  const rejected: string[] = []
  for (const file of files) {
    if (!(ACCEPTED_MEDIA_TYPES as readonly string[]).includes(file.type)) {
      // **何が駄目だったかを言う。** 「使えません」だけでは、撮り直せばよいのか
      // 諦めるべきなのかが分からない
      const 種別 = file.type === '' ? '種別が分かりません' : file.type
      rejected.push(`${file.name}（${種別}）は添付できません`)
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(
        `${file.name}（${mib(file.size)}）は上限の ${mib(MAX_ATTACHMENT_BYTES)} を超えています`,
      )
      continue
    }
    accepted.push({
      id: 鍵を採る(),
      file,
      preview: URL.createObjectURL(file),
    })
  }
  return { accepted, rejected }
}

/**
 * 小窓の絵を捨てる。**外すときと送り終えたときに必ず呼ぶ**。
 *
 * 忘れると、付け外しを繰り返すたびにブラウザの中で溜まる（`FileView` が
 * `URL.revokeObjectURL` を `useEffect` の後始末で呼んでいるのと同じ約束）。
 */
export function releasePreview(attachment: Attachment): void {
  URL.revokeObjectURL(attachment.preview)
}
