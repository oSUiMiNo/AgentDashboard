export function markdownAssetPath(documentPath: string, reference: string): string | null {
  const trimmed = reference.trim()
  if (trimmed === '' || trimmed.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  let decoded: string
  try {
    decoded = decodeURI(trimmed.replace(/[?#].*$/, ''))
  } catch {
    return null
  }
  const parts = decoded.startsWith('/') ? [] : documentPath.split('/').filter((part) => part !== '').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.length === 0 ? null : `/${parts.join('/')}`
}
