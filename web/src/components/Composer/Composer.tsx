/**
 * セッションへ指示を送る入力欄（要件「専用画面から指示を送れる」／設計§4・§6）。
 *
 * # タブの外側に常設する
 *
 * 構造化ビューとターミナルのどちらを見ていても送れるように、タブの切り替えとは
 * 独立した位置に置く。要件が言う使い方は「普段は構造化ビューを見ていて、そこから
 * 指示を出す」なので、指示を出すたびにターミナルへ切り替えさせるのは筋が悪い。
 *
 * # Ctrl+Enter で送る
 *
 * Ctrl+Enter＝送信、Enter と Shift+Enter＝改行。チャット欄の一般的な作法（Enter で送信）
 * ではなく、**すぐ隣の端末と同じ割り当て**を採っている。この画面には入力口が2つあり、
 * 押し分けが違うと結果が「いまどちらに焦点があるか」で変わってしまう。判断は
 * [`isComposerSubmit`] が持つ（端末側と同じ `lib/keys.ts`）。
 *
 * 改行を含む指示は、サーバ側が bracketed paste で包んでから PTY へ書く
 * （`crates/core/src/session/input.rs`）。ブラウザ側では加工しない。
 * 加工を両側でやると、どちらが正なのか分からなくなる。
 *
 * # 画像の添付（画像添付 設計§9）
 *
 * 付ける道は3つ（ドラッグ＆ドロップ・貼り付け・「＋」）だが、**拾う口は2つで足りる**
 * ——`onPaste` と `<input type="file">` である。**経路ごとに書き分けない。**
 *
 * **スマホで効くのは2通りだけである**（2026-09-03 に実機で確かめた）。長押しの
 * 「貼り付け」は `onPaste` に、OS の画像選択は `<input type="file">` に落ちる。
 * **キーボード上部のクリップボードの面からは、こちらへ何も届かない**——Chrome が
 * 「Chrome は、ここでの画像の貼り付けをサポートしていません」と自分で断る。
 *
 * あれは `paste` ではなく Android の `InputConnection.commitContent` という別の口で、
 * **キーボードがアプリへ直接手渡す仕組み**である。Chrome は実装を持っているものの
 * `AndroidMediaInsertion` という旗の内側にあり、**スマホでは既定で閉じている**
 * （開いているのはデスクトップ Android だけ。かつ旗自体に期限があり、
 * `expiry_milestone: 155`＝2026-10 ごろに `chrome://flags` から消える）。
 *
 * **`<textarea>` である限り、どのブラウザでも1枚も届かない。** 申告の対象が
 * 書式付きの入力欄だけだからである。**逆に言えば `contenteditable` にすれば道はある**
 * ——**Firefox for Android は 2022年から既定で効く**（期限なし）。ここを作り替えるなら、
 * **拾い口を2本持つことになる**：Chrome は `onPaste` の `clipboardData.files`、
 * Firefox は `input`（`insertFromPaste`）のあと DOM に増えた `<img src="data:...">`。
 * **しかも Firefox では `preventDefault()` を呼んではいけない**——挿入ごと取り消される。
 *
 * **やらない判断であって、できない判断ではない**（調査 2026-09-03）。作り替えの代金が
 * 大きいので見送っている。やるならイシュー
 * `キーボードのクリップボードから選んで画像を添付する`。
 *
 * **`compact` で分岐しない。** `compact` は `InputDock` が消費してここへは渡らないので、
 * ここへ足すだけで単独画面と横並びの両方に出る（§9-2）。分岐を書くと片側に出なくなる。
 *
 * **送信を押すまで、画像はブラウザの外へ出ない**（§2）。押してから運び、
 * 置き終わってから本文を組み立てる。運びに失敗したら送らない——添付も本文も残す。
 *
 * # 断られたら戻す（設計§7-2）
 *
 * **`sendInput` が `true` を返しても、届いたとは限らない。** 言えるのは WebSocket が
 * フレームを受け取ったことだけで、指示そのものは**印を待って断られる**ことがある
 * （`Session::send_instruction_with`）。断りは遅れて届くので、そのときには本文も添付も
 * 消えている——設計§7-2 が「もう一度押せる」と約束しているのに、打ち直しと画像の
 * 選び直しが要る形になっていた。
 *
 * そこで**送ったものを控えておき、断りが届いたら戻す**。相関IDが線に無いので、
 * 「直後に届いた同じカードの断り」が本当にこの送信への返事かは**推測でしかない**——
 * だから [`RESTORE_WINDOW_MS`] の窓で区切る。
 *
 * **文言はここに出さない。** `SessionView` が `card-error` として既に出しているので、
 * 再掲すると同じ文が上下に2つ並ぶ。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CloseGlyph, PlusGlyph, SendGlyph } from '@/components/ui/glyphs'
import { Textarea } from '@/components/ui/textarea'
import {
  ACCEPT_ATTRIBUTE,
  pickImages,
  鍵を採る,
  releasePreview,
  type Attachment,
} from '@/lib/attachments'
import { report } from '@/lib/clientLogs'
import { markComposerBusy } from '@/lib/composerBusy'
import { useDraft } from '@/lib/drafts'
import { listDir, readFile, uploadAttachment } from '@/lib/hostfs'
import { isCandidateAccept, isCandidateMove, isComposerSubmit } from '@/lib/keys'
import { isEnded, type SessionStatus } from '@/lib/protocol'
import type { CardId } from '@/lib/protocol'
import {
  filterCandidates,
  harvestCandidates,
  slashQueryAt,
  type CandidateHarvest,
  type SlashCandidate,
} from '@/lib/slashCandidates'
import { sendTerminalKey } from '@/lib/terminalBridge'
import { useAuthStore } from '@/stores/auth'
import {
  clearCardNotices,
  pushCardNotice,
  useCardError,
  useSessionCard,
} from '@/stores/sessions'
import { watchUserMessage } from '@/stores/transcript'
import { useWsStore } from '@/stores/ws'
import { MAX_VISIBLE, SlashMenu } from './SlashMenu'

/**
 * 送ったものを控えておく長さ（ミリ秒）。
 *
 * 断りは**印の待ちの上限**（`attachment_mark_wait_ms`・既定5000）を待ってから返るので、
 * 既定の4倍の余裕を取る。**上限をこれより厚く設定した機械では戻らなくなる**が、それは
 * 「控えを取る前と同じ振る舞い」に落ちるだけで、新しい害は出ない。
 *
 * 窓で区切るのは、`ServerMessage::Error` に**相関IDが無い**ため。窓を外すと、
 * ずっと後で来た無関係な断り（権限モードの切替が断られた等）で古い本文が戻ってしまう。
 */
const RESTORE_WINDOW_MS = 20_000

/** 送ったものの控え。断りが届いたらこれを画面へ戻す。 */
interface 控え {
  text: string
  attachments: Attachment[]
  /** 窓を閉じるための時計。差し替え・解決・畳みのときに止める */
  timer: ReturnType<typeof setTimeout>
  /**
   * 記録の見張りを外す（取り消し 設計§4）。
   *
   * **時計とは別に要る。** 時計は「届かなかったとき」の保険で、こちらは
   * 「**読まれたから、もう取り消せない**」を知る本筋である。
   */
  見張りを外す: () => void
}

interface Props {
  /** 外から寸法を決める（帯へ横並びに置くため） */
  className?: string
  cardId: CardId
  status: SessionStatus
  /**
   * このカードを抱えている PC（画像添付 設計§9-2）。
   *
   * **必ず在る。** `hostOf()` は `agentId ?? LOCAL_HOST` を返すので、ローカルモードでも
   * 文字列（`"local"`）になる。**「宛先が分からないから口を出さない」という分岐は
   * 作らない**——`null` になる経路が無いので、書いても一度も通らない死んだ枝になる。
   *
   * **古い PC のカードでも口は出る。** 設計§4-1 は「名乗らない PC には出さない」と
   * 書いているが、そうは作っていない（ブラウザは `supports_blob_write` を読まない）。
   * 置く側が **409 で断る**ので、押した人には「いまのこの相手ではできない」が届く——
   * **同じ仕組みを使うファイル閲覧も口を隠していない**ので、そちらへ揃えてある。
   */
  host: string
  /**
   * 十字ボタンが出ている間は高さを詰める（十字ボタン設計§11）。
   *
   * **消さない。** 要素が消えると日本語の変換中の文字が復元できない——変換途中の
   * 文字は入力欄の値としてまだ確定していないため、消えた瞬間に取り戻す先が無くなる。
   * この判断が、判定を「迷ったら出す」側へ倒せる根拠になっている。
   */
}

export function Composer({ cardId, status, host, className = '' }: Props) {
  const sendInput = useWsStore((state) => state.sendInput)
  // 下書きの鍵を分けるためのアカウント。**`lib/` から `stores/` は読まない**ので、
  // 読むのはこちら側（十字ボタン設計§11 のフェーズ3 の訂正）
  const account = useAuthStore((state) => state.auth.account)
  const [text, setText] = useDraft(cardId, account)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 付いている添付。**下書きと違って覚えない**——`File` はページを跨いで持てないし、
  // 「前に開いたときの画像がまだ付いている」のは押す人の意図と食い違う
  const [attachments, setAttachments] = useState<Attachment[]>([])
  // 運んでいる最中。二度押しで同じ画像を2回置かせない
  const [sending, setSending] = useState(false)
  // 断られた理由と、運びに失敗した理由。**画面にそのまま出す**
  // 大きく見ている1枚。**送る前に中身を確かめる道**（利用者の指定 2026-09-03）——
  // 細かい字のスクショは、小窓の大きさでは読めない
  const [拡大中, set拡大中] = useState<Attachment | null>(null)
  // 断りの並び。**文字列そのものを React の鍵にしない**——同じ名前のファイルを
  // 2つ落とすと鍵がぶつかって、片方しか出ない
  const [trouble, setTrouble] = useState<{ id: string; text: string }[]>([])
  // 送ったものの控え。**断られたら戻す**（設計§7-2）
  const 控え中 = useRef<控え | null>(null)
  const cardError = useCardError(cardId)
  const ended = isEnded(status)
  // 打てるものの一覧。**集めるのは1回だけ**——打鍵のたびにディスクを舐めると、
  // この機械では106件ぶんの読み取りが毎回走る
  const [harvest, setHarvest] = useState<CandidateHarvest | null>(null)
  // 一覧の中で選ばれている番号。**打ち直すたびに先頭へ戻す**
  const [selected, setSelected] = useState(0)
  // Esc で閉じたか。**打ち直せばまた開く**——閉じたまま戻らないと、打ち間違いを
  // 直すたびに一覧を諦めることになる
  const [dismissed, setDismissed] = useState(false)
  // いま入力欄のどこに居るか。**一覧を出すかは、先頭ではなくここで決まる**——
  // 文の途中に打った `/` でも名前を思い出せるように（2026-09-08）
  const [caret, setCaret] = useState(0)
  // 確定したあとに置きたい位置。**入力欄は `text` で操られている**ので、放っておくと
  // 差し替えた瞬間に末尾へ飛び、続きを打つと文の最後へ入る
  const 置き直す位置 = useRef<number | null>(null)
  const project = useSessionCard(cardId)?.project
  // 添付の口を出すかどうかは**終わっているか**だけで決まる。`host` は必ず在るので
  // 「宛先が分からない」という枝は作らない（作っても一度も通らない）
  const 添付できる = !ended

  /** 控えを畳む。**絵もここで捨てる**——捨てる場所を散らすと必ず取り残しが出る */
  const 控えを捨てる = () => {
    const held = 控え中.current
    if (held === null) {
      return
    }
    控え中.current = null
    clearTimeout(held.timer)
    held.見張りを外す()
    for (const one of held.attachments) {
      releasePreview(one)
    }
  }

  /**
   * 控えを画面へ戻す。
   *
   * **引き金は2つある**——断り（`cardError`）が届いたときと、送った直後に `↑` が
   * 押されたとき（取り消し 設計§5）。**戻す中身は同じ**なので、片方だけ直る形を
   * 作らないよう1本に寄せてある。
   *
   * **文も添付も同じ経路で戻る。** 添付の実体はサーバ側に残っている（掃除される
   * のはセッションを畳むときで、送信では消えない）ので、戻したらそのまま送り直せる。
   */
  const 控えを戻す = () => {
    const held = 控え中.current
    if (held === null) {
      return
    }
    控え中.current = null
    clearTimeout(held.timer)
    held.見張りを外す()
    // **打ち直しの途中なら邪魔しない。** 押したあとに書き始めた文のほうが新しい
    if (text !== '' || attachments.length > 0) {
      for (const one of held.attachments) {
        releasePreview(one)
      }
      return
    }
    setText(held.text)
    setAttachments(held.attachments)
  }

  // 断りが届いたら、送ったものを戻す（設計§7-2）。**文言は出さない**——
  // `SessionView` が `card-error` として既に出しているので、再掲すると2つ並ぶ
  useEffect(() => {
    if (cardError === null) {
      return
    }
    控えを戻す()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 断りが届いた瞬間だけ動かす
  }, [cardError])

  // 畳まれるときも控えを捨てる。**残すと `blob:` がブラウザの中に溜まる**
  useEffect(() => 控えを捨てる, [])

  // 置いたままの添付も、畳まれるときに捨てる。
  //
  // **控えとは別の集合である。** 控えは「送ったが断られるかもしれないぶん」で、こちらは
  // 「まだ送っていないぶん」——付けたまま別の画面へ移ると、こちらだけが残る。
  // 送った時点で `attachments` は空になり中身は控えへ移るので、**二重に捨てることは無い**。
  //
  // ref を経由するのは、後始末が**畳まれた瞬間の中身**を要るため。依存に
  // `attachments` を置くと、付け外しのたびに後始末が走って捨ててはいけないものまで捨てる
  const 置いたまま = useRef<Attachment[]>([])
  置いたまま.current = attachments
  useEffect(
    () => () => {
      for (const one of 置いたまま.current) {
        releasePreview(one)
      }
    },
    [],
  )

  // 抱えている間だけ、台帳へ1行置く（`lib/composerBusy.ts`）。**版が切り替わったとき、
  // このタブが自分で読み直してよいか**の判定に使う——添付は読み直すと消えるので、
  // 抱えているタブは読み直さずバナーを出して人に任せる。
  //
  // **依存は真偽値1つにする。** `attachments` を依存に置くと、上の後始末と同じ罠を踏む
  // （付け外しのたびに効果が走り、登録し直しの隙間が増える）。真偽値なら動くのは
  // 0→1 と 1→0 の2回だけで、2枚目・3枚目を足しても1枚外しても走らない。
  //
  // **`sending` は数えない。** あれが立つのは `attachments.length > 0` の内側だけなので、
  // ここが真なら必ず真である。判定を2本持つと、片方だけ直したときに食い違う。
  //
  // **`控え中` も数えない。** あれは送信が通るたびに 20 秒持つが、版の入れ替えでは
  // 接続が既に切れており、控えが待っている断り（`ServerMessage::Error`）は届かない。
  // 数えると「送信直後の20秒はどのタブも読み直さない」という、誰も得しない停止になる。
  const 抱えている = attachments.length > 0
  useEffect(() => (抱えている ? markComposerBusy() : undefined), [抱えている])

  // 打てるものを、その PC のディスクから数え上げる（設計§2）。
  //
  // **`/` を打った時点ではなく、開いた時点で集める。** 打ってから読みに行くと、
  // 1文字目と一覧が出るまでに待ちが挟まる——この機械では106件あり、フォルダを
  // 何枚も舐めるので体感に出る。
  //
  // **終わったセッションでは集めない。** 打てないので一覧も要らない。
  useEffect(() => {
    if (ended) {
      return
    }
    let 生きている = true
    void (async () => {
      const fs = {
        listDir: (path?: string) => listDir(host, path),
        readFile: (path: string) => readFile(host, path),
      }
      try {
        const got = await harvestCandidates(fs, project)
        if (!生きている) {
          return
        }
        setHarvest(got)
        // **集め終わりに1行だけ**（設計§11）。1件ごとには出さない——
        // 打鍵のたびに三桁の行が積まれる。
        //
        // **落としたぶんは画面から消える**ので、ここに数が残っていないと
        // 「自分のコマンドが出てこない」を切り分けられない
        report(
          'slash_candidates',
          'INFO',
          `候補 ${got.candidates.length} 件（隠し ${got.hidden}・読めず ${got.unreadable}・打ち切り ${got.truncated}）`,
          { cardId },
        )
      } catch (error) {
        if (!生きている) {
          return
        }
        // **集められなくても入力欄は使える。** 一覧が出ないだけで、打って送る道は残る
        setHarvest({
          candidates: [],
          hidden: 0,
          unreadable: 1,
          truncated: false,
        })
        report(
          'slash_candidates',
          'INFO',
          `候補を集められなかった：${String(error)}`,
          { cardId },
        )
      }
    })()
    return () => {
      生きている = false
    }
  }, [cardId, host, project, ended])

  // いま居る語が `/` で始まっているか。**入力の先頭とは限らない**（設計§5-2）
  const 問い合わせ = slashQueryAt(text, caret)
  // 打った文字で狭める。**並びは入れ替えない**（押そうとした的が逃げる）。
  // 渡すのは**入力欄の全文ではなく語のほう**——全文だと、文の途中の `/` が
  // `filterCandidates` の「`/` で始まるか」に落ちる
  const 候補 = filterCandidates(harvest?.candidates ?? [], 問い合わせ?.token ?? '')
  // 一覧を出すか。**`/` の語の中に居なければ出さない**ので、普通の指示を
  // 打っている最中にも、引数を打っている最中にも被さらない
  const 候補が出ている =
    !ended && !dismissed && 問い合わせ !== null && harvest !== null

  /** 選んでいるものを入力欄へ入れる。**`setText` を通す**ので書きかけが追随する */
  const 確定する = (candidate: SlashCandidate) => {
    const 場所 = 問い合わせ
    if (場所 === null) return
    // **語のぶんだけを差し替える。** 先頭から置き換えると、文の途中で選んだ瞬間に
    // 前の文が丸ごと消える
    setText(`${text.slice(0, 場所.start)}/${candidate.name}${text.slice(場所.end)}`)
    置き直す位置.current = 場所.start + 1 + candidate.name.length
    setDismissed(true)
    inputRef.current?.focus()
  }

  // 差し替えたあと、名前の直後へ戻す。**`text` が変わったあとでないと効かない**
  useLayoutEffect(() => {
    const 位置 = 置き直す位置.current
    if (位置 === null) return
    置き直す位置.current = null
    inputRef.current?.setSelectionRange(位置, 位置)
    setCaret(位置)
  }, [text])

  /** 3経路の共通の入口。**判定は `pickImages` の1つを通る**（設計§9） */
  const 受け取る = async (files: readonly File[]) => {
    if (!添付できる || files.length === 0) {
      return
    }
    // **待つのは、中身の写しを取るからである**（`pickImages` の説明）。
    // 呼ぶ側（落とす・貼る・選ぶ）はどれも待たない——待たせても画面ですることが無い
    const { accepted, rejected } = await pickImages(files)
    setAttachments((now) => [...now, ...accepted])
    setTrouble(rejected.map((text) => ({ id: 鍵を採る(), text })))
  }

  const 拡大する = (one: Attachment) => set拡大中(one)

  const 外す = (id: string) => {
    // 大きく見ているものを外したら、そちらも閉じる（消えた絵を見せ続けない）
    set拡大中((いま) => (いま?.id === id ? null : いま))
    setAttachments((now) => {
      const 出す = now.find((one) => one.id === id)
      if (出す) {
        releasePreview(出す)
      }
      return now.filter((one) => one.id !== id)
    })
  }

  const submit = async () => {
    if (ended || sending) {
      return
    }

    // **押してから運ぶ。** 先に運んでおくと、外したときに置いたものが残る（§2）
    let paths: string[] = []
    if (attachments.length > 0) {
      setSending(true)
      try {
        paths = []
        for (const one of attachments) {
          const written = await uploadAttachment(host, cardId, one.bytes)
          paths.push(written.path)
        }
      } catch (err) {
        // **運びに失敗したら送らない。** 添付も入力欄の中身も残す（§9-1）——
        // ここで消すと、押し直すために画像を選び直すことになる
        setTrouble([
          {
            id: 鍵を採る(),
            text: err instanceof Error ? err.message : '画像を置けませんでした',
          },
        ])
        return
      } finally {
        setSending(false)
      }
    }

    // **前の断りを消してから送る。** 残したままだと、同じ文言の断りが2回続いたときに
    // `useCardError` の値が変わらず、React から「届いた」ことが見えない
    // （`useSyncExternalStore` が `Object.is` で弾く）
    //
    // **消すのは送信の断りだけ。** 種別を省くと全部消えるので、復旧の失敗や端末が
    // 開けない断り（どちらも消えない側・設計§7-3）が、指示を1つ送っただけで
    // **読む前に消える**——`clearCardError` の doc がまさにこれを禁じている
    clearCardNotices(cardId, 'send_input')

    // **送れたときだけ消す。** 送れていない文が消えるのが、いちばん困る形
    if (!sendInput(cardId, text, paths)) {
      // **黙って戻らない**（2026-09-06）。線が閉じていると `sendInput` は送らずに
      // 偽を返すが、ここは以前**何も出さずに戻っていた**——押した人から見ると
      // 「押したのに何も起きない」だけで、**送れていないことが画面のどこにも出ない**。
      //
      // **吹き出しは出ない。** 発言が青い吹き出しになるのは、claude が記録へ書いて
      // パーサがノードを出したときだけなので、**送れていない文が読まれた顔で並ぶ
      // ことはない**。だから足りないのは色ではなく、**断りそのもの**である。
      //
      // **打った文はそのまま残る**（上の早期 return が `setText('')` の手前にある）
      // ので、線が戻ったら押し直せばよい。そのことも書いて渡す。
      pushCardNotice(
        cardId,
        '送れていません（つながりが切れています）。打った文はそのまま残してあるので、つながり直してから送り直してください',
        'send_input',
      )
      return
    }

    // **控えを取る。絵はまだ捨てない**（設計§7-2——断られたらそのまま戻せること）。
    // 前の控えが残っていれば、そちらはもう戻す相手が居ないので畳む
    控えを捨てる()
    // **控えを先に置いてから見張りを付ける。** 逆にすると、見張りが即座に当たった
    // ときに畳む相手（`控え中.current`）がまだ居ない
    const held: 控え = {
      text,
      attachments,
      timer: setTimeout(控えを捨てる, RESTORE_WINDOW_MS),
      見張りを外す: () => {},
    }
    控え中.current = held
    // 読まれたら畳む（取り消し 設計§4）。**時間の窓は保険として残す**——
    // 記録が届かない経路（線が切れた等）で永久に開いたままにしないため
    held.見張りを外す = watchUserMessage(cardId, text, 控えを捨てる)

    setText('')
    set拡大中(null)
    setAttachments([])
    setTrouble([])
    inputRef.current?.focus()
  }

  return (
    <form
      data-testid="composer"
      // 縦に積む。**添付は入力欄の「上」**（§9-1）——下に置くと、送信ボタンとの間に
      // 押し間違えやすい列ができる
      // **`relative` は候補の一覧の寄せ先**（設計§6）。一覧は `absolute` で器の外へ
      // 重ねるので、この指定が無いと画面のどこか遠くへ飛ぶ
      className={`relative flex flex-col gap-1 ${className}`}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      // ドラッグ＆ドロップ。**`onDragOver` で既定を止めないと、ブラウザが
      // その画像を開いてしまい画面ごと入れ替わる**
      onDragOver={(event) => {
        if (添付できる) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        if (!添付できる) {
          return
        }
        event.preventDefault()
        受け取る([...event.dataTransfer.files])
      }}
    >
      {/*
        候補の一覧。**器の外へ重ねる**ので、ここに置いても入力欄の高さは動かない。
        0件でも出す——何に当たらなかったのかと、**そのまま送れる**ことを言うため（設計§6-4）
      */}
      {候補が出ている && (
        <SlashMenu
          candidates={候補}
          selected={Math.min(selected, Math.max(0, 候補.length - 1))}
          unreadable={harvest?.unreadable ?? 0}
          truncated={harvest?.truncated ?? false}
          text={問い合わせ?.token ?? text}
          onPick={確定する}
          onHover={setSelected}
        />
      )}
      {attachments.length > 0 && (
        <ul
          data-testid="composer-attachments"
          className="flex flex-wrap items-center gap-2"
        >
          {attachments.map((one) => (
            <li
              key={one.id}
              data-testid="composer-attachment"
              // **札の形にする。** 絵だけを並べると、何を付けたのかが名前で確かめられない
              // （メッセンジャーの見せ方に揃えた・利用者の指定 2026-09-03）
              className="border-border bg-card relative flex w-[7.5rem] flex-col gap-1
                rounded-lg border p-2"
            >
              {/* **絵は切り抜かない。** 横長の画像で端が切れると、何を付けたのかが
                  確かめられない。`object-contain` で全体を入れ、余りは地の色で埋める */}
              <button
                type="button"
                data-testid="composer-attachment-open"
                aria-label={`${one.name} を大きく見る`}
                title="大きく見る"
                onClick={() => 拡大する(one)}
                className="bg-muted/40 focus-visible:ring-ring flex h-20 items-center
                  justify-center overflow-hidden rounded transition-opacity
                  hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none
                  active:opacity-60"
              >
                <img
                  src={one.preview}
                  alt={one.name}
                  className="max-h-full max-w-full object-contain"
                />
              </button>
              {/* 名前は1行で切る。**全体は `title` に残す**ので、乗せれば読める */}
              <span
                data-testid="composer-attachment-name"
                title={one.name}
                className="text-muted-foreground truncate text-[0.7rem] leading-tight"
              >
                {one.name}
              </span>
              <button
                type="button"
                data-testid="composer-attachment-remove"
                aria-label={`${one.name} を外す`}
                title="外す"
                onClick={() => 外す(one.id)}
                // **当たり判定を 48px 取る**（DESIGN.md §24.3）。見た目は小さくてよいが、
                // 指で外せないと「付けたら取れない」になる
                className="text-muted-foreground hover:text-foreground active:text-foreground
                  absolute -top-3 -right-3 flex size-12 items-center justify-center
                  transition-colors"
              >
                {/* 絵文字を使わない（DESIGN.md §33）。線で描く */}
                <span
                  aria-hidden
                  className="border-border bg-background flex size-5 items-center
                    justify-center rounded-full text-xs leading-none"
                >
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {trouble.length > 0 && (
        <ul data-testid="composer-trouble" className="text-xs text-destructive">
          {trouble.map((断り) => (
            <li key={断り.id}>{断り.text}</li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        {添付できる && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              data-testid="composer-file"
              className="sr-only"
              onChange={(event) => {
                受け取る([...(event.target.files ?? [])])
                // 同じファイルを続けて選べるようにする（値が残ると change が出ない）
                event.target.value = ''
              }}
            />
            <Button
              type="button"
              /*
                **枠を外して線画だけにする**（細かい修正 設計§6-1・要件9）。お手本にした
                LINE と Discord は、どちらも入力欄まわりの補助操作に枠を持たない——
                器が並ぶと、どれが入力欄なのかが読み取りにくくなる。

                **塗らない。** 塗るのは送信だけ（`DESIGN.md` §15.1）——同じ濃さで
                並べると、どちらが「実行」なのかが読めなくなる。
              */
              variant="ghost"
              size="icon-sm"
              data-testid="composer-attach"
              aria-label="画像を添付"
              title="画像を添付"
              disabled={sending}
              onClick={() => fileRef.current?.click()}
            >
              <PlusGlyph className="size-4" />
            </Button>
          </>
        )}
        <Textarea
          ref={inputRef}
          data-testid="composer-input"
          value={text}
          disabled={ended}
          // 畳んでも消さない。**行数を詰めるだけ**
          rows={1}
          placeholder={
            ended
              ? 'このセッションは終了しています'
              : '指示やスラッシュコマンドを入力（Ctrl+Enter で送信 / Enter で改行）'
          }
          onChange={(event) => {
            setText(event.target.value)
            setCaret(event.target.selectionStart ?? event.target.value.length)
            // 打ち直したら、選び直しも一覧の開き直しもする。**閉じたまま戻らないと、
            // 打ち間違いを直すたびに一覧を諦めることになる**
            setSelected(0)
            setDismissed(false)
          }}
          // **矢印やクリックで動いただけでも追う。** 打っていないのに居場所が変わる
          // 道はここしか無く、拾わないと `/` の語へ戻っても一覧が出ない
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart ?? 0)
          }}
          // 貼り付け。**PC の Ctrl+V もスマホの長押し貼り付けも、ここへ来る**（§9）
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (files.length === 0) {
              return
            }
            // 画像が来たときだけ既定を止める。字を貼る動きは邪魔しない
            event.preventDefault()
            受け取る(files)
          }}
          onKeyDown={(event) => {
            // 候補の一覧が出ている間だけの押し分け（設計§7）。**必ず最初に見る。**
            //
            // **`候補が出ている` が偽なら、この枝は何も奪わずに下へ素通りする**——
            // 素の Enter は既存の経路のまま textarea の既定で改行になる。ここが
            // 崩れると、候補と関係なく Enter が改行でなくなるという、いちばん重い
            // 回帰になる（判定そのものは `lib/keys.ts` が持ち、ここには条件を散らさない）。
            //
            // **下の `ArrowUp`（送信の取り消し）とは同時に成立しない。** あちらは
            // 「入力欄が空」を要求し、こちらは `/` で始まっていることを要求するので、
            // 両方が真になる文字列が無い。**それでも順序を決めてある**のは、
            // 将来どちらかの条件が緩んだときに、どちらが勝つのかを読めるようにするため。
            const 押し分けの材料 = {
              key: event.key,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            }
            if (isCandidateAccept(押し分けの材料, 候補が出ている && 候補.length > 0)) {
              event.preventDefault()
              確定する(候補[Math.min(selected, 候補.length - 1)])
              return
            }
            const 操作 = isCandidateMove(押し分けの材料, 候補が出ている)
            // **当たるものが0件のときは、↑↓ を奪わない。** 動かす行が1つも無いのに
            // `preventDefault()` すると、`/` で始まる複数行を書いている最中に
            // **行を上下へ移動できなくなる**——一覧は「当たりません」を出したまま
            // 開いているので、`候補が出ている` だけを見ると奪ってしまう。
            // **Esc は0件でも要る**（畳む道が無くなるため）ので、そちらは通す。
            if (操作 === 'close' || (操作 !== null && 候補.length > 0)) {
              event.preventDefault()
              if (操作 === 'close') {
                setDismissed(true)
              } else {
                // 端で止める。**巡回させない**——長い一覧で端まで送ったつもりが
                // 反対の端へ飛ぶと、目で追っていた行を見失う
                const 幅 = Math.min(候補.length, MAX_VISIBLE)
                setSelected((now) =>
                  操作 === 'up'
                    ? Math.max(0, Math.min(now, 幅 - 1) - 1)
                    : Math.min(幅 - 1, now + 1),
                )
              }
              return
            }
            // 送った直後の取り消し。**焦点を移さずに端末へ `↑` を回す**（取り消し 設計§3）。
            // これが無いと、ターミナルを一度クリックしてからでないと取り消せない——
            // 文を書いている時点で焦点はこの入力欄に在るので、毎回その手間が挟まる。
            //
            // **常時は回さない。** 回すと、複数行を書いているときに行を上へ移動できなくなる。
            // 回すのは次が揃ったときだけ：
            //   - **控えが生きている**……戻す中身が無いなら、取り消しても何も戻らない
            //   - **入力欄が空**……打ち直しを始めているなら、そちらのほうが新しい
            // 2つ目は断りによる復元と同じ判断で、**新しい規則は増やしていない**。
            //
            // **変換中は触らない。** IME の候補を上下で選んでいる最中に奪うと、
            // 変換そのものができなくなる。**修飾キー付きも通す**——素の `↑` だけを見る。
            if (
              event.key === 'ArrowUp' &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              控え中.current !== null &&
              text === '' &&
              attachments.length === 0
            ) {
              event.preventDefault()
              // 端末の受け口が無いカードでは、`sendTerminalKey` が黙って捨てる。
              // **こちらで受け口の有無を見ない**——判定を2箇所に持つと必ず食い違う
              sendTerminalKey(cardId, 'up')
              // **先に端末へ回してから戻す。** 取り消しには締切があるので、
              // こちらの描画を待たせない
              控えを戻す()
              return
            }
            // 送信でないキーは何もせず通す。素の Enter は textarea の既定が改行にする
            // （`<form>` の中でも textarea の Enter は submit を起こさない）
            if (
              !isComposerSubmit({
                key: event.key,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
                isComposing: event.nativeEvent.isComposing,
              })
            ) {
              return
            }
            event.preventDefault()
            void submit()
          }}
          className="min-h-0 flex-1 resize-none"
        />
        {/*
          **入力欄まわりで唯一塗るもの**（`DESIGN.md` §15.1「主要操作は1つだけ塗る」・
          細かい修正 設計§6-1）。枠は外したが、ここだけは Primary Accent で塗る——
          枠を全部外したうえで塗りも無くすと、**送信がどれか分からなくなる**。

          色は `DESIGN.md` §11.2 の Primary Accent。**新しい色は増やしていない**
          （`index.css` の `--accent-face` / `--accent-edge` と同じ値を、
          `color-mix` を通さずそのまま塗っているだけ）。

          **文字を絵に替えたので、言葉は `aria-label` と `title` に残す。**
        */}
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          data-testid="composer-send"
          aria-label={sending ? '送信中' : '送信'}
          title={sending ? '送信中' : '送信（Ctrl+Enter）'}
          disabled={ended || sending}
          className="rounded-full bg-[#3dd9e6] text-neutral-900 hover:bg-[#3dd9e6]/85 disabled:opacity-50"
        >
          <SendGlyph className="size-4" />
        </Button>
      </div>

      {拡大中 !== null && (
        <>
          {/* 暗い幕。**押したら閉じる**——見るだけの窓なので、取り違えても害が無い
              （`ReviveBudgetDialog` は「全部戻す」を抱えているので閉じない側だった） */}
          <button
            type="button"
            data-testid="composer-preview-backdrop"
            aria-label="閉じる"
            onClick={() => set拡大中(null)}
            className="fixed inset-0 z-40 cursor-default bg-black/70"
          />
          <div
            data-testid="composer-preview"
            role="dialog"
            aria-label={`${拡大中.name} を大きく見る`}
            className="bg-background fixed inset-4 z-50 flex flex-col gap-2 rounded-xl
              border p-3 shadow-xl sm:inset-x-auto sm:inset-y-10 sm:left-1/2
              sm:w-[min(48rem,92vw)] sm:-translate-x-1/2"
          >
            <header className="flex shrink-0 items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">
                {拡大中.name}
              </span>
              {/*
                **`outline` をやめて他の ✕ と揃える**（設計§9-1）。ここだけ濃かった
                のは、6箇所が別々に書かれていたころの名残である。
              */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="composer-preview-close"
                aria-label="閉じる"
                title="閉じる"
                onClick={() => set拡大中(null)}
              >
                <CloseGlyph />
              </Button>
            </header>
            {/* **ここでも切り抜かない。** 確かめるために開いた窓で端が切れては意味が無い */}
            <img
              src={拡大中.preview}
              alt={拡大中.name}
              className="min-h-0 flex-1 rounded object-contain"
            />
          </div>
        </>
      )}
    </form>
  )
}
