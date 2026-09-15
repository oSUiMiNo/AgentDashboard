import type { CrepeConfig } from '@milkdown/crepe'
import { Crepe } from '@milkdown/crepe'
import { safeMarkdownUrl } from '../../../lib/fileMarkdown'

export function markdownEditorConfig(root: HTMLElement, onError: (message: string) => void): CrepeConfig {
  return {
    root,
    features: {
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
    },
    featureConfigs: {
      [Crepe.Feature.Cursor]: { virtual: false },
      [Crepe.Feature.Placeholder]: { text: '書きはじめる。 / でブロックを追加', mode: 'block' },
      [Crepe.Feature.BlockEdit]: {
        textGroup: {
          label: '基本', text: { label: 'テキスト' },
          h1: { label: '見出し 1' }, h2: { label: '見出し 2' }, h3: { label: '見出し 3' },
          h4: { label: '見出し 4' }, h5: { label: '見出し 5' }, h6: { label: '見出し 6' },
          quote: { label: '引用' }, divider: { label: '区切り線' },
        },
        listGroup: {
          label: 'リスト', bulletList: { label: '箇条書き' }, orderedList: { label: '番号付きリスト' },
          taskList: { label: 'チェックリスト' },
        },
        advancedGroup: {
          label: 'コンテンツ', image: { label: '画像' }, codeBlock: { label: 'コードブロック' },
          table: { label: '表' }, math: null,
        },
      },
      [Crepe.Feature.Toolbar]: {
        boldLabel: '太字', italicLabel: '斜体', strikethroughLabel: '取り消し線',
        codeLabel: 'インラインコード', linkLabel: 'リンク',
      },
      [Crepe.Feature.CodeMirror]: {
        searchPlaceholder: '言語を検索', copyText: 'コピー', noResultText: '見つかりません',
        previewToggleText: (only) => only ? 'コードを編集' : 'プレビューを隠す',
      },
      [Crepe.Feature.LinkTooltip]: { inputPlaceholder: 'URLまたは相対パス' },
      [Crepe.Feature.ImageBlock]: {
        blockConfirmButton: '画像を挿入', blockCaptionPlaceholderText: '画像の説明（代替テキスト）',
        blockUploadPlaceholderText: '画像のURLを貼り付け', inlineUploadPlaceholderText: '画像のURLを貼り付け',
        proxyDomURL: (url) => safeMarkdownUrl(url) ? url : '',
        onUpload: async () => {
          onError('画像はURLで指定してください。ファイルのアップロードには対応していません。')
          throw new Error('画像はURLで指定してください。')
        },
      },
    },
  }
}
