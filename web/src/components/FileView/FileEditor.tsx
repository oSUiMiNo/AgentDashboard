/**
 * エディタの中身（`ファイルビュアにエディタ機能を追加` 設計§6）。
 *
 * # 3層を重ねる
 *
 * `shiki` は**色付け器であってエディタではない**ので、打つのは `<textarea>` が
 * 受け持ち、その下に色付きの `<pre>` を敷く。行番号はさらに左へ置く。
 *
 * ```
 *   行番号      色付きの <pre>      透明な <textarea>
 *   （見せる）   （見せる）          （打つ。文字は透明）
 * ```
 *
 * # 組版は器へ1回だけ書く
 *
 * 3層の文字が1ピクセルでもずれると、**カーソルが文字の上から外れる**。「同じ指定を
 * 3箇所へ書く」で揃えると**2箇所が直されて1箇所が取り残される余地**が残るので、
 * **器（`file-editor-stack`）へ1回書いて、3層は継承で受け取る**。ずれる余地を
 * 構造から消す。
 *
 * # 打っている間は色を付け直さない
 *
 * `shiki` は TextMate 文法で**同期・CPU 依存**である。打鍵のたびに走らせると、
 * 打っている本人の入力が詰まる。**止まってから**付ける（[`WRITE_DEBOUNCE_MS`]）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TokenNode } from 'react-diff-view'

import { WRITE_DEBOUNCE_MS } from '@/lib/drafts'
import { 字下げする, 字下げを戻す } from '@/lib/fileIndent'
import { tokenizeFile } from '@/lib/highlight'

/**
 * 色付けを諦める大きさ。
 *
 * 整形 Markdown の既定（`FORMAT_DEFAULT_LIMIT`）と同じ 256KiB に揃えてある。
 * **別の数にすると「大きい」の意味が面によって変わる。**
 */
export const PAINT_LIMIT = 256 * 1024

/** 字下げ1つぶんの既定。**中身から推定しない**（設計§6-6）。 */
export const DEFAULT_INDENT = '  '

interface Props {
  value: string
  onChange: (次: string) => void
  /** `Ctrl+S`／`Cmd+S` の行き先。**押せるかは呼ぶ側が決める** */
  onSave: () => void
  /**
   * 保存を押せるか。**ボタンと同じ述語を受け取る**（設計§6-7）——
   * ここで別の条件を書くと「ボタンは押せないのに鍵盤では保存できる」が起こる。
   */
  保存できる: boolean
  /** 色付けの言語を決めるための道 */
  path: string
  /** 読み上げ用の名前 */
  ラベル: string
  /** 字下げ1つぶん */
  インデント?: string
}

/** HAST の `style="a:b;c:d"` を React の形へ。**文字列のままでは React が受け取らない。** */
function 見た目(値: unknown): Record<string, string> | undefined {
  if (typeof 値 !== 'string' || 値 === '') {
    return undefined
  }
  const 出来上がり: Record<string, string> = {}
  for (const 一つ of 値.split(';')) {
    const 区切り = 一つ.indexOf(':')
    if (区切り <= 0) {
      continue
    }
    const 名 = 一つ.slice(0, 区切り).trim()
    const 中身 = 一つ.slice(区切り + 1).trim()
    if (名 === '' || 中身 === '') {
      continue
    }
    // `background-color` → `backgroundColor`
    出来上がり[名.replace(/-([a-z])/g, (_, 文字: string) => 文字.toUpperCase())] = 中身
  }
  return Object.keys(出来上がり).length > 0 ? 出来上がり : undefined
}

/** shiki が返した木を React の要素へ。**`innerHTML` を使わない**（中身は利用者のファイルである）。 */
function 描く(node: TokenNode, 鍵: number): React.ReactNode {
  const 実体 = node as {
    type?: string
    value?: string
    tagName?: string
    properties?: Record<string, unknown>
    children?: TokenNode[]
  }
  if (実体.type === 'text') {
    return 実体.value ?? ''
  }
  if (実体.type !== 'element') {
    return null
  }
  return (
    <span key={鍵} style={見た目(実体.properties?.style)}>
      {(実体.children ?? []).map((子, i) => 描く(子, i))}
    </span>
  )
}

export function FileEditor({
  value,
  onChange,
  onSave,
  保存できる,
  path,
  ラベル,
  インデント = DEFAULT_INDENT,
}: Props) {
  const 打つ層 = useRef<HTMLTextAreaElement>(null)
  const 色の層 = useRef<HTMLPreElement>(null)
  const 番号の層 = useRef<HTMLDivElement>(null)
  const [色, set色] = useState<TokenNode[][] | null>(null)
  /**
   * 次の `Tab` を焦点移動に譲るか（設計§6-6）。
   *
   * **`Tab` を奪ったままにすると、鍵盤だけで画面から出られなくなる。** `Escape` で
   * 1回だけ譲る形は CodeMirror や Monaco が採っている定石である。
   */
  const [逃げる, set逃げる] = useState(false)

  const 重い = value.length > PAINT_LIMIT
  const 行数 = useMemo(() => value.split('\n').length, [value])
  /** 桁が増えても本文が横へずれないよう、**総行数から先に幅を決める**（設計§6-5）。 */
  const 桁 = String(行数).length

  /**
   * 止まってから色を付ける。
   *
   * **戻り値で捨てる**——遅い色付けが終わる前に次の打鍵が来たら、古い結果は要らない。
   */
  useEffect(() => {
    if (重い) {
      set色(null)
      return
    }
    let 生きている = true
    const 待ち = setTimeout(() => {
      void tokenizeFile(value, path).then((出来た) => {
        if (生きている) {
          set色(出来た)
        }
      })
    }, WRITE_DEBOUNCE_MS)
    return () => {
      生きている = false
      clearTimeout(待ち)
    }
  }, [value, path, 重い])

  /** 打つ層の送りを、見せる2層へ写す（設計§6-1 の条件3）。 */
  const 送りを合わせる = useCallback(() => {
    const 打つ = 打つ層.current
    if (!打つ) {
      return
    }
    if (色の層.current) {
      色の層.current.style.transform = `translate(${-打つ.scrollLeft}px, ${-打つ.scrollTop}px)`
    }
    if (番号の層.current) {
      番号の層.current.style.transform = `translateY(${-打つ.scrollTop}px)`
    }
  }, [])

  // 中身が入れ替わったとき（別のファイルを開いた・保存した）も合わせ直す
  useEffect(() => {
    送りを合わせる()
  }, [value, 送りを合わせる])

  const 鍵盤 = useCallback(
    (出来事: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const 打つ = 出来事.currentTarget
      // **`Ctrl+S`／`Cmd+S`。** 止めないとブラウザのページ保存が始まる（設計§6-7）
      if ((出来事.ctrlKey || 出来事.metaKey) && 出来事.key.toLowerCase() === 's') {
        出来事.preventDefault()
        if (保存できる) {
          onSave()
        }
        return
      }
      if (出来事.key === 'Escape') {
        // **止めない。** 探す帯など、外側が `Escape` で閉じる道を塞がない
        set逃げる(true)
        return
      }
      if (出来事.key === 'Tab') {
        if (逃げる) {
          // 1回だけ譲る。**止めないので、ブラウザが次の要素へ移す**
          set逃げる(false)
          return
        }
        出来事.preventDefault()
        const 効かせる = 出来事.shiftKey ? 字下げを戻す : 字下げする
        const 結果 = 効かせる(打つ.value, 打つ.selectionStart, 打つ.selectionEnd, インデント)
        onChange(結果.text)
        // **React が値を書き戻したあとに選択を置く。** 先に置くと、書き戻しで消える
        requestAnimationFrame(() => {
          打つ.setSelectionRange(結果.start, 結果.end)
        })
        return
      }
      if (逃げる) {
        set逃げる(false)
      }
    },
    [逃げる, インデント, onChange, onSave, 保存できる],
  )

  return (
    <div className="file-editor-stack relative h-full w-full overflow-hidden font-mono">
      {/* **行番号。** 選択にもコピーにも付いてこない——付くと、貼ったときに壊れる */}
      <div
        aria-hidden
        className="file-editor-gutter pointer-events-none absolute top-0 left-0 select-none"
        style={{ width: `${桁 + 1}ch` }}
        ref={番号の層}
      >
        {Array.from({ length: 行数 }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      {/* **色付きの層。** 打つ層の真下に重なる */}
      <pre
        aria-hidden
        className="file-editor-paint pointer-events-none absolute top-0"
        style={{ left: `${桁 + 1}ch` }}
        ref={色の層}
      >
        {色 === null
          ? value
          : 色.map((行, i) => (
              <div key={i}>{行.length === 0 ? '\n' : 行.map((token, j) => 描く(token, j))}</div>
            ))}
      </pre>
      <textarea
        data-testid="file-editor"
        className="file-editor absolute top-0 h-full w-full resize-none overflow-auto border-0 bg-transparent outline-none"
        style={{ paddingLeft: `${桁 + 1}ch` }}
        wrap="off"
        spellCheck={false}
        aria-label={ラベル}
        value={value}
        ref={打つ層}
        onScroll={送りを合わせる}
        onKeyDown={鍵盤}
        onChange={(出来事) => {
          onChange(出来事.target.value)
        }}
      />
      {/* **逃げ道は、存在を知られて初めて逃げ道になる**（設計§6-6）。焦点があるときだけ出す */}
      <p
        data-testid="file-editor-hint"
        className="file-editor-hint pointer-events-none absolute right-1 bottom-1 opacity-0"
      >
        Tab で字下げ／Escape のあと Tab で次へ
      </p>
      {重い && (
        <p data-testid="file-paint-heavy" className="absolute top-1 right-1 text-xs text-amber-300">
          大きいので色を付けていません
        </p>
      )}
    </div>
  )
}
