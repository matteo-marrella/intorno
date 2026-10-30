import { contextBridge, ipcRenderer } from 'electron'

type Room = { id: string; name: string }
export type ShareSource = {
  id: string
  name: string
  screen: boolean
  thumb: string
  icon: string | null
}
const on = <T>(channel: string, cb: (v: T) => void): (() => void) => {
  const h = (_e: unknown, v: T): void => cb(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api = {
  media: {
    ensure: (): Promise<{ microphone: boolean; camera: boolean }> =>
      ipcRenderer.invoke('media:ensure'),
    status: (): Promise<{ microphone: string; camera: string }> =>
      ipcRenderer.invoke('media:status'),
    openPrivacy: (pane: 'Microphone' | 'Camera' | 'ScreenCapture'): Promise<void> =>
      ipcRenderer.invoke('shell:openPrivacy', pane)
  },
  call: {
    current: (): Promise<Room | null> => ipcRenderer.invoke('call:current'),
    join: (room: Room): void => ipcRenderer.send('call:join', room),
    leave: (): void => ipcRenderer.send('call:leave'),
    onStarted: (cb: (r: Room) => void) => on<Room>('call:started', cb),
    onEnded: (cb: () => void) => on<void>('call:ended', cb)
  },
  bubbles: {
    resize: (w: number, h: number): void => ipcRenderer.send('bubbles:resize', w, h),
    dragStart: (sx: number, sy: number): void => ipcRenderer.send('bubbles:drag-start', sx, sy),
    dragMove: (sx: number, sy: number): void => ipcRenderer.send('bubbles:drag-move', sx, sy),
    geometry: (g: {
      sx: number
      sy: number
      sw: number
      sh: number
      barW: number
      flip: boolean
    }): void =>
      ipcRenderer.send('bubbles:geometry', g),
    onLayout: (cb: (l: { flip: boolean; dx: number }) => void) =>
      on<{ flip: boolean; dx: number }>('bubbles:layout', cb),
    dragEnd: (): void => ipcRenderer.send('bubbles:drag-end'),
    setVisible: (v: boolean): void => ipcRenderer.send('bubbles:visible', v),
    ignoreMouse: (ignore: boolean): void => ipcRenderer.send('bubbles:ignore-mouse', ignore),
    onMuteShortcut: (cb: () => void) => on<void>('shortcut:mute', cb)
  },
  share: {
    pick: (): void => ipcRenderer.send('share:pick'),
    status: (): Promise<string> => ipcRenderer.invoke('share:status'),
    sources: (): Promise<ShareSource[] | null> => ipcRenderer.invoke('share:sources'),
    choose: (id: string): void => ipcRenderer.send('share:choose', id),
    cancel: (): void => ipcRenderer.send('share:cancel'),
    onChosen: (cb: () => void) => on<void>('share:chosen', cb),
    onClose: (cb: () => void) => on<void>('picker:close', cb)
  },
  update: {
    onReady: (cb: (version: string) => void) => on<string>('update:ready', cb),
    onAvailable: (cb: (version: string) => void) => on<string>('update:available', cb),
    install: (): void => ipcRenderer.send('update:install'),
    download: (): void => ipcRenderer.send('update:download')
  },
  auth: {
    onUrl: (cb: (url: string) => void) => on<string>('auth:url', cb)
  },
  settings: {
    get: (): Promise<{ autoLaunch: boolean }> => ipcRenderer.invoke('settings:get'),
    setAutoLaunch: (on: boolean): Promise<boolean> =>
      ipcRenderer.invoke('settings:setAutoLaunch', on)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
