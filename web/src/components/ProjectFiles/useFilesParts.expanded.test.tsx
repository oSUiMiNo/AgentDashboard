import { render } from '@testing-library/react'
import { useState } from 'react'
import { useFilesParts } from '@/components/ProjectFiles/useFilesParts'
import { putExpanded, readExpanded } from '@/lib/filesPlace'

vi.mock('@/lib/filesPlace', async (importOriginal) => {
  const 元 = await importOriginal<typeof import('@/lib/filesPlace')>()
  return {
    ...元,
    readExpanded: vi.fn(元.readExpanded),
    putExpanded: vi.fn(元.putExpanded),
  }
})

interface 控えた受け取り物 {
  root: string
  loadExpanded: () => string[]
  onExpandedChange: (expanded: string[]) => void
}

const 控え: 控えた受け取り物[] = []

vi.mock('@/components/FolderBrowser/FolderTree', () => ({
  FolderTree: (props: 控えた受け取り物) => {
    useState(() => props.loadExpanded())
    控え.push(props)
    return <div data-testid="folder-browser" data-path={props.root} />
  },
}))

const ROOT = '/home/me/dev/app'
const PLACE_KEY = 'agentdashboard.project-files-place'

function Card({ project, withSidebar }: { project: string; withSidebar: boolean }) {
  const { sidebar, column } = useFilesParts({
    host: 'local',
    project,
    open: true,
    onToggle: () => {},
  })
  return (
    <div>
      {withSidebar && sidebar}
      {column}
    </div>
  )
}

beforeEach(() => {
  控え.length = 0
  globalThis.localStorage.clear()
  vi.mocked(readExpanded).mockClear()
  vi.mocked(putExpanded).mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('見つかりません', { status: 404 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('展開の覚えを読む・書く所', () => {
  it('横並びのカードが複数あっても、展開の覚えを読むのはサイドバーを描く1か所だけ', () => {
    globalThis.localStorage.setItem(
      PLACE_KEY,
      JSON.stringify({
        [JSON.stringify(['local', ROOT])]: { expanded: [`${ROOT}/MyDocs`], dirSeen: null },
      }),
    )

    render(
      <>
        <Card project={ROOT} withSidebar />
        <Card project={ROOT} withSidebar={false} />
        <Card project={ROOT} withSidebar={false} />
      </>,
    )

    expect(控え.length).toBeGreaterThan(0)
    expect(readExpanded).toHaveBeenCalledTimes(1)
    expect(readExpanded).toHaveBeenCalledWith('local', ROOT)
  })

  it('PJT が空文字の間は、展開の覚えを読みも書きもしない（空文字の鍵の行を作らない）', () => {
    render(<Card project="" withSidebar />)

    const 受け取り物 = 控え.at(-1)
    expect(受け取り物).toBeDefined()
    expect(受け取り物?.loadExpanded()).toEqual([])
    受け取り物?.onExpandedChange(['/home/me/dev/app/MyDocs'])

    expect(readExpanded).not.toHaveBeenCalled()
    expect(putExpanded).not.toHaveBeenCalled()
    const 表 = JSON.parse(globalThis.localStorage.getItem(PLACE_KEY) ?? '{}') as Record<
      string,
      unknown
    >
    expect(Object.keys(表)).not.toContain(JSON.stringify(['local', '']))
  })
})
