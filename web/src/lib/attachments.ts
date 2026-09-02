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

/**
 * 入力欄に付いた1枚。**送信を押すまでブラウザの外へ出ない**（設計§2）。
 *
 * # なぜ `File` を持たないのか
 *
 * **`File` は、その場で読めることを保証しない。** 中身はディスク（スマホなら
 * `content://` の一時ファイル）に在り、`File` はそこへの参照でしかない。選んだあとに
 * 元が書き換わる・消える・クリップボードが入れ替わると、**送ろうとした瞬間に読めなくなる**。
 *
 * Chrome はこれを `net::ERR_UPLOAD_FILE_CHANGED` として弾き、`fetch` は
 * **`TypeError: Failed to fetch`** を投げる——HTTP の応答が無いので、こちらには
 * 状態コードも理由も届かない。実際に利用者のスマホで出た（2026-09-03）。
 * 手元でも同じ形で再現できる（選んでから中身を書き換えて送ると必ず落ちる）。
 *
 * **だから付けた時点で写しを取り、送るのは写しにする。** 元がどうなろうと送れる。
 * 小窓の絵も写しから作るので、**絵が壊れることも無くなる**。
 *
 * 代金はメモリで、上限は1枚 8 MiB（`MAX_ATTACHMENT_BYTES`）×枚数。**先に運んでしまう
 * 案は採らない**——外したときや画面を移ったときに、置いたものが向こうに残る（設計§2）。
 */
export interface Attachment {
  /** 画面での付け外しに使う鍵。中身とは無関係 */
  id: string
  /** 画面に出す名前。**ディスク上の名前はサーバが採番する**ので、表示にしか使わない */
  name: string
  /** 媒体型。運ぶときのヘッダに載せる */
  mediaType: string
  /** **付けた時点で取った写し。** 送るのはこれ */
  bytes: Blob
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
 *
 * **非同期なのは、ここで中身を読んで写しを取るからである**（`Attachment` の説明）。
 */
export async function pickImages(files: readonly File[]): Promise<Picked> {
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
    // **ここで読む。** 大きさと種別を先に見てから読むので、断るものは読まない。
    // 読めなかったら**その場で言う**——送信を押してから「Failed to fetch」と出るより、
    // 付けた瞬間に「読めませんでした」と出るほうが、撮り直す判断ができる
    let bytes: Blob
    try {
      bytes = new Blob([await file.arrayBuffer()], { type: file.type })
    } catch {
      rejected.push(
        `${file.name} を読めませんでした（元の画像が入れ替わったか、消えた可能性があります）`,
      )
      continue
    }
    accepted.push({
      id: 鍵を採る(),
      name: file.name,
      mediaType: file.type,
      bytes,
      // **写しから作る。** 元から作ると、元が消えたときに絵も壊れる
      preview: URL.createObjectURL(bytes),
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
