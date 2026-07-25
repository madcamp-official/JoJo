import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type { CaptureSource, SearchRequest, SearchResult, SelectionContext } from '@shared/types'

// preload — 렌더러에 안전한 API 만 노출 (공동)
const api = {
  listWindows: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.WINDOW_LIST),

  openWindowPicker: (): Promise<void> => ipcRenderer.invoke(IPC.OPEN_WINDOW_PICKER),

  closeWindowPicker: (): Promise<void> => ipcRenderer.invoke(IPC.CLOSE_WINDOW_PICKER),

  selectWindow: (source: CaptureSource): Promise<void> =>
    ipcRenderer.invoke(IPC.SELECT_WINDOW, source),

  onWindowSelected: (cb: (source: CaptureSource) => void): (() => void) => {
    const listener = (_e: unknown, source: CaptureSource) => cb(source)
    ipcRenderer.on(IPC.WINDOW_SELECTED, listener)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SELECTED, listener)
  },

  resolveSelection: (point: { x: number; y: number }): Promise<SelectionContext> =>
    ipcRenderer.invoke(IPC.SELECTION_RESOLVED, point),

  search: (ctx: SelectionContext, req: SearchRequest): Promise<SearchResult> =>
    ipcRenderer.invoke(IPC.SEARCH_REQUEST, ctx, req),

  onSearchStream: (cb: (chunk: SearchResult) => void): (() => void) => {
    const listener = (_e: unknown, chunk: SearchResult) => cb(chunk)
    ipcRenderer.on(IPC.SEARCH_STREAM, listener)
    return () => ipcRenderer.removeListener(IPC.SEARCH_STREAM, listener)
  },
}

contextBridge.exposeInMainWorld('nuance', api)
export type NuanceApi = typeof api
