import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileView } from '@/components/FileView/FileView'
import { editKey, putEdit, readEdit, readEditDetails, WRITE_DEBOUNCE_MS } from '@/lib/fileEdits'
import type { FileContent } from '@/lib/hostfs'
import { useAuthStore } from '@/stores/auth'

const controls = vi.hoisted(() => ({
  change: null as ((value: string) => void) | null,
  save: null as (() => void) | null,
}))

vi.mock('./FileEditor', () => ({
  FileEditor: ({ value, onChange, onSave }: {
    value: string
    onChange: (value: string) => void
    onSave: () => void
  }) => {
    controls.change = onChange
    controls.save = onSave
    return <textarea data-testid="file-editor" value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
          event.preventDefault()
          onSave()
        }
      }} />
  },
}))

const ROOT = '/test-project'
const A = `${ROOT}/a.txt`
const B = `${ROOT}/b.txt`

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function file(text = '元の本文', stamp: string | undefined = 's1', path = A): FileContent {
  return { path, text, stamp, writable: true, truncated: false, bytes: text.length }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200 })
}

function network(initial = file()) {
  const files = new Map([[A, initial], [B, file('別の本文', 'b1', B)]])
  const reads = new Map<string, Promise<Response>[]>()
  const writes: { host: string; path: string; stamp: string | null; text: string; result: ReturnType<typeof deferred<Response>> }[] = []
  const requests: { method: string; host: string; path: string }[] = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://test')
    const host = decodeURIComponent(url.pathname.split('/')[3])
    const path = url.searchParams.get('path')!
    const method = init?.method ?? 'GET'
    requests.push({ method, host, path })
    if (method === 'PUT') {
      const result = deferred<Response>()
      writes.push({ host, path, stamp: url.searchParams.get('stamp'), text: String(init?.body), result })
      return result.promise
    }
    return reads.get(path)?.shift() ?? Promise.resolve(json(files.get(path)))
  }))
  return {
    files, writes, requests,
    holdRead(path = A) {
      const result = deferred<Response>()
      reads.set(path, [...(reads.get(path) ?? []), result.promise])
      return result
    },
    async finish(index = 0, response = json({ path: writes[index].path, bytes: writes[index].text.length, stamp: 's2' })) {
      await act(async () => { writes[index].result.resolve(response) })
    },
  }
}

function Viewer({ path = A, host = 'local' }: { path?: string; host?: string }) {
  return <FileView host={host} root={ROOT} path={path} tabs={[A, B]}
    onSelectTab={() => {}} onCloseTab={() => {}} onReorderTab={() => {}} onReorderTabCommit={() => {}} />
}

function type(text: string) {
  fireEvent.change(screen.getByTestId('file-editor'), { target: { value: text } })
}

function save() {
  fireEvent.click(screen.getByTestId('file-save'))
}

function pagehide() {
  act(() => { globalThis.dispatchEvent(new Event('pagehide')) })
}

beforeEach(() => {
  localStorage.clear()
  useAuthStore.setState((state) => ({ auth: { ...state.auth, account: null } }))
  controls.change = null
  controls.save = null
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('FileViewの非同期保存', () => {
  it('保存中の追加入力を残し、送信分だけを基準にして次の保存へ渡す', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('送信した本文')
    save()
    type('保存中に増えた本文')
    pagehide()
    expect(readEditDetails('local', A, null)).toEqual({ text: '保存中に増えた本文', baseStamp: 's1' })
    await api.finish()
    expect(screen.getByTestId('file-editor')).toHaveValue('保存中に増えた本文')
    expect(screen.getByTestId('file-save')).not.toBeDisabled()
    expect(readEditDetails('local', A, null)).toEqual({ text: '保存中に増えた本文', baseStamp: 's2' })
    save()
    expect(api.writes).toHaveLength(2)
    expect(api.writes.map(({ text, stamp }) => ({ text, stamp }))).toEqual([
      { text: '送信した本文', stamp: 's1' }, { text: '保存中に増えた本文', stamp: 's2' },
    ])
    await api.finish(1)
    expect(readEdit('local', A, null)).toBeNull()
    expect(screen.getByTestId('file-save')).toBeDisabled()
  })

  it('保存中に変更して送信文字列へ戻った場合だけ下書きを消す', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('送信した本文')
    save()
    type('いったん変更')
    type('送信した本文')
    await api.finish()
    pagehide()
    expect(screen.getByTestId('file-editor')).toHaveValue('送信した本文')
    expect(readEdit('local', A, null)).toBeNull()
    expect(screen.getByTestId('file-save')).toBeDisabled()
  })

  it('保存中に元の本文へ戻してもpagehideでその入力を失くさない', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('送信した本文')
    save()
    type('元の本文')
    pagehide()
    expect(readEdit('local', A, null)).toBe('元の本文')
    await api.finish()
    expect(screen.getByTestId('file-editor')).toHaveValue('元の本文')
    expect(readEditDetails('local', A, null)).toEqual({ text: '元の本文', baseStamp: 's2' })
    expect(screen.getByTestId('file-save')).not.toBeDisabled()
  })

  it('再描画前に保存を二度呼んでも同じ文書へ一度しか送らない', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('送る本文')
    const invoke = controls.save!
    act(() => { invoke(); invoke() })
    expect(api.writes).toHaveLength(1)
    await api.finish()
    expect(screen.getByTestId('file-save')).toBeDisabled()
  })

  it.each(['成功', '409', '通信失敗'] as const)('AからBへ移った後のAの%sがBの入力と保存状態を汚さない', async (result) => {
    const api = network()
    const view = render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('Aの送信分')
    save()
    view.rerender(<Viewer path={B} />)
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('別の本文'))
    type('Bの編集')
    save()
    expect(api.writes).toHaveLength(2)
    if (result === '通信失敗') {
      await act(async () => { api.writes[0].result.reject(new Error('Aの通信失敗')) })
    } else {
      await api.finish(0, result === '409' ? new Response('Aの競合', { status: 409 }) : json({ path: A, bytes: 6, stamp: 'a2' }))
    }
    expect(screen.getByTestId('file-editor')).toHaveValue('Bの編集')
    expect(screen.getByTestId('file-save')).toHaveTextContent('保存中')
    expect(screen.queryByTestId('file-save-error')).toBeNull()
    expect(readEdit('local', A, null)).toBe('Aの送信分')
    await api.finish(1)
    expect(readEdit('local', B, null)).toBeNull()
  })

  it('AからBを経てAへ戻った新世代に古い保存応答を適用せず、次の保存を直列化する', async () => {
    const api = network()
    const view = render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('古いAの送信分')
    save()
    view.rerender(<Viewer path={B} />)
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('別の本文'))
    view.rerender(<Viewer />)
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('古いAの送信分'))
    type('新しいAの編集')
    save()
    expect(api.writes).toHaveLength(1)
    expect(screen.getByTestId('file-save')).toHaveTextContent('保存中')
    await api.finish()
    expect(api.writes).toHaveLength(2)
    expect(api.writes[1].text).toBe('新しいAの編集')
    expect(api.writes[1].stamp).toBe('s1')
    expect(screen.getByTestId('file-editor')).toHaveValue('新しいAの編集')
    expect(screen.getByTestId('file-save')).toHaveTextContent('保存中')
    await api.finish(1, new Response('新世代で競合', { status: 409 }))
    expect(screen.getByTestId('file-save-error')).toHaveTextContent('新世代で競合')
    pagehide()
    expect(readEditDetails('local', A, null)).toEqual({ text: '新しいAの編集', baseStamp: 's1' })
  })

  it('アンマウント後の成功応答が次の画面の下書きを消さない', async () => {
    const api = network()
    const view = render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('送信分')
    save()
    type('最後の追加入力')
    view.unmount()
    expect(readEdit('local', A, null)).toBe('最後の追加入力')
    await api.finish()
    expect(readEditDetails('local', A, null)).toEqual({ text: '最後の追加入力', baseStamp: 's1' })
  })

  it('accountを切り替えると読み直し、古い応答が新しい口座の下書きを消さない', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('元の口座の編集')
    save()
    act(() => useAuthStore.setState((state) => ({ auth: { ...state.auth, account: 'other' } })))
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('元の本文'))
    type('別の口座の編集')
    await api.finish()
    pagehide()
    expect(screen.getByTestId('file-editor')).toHaveValue('別の口座の編集')
    expect(readEdit('local', A, null)).toBe('元の口座の編集')
    expect(readEdit('local', A, 'other')).toBe('別の口座の編集')
    expect(api.requests.filter(({ method }) => method === 'GET')).toHaveLength(2)
  })

  it('hostを切り替えても古い応答と遅れて届く変更通知を新しい文書へ適用しない', async () => {
    const api = network()
    const view = render(<Viewer />)
    await screen.findByTestId('file-editor')
    const oldChange = controls.change!
    const oldSave = controls.save!
    type('元のホストの編集')
    save()
    view.rerender(<Viewer host="remote" />)
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('元の本文'))
    type('別のホストの編集')
    act(() => { oldChange('遅れて届いた変更'); oldSave() })
    await api.finish()
    pagehide()
    expect(api.writes).toHaveLength(1)
    expect(screen.getByTestId('file-editor')).toHaveValue('別のホストの編集')
    expect(readEdit('local', A, null)).toBe('元のホストの編集')
    expect(readEdit('remote', A, null)).toBe('別のホストの編集')
  })

  it('通信失敗を競合と分けて表示し、入力と下書きを保持する', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('失くせない編集')
    save()
    await act(async () => { api.writes[0].result.reject(new Error('回線が切れました')) })
    expect(screen.getByTestId('file-save-error')).toHaveTextContent('回線が切れました')
    expect(screen.queryByTestId('file-conflict-choice')).toBeNull()
    expect(screen.getByTestId('file-editor')).toHaveValue('失くせない編集')
    pagehide()
    expect(readEdit('local', A, null)).toBe('失くせない編集')
    expect(screen.getByTestId('file-save')).not.toBeDisabled()
  })
})

describe('FileViewの下書き復元と読み直し', () => {
  it('元のstampが一致する下書きは通常保存できる', async () => {
    putEdit('local', A, '前の続き', null, 's1')
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-unsaved')
    expect(screen.queryByTestId('file-conflict-choice')).toBeNull()
    save()
    expect(api.writes[0].stamp).toBe('s1')
    await api.finish()
    expect(screen.queryByTestId('file-unsaved')).toBeNull()
    expect(readEdit('local', A, null)).toBeNull()
  })

  it.each(['stamp違い', '旧形式'] as const)('%sの下書きを最新版stampで黙って保存しない', async (format) => {
    if (format === '旧形式') {
      localStorage.setItem('agentdashboard.file-edits.local', JSON.stringify({ [editKey('local', A)]: '前の続き' }))
    } else {
      putEdit('local', A, '前の続き', null, '古い版')
    }
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    expect(screen.getByTestId('file-editor')).toHaveValue('前の続き')
    expect(screen.getByTestId('file-save')).toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('file-editor'), { key: 's', ctrlKey: true })
    expect(api.writes).toHaveLength(0)
    type('前の続きに追加')
    pagehide()
    expect(readEditDetails('local', A, null)?.baseStamp).toBe(format === '旧形式' ? null : '古い版')
    api.files.set(A, file('外部の最新版', 's3'))
    fireEvent.click(screen.getByTestId('file-overwrite'))
    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect(api.writes[0].stamp).toBe('s3')
    expect(api.writes[0].text).toBe('前の続きに追加')
    await api.finish()
    expect(readEdit('local', A, null)).toBeNull()
  })

  it('上書き前のstamp再取得中に増えた入力も、送信文字列とは別に残す', async () => {
    putEdit('local', A, '上書きする文', null)
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    const read = api.holdRead()
    fireEvent.click(screen.getByTestId('file-overwrite'))
    type('stamp再取得中の追加入力')
    await act(async () => { read.resolve(json(file('他所の文', 's3'))) })
    expect(api.writes[0].text).toBe('上書きする文')
    expect(api.writes[0].stamp).toBe('s3')
    await api.finish()
    expect(screen.getByTestId('file-editor')).toHaveValue('stamp再取得中の追加入力')
    expect(readEditDetails('local', A, null)).toEqual({ text: 'stamp再取得中の追加入力', baseStamp: 's2' })
  })

  it('復元した下書きを明示的に捨てたら、次の編集は現在のstampから始まる', async () => {
    putEdit('local', A, '古い編集', null)
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-unsaved')
    fireEvent.click(screen.getByTestId('file-discard'))
    expect(screen.getByTestId('file-editor')).toHaveValue('元の本文')
    type('新しい編集')
    save()
    expect(api.writes[0].stamp).toBe('s1')
    await api.finish()
  })

  it('ディスクと同じ文字列の下書きは復元せず削除する', async () => {
    putEdit('local', A, '元の本文', null, '古い版')
    network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    expect(screen.queryByTestId('file-unsaved')).toBeNull()
    expect(screen.queryByTestId('file-conflict-choice')).toBeNull()
    expect(readEdit('local', A, null)).toBeNull()
  })

  it('読み直し中の新しい入力は捨てず、基準のstampも勝手に進めない', async () => {
    putEdit('local', A, '復元した編集', null, '古い版')
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    const read = api.holdRead()
    fireEvent.click(screen.getByTestId('file-reload'))
    type('読み直し中の新しい入力')
    await act(async () => { read.resolve(json(file('取り直した本文', 's3'))) })
    expect(screen.getByTestId('file-editor')).toHaveValue('読み直し中の新しい入力')
    expect(screen.getByTestId('file-save-error')).toHaveTextContent('読み直している間に入力')
    pagehide()
    expect(readEditDetails('local', A, null)).toEqual({ text: '読み直し中の新しい入力', baseStamp: '古い版' })
    fireEvent.click(screen.getByTestId('file-reload'))
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('元の本文'))
    type('読み直した後の編集')
    save()
    expect(api.writes).toHaveLength(1)
    expect(api.writes[0].stamp).toBe('s1')
    await api.finish()
  })

  it('読み直し中に文字列を元へ戻しても編集revisionが変わったので捨てない', async () => {
    putEdit('local', A, '復元した編集', null)
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    const read = api.holdRead()
    fireEvent.click(screen.getByTestId('file-reload'))
    type('一度変える')
    type('復元した編集')
    await act(async () => { read.resolve(json(file('別の本文', 's3'))) })
    expect(screen.getByTestId('file-editor')).toHaveValue('復元した編集')
    expect(screen.getByTestId('file-save-error')).toHaveTextContent('編集を残しました')
  })

  it.each(['成功', '失敗'] as const)('AからBからAへ戻る間に届いた古い読み直しの%sを適用しない', async (result) => {
    putEdit('local', A, '前の続き', null, 's0')
    const api = network()
    const view = render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    const read = api.holdRead()
    fireEvent.click(screen.getByTestId('file-reload'))
    view.rerender(<Viewer path={B} />)
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('別の本文'))
    view.rerender(<Viewer />)
    await waitFor(() => expect(screen.getByTestId('file-editor')).toHaveValue('前の続き'))
    type('戻ってからの入力')
    await act(async () => {
      if (result === '成功') read.resolve(json(file('古い読み直しの答え', 's3')))
      else read.reject(new Error('古い読み直しの失敗'))
    })
    expect(screen.getByTestId('file-editor')).toHaveValue('戻ってからの入力')
    expect(screen.getByTestId('file-save-error')).not.toHaveTextContent('古い読み直しの失敗')
    expect(screen.getByTestId('file-reload')).not.toBeDisabled()
    pagehide()
    expect(readEdit('local', A, null)).toBe('戻ってからの入力')
  })

  it('アンマウント後の読み直し応答でも下書きを保持する', async () => {
    putEdit('local', A, '前の続き', null)
    const api = network()
    const view = render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    const read = api.holdRead()
    fireEvent.click(screen.getByTestId('file-reload'))
    type('最後に打った文')
    view.unmount()
    await act(async () => { read.resolve(json(file('取り直した本文', 's3'))) })
    expect(readEdit('local', A, null)).toBe('最後に打った文')
  })
})

describe('FileViewの保存制限と下書き失敗', () => {
  it.each([
    ['書けない', { writable: false }],
    ['部分読込', { truncated: true }],
    ['stampなし', { stamp: undefined }],
    ['stampが空', { stamp: '' }],
  ] as const)('%sは復元した編集があっても再取得で保存制限を回避できない', async (_label, invalid) => {
    putEdit('local', A, '復元した編集', null, 'old')
    const api = network({ ...file(), ...invalid })
    render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    act(() => { controls.change?.('受け付けてはいけない'); controls.save?.() })
    fireEvent.click(screen.getByTestId('file-overwrite'))
    expect(api.requests).toHaveLength(1)
    expect(api.writes).toHaveLength(0)
    expect(readEdit('local', A, null)).toBe('復元した編集')
    if (screen.queryByTestId('file-editor')) {
      expect(screen.getByTestId('file-editor')).toHaveValue('復元した編集')
      fireEvent.keyDown(screen.getByTestId('file-editor'), { key: 's', metaKey: true })
      expect(api.writes).toHaveLength(0)
    }
  })

  it.each([
    ['書けない', { writable: false }],
    ['部分読込', { truncated: true }],
    ['stampなし', { stamp: undefined }],
  ] as const)('明示上書きでも再取得が%sならPUTせず入力を残す', async (_label, invalid) => {
    putEdit('local', A, '復元した編集', null)
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-conflict-choice')
    api.files.set(A, { ...file('最新版', 's3'), ...invalid })
    fireEvent.click(screen.getByTestId('file-overwrite'))
    await waitFor(() => expect(screen.getByTestId('file-save-error')).toHaveTextContent('上書きできません'))
    expect(api.requests).toHaveLength(2)
    expect(api.writes).toHaveLength(0)
    expect(screen.getByTestId('file-editor')).toHaveValue('復元した編集')
  })

  it('debounce書き込みが失敗しても入力を残して通知し、pagehideで再試行する', async () => {
    network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    vi.useFakeTimers()
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('容量不足') })
    type('失くせない本文')
    act(() => { vi.advanceTimersByTime(WRITE_DEBOUNCE_MS) })
    expect(screen.getByTestId('file-draft-error')).toHaveTextContent('下書きをこのブラウザに保存できません')
    expect(screen.queryByTestId('file-save-error')).toBeNull()
    expect(screen.getByTestId('file-editor')).toHaveValue('失くせない本文')
    set.mockRestore()
    pagehide()
    expect(readEditDetails('local', A, null)).toEqual({ text: '失くせない本文', baseStamp: 's1' })
    expect(screen.queryByTestId('file-draft-error')).toBeNull()
  })

  it('保存成功後の下書き削除が失敗しても古い本文を復元せず、pagehideで削除を再試行する', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    type('保存した本文')
    pagehide()
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('拒否') })
    save()
    await api.finish()
    expect(screen.getByTestId('file-draft-error')).toBeInTheDocument()
    expect(screen.getByTestId('file-editor')).toHaveValue('保存した本文')
    expect(screen.getByTestId('file-save')).toBeDisabled()
    expect(screen.queryByTestId('file-unsaved')).toBeNull()
    type('次の入力')
    expect(screen.getByTestId('file-editor')).toHaveValue('次の入力')
    set.mockRestore()
    pagehide()
    expect(readEditDetails('local', A, null)).toEqual({ text: '次の入力', baseStamp: 's2' })
    expect(screen.queryByTestId('file-draft-error')).toBeNull()
  })

  it('pagehideはdebounce前の本文と元stampを確定し、遅い時計が削除済みの本文を戻さない', async () => {
    const api = network()
    render(<Viewer />)
    await screen.findByTestId('file-editor')
    vi.useFakeTimers()
    type('最後の入力')
    expect(readEdit('local', A, null)).toBeNull()
    pagehide()
    expect(readEditDetails('local', A, null)).toEqual({ text: '最後の入力', baseStamp: 's1' })
    save()
    await api.finish()
    act(() => { vi.advanceTimersByTime(WRITE_DEBOUNCE_MS + 1) })
    expect(readEdit('local', A, null)).toBeNull()
    expect(screen.getByTestId('file-editor')).toHaveValue('最後の入力')
  })
})
