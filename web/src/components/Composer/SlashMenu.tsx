/**
 * 入力欄の上に出る、スラッシュコマンドの候補一覧（設計§6）。
 *
 * # 見た目だけを持つ
 *
 * **集める側を知らない。** 候補の配列と選択中の番号を受け取り、押されたら呼び返すだけで、
 * ディスクも `hostfs` も見ない。集めるのは [`harvestCandidates`]、絞るのは
 * [`filterCandidates`] の仕事で、**切るのはここ**（下記）。
 *
 * # radix の `Select` は使わない
 *
 * あれはトリガーを押して開き、**焦点を奪う**作りである。ここでほしいのは「入力欄に
 * 打ちながら出て、**焦点は入力欄に残る**」形（設計§6-3）——奪われると、次の1文字が
 * 入力欄へ入らない。**借りるのは `SelectItem` のクラス名の並びだけ**で、
 * `Primitive.Item` は使わず素の `<li role="option">` を書く。
 *
 * `role="option"` と `data-value` を付けてあるので、E2E の `pickOption`
 * （`web/e2e/helpers.ts`）がそのまま効く。
 *
 * # 入力欄の器の高さを 1px も変えない
 *
 * `absolute` で重ねる。伸び縮みさせると「端末の大きさが変わる → `ResizeObserver` →
 * `fit` → TUI 再描画」の輪に入る。`InputDock` が同じ理由で `absolute` を選んでいる。
 *
 * # `opacity` を使わない
 *
 * 沈めるのに `opacity` を使うと、**重なった裏の文字が透ける**（設計§6-2。実際に起きた）。
 * 色は `color-mix` で**不透明に**混ぜる。
 */
import type { SlashCandidate } from '@/lib/slashCandidates'

/**
 * 一度に出す行数の上限（`DESIGN.md` §15.2）。
 *
 * **溢れるのが普通である。** 実測でこの機械には106件あるので、絞り込む前は必ず超える。
 * **切るのはここの担当**で、`filterCandidates` は切らずに全部返す——集める側に
 * 「画面に何行入るか」を知らせると、層が混ざる。
 */
export const MAX_VISIBLE = 8

/** 候補の出どころを、画面に出す短い名前へ。 */
const SOURCE_LABEL: Record<SlashCandidate['source'], string> = {
  'project-command': 'PJT',
  'user-command': '利用者',
  'project-skill': 'PJT スキル',
  'user-skill': 'スキル',
  plugin: 'プラグイン',
  builtin: '組み込み',
}

interface Props {
  /** 絞り込み済みの候補。**切るのはこの部品**なので、全部渡してよい */
  candidates: readonly SlashCandidate[]
  /**
   * いま選ばれている番号（`candidates` の添字）。**`null` は「どれも選ばれていない」**
   * ——あいまい一致の層はこの状態で開く（設計§20-5）。
   */
  selected: number | null
  /**
   * あいまい一致で当たったか（設計§20-6）。真のときだけ一言添える。
   *
   * **厳密な一致では出さない。** 今日と1文字も変えないため
   */
  fuzzy?: boolean
  /**
   * **集めた総数**（絞る前）。0件の文面をどちらにするかがこれで決まる（設計§20-6）。
   *
   * 渡さなければ「見えているものが全部だった」と読む——**`candidates` から数えると、
   * 絞って0件になっただけの状態を「1件も集まらなかった」と取り違える**。実際、
   * 読めなかったぶんが1件でもある機械では、当たらないたびに毎回そちらへ落ちていた。
   */
  collected?: number
  /** 読めずに落ちたぶん。0 なら出さない */
  unreadable: number
  /** 上限で打ち切られたフォルダがあったか */
  truncated: boolean
  /** 打たれている文字（0件のときに何に当たらなかったのかを言うため） */
  text: string
  /** 行が押されたとき */
  onPick: (candidate: SlashCandidate) => void
  /** マウスが行に載ったとき（選択を追随させる） */
  onHover: (index: number) => void
}

export function SlashMenu({
  candidates,
  selected,
  fuzzy = false,
  collected,
  unreadable,
  truncated,
  text,
  onPick,
  onHover,
}: Props) {
  const 見せる = candidates.slice(0, MAX_VISIBLE)
  const 溢れ = candidates.length - 見せる.length
  // **「読めませんでした」を主文にしてよいのは、1件も集まらなかったときだけ。**
  // 絞って0件になっただけの状態と取り違えると、**当たらないたびに毎回
  // 「読めませんでした」が出る**（実際にそうなっていた）
  const 読めなかったを主文にする =
    見せる.length === 0 && (collected ?? candidates.length) === 0 && unreadable > 0

  return (
    <div
      data-testid="slash-menu"
      // **入力欄の上に重ねる。** `bottom-full` で器の外へ出すので、器の高さは動かない
      className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-md border shadow-md"
      // 地は不透明に塗る。**`opacity` は使わない**——裏の文字が透ける（設計§6-2）
      style={{ background: 'var(--color-popover)' }}
    >
      {/*
        **あいまいで当たったときだけ、一言添える**（設計§20-6）。理由は2つ——
        ①`coten` と打って `context` が出てくる理由が分からないと**候補が壊れて見える**
        ②**どれも選ばれていない状態で開くこと**が、押しても確定しない故障ではなく
        意図した状態だと伝わる。**厳密な一致では出さない**（今日と1文字も変えない）
      */}
      {fuzzy && 見せる.length > 0 && (
        <p
          data-testid="slash-menu-fuzzy"
          className="text-muted-foreground border-b px-2 py-1 text-[0.65rem] leading-tight"
        >
          近いものを出しています。選ぶと確定します
        </p>
      )}

      {見せる.length > 0 && (
        <ul role="listbox" aria-label="スラッシュコマンドの候補" className="p-1">
          {見せる.map((candidate, index) => {
            const 選択中 = index === selected
            return (
              <li
                key={`${candidate.source}:${candidate.name}`}
                role="option"
                aria-selected={選択中}
                data-value={candidate.name}
                data-selected={選択中 ? 'true' : undefined}
                // **選ばれている印は「地の色」と「左の線」の両方**（`DESIGN.md` §27.3）。
                // 1px の枠だけで済ませると、暗い画面では差が消える
                // **床は 48px**（`DESIGN.md` §24.3 の Mobile / Touch）。指で押す一覧
                // なので、いちばん厳しい段に合わせる。**説明が無い候補でも縮まない**
                // ように、余白ではなく最小の高さで決める——実測 43px（説明あり）／
                // 36px（説明なし）で、どちらも触れる大きさに届いていなかった
                className={`flex min-h-12 cursor-default flex-col justify-center gap-0.5 rounded-sm py-1.5 pr-2 text-xs select-none ${
                  選択中 ? 'border-l-2 pl-[calc(0.5rem-2px)]' : 'border-l-0 pl-2'
                }`}
                style={
                  選択中
                    ? {
                        // 不透明に混ぜる。**`opacity` を使わない**
                        background:
                          'color-mix(in oklch, var(--color-popover), var(--color-foreground) 10%)',
                        borderLeftColor: 'var(--accent-edge, currentColor)',
                      }
                    : // 選ばれていない行は**地の色そのもの**。塗ると選択の印が効かなくなる
                      { background: 'transparent' }
                }
                onMouseEnter={() => onHover(index)}
                // **`onMouseDown` で拾う。** `onClick` だと、その前に入力欄から
                // 焦点が外れて一覧が閉じ、押したはずの行が消える
                onMouseDown={(event) => {
                  event.preventDefault()
                  onPick(candidate)
                }}
              >
                <span className="flex items-baseline gap-2">
                  {/* 主役は名前（`DESIGN.md` §24.5） */}
                  <span className="font-medium">/{candidate.name}</span>
                  <span className="text-muted-foreground text-[0.65rem]">
                    {SOURCE_LABEL[candidate.source]}
                  </span>
                </span>
                {candidate.description !== '' && (
                  <span className="text-muted-foreground text-[0.65rem] leading-tight">
                    {candidate.description}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/*
        **0件でも黙って消えない**（設計§6-4）。何に当たらなかったのかを言い、
        **そのまま送れる**ことを添える——打ったものが無効だと読まれると、
        打ち直しか諦めになる
      */}
      {見せる.length === 0 && (
        <p
          data-testid="slash-menu-empty"
          className="text-muted-foreground px-2 py-1.5 text-xs"
        >
          {読めなかったを主文にする
            ? `この PC のコマンドを読めませんでした（${unreadable} 件）。そのまま送れます`
            : `${text.split(/\s/, 1)[0]} に当たるものはありません。そのまま送れます`}
        </p>
      )}

      {/*
        **一覧が全部でないことを、隠さない**（設計§5・§6-4）。切ったぶん・読めなかった
        ぶん・打ち切られたぶんは、それぞれ別の理由なので別に言う
      */}
      <div className="text-muted-foreground border-t px-2 py-1 text-[0.65rem] leading-tight">
        {溢れ > 0 && <p data-testid="slash-menu-more">ほか {溢れ} 件あります</p>}
        {truncated && (
          <p data-testid="slash-menu-truncated">
            多すぎるフォルダがあり、途中で打ち切っています
          </p>
        )}
        {/*
          **主文にしていないぶんは、必ず下端へ回す**（設計§20-6）。集まってはいるが
          読めなかったぶんもあり、かつ当たらなかった、という状態が実際にある——
          そこで数を落とすと、**自分のコマンドが出てこない理由が画面から消える**
        */}
        {unreadable > 0 && !読めなかったを主文にする && (
          <p data-testid="slash-menu-unreadable">
            {unreadable} 件は読めませんでした
          </p>
        )}
        {/*
          **常に出す**（要件の完了条件）。ここに出ないものが在ると知らせておかないと、
          「一覧に無い＝打てない」と読まれる
        */}
        <p data-testid="slash-menu-caveat">
          MCP のプロンプトはここに出ません。組み込みの表は版とずれることがあります
        </p>
      </div>
    </div>
  )
}
