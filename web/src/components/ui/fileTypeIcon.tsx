import type { FileIconType } from '@/lib/fileKind'

type IconType = FileIconType | 'folder' | 'link'

const 色: Record<IconType, string> = {
  folder: 'var(--type-folder)',
  document: 'var(--type-document)',
  code: 'var(--type-code)',
  image: 'var(--type-image)',
  text: 'var(--type-document)',
  link: 'var(--type-document)',
}

function 形(type: IconType) {
  switch (type) {
    case 'folder':
      return <path fill="currentColor" d="M2.5 5.5A1.5 1.5 0 0 1 4 4h5.3l2 2.2H20a1.5 1.5 0 0 1 1.5 1.5v10.8A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5z" />
    case 'document':
      return (
        <g fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
          <path d="M4.5 6h15" />
          <path d="M4.5 12h15" />
          <path d="M4.5 18h9" />
        </g>
      )
    case 'code':
      return (
        <g fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path d="m8.5 6-6 6 6 6" />
          <path d="m15.5 6 6 6-6 6" />
        </g>
      )
    case 'image':
      return (
        <g fill="currentColor">
          <circle cx="7.5" cy="6.5" r="3" />
          <path d="M1.5 21 9 10.5l4.6 6.2L17 12.5 22.5 21z" />
        </g>
      )
    case 'text':
      return (
        <g fill="currentColor">
          <path d="M5.5 2.5H14V8h5.5v12.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z" />
          <path d="M16 2.5 19.5 6H16z" />
        </g>
      )
    case 'link':
      return (
        <g fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 20v-6a4 4 0 0 1 4-4h11" />
          <path d="m15.5 5.5 4.5 4.5-4.5 4.5" />
        </g>
      )
  }
}

export function FileTypeIcon({ type, className }: { type: IconType; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      data-icon={type}
      className={className}
      style={{ color: 色[type] }}
    >
      {形(type)}
    </svg>
  )
}
