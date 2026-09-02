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
 * **切り出したのは印だけで、ボタンは切り出していない。** セッション画面の電源ボタンは
 * 「点いているか」「起こし直せるか」「連打よけ」を抱えており、帯のほうは
 * 「選んだうちの何枚に効くか」を持つ——**中身が違うものを1つにまとめない**。
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
