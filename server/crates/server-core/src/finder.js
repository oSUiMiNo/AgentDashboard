/*
 * プレビュー（隔離した箱）の中を探すための、いちばん小さな仕掛け。
 *
 * # なぜ中へ入れるのか
 *
 * 箱は `allow-same-origin` を持たないので**別の出自を名乗る**。親の画面からは中の
 * 文書に1バイトも触れない——これは隔離が効いている証拠であって、直すべき不具合では
 * ない。**だから親が中を探すのではなく、中に探す係を置いて指示だけを渡す。**
 *
 * **隔離は1段も緩めていない。** できるようになったのは「親と便りをやり取りする」
 * ことだけで、`postMessage` は隔離された箱にも元から許されている。
 *
 * # 便りは信用しない
 *
 * この文書は**利用者の手元の任意の HTML** なので、中の script も同じ窓から親へ便りを
 * 送れる。**親は数しか読まない**（当たりの数と何番目か）ので、嘘の便りで起こせるのは
 * 「件数の表示が狂う」までである。**親の側で何かを実行させる道は開けていない。**
 *
 * # 大文字小文字を畳むとき、長さを変えない
 *
 * `toLowerCase()` は文字によって長さが変わる（`İ` は2文字）。丸ごと畳むと**位置が
 * ずれて当たりが横へ動く**ので、1文字ずつ畳み、長さが変わる文字は畳まずに残す。
 */
(() => {
  const 全部 = 'file-find-frame'
  const いま = 'file-find-frame-current'

  const 色 = document.createElement('style')
  色.textContent =
    '::highlight(file-find-frame){background-color:rgba(61,217,230,.32)}' +
    '::highlight(file-find-frame-current){background-color:#3dd9e6;color:#101010}'
  ;(document.head ?? document.documentElement).append(色)

  /** 長さを変えずに大文字小文字を畳む。**位置がずれないことが唯一の条件。** */
  const 畳む = (text) => {
    let out = ''
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      const low = ch.toLowerCase()
      out += low.length === 1 ? low : ch
    }
    return out
  }

  const 描ける = () =>
    typeof CSS !== 'undefined' &&
    CSS.highlights !== undefined &&
    typeof Highlight === 'function'

  let 当たり = []

  /** 本文を1本に繋いでから探す。**要素をまたいだ語にも当たる。** */
  const 探す = (語) => {
    当たり = []
    if (!語) {
      return
    }
    /*
      **`<script>` と `<style>` の中は歩かない。**

      継いだ係の本文そのものが `document.body` の中のテキストになる（`</html>` の
      後ろの `<script>` はパーサが body へ移す）ので、**`document` や `const` を
      探すと、画面のどこにも見えない当たりが十数件混ざる**。しかも矩形が 0 なので
      送っても画面が動かず、「N / M」の数だけ進む。
    */
    const 歩き = document.createTreeWalker(
      document.body ?? document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const 親 = node.parentElement
          const 名 = 親 === null ? '' : 親.tagName
          return 名 === 'SCRIPT' || 名 === 'STYLE' || 名 === 'NOSCRIPT'
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT
        },
      },
    )
    const nodes = []
    const starts = []
    let text = ''
    for (let n = 歩き.nextNode(); n !== null; n = 歩き.nextNode()) {
      if (n.data === '') {
        continue
      }
      starts.push(text.length)
      nodes.push(n)
      text += n.data
    }
    const hay = 畳む(text)
    const needle = 畳む(語)
    const 引く = (index, 端) => {
      const 探す位置 = 端 === 'end' ? index - 1 : index
      let lo = 0
      let hi = nodes.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const start = starts[mid]
        const end = start + nodes[mid].data.length
        if (探す位置 < start) {
          hi = mid - 1
        } else if (探す位置 >= end) {
          lo = mid + 1
        } else {
          return { node: nodes[mid], offset: index - starts[mid] }
        }
      }
      return null
    }
    let from = 0
    for (;;) {
      const at = hay.indexOf(needle, from)
      if (at < 0) {
        break
      }
      const s = 引く(at, 'start')
      const e = 引く(at + needle.length, 'end')
      if (s && e) {
        const r = document.createRange()
        r.setStart(s.node, s.offset)
        r.setEnd(e.node, e.offset)
        当たり.push(r)
      }
      from = at + needle.length
    }
  }

  /** 印を塗り、いま見ている当たりまで箱を送る。 */
  const 塗る = (index) => {
    if (!描ける()) {
      return
    }
    const 薄い = new Highlight()
    当たり.forEach((r, i) => {
      if (i !== index) {
        薄い.add(r)
      }
    })
    CSS.highlights.set(全部, 薄い)
    const 濃い = 当たり[index]
    if (濃い === undefined) {
      CSS.highlights.delete(いま)
      return
    }
    CSS.highlights.set(いま, new Highlight(濃い))
    const 矩形 = 濃い.getBoundingClientRect()
    const 高さ = document.documentElement.clientHeight
    if (矩形.top < 0 || 矩形.bottom > 高さ) {
      // **画面の真ん中へ寄せる。** 既に見えているなら動かさない
      scrollBy({ top: 矩形.top - 高さ / 2 + 矩形.height / 2 })
    }
  }

  const 消す = () => {
    当たり = []
    if (描ける()) {
      CSS.highlights.delete(全部)
      CSS.highlights.delete(いま)
    }
  }

  addEventListener('message', (event) => {
    const 便り = event.data
    if (便り === null || typeof 便り !== 'object' || 便り.__fileFind !== 'search') {
      return
    }
    const 語 = typeof 便り.query === 'string' ? 便り.query : ''
    if (語 === '') {
      消す()
      parent.postMessage({ __fileFind: 'result', total: 0, index: 0 }, '*')
      return
    }
    探す(語)
    const 総数 = 当たり.length
    const index = 総数 === 0 ? 0 : ((便り.index | 0) % 総数 + 総数) % 総数
    塗る(index)
    parent.postMessage({ __fileFind: 'result', total: 総数, index }, '*')
  })

  // **用意ができたことを伝える。** 親は最初の便りをここまで待つ
  parent.postMessage({ __fileFind: 'ready' }, '*')
})()
