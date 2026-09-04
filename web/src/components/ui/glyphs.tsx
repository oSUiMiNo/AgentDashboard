/**
 * 手書きのインライン SVG の印（並べ替え設計§5-2）。
 *
 * # ライブラリを使い始めない
 *
 * `lucide-react` は依存に入っているが、**`web/src` から1件も使われていない**。
 * この PJT はアイコンですら自分で線を引いてきた（`方針.md` §6-3）——線の太さと
 * `viewBox` を自分で握れるほうが、`DESIGN.md` の寸法と揃えやすいためである。
 * ここで使い始めると、**同じ画面に2つの流儀が並ぶ**。
 *
 * # なぜ切り出したか
 *
 * まとめて操作の帯（§5-2）が、セッション画面と**同じ印**を使う。同じものを2度
 * 引くと、片方だけ直されて**同じ意味の印が2つの形になる**。
 *
 * # ここに在るのは印だけ
 *
 * **ボタンは `ui/power-button.tsx` にある。** セッション画面の電源ボタンは「点いているか」
 * 「起こし直せるか」「連打よけ」を抱えているので、印とは別の場所に置いてある——
 * **カードでも同じものを出す**ことになったので（細かい修正 設計§2-1）、`SessionView` の
 * 中から出したが、印と一緒にはしていない。
 *
 * **帯（まとめて操作）の電源は、いまも別物のまま。** あちらは「選んだうちの何枚に効くか」を
 * 持っており、**中身が違うものを1つにまとめない**。共有しているのは `PowerGlyph` だけである。
 */

/** 電源の印（設計§15-1）。**言葉は `aria-label` と `title` に残す。** */
export function PowerGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v9" />
      <path d="M18.4 7a9 9 0 1 1-12.8 0" />
    </svg>
  )
}

/** 「終了」の印（設計§15-2）。**言葉は `aria-label` と `title` に残す。** */
export function TrashGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

/**
 * 「名前を付ける」の印（名前付け設計§9-6）。**絵文字は使わない**（`DESIGN.md` §14.4）。
 *
 * 鉛筆の軸と先端の2本だけで描く。`DESIGN.md` §18.2 の下限（線の太さはグリッドの
 * 1/8 以上）を満たすため、24 のグリッドで `strokeWidth={2}` にしてある——
 * 小さく置いても消えない。
 */
export function PencilGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      <path d="M15 5l4 4" />
    </svg>
  )
}

/**
 * 「前へ／後ろへ」「上へ／下へ」の印（並べ替え設計§15-6）。**言葉は `aria-label` と `title` に残す。**
 *
 * 帯（まとめて操作）に置き、1つ選んでいるときだけ出す——ドラッグ以外の道
 * （WCAG 2.2 SC 2.5.7）。向きは4つで、同じ山形を回して使う。
 */
export function ChevronGlyph({
  direction,
  className,
}: {
  direction: 'up' | 'down' | 'left' | 'right'
  className?: string
}) {
  const rotate = { up: 0, right: 90, down: 180, left: 270 }[direction]
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 15 6-6 6 6" transform={`rotate(${rotate} 12 12)`} />
    </svg>
  )
}

/**
 * 「閉じる」の印（細かい修正 設計§2-2・§9-1）。**言葉は `aria-label` と `title` に残す。**
 *
 * **同じ絵が `GroupView` と `SessionView` に1文字違わず写されていた。** 片方だけ直されて
 * 同じ意味の印が2つの形になる前に、ここへ寄せた。
 *
 * **「面を閉じる」だけに使う。**「操作をやめる」は文字のまま残す（§9-1）——
 * 取り返しの付かなさが違うものを、同じ形にしない。
 */
export function CloseGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}

/**
 * 「設定」の印（細かい修正 設計§9-2）。**絵文字（`⚙️`）は使わない**（`DESIGN.md` §14.4 が
 * 禁止例に名指しで挙げている）。
 *
 * **歯は6枚。** はじめ「中心の輪＋8本の軸」で描いたが、**焼いて見たら太陽（明るさ調整）
 * だった**——`DESIGN.md` §18.4 の門は「他と見分けが付くか」だけでなく、**その意味に
 * 見えるか**を見る門である。歯を持たない図は、歯車の代わりにならない。
 *
 * 8枚だと 18px で歯が隣とくっついて丸に戻るので、**6枚**にしてある（実際に焼いて比べた）。
 * 歯先は平ら、谷は浅く、中心の穴は `r=3`。
 */
export function GearGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M 9.36 2.15 L 14.64 2.15 L 14.61 5.94 L 15.95 6.71 L 19.21 4.79 L 21.85 9.36 L 18.55 11.22 L 18.55 12.78 L 21.85 14.64 L 19.21 19.21 L 15.95 17.29 L 14.61 18.06 L 14.64 21.85 L 9.36 21.85 L 9.39 18.06 L 8.05 17.29 L 4.79 19.21 L 2.15 14.64 L 5.45 12.78 L 5.45 11.22 L 2.15 9.36 L 4.79 4.79 L 8.05 6.71 L 9.39 5.94 Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

/**
 * 「送信」の印（細かい修正 設計§6-1）。**入力欄まわりで唯一塗るもの**——
 * `DESIGN.md` §15.1「主要操作は1つだけ塗る」。
 *
 * **山形（`ChevronGlyph`）と見分けが付くこと**が、この絵に課された条件である（§18.4 の門）。
 * どちらも三角と線でできているので、**折り目の線を必ず入れる**——これが無いと、
 * 小さくしたときにただの三角になる。
 */
export function SendGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 3 3 10.5l8 2.5 2.5 8z" />
      <path d="M21 3 11 13" />
    </svg>
  )
}

/**
 * 「コピー」の印（細かい修正 設計§8-3）。**結果の文字（`コピーしました` /
 * `コピーできません`）は絵にしない**——成功と失敗が見分けられなくなる。
 *
 * **鉛筆（`PencilGlyph`）と見分けが付くこと**が条件である（§18.4 の門）。あちらは
 * 斜めの軸と先端、こちらは**2枚の紙が重なった形**で、線の向きがまったく違う。
 */
export function CopyGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )
}

/**
 * 「溜まっている知らせ」の印（細かい修正 設計§7-4）。**1件以上あるときだけ出す**——
 * 常に出すと、押す意味のない印が画面に居座る。
 */
export function BellGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}

/**
 * 「足す」の印（帯設計§16-4・細かい修正 設計§4-3）。
 *
 * **全角の `＋` という文字ではなく、線で描く**（`DESIGN.md` §14.4）。✕・ゴミ箱・電源と
 * 同じ作りに揃える。
 *
 * **器や立体は持たせない。** この形は**一覧の枠のヘッダでも出る**ので、`DESIGN.md` §12.3
 * 「一覧の行に物質を持たせない」が効く。**形だけを直す。**
 */
export function PlusGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

/**
 * キーボードの印（設計§12）。**言葉は `aria-label` と `title` に残す。**
 *
 * 端末へ文字を打つ唯一の入口に付ける。**絵文字（⌨）は使わない**——`DESIGN.md` §35.1 の
 * 台帳が増えるうえ、字形が機械ごとに変わるので線の太さを揃えられない。
 */
export function KeyboardGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  )
}
