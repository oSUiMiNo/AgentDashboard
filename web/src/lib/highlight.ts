/**
 * 差分のシンタックスハイライト（設計§10）。
 *
 * # 開いたツールコールの分だけを色付けする
 *
 * 履歴には数百のツールコールが並ぶ。全部を先に色付けすると、見ていない差分のために
 * CPU とメモリを使うことになる。ここでは**展開されたツールコールの差分だけ**を
 * 対象にし、しかもハイライタ本体は最初に必要になった瞬間に読み込む
 * （`import()` で分割する）。一覧画面の初期表示にハイライタを巻き添えにしない。
 *
 * # まとめて1回だけ用意する
 *
 * ハイライタの生成は重いので、1度だけ作って使い回す。言語とテーマを絞った
 * 「細粒度バンドル」を使い、正規表現エンジンも WASM を読まない JavaScript 実装にする。
 * ここを既定の `shiki` 本体にすると、使わない言語まで初期バンドルに載る。
 */

import type { HunkData, HunkTokens, TokenNode } from 'react-diff-view'

/**
 * 対応する言語の読み込み口。
 *
 * 動的 import の指定は**文字列リテラルで書く**こと。変数を混ぜるとバンドラが
 * 何を含めればよいか判断できず、実行時に読み込みが失敗する。
 */
const LANG_LOADERS = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  json: () => import('@shikijs/langs/json'),
  toml: () => import('@shikijs/langs/toml'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  shell: () => import('@shikijs/langs/shell'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
} as const

/** 拡張子 → 言語。トランスクリプトで実際によく出るものに絞る。 */
const EXTENSIONS: Record<string, keyof typeof LANG_LOADERS> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  json: 'json',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  sh: 'shell',
  bash: 'shell',
  css: 'css',
  html: 'html',
}

const THEME = 'github-dark-default'

type Highlighter = {
  codeToHast: (code: string, options: { lang: string; theme: string }) => unknown
}

let highlighter: Promise<Highlighter | null> | null = null

/** 拡張子から言語を決める。分からなければ色付けしない。 */
export function languageOf(filePath: string): string | null {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSIONS[extension] ?? null
}

/**
 * ハイライタを用意する（最初の1回だけ実際に読み込む）。
 *
 * 失敗しても `null` を返すだけにする。色が付かないだけで差分そのものは読めるので、
 * ここで例外を投げて画面を壊す価値はない。
 */
async function ensureHighlighter(): Promise<Highlighter | null> {
  if (!highlighter) {
    highlighter = (async () => {
      try {
        const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
          import('shiki/core'),
          import('shiki/engine/javascript'),
        ])
        return (await createHighlighterCore({
          themes: [import('@shikijs/themes/github-dark-default')],
          langs: Object.values(LANG_LOADERS).map((load) => load()),
          // WASM を読まない正規表現エンジン。ブラウザでの起動が速く、
          // 取得するファイルも増えない
          engine: createJavaScriptRegexEngine(),
        })) as unknown as Highlighter
      } catch {
        return null
      }
    })()
  }
  return highlighter
}

/** HAST のノードを react-diff-view の TokenNode へ写す（形はほぼ同じ）。 */
function toTokenNodes(value: unknown): TokenNode[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value as TokenNode[]
}

/** shiki が返す木から「行ごとのトークン列」を取り出す。 */
function linesOf(hast: unknown): TokenNode[][] {
  const root = hast as { children?: unknown[] } | undefined
  const pre = root?.children?.[0] as { children?: unknown[] } | undefined
  const code = pre?.children?.[0] as { children?: unknown[] } | undefined
  const lines = (code?.children ?? []).filter(
    (child) => (child as { type?: string }).type === 'element',
  )
  return lines.map((line) => toTokenNodes((line as { children?: unknown[] }).children))
}

/**
 * 差分の左右それぞれを色付けして、表示ライブラリが読める形にする。
 *
 * 変更前・変更後をそれぞれ1つのコードとして色付けしてから行に切り分ける。1行ずつ
 * 色付けすると、複数行にまたがる文字列やコメントの色が壊れる。
 */
export async function tokenizeHunks(
  hunks: HunkData[],
  filePath: string,
): Promise<HunkTokens | null> {
  const lang = languageOf(filePath)
  if (!lang) {
    return null
  }
  const shiki = await ensureHighlighter()
  if (!shiki) {
    return null
  }

  const oldLines: string[] = []
  const newLines: string[] = []
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type !== 'insert') {
        oldLines.push(change.content)
      }
      if (change.type !== 'delete') {
        newLines.push(change.content)
      }
    }
  }

  try {
    return {
      old: linesOf(shiki.codeToHast(oldLines.join('\n'), { lang, theme: THEME })),
      new: linesOf(shiki.codeToHast(newLines.join('\n'), { lang, theme: THEME })),
    }
  } catch {
    // 言語の判定を外した場合など。色が付かないだけで差分は読める
    return null
  }
}
