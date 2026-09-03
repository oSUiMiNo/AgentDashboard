import { NICKNAME_MAX_CHARS } from '@/lib/protocol'

/**
 * セッションの名前を打ち込む欄（名前付け設計§9-5）。
 *
 * # なぜ部品にするのか
 *
 * 名前は**カードの小窓**と**セッションの帯**の両方から付けられる。打ち込みの決まり
 * ——上限・改行を弾く・Escape でやめる・外れたらやめる・キーを外へ漏らさない——を
 * 2箇所に書くと、片方だけ直したときに**同じ操作が場所によって違う振る舞い**になる。
 *
 * **置き場所は各自に残す。** 小窓は器そのものが `<button>` なので絶対配置の兄弟に
 * するしかないが、帯にはその制約が無い。ここが持つのは中身の決まりだけである。
 *
 * # 手元に正を持たない
 *
 * 打っている間も**表示は書き換えない**。確定してもサーバの `session_upsert` が
 * 戻るまで名前は変わらない（`setModel` と同じ流儀）。ブラウザ側にも正を持つと、
 * 2箇所が食い違う。
 */
export function NicknameInput({
  value,
  onChange,
  onCancel,
  className,
}: {
  value: string
  onChange: (next: string) => void
  /** やめる（Escape ／ 欄から外れる）。呼ぶ側は下書きを捨てる */
  onCancel: () => void
  className?: string
}) {
  return (
    <input
      data-testid="nickname-input"
      autoFocus
      value={value}
      maxLength={NICKNAME_MAX_CHARS}
      aria-label="セッションの名前"
      // **改行は入力の時点で弾く**（1行で切るので、切った先が読めない）
      onChange={(event) => onChange(event.target.value.replace(/[\r\n]/g, ''))}
      onKeyDown={(event) => {
        // **キーを外へ漏らさない。** 帯の下には端末が居るので、漏らすと
        // 打った文字がそのまま claude へ飛ぶ
        event.stopPropagation()
        if (event.key === 'Escape') onCancel()
      }}
      onBlur={onCancel}
      className={
        className ??
        'border-border bg-card text-foreground w-full rounded-[3px] border px-1 py-0.5 text-xs'
      }
    />
  )
}
