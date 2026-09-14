import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { act, cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GLOBAL_TARGET, sessionTarget } from '@/lib/annotationTarget'
import type { AnnotationTarget, MemoView } from '@/lib/protocol'
import { clearMemos, replaceMemos } from '@/stores/memos'
import { useWsStore } from '@/stores/ws'
import { MemoPane, 下段に出す数 } from './MemoPane'

/*
  **この面は、全体メモとセッションメモの両方が使う同じ部品である**（要件9・利用者の指定）。

  だから**宛先違いを同じ部品へ渡して両方通す**。別々の部品を並べたテストにすると、
  **割れていても緑になる**——それでは要件9 の担保にならない。
*/

function memo(id: string, over: Partial<MemoView> = {}): MemoView {
  return {
    id,
    body: { blocks: [], markdown: id },
    noted_at: 1_700_000_000_000,
    ...over,
  }
}

/** 宛先違いで同じことを通すための一覧。**この配列がテストの芯である。** */
const 宛先たち: [string, AnnotationTarget][] = [
  ['全体', GLOBAL_TARGET],
  ['セッション', sessionTarget('s-1')],
]

/*
  **既定は「送れた」にする。**

  口はどれも**送れたかを返す**（`ws.ts`）。`vi.fn()` の戻り値は `undefined` なので、
  **既定のままだと全部のテストが「送れなかった」経路を通る**——呼ばれたことしか見て
  いない検査は緑のままなので、**成功経路を1度も通らずに通ってしまう**。

  このイシューで**3度目の「材料が揃っていて何も守らない」**である（1度目は時刻、
  2度目は画像の大きさ）。**戻り値を持つ口をモックするときは、戻り値も与える。**
*/
const 送れた = () => vi.fn(() => true)

beforeEach(() => {
  clearMemos()
  useWsStore.setState({
    memoList: 送れた(),
    memoAdd: 送れた(),
    memoEdit: 送れた(),
    memoCheck: 送れた(),
    memoRemove: 送れた(),
  })
})

afterEach(() => {
  cleanup()
  clearMemos()
})

describe.each(宛先たち)('メモの面（%s宛て）', (名, target) => {
  it('開いたら一覧を引く。**宛先を引数で渡している**', () => {
    const memoList = 送れた()
    useWsStore.setState({ memoList })

    render(<MemoPane target={target} label={`${名}のメモ`}
        保存先={null}
      />)

    // **宛先ごとに別の口を叩いていない**こと。口は1つで、宛先は引数
    expect(memoList).toHaveBeenCalledWith(target)
  })

  it('届いた順のまま出す（並べ直さない）', () => {
    /*
      **時刻をわざと逆に積む。**

      同じ時刻の2件で見ていると、手元で並べ直す実装を入れても順が変わらず、
      **この検査は何も守らないまま緑になる**（実際に一度そうなっていた）。
      サーバの順と時刻の順が**食い違う**材料でなければ、並べ直しは捕まらない。
    */
    replaceMemos(target, [
      memo('先', { noted_at: 2_000 }),
      memo('後', { noted_at: 1_000 }),
    ])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    const 出た = screen.getAllByTestId('memo-bubble')
    expect(出た).toHaveLength(2)
    // **サーバの順のまま。** 手元で時刻から並べ直していない
    expect(出た[0]).toHaveTextContent('先')
    expect(出た[1]).toHaveTextContent('後')
  })

  it('チェック済みは上段へ分かれ、既定では畳まれている', () => {
    replaceMemos(target, [
      memo('未', {}),
      memo('済', { checked_at: 1_700_000_001_000 }),
    ])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    // 畳まれているので、上段の中身は出ていない
    expect(screen.queryByTestId('memo-checked')).toBeNull()
    expect(screen.getByTestId('memo-checked-toggle')).toHaveTextContent('1 件')
    // 下段には未チェックだけ
    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('memo-checked-toggle'))
    expect(screen.getByTestId('memo-checked')).toBeInTheDocument()
    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(2)
  })

  it('3つのボタンは onMouseDown で押す（onClick では効かない）', () => {
    const memoCheck = 送れた()
    useWsStore.setState({ memoCheck })
    replaceMemos(target, [memo('あ')])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    const 片付ける = screen.getByTestId('memo-check')

    /*
      **`onClick` で押しても何も起きないことを、先に見る。**

      これが「`onMouseDown` で拾っている」ことの担保である。`onClick` に直すと
      **この行が落ちる**——重ねた面では、押す前に焦点が外れて面が閉じ、
      押したはずのボタンが消えるため（`SlashMenu` の先例）。
    */
    fireEvent.click(片付ける)
    expect(memoCheck).not.toHaveBeenCalled()

    fireEvent.mouseDown(片付ける)
    expect(memoCheck).toHaveBeenCalledWith('あ', true)
  })

  it('チェック済みを押すと、外す側で送る', () => {
    const memoCheck = 送れた()
    useWsStore.setState({ memoCheck })
    replaceMemos(target, [memo('済', { checked_at: 1_700_000_001_000 })])
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    fireEvent.click(screen.getByTestId('memo-checked-toggle'))
    fireEvent.mouseDown(screen.getByTestId('memo-check'))
    expect(memoCheck).toHaveBeenCalledWith('済', false)
  })

  it('溜まったら畳み、押すと伸びる', () => {
    const 多い = Array.from({ length: 下段に出す数 + 3 }, (_, i) => memo(`m${i}`))
    replaceMemos(target, 多い)
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(下段に出す数)
    expect(screen.getByTestId('memo-more')).toHaveTextContent('ほか 3 件')

    fireEvent.click(screen.getByTestId('memo-more'))
    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(下段に出す数 + 3)
  })

  it('畳むときに残すのは新しいほう（末尾）である', () => {
    const 多い = Array.from({ length: 下段に出す数 + 1 }, (_, i) =>
      memo(`m${i}`, { noted_at: 1_000 + i }),
    )
    replaceMemos(target, 多い)
    render(<MemoPane target={target} label={名}
        保存先={null}
      />)

    // **いちばん下が最新**なので、隠すのは先頭側
    expect(screen.queryByText('m0')).toBeNull()
    expect(screen.getByText(`m${下段に出す数}`)).toBeInTheDocument()
  })
  /*
    **送れなかったときに、黙って戻らない**（レビュー対応1）。

    `Composer` は「送れたときだけ消す。送れていない文が消えるのが、いちばん困る形」
    という約束を持っており、`send` の doc も同じことを名指しで禁じている。**メモの面
    だけがこれを破っていた**——口の型が `void` で、**呼ぶ側が確かめる道が塞がれていた**
    ためである。

    **型を `boolean` へ変えたので、確かめずに進む道はもう無い。** ここで守るのは
    「**確かめた結果をどう出すか**」——**面の中に断りを出す**ことである。

    **宛先で出し分けない。** セッションメモだけ `card-error` に乗せる形も採れるが、
    それをすると**面の中が宛先を見る**ことになり、この部品の約束（要件9）が崩れる。
  */
  it('片付けが送れなかったら、面の中で断る（黙って戻らない）', () => {
    const memoCheck = vi.fn(() => false)
    useWsStore.setState({ memoCheck })
    replaceMemos(target, [memo('あ')])
    render(<MemoPane target={target} label={名} 保存先={null} />)

    expect(screen.queryByTestId('memo-row-send-failed')).toBeNull()
    fireEvent.mouseDown(screen.getByTestId('memo-check'))

    expect(memoCheck).toHaveBeenCalledWith('あ', true)
    expect(screen.getByTestId('memo-row-send-failed')).toHaveTextContent('送れていません')
  })

  it('消すのが送れなかったら、面の中で断る', () => {
    const memoRemove = vi.fn(() => false)
    useWsStore.setState({ memoRemove })
    replaceMemos(target, [memo('あ')])
    render(<MemoPane target={target} label={名} 保存先={null} />)

    fireEvent.mouseDown(screen.getByTestId('memo-edit'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove-confirm'))

    expect(memoRemove).toHaveBeenCalledWith('あ')
    expect(screen.getByTestId('memo-row-send-failed')).toHaveTextContent('送れていません')
  })

  it('送れたときは断らない（成功の経路も通す）', () => {
    const memoCheck = 送れた()
    useWsStore.setState({ memoCheck })
    replaceMemos(target, [memo('あ')])
    render(<MemoPane target={target} label={名} 保存先={null} />)

    fireEvent.mouseDown(screen.getByTestId('memo-check'))

    expect(screen.queryByTestId('memo-row-send-failed')).toBeNull()
  })
})

/*
  **抜け殻・終了したカード**（設計§6-9）。読めるが書けない。
*/
describe('抜け殻のカード', () => {
  it('入力欄が出ず、直す・片付けるも出ない', () => {
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} readOnly label="終わったセッションのメモ"
        保存先={null}
      />)

    expect(screen.queryByTestId('memo-compose')).toBeNull()
    expect(screen.getByTestId('memo-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('memo-edit')).toBeNull()
    expect(screen.queryByTestId('memo-check')).toBeNull()
  })

  it('コピーはできる（読むためだけに開く面なので、持ち出す道は残す）', () => {
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} readOnly label="終わったセッションのメモ"
        保存先={null}
      />)

    expect(screen.getByTestId('memo-copy')).toBeInTheDocument()
  })

  it('読めることは必須である（目的1）', () => {
    replaceMemos(GLOBAL_TARGET, [memo('復旧のときに読む')])
    render(<MemoPane target={GLOBAL_TARGET} readOnly label="終わったセッションのメモ"
        保存先={null}
      />)

    expect(screen.getByText('復旧のときに読む')).toBeInTheDocument()
  })
})

/*
  **コピーの逃げ道**（設計§6-7）。

  要件の確かめ方が「**安全なオリジンでない環境でも、値を取れる形になっている**こと」を
  求めている。`copyToClipboard` が偽を返したとき、**値を選ばせる形が出る**かを見る。
*/
describe('コピー', () => {
  it('写せなかったら、値を選ばせる形が出る', async () => {
    // `navigator.clipboard` がそもそも無く、古い方法も失敗する環境を作る
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const execCommand = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    replaceMemos(GLOBAL_TARGET, [memo('取り出したい字')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.mouseDown(screen.getByTestId('memo-copy'))

    const 逃げ道 = await screen.findByTestId('memo-copy-fallback')
    expect(逃げ道).toHaveTextContent('取り出したい字')

    vi.unstubAllGlobals()
  })

  it('写せたら、逃げ道は出ない', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.mouseDown(screen.getByTestId('memo-copy'))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.queryByTestId('memo-copy-fallback')).toBeNull()

    vi.unstubAllGlobals()
  })
})

/*
  **消す道は編集の中にある**（設計§7-8）。

  吹き出しのボタンは3つのまま（要件3 が数を決めている）で、消すのは鉛筆を開いた先。
  **確認を1回挟む。**
*/
describe('消す道', () => {
  it('吹き出しのボタンは3つのまま（消すは並ばない）', () => {
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    const 並び = screen.getByTestId('memo-ops')
    expect(並び.querySelectorAll('button')).toHaveLength(3)
    expect(screen.queryByTestId('memo-remove')).toBeNull()
  })

  it('確認を1回挟んでから消す', () => {
    const memoRemove = 送れた()
    useWsStore.setState({ memoRemove })
    replaceMemos(GLOBAL_TARGET, [memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.mouseDown(screen.getByTestId('memo-edit'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove'))
    // **1回押しただけでは消えない**
    expect(memoRemove).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByTestId('memo-remove-confirm'))
    expect(memoRemove).toHaveBeenCalledWith('あ')
  })
})

/*
  **書いて送る道**（要件1・要件4）。

  面の中でいちばん使われる動きなので、**確定が口まで届くこと**をここで固定する。
  Ctrl+Enter は入力欄・ターミナルと同じ述語（`isComposerSubmit`）を通っている。
*/
describe('書いて送る', () => {
  it('空のまま Ctrl+Enter を押しても送らない', () => {
    const memoAdd = 送れた()
    useWsStore.setState({ memoAdd })
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.keyDown(screen.getByTestId('memo-compose'), {
      key: 'Enter',
      ctrlKey: true,
    })
    // **空を積まない。** 押し間違いで空の吹き出しが増えない
    expect(memoAdd).not.toHaveBeenCalled()
  })

  it('Ctrl を伴わない Enter では送らない（ブロックを割る側）', () => {
    const memoAdd = 送れた()
    useWsStore.setState({ memoAdd })
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.keyDown(screen.getByTestId('memo-compose'), { key: 'Enter' })
    expect(memoAdd).not.toHaveBeenCalled()
  })

  it('変換中の Ctrl+Enter では送らない（IME の確定と取り違えない）', () => {
    const memoAdd = 送れた()
    useWsStore.setState({ memoAdd })
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ"
        保存先={null}
      />)

    fireEvent.keyDown(screen.getByTestId('memo-compose'), {
      key: 'Enter',
      ctrlKey: true,
      isComposing: true,
    })
    expect(memoAdd).not.toHaveBeenCalled()
  })

})

/*
  **確定すると表示が崩れる**（利用者の報告・2026-09-13、`v0.1.138`）。
  原因は3つとも別で、経緯は `調査レポート/メモの確定後に表示が崩れる.md` に在る。

  **どれも「本文が出ること」を見る検査では捕まらなかった。** 要素は出ていて、
  スタイルだけが当たっていなかったためである。
*/
describe('吹き出しの見た目', () => {
  function 描く(markdown: string): HTMLElement {
    replaceMemos(GLOBAL_TARGET, [memo('m-1', { body: { blocks: [], markdown } })])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    return screen.getByTestId('memo-body')
  }

  it('本文は、履歴やファイルビュアと同じ共用クラスで描く', () => {
    /*
      **`prose-sm` と書いてあったが、あれはどこにも無いクラスだった**——Tailwind
      Typography はこの PJT に入っていない。**要素は出ているのにスタイルが1つも
      当たらず**、表もコードブロックも平文に見えていた。

      **`toContain` で見ない。** クラス名の部分一致は、別のクラスを含んだだけで
      通ってしまう。**語として持っているか**を見る。
    */
    const 本文 = 描く('あ')
    expect(本文.classList.contains('prose-dashboard')).toBe(true)
    expect(本文.classList.contains('prose-sm')).toBe(false)
  })

  it('Tailwind Typography は入っていない（`prose-*` を当てにできない）', () => {
    /*
      **この前提が崩れたら、上の検査の理由も変わる。** 依存が入った日に気づけるよう、
      前提そのものを数える。
    */
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const 全部 = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(Object.keys(全部).some((name) => name.includes('typography'))).toBe(false)
  })

  it('GFM の表が、表として出る', () => {
    // **実機の記録から採った**（`memos`・`noted_at=1789306252939` と同じ形）
    const 本文 = 描く('| A | B |\n| --- | --- |\n| 1 | 2 |\n')
    expect(本文.querySelector('table'), '表が出ていない').not.toBeNull()
    expect(本文.querySelectorAll('td')).toHaveLength(2)
  })

  it('囲みコードが、コードとして出る', () => {
    const 本文 = 描く('```text\nMyDocs/イシュー/\n```\n')
    const pre = 本文.querySelector('pre')
    expect(pre, 'コードブロックが出ていない').not.toBeNull()
    expect(pre!.querySelector('code')).not.toBeNull()
  })

  it('ブロックの最終行に取り残された `\\` を出さない', () => {
    /*
      **BlockNote は段落内の改行を、行末のバックスラッシュ（hard break）で書き出す。**
      ところが remark は `- ` で始まる行をリストの開始と読んで**段落を終わらせる**ので、
      それまで hard break だった `\` が**ブロックの最終行**へ移る。

      **CommonMark では、ブロックの最終行の `\` は hard break にならない**——
      改行する相手が無いためで、**リテラルの文字として画面に出る。**

      **材料は実機の記録そのもの**（`memos`・`noted_at=1789308676419`）。作り物の
      1行では割れが起きず、**この検査は何も守らないまま緑になる。**
    */
    const 本文 = 描く(
      'LAN内アドレスのボタンが応答なしになる\\\nのセッションへ\\\n \\\n' +
        '- 調査レポートを念のため再調査させてブラッシュアップ\\\n- 実装を命じる\n',
    )
    expect(本文.textContent).not.toContain('\\')
    // **消しすぎていないこと。** `\` ごと行が落ちていたら、これで捕まる
    expect(本文.textContent).toContain('のセッションへ')
    expect(本文.textContent).toContain('実装を命じる')
  })

  it('囲みコードの中の行継続（`\\`）は残す', () => {
    /*
      **文字列の置換で消すと、ここが壊れる。** シェルの行継続を書き留めたメモは
      この道具の用途そのものなので、**壊してはいけない側**である。

      mdast の段で `paragraph` と `heading` だけを見ているので、囲みコードは
      **別のノード**として無傷で残る。
    */
    const 本文 = 描く('```bash\ntar -cf a.tar \\\n```\n')
    expect(本文.querySelector('code')?.textContent).toContain('\\')
  })

  it('操作の群を、本文の上へ重ねない', () => {
    /*
      **絶対配置で本文へ重ねていたので、1行目が長いと必ず潜った。**
      狭い画面だけの話ではない——1行目がボタン列の幅まで届けば、幅がいくつでも起きる。

      **「重なりにくい」ではなく「重ねられない」ことを見る。** 余白や幅で避ける形だと、
      中身しだいで再発するし、jsdom では 測れない。**普通の並びに居ること**を見れば、
      幅にも中身にも依らない。
    */
    描く('あ')
    const 群 = screen.getByTestId('memo-ops')
    const 本文 = screen.getByTestId('memo-body')

    expect(群.classList.contains('absolute'), '絶対配置に戻っている').toBe(false)
    expect(本文.contains(群), '本文の中に居る').toBe(false)
    // **時刻と同じ行に居る。** 時刻は短いので、右側は元から空いている
    expect(群.parentElement?.querySelector('time'), '時刻と同じ行に居ない').not.toBeNull()
  })
})

/*
  **実機で触った利用者から出た、見た目の直し**（2026-09-14）。

  | 言われたこと | どこで見張るか |
  |---|---|
  | カードの背景と面の背景が近すぎて見にくい | 地の色（下） |
  | カード同士の隙間を3倍に | 隙間（下） |
  | 面が小さすぎる。横1.4倍・縦2倍、ただし窓が小さければ収縮 | 置き場所（`置き場所の作法`） |
  | 画像の幅が確定後に失われる | 画像の幅（下）と `lib/memoBody.test.ts` |
  | 表の空白カラムだけ細い | `置き場所の作法`（CSS） |
  | 入力欄が一番下まで繰らないと出ない | 縮む側（下）と `置き場所の作法` |

  **どれも「直した値」ではなく「直した理由が生きているか」を見る。** 例えば隙間は
  `gap-3` という綴りではなく、**上段と下段が同じであること**まで見る——片方だけ
  戻ると、畳みを開いた瞬間に詰まって見える。
*/
describe('面の見た目（利用者の報告・2026-09-14）', () => {
  function 面を描く(): void {
    replaceMemos(GLOBAL_TARGET, [
      memo('m-1'),
      memo('m-2', { checked_at: 1_700_000_001_000 }),
    ])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
  }

  it('吹き出しの地は、面の地と混ぜない', () => {
    /*
      **`bg-muted/40` は薄すぎた。** 面は `bg-popover`（`oklch(0.205)`）、
      `--muted` は `oklch(0.269)` なので、40% で混ぜた実効は `oklch(0.231)`
      ——**差は 0.026** しかなく、利用者から「近すぎて見にくい」と言われた。

      **語として見る。** `bg-muted/40` は「`bg-muted/40`」という1語のクラスなので、
      部分一致で見ると透かした版も通ってしまう。
    */
    面を描く()
    const 吹き出し = screen.getAllByTestId('memo-bubble')[0]
    expect(吹き出し.classList.contains('bg-muted'), '不透明の地になっていない').toBe(true)
    expect(吹き出し.classList.contains('bg-muted/40'), '透かした地に戻っている').toBe(false)
    // **縁で1枚として切り出す。** 地の差だけでは、隣り合ったカードの境が読めない
    expect(吹き出し.classList.contains('border'), '縁が無い').toBe(true)
  })

  it('カード同士の隙間は、上段と下段で揃える', () => {
    /*
      **利用者の指定は「3倍」**（`gap-1` = 0.25rem → `gap-3` = 0.75rem）。

      **上段（片付けたもの）も同じカードである。** 片方だけ変えると、畳みを開いた
      瞬間に詰まって見える——**同じものが場所によって違う隙間で並ぶ**。
    */
    面を描く()
    fireEvent.click(screen.getByTestId('memo-checked-toggle'))
    const 下段 = screen.getByTestId('memo-list')
    const 上段 = screen.getByTestId('memo-checked')
    expect(下段.classList.contains('gap-3'), '下段が3倍になっていない').toBe(true)
    expect(上段.classList.contains('gap-3'), '上段が下段と揃っていない').toBe(true)
    expect(下段.classList.contains('gap-1'), '下段が元の隙間に戻っている').toBe(false)
    expect(上段.classList.contains('gap-1'), '上段が元の隙間に戻っている').toBe(false)
  })

  it('面は、置き場所の高さに合わせて縮む側になる', () => {
    /*
      **入力欄が常に見えるための土台**（利用者の報告「メッセージ入力欄が、一番下まで
      スクロールしないと表示されない」）。

      面が縮まなければ、溢れたぶんは**外側**がスクロールする——入力欄はこの面の
      いちばん下にあるので、下まで繰らないと現れない。**`flex-1` と `min-h-0` は対**で、
      片方だけでは縮まない。
    */
    面を描く()
    const 面 = screen.getByTestId('memo-pane')
    expect(面.classList.contains('flex-1'), '伸びる側のままになっている').toBe(true)
    expect(面.classList.contains('min-h-0'), '中身の高さで押し広げられる').toBe(true)
    // **繰るのは一覧だけ。** ここが外れると、入力欄がまた押し出される
    const 下段 = screen.getByTestId('memo-list')
    expect(下段.classList.contains('overflow-y-auto'), '一覧が繰れない').toBe(true)
    expect(下段.classList.contains('flex-1'), '一覧が縮まない').toBe(true)
  })

  it('入力欄は、一覧の外に居る（一緒に繰られない）', () => {
    /*
      **一覧の中に入力欄が居ると、一覧を繰るたびに一緒に流れる。**
      メッセンジャーの入力欄は動かない場所に在るので、**一覧の兄弟**でなければならない。
    */
    面を描く()
    const 下段 = screen.getByTestId('memo-list')
    const 入力欄 = screen.getByTestId('memo-compose')
    expect(下段.contains(入力欄), '入力欄が一覧の中に居る').toBe(false)
  })

  it('確定した画像に、編集で決めた幅が効く', () => {
    /*
      **Markdown には幅の置き場が無い**ので、隣に置いてある `blocks` から引く
      （`lib/memoBody.ts` の `画像の幅`）。引けないと元の大きさで描かれ、
      スクリーンショットは面より大きいので**必ず横幅いっぱいに見える。**
    */
    const url = '/api/memo-blobs/48b5d4c5'
    replaceMemos(GLOBAL_TARGET, [
      memo('m-1', {
        body: {
          blocks: [{ type: 'image', props: { url, previewWidth: 197 } }],
          markdown: `![image.png](${url})`,
        },
      }),
    ])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)

    const 画像 = screen.getByTestId('memo-body').querySelector('img')
    expect(画像, '画像が出ていない').not.toBeNull()
    expect(画像?.style.width, '編集で決めた幅が効いていない').toBe('197px')
  })

  it('幅を変えていない画像には、幅を与えない', () => {
    /*
      **いままで正しく出ていたものを動かさない。** `previewWidth` が無いのは
      「幅を変えていない」という意味で（実測）、そのときは元の大きさが正しい。
    */
    const url = '/api/memo-blobs/f082e1e2'
    replaceMemos(GLOBAL_TARGET, [
      memo('m-1', {
        body: { blocks: [{ type: 'image', props: { url } }], markdown: `![image.png](${url})` },
      }),
    ])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)

    expect(screen.getByTestId('memo-body').querySelector('img')?.style.width).toBe('')
  })
})

/*
  **面の大きさと、外側のスクロールは、面の外で決まっている。**

  `MemoPane` を置いている場所は3つあり（全体メモ・セッションの区画・一覧の吹き出し）、
  **大きさも、繰る／繰らないも、そちらの `className` が持っている。** jsdom では
  そこまで組み立てないので、**置き場所のソースを読んで数える。**

  **3箇所を配列で回す。** 1箇所だけ直し忘れると、同じ面が開く場所によって違う
  振る舞いをする——利用者から見ると「直っているときと直っていないときがある」に
  なり、いちばん追いにくい形の壊れ方になる。
*/
describe('置き場所の作法（利用者の報告・2026-09-14）', () => {
  /** `<MemoPane` の直前にある `className` を抜く。**置き場所そのものの綴り。** */
  function 置き場所の綴り(パス: string): string {
    const src = readFileSync(resolve(process.cwd(), パス), 'utf8')
    const i = src.indexOf('<MemoPane')
    expect(i, `${パス} に MemoPane が居ない`).toBeGreaterThan(0)
    const 直前 = [...src.slice(0, i).matchAll(/className="([^"]*)"/g)].pop()
    expect(直前, `${パス} の置き場所に className が無い`).toBeDefined()
    return 直前?.[1] ?? ''
  }

  const 置き場所たち: [string, string][] = [
    ['全体メモ', 'src/App.tsx'],
    ['セッションの区画', 'src/components/SessionView/SessionView.tsx'],
    ['一覧の吹き出し', 'src/components/SessionTile/SessionTile.tsx'],
  ]

  it.each(置き場所たち)('%s：外側では繰らない', (_名, パス) => {
    /*
      **ここが外れると、入力欄が一番下まで繰らないと出てこない**（利用者の報告）。
      `PopoverContent` は既定で `overflow-y-auto` を持っているので、**黙っていると
      外側がスクロール容器になる。**

      **`overflow-hidden` では足りない。** あれは `overflow`、既定は `overflow-y` で
      別の綴りなので、`tailwind-merge` が競合と見なさず**両方残って既定が後勝ちする。**
      同じ `overflow-y` で打ち消す。
    */
    expect(置き場所の綴り(パス)).toContain('overflow-y-hidden')
  })

  it.each(置き場所たち)('%s：高さに上限を持つ', (_名, パス) => {
    // 上限が無ければ中身の数だけ縦に伸び、入力欄が画面の下へ出ていく
    expect(置き場所の綴り(パス)).toContain('max-h-[')
  })

  it.each(置き場所たち)('%s：窓が小さければ縮む', (_名, パス) => {
    /*
      **利用者の指定**——「ダッシュボードのウィンドウそのものが小さい場合は臨機応変に
      収縮するように」。決め打ちの高さだけを書くと、低い窓では面が画面からはみ出す。
      `min()` で、決めた大きさと**実際に空いている分**の小さいほうを採る。
    */
    expect(置き場所の綴り(パス)).toMatch(/max-h-\[min\(/)
  })

  it.each(置き場所たち)('%s：面が縮む側になれる（親が flex）', (_名, パス) => {
    // `MemoPane` の `flex-1` は、**親が flex のときだけ**効く
    expect(置き場所の綴り(パス)).toContain('flex')
  })

  it('Popover の面は、横も 1.4 倍で、窓に合わせて縮む', () => {
    /*
      **利用者の指定は「横幅を1.4倍」**。元は全体メモ `w-96`（24rem）、一覧の吹き出し
      `w-80`（20rem）だったので、それぞれ 33.6rem・28rem になる。

      **セッションの区画は横を広げない。** あそこは端末や履歴と横幅を分け合っており、
      **面だけ広げると隣が潰れる**——Popover のように浮いていないので、逃げ場が無い。
    */
    expect(置き場所の綴り('src/App.tsx')).toContain('w-[min(33.6rem,90vw)]')
    expect(置き場所の綴り('src/components/SessionTile/SessionTile.tsx')).toContain(
      'w-[min(28rem,90vw)]',
    )
  })

  it('表は、空の列も同じ幅を受け取る', () => {
    /*
      **利用者の報告**——「表が表として見えるようにはなったが、空白カラムだけ小さく
      表示されるのは気持ち悪い」。共用の `.prose-dashboard table` は `display: block`
      なので**列幅が中身の量だけで決まり**、空のセルは余白ぶんまで縮む。

      **共用クラスへ直接書かない。** あれは履歴とファイルビュアも使っている
      （`index.css` の注意書き）ので、**メモの吹き出しの中だけ**に効かせる。
    */
    const css = readFileSync(resolve(process.cwd(), 'src/memo.css'), 'utf8')
    const 規則 = css.match(/\.memo-bubble\s+\.prose-dashboard\s+table\s*\{([^}]*)\}/)
    expect(規則, 'メモの吹き出しに限った表の規則が無い').not.toBeNull()
    const 中身 = 規則?.[1] ?? ''
    // 等分して固定する。**中身では動かさない**のが `fixed` の意味
    expect(中身).toMatch(/table-layout:\s*fixed/)
    expect(中身).toMatch(/width:\s*100%/)
    // `display: block` のままでは `table-layout` も `width` も効かない
    expect(中身).toMatch(/display:\s*table/)
  })

  it('表は、空のセルも1行ぶんの高さを保つ', () => {
    /*
      **列を等分しただけでは、同じ気持ち悪さが行に残る。** 空の行は中身の高さが
      ゼロなので、余白ぶんの細い帯になる（実測：中身のある行 29.4px に対し 9.4px）。

      **ここで確かめられるのは「その字が書いてあること」だけである。** 効いたかは
      実ブラウザでしか測れないので、**本物の見張りは `e2e/memo.spec.ts` に在る**
      ——現に、列の規則はこの形の検査を通ったまま、行が揃わない状態で配られた。
    */
    /*
      **注釈を先に落とす。** 規則の中に置いた説明文には、その規則の字がそのまま
      引用されている——**落とさずに照合すると、宣言ではなく説明文に当たって、
      宣言を消しても素通りする**（実際に踏んだ）。
    */
    const css = readFileSync(resolve(process.cwd(), 'src/memo.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    const 規則 = css.match(
      /\.memo-bubble\s+\.prose-dashboard\s+th,\s*\.memo-bubble\s+\.prose-dashboard\s+td\s*\{([^}]*)\}/,
    )
    expect(規則, 'メモの吹き出しに限ったセルの規則が無い').not.toBeNull()
    const 中身 = 規則?.[1] ?? ''
    // セルの `height` は上限ではなく最小値なので、中身が増えれば伸びる
    expect(中身).toMatch(/height:\s*1lh/)
    // 全体が border-box なので、戻さないと余白が高さに食い込んで揃わない
    expect(中身).toMatch(/box-sizing:\s*content-box/)
    // 等分した列は横へ逃げられない（繰る道を捨てた）ので、長い語はどこででも折る
    expect(中身).toMatch(/overflow-wrap:\s*anywhere/)
  })
})

/*
  **直している最中に、外から変えられたとき**（メモ設計§7-7）。

  # ここで守るのは「消えないこと」と「黙らないこと」

  **実測（0.1.143）では、3通りのうち2通りで書きかけが消えていた**——外でかたづけられた
  ときと消されたときは、**吹き出しごと一覧から外れて編集欄が建て直された**。本文が
  書き換わったときは書きかけこそ残るが、**知らせが1つも出なかった**ので、利用者は
  自分が何を踏み潰すのか知らないまま確定できた。

  **jsdom は CSS を1バイトも当てない**ので、ここで確かめるのは**組み立て**だけ
  ——編集欄が建ったままか、断りが出ているか、道が2つあるか。**書きかけの字そのものが
  残るか**はブロックエディタへ打ち込まないと分からないので、`e2e/memo.spec.ts` が見る。
*/
describe('直している最中に外から変えられたとき', () => {
  /**
   * サーバからの配信。**`act` で包む。**
   *
   * 包まないと `useSyncExternalStore` の更新が当たらず、**配ったつもりで何も起きない**
   * ——「編集欄が建ったまま」の類はそれでも緑になるので、**検査が空になる。**
   * 実際に一度そうなっていた（包む前は3件とも配信が届かないまま通っていた）。
   */
  function 配る(memos: MemoView[]) {
    act(() => replaceMemos(GLOBAL_TARGET, memos))
  }

  /** 直しに入る。**編集欄が建ったことまで確かめる**（建っていなければ以後は無意味） */
  function 直しに入る() {
    fireEvent.mouseDown(screen.getByTestId('memo-edit'))
    expect(screen.getByTestId('memo-editing')).toBeInTheDocument()
  }

  it('外で本文が書き換わっても、編集欄は建ったまま', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()

    配る([memo('あ', { body: { blocks: [], markdown: '外で直した' } })])

    expect(screen.getByTestId('memo-editing')).toBeInTheDocument()
  })

  it('外でかたづけられても、編集欄は建ったまま（＝書きかけを捨てない）', () => {
    /*
      **ここが実測で消えていた側。** かたづけると吹き出しは上段へ移り、上段は既定で
      畳まれているので**面から丸ごと外れる**——建て直しどころか描かれなくなる。
    */
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()

    配る([memo('あ', { checked_at: 1_700_000_001_000 })])

    expect(screen.getByTestId('memo-editing')).toBeInTheDocument()
    // **留める先は直し始めた段。** 押してもいない利用者の目の前で段をまたがせない
    expect(screen.getByTestId('memo-list')).toContainElement(screen.getByTestId('memo-editing'))
  })

  it('外で消されても、編集欄は建ったまま（＝書きかけを捨てない）', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()

    配る([])

    expect(screen.getByTestId('memo-editing')).toBeInTheDocument()
  })

  it('留めた1件を、上段と下段で二重に描かない', () => {
    /*
      **上段に別の1件を置いておく。** 直しているぶんだけを上段に入れると、留めた
      結果いなくなって畳みのボタンごと消え、**開いて確かめる道が無くなる。**
    */
    配る([memo('あ'), memo('い', { checked_at: 1_700_000_001_000 })])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()

    配る([
      memo('あ', { checked_at: 1_700_000_002_000 }),
      memo('い', { checked_at: 1_700_000_001_000 }),
    ])
    // 上段を開いても、留めたぶんがもう1つ出てはいけない
    fireEvent.click(screen.getByTestId('memo-checked-toggle'))

    expect(screen.getAllByTestId('memo-editing')).toHaveLength(1)
    // 直していない「い」だけが吹き出しとして残る（「あ」は編集欄になっている）
    expect(screen.getAllByTestId('memo-bubble')).toHaveLength(1)
  })

  it('上段で直していたものは、外で戻されても上段に留まる', () => {
    配る([memo('あ', { checked_at: 1_700_000_001_000 })])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    fireEvent.click(screen.getByTestId('memo-checked-toggle'))
    直しに入る()

    配る([memo('あ')])

    expect(screen.getByTestId('memo-checked')).toContainElement(screen.getByTestId('memo-editing'))
  })

  it('黙って入れ替えない——何が起きたかを断りに出す', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    // 直しに入った時点では何も言わない（言うと、開くたびに断りが出る）
    expect(screen.queryByTestId('memo-outside-change')).toBeNull()

    配る([memo('あ', { body: { blocks: [], markdown: '外で直した' } })])

    const 断り = screen.getByTestId('memo-outside-change')
    expect(断り).toHaveTextContent('別の画面で書き換えられました')
    // **書きかけが無事であることまで言う。** 言わないと、押す道を選べない
    expect(断り).toHaveTextContent('書きかけはそのまま残してあります')
  })

  it('消す道が2つある（§47.5）', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    配る([memo('あ', { body: { blocks: [], markdown: '外で直した' } })])

    expect(screen.getByTestId('memo-outside-take')).toBeInTheDocument()
    expect(screen.getByTestId('memo-outside-keep')).toBeInTheDocument()
  })

  it('「外の内容を取る」を押すと、直すのをやめて外の内容が出る', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    配る([memo('あ', { body: { blocks: [], markdown: '外で直した' } })])

    fireEvent.mouseDown(screen.getByTestId('memo-outside-take'))

    expect(screen.queryByTestId('memo-editing')).toBeNull()
    expect(screen.getByTestId('memo-body')).toHaveTextContent('外で直した')
  })

  it('「書きかけを残す」を押すと、断りだけが消えて編集欄は建ったまま', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    配る([memo('あ', { body: { blocks: [], markdown: '外で直した' } })])

    fireEvent.mouseDown(screen.getByTestId('memo-outside-keep'))

    expect(screen.queryByTestId('memo-outside-change')).toBeNull()
    expect(screen.getByTestId('memo-editing')).toBeInTheDocument()
  })

  it('見送ったあとに、もう一度外から変えられたら、また断る', () => {
    /*
      **「もう見た」を旗1つで持つと、ここが黙る**——黙って踏み潰す形へ戻る。
      印で持っている理由がこれである。
    */
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    配る([memo('あ', { body: { blocks: [], markdown: '一度目' } })])
    fireEvent.mouseDown(screen.getByTestId('memo-outside-keep'))
    expect(screen.queryByTestId('memo-outside-change')).toBeNull()

    配る([memo('あ', { body: { blocks: [], markdown: '二度目' } })])

    expect(screen.getByTestId('memo-outside-change')).toBeInTheDocument()
  })

  it('一度見送った状態へ外が戻ってきても、開き直したあとなら断る', () => {
    /*
      **見送りは「開いているその1回」のもの。** 持ち越すと、**前に見送ったのと同じ
      中身へ外が戻ったとき**に印が一致して黙る——直し始めた中身とは違うのに、
      書きかけが黙って踏み潰せる状態になる。

      筋：B を見送る → やめる → 外が C になる → C から直し始める → 外が B へ戻る。
      **B は「一度見送った印」なので、持ち越していると黙る。**
    */
    const 本文 = (字: string) => ({ body: { blocks: [], markdown: 字 } })
    配る([memo('あ', 本文('A'))])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    配る([memo('あ', 本文('B'))])
    fireEvent.mouseDown(screen.getByTestId('memo-outside-keep'))
    fireEvent.mouseDown(screen.getByTestId('memo-edit-cancel'))

    配る([memo('あ', 本文('C'))])
    直しに入る()
    配る([memo('あ', 本文('B'))])

    expect(screen.getByTestId('memo-outside-change')).toBeInTheDocument()
  })

  it('消されたときは「外の内容を取る」と言わない（取る中身が無い）', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()

    配る([])

    expect(screen.getByTestId('memo-outside-change')).toHaveTextContent('別の画面で消されました')
    expect(screen.getByTestId('memo-outside-take')).not.toHaveTextContent('外の内容')
  })

  it('外で消されたあと「受け入れる」を押すと、面から消える', () => {
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    配る([])

    fireEvent.mouseDown(screen.getByTestId('memo-outside-take'))

    expect(screen.queryByTestId('memo-editing')).toBeNull()
    expect(screen.queryByTestId('memo-bubble')).toBeNull()
  })

  it('自分が確定したぶんでは断らない（自分の操作が外から来たように見えない）', () => {
    /*
      **自分の確定も全タブへ配られて返ってくる。** 返りで断りが出ると、**直すたびに
      毎回断りが出る**ことになり、本当の衝突と見分けられなくなる。
    */
    配る([memo('あ')])
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)
    直しに入る()
    fireEvent.mouseDown(screen.getByTestId('memo-edit-cancel'))
    // 確定して閉じたあとに、そのぶんが配られて戻ってくる
    配る([memo('あ', { body: { blocks: [], markdown: '自分で直した' } })])

    expect(screen.queryByTestId('memo-outside-change')).toBeNull()
  })
})

/*
  **自分の操作を「外から来た」と言わない。**

  直している1件を面が留めるようにした（§7-7）副作用で、**自分で消しても編集欄が
  居残る**ようになった——留める前は、消えた行ごと編集欄が外れていたので閉じる必要が
  無かった。居残ると、自分が押した「消す」を**「別の画面で消されました」と言い出す。**
  E2E で踏んで足した。
*/
describe('自分でした操作は、外から来たことにしない', () => {
  it('自分で消したら、編集欄は閉じる', () => {
    act(() => replaceMemos(GLOBAL_TARGET, [memo('あ')]))
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)

    fireEvent.mouseDown(screen.getByTestId('memo-edit'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove-confirm'))
    // 消したぶんがサーバから配られて返ってくる
    act(() => replaceMemos(GLOBAL_TARGET, []))

    expect(screen.queryByTestId('memo-editing')).toBeNull()
    expect(screen.queryByTestId('memo-outside-change')).toBeNull()
  })

  it('送れなかったときは閉じない（打った字を捨てない）', () => {
    useWsStore.setState({ memoRemove: vi.fn(() => false) })
    act(() => replaceMemos(GLOBAL_TARGET, [memo('あ')]))
    render(<MemoPane target={GLOBAL_TARGET} label="全体のメモ" 保存先={null} />)

    fireEvent.mouseDown(screen.getByTestId('memo-edit'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove'))
    fireEvent.mouseDown(screen.getByTestId('memo-remove-confirm'))

    expect(screen.getByTestId('memo-editing')).toBeInTheDocument()
    expect(screen.getByTestId('memo-row-send-failed')).toHaveTextContent('送れていません')
  })
})
