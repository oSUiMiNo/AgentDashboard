export const OPEN_FILE = 'agentdashboard:open-file'

export function requestOpenFile(path: string): void {
  globalThis.dispatchEvent(new CustomEvent<string>(OPEN_FILE, { detail: path }))
}
