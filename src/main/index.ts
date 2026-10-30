import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  systemPreferences,
  session,
  desktopCapturer,
  Tray,
  Menu,
  nativeImage,
  type Rectangle
} from 'electron'
import { join } from 'path'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'

const PROTOCOL = 'intorno'

interface SavedState {
  bubbles?: { x: number; y: number }
}

const statePath = (): string => join(app.getPath('userData'), 'state.json')
function loadState(): SavedState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'))
  } catch {
    return {}
  }
}
function saveState(s: SavedState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(s))
  } catch {
    /* non critico */
  }
}

let lobby: BrowserWindow | null = null
let picker: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let pendingShareId: string | null = null
let bubbles: BrowserWindow | null = null
let currentRoom: { id: string; name: string } | null = null
let pendingAuthUrl: string | null = null
const state = loadState()

function load(win: BrowserWindow, hash = ''): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? '#' + hash : ''))
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

function createLobby(): void {
  lobby = new BrowserWindow({
    width: 360,
    height: 580,
    minWidth: 320,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  lobby.on('ready-to-show', () => lobby?.show())
  lobby.on('close', (e) => {
    if (quitting) return
    e.preventDefault() // si nasconde: la chiamata continua, si riapre dall'icona nella barra
    lobby?.hide()
  })
  lobby.on('closed', () => {
    lobby = null
    bubbles?.close()
  })
  lobby.webContents.setWindowOpenHandler((d) => {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })
  lobby.webContents.on('did-finish-load', () => {
    if (pendingAuthUrl) {
      lobby?.webContents.send('auth:url', pendingAuthUrl)
      pendingAuthUrl = null
    }
  })
  load(lobby)
}

function openBubbles(room: { id: string; name: string }): void {
  if (bubbles) {
    bubbles.removeAllListeners('closed')
    bubbles.close()
  }
  currentRoom = room
  geo = null
  flip = false
  lastLayout = { flip: false, dx: 0 }
  const { workArea } = screen.getPrimaryDisplay()
  const pos = state.bubbles ?? { x: workArea.x + workArea.width - 460, y: workArea.y + 40 }
  const win = new BrowserWindow({
    width: 420,
    height: 240,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false // la pipeline video deve girare anche quando la finestra è coperta
    }
  })
  bubbles = win
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Lo schermo condiviso si apre con window.open('', 'intorno-share'): finestra normale e ridimensionabile.
  win.webContents.setWindowOpenHandler((d) =>
    d.frameName === 'intorno-campfire'
      ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 920,
            height: 640,
            minWidth: 420,
            minHeight: 320,
            frame: true,
            transparent: false,
            hasShadow: true,
            alwaysOnTop: false,
            skipTaskbar: false,
            resizable: true,
            autoHideMenuBar: true,
            backgroundColor: '#080f11'
          }
        }
      : d.frameName === 'intorno-share'
      ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 960,
            height: 600,
            minWidth: 360,
            minHeight: 220,
            frame: true,
            transparent: false,
            hasShadow: true,
            alwaysOnTop: false,
            skipTaskbar: false,
            resizable: true,
            autoHideMenuBar: true,
            backgroundColor: '#080f11'
          }
        }
      : { action: 'deny' }
  )
  // Come in Around: lo schermo condiviso si vede a tutto schermo e le bolle restano sopra (visibili
  // su ogni desktop). Esc o il pulsante verde lo riducono a finestra; F lo rimette a schermo intero.
  win.webContents.on('did-create-window', (child, details) => {
    if (details.frameName !== 'intorno-share') return
    child.setFullScreen(true)
    child.webContents.on('before-input-event', (_e, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'Escape' && child.isFullScreen()) child.setFullScreen(false)
      else if (input.key.toLowerCase() === 'f') child.setFullScreen(!child.isFullScreen())
    })
  })
  win.on('ready-to-show', () => win.showInactive())
  win.on('closed', () => {
    if (bubbles === win) {
      bubbles = null
      currentRoom = null
      docked = null
      stopShareFrame()
    }
    lobby?.webContents.send('call:ended')
    refreshTray()
  })
  const q = new URLSearchParams({ roomId: room.id, roomName: room.name }).toString()
  load(win, `/bubbles?${q}`)
  lobby?.webContents.send('call:started', room)
  refreshTray()
}

function openPicker(): void {
  console.log('[share] apro il selettore')
  if (picker) return picker.focus()
  const W = 560
  const H = 500
  const anchor = bubbles?.getBounds() ?? lobby?.getBounds() ?? { x: 100, y: 100, width: 400, height: 200 }
  const { workArea } = screen.getDisplayMatching(anchor)
  let x = Math.round(anchor.x + anchor.width / 2 - W / 2)
  // Sotto le bolle se c'è spazio, altrimenti sopra
  let y = anchor.y + anchor.height - 12
  if (y + H > workArea.y + workArea.height) y = anchor.y - H + 12
  x = Math.min(Math.max(workArea.x, x), workArea.x + workArea.width - W)
  y = Math.min(Math.max(workArea.y, y), workArea.y + workArea.height - H)

  const win = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  picker = win
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    // Come un popover: si chiude (con animazione) quando perde il focus
    setTimeout(() => win.on('blur', () => win.webContents.send('picker:close')), 400)
  })
  win.on('closed', () => {
    if (picker === win) picker = null
  })
  load(win, '/picker')
}

function showLobby(): void {
  if (!lobby) return createLobby()
  if (lobby.isMinimized()) lobby.restore()
  lobby.show()
  lobby.focus()
}

function refreshTray(): void {
  if (!tray) return
  tray.setToolTip(currentRoom ? `Intorno · ${currentRoom.name}` : 'Intorno')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Apri Intorno', click: showLobby },
      ...(currentRoom
        ? [{ label: `Esci da “${currentRoom.name}”`, click: () => bubbles?.close() }]
        : []),
      { type: 'separator' as const },
      { label: 'Esci da Intorno', click: () => app.quit() }
    ])
  )
}

function handleAuthUrl(url: string): void {
  if (lobby && !lobby.webContents.isLoading()) {
    lobby.webContents.send('auth:url', url)
    if (lobby.isMinimized()) lobby.restore()
    lobby.show()
    lobby.focus()
  } else {
    pendingAuthUrl = url
  }
}

// Una sola istanza + deep link intorno://
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`))
    if (url) handleAuthUrl(url)
    else lobby?.show()
  })
}
app.on('open-url', (e, url) => {
  e.preventDefault()
  handleAuthUrl(url)
})

// Dove vengono pubblicate le release (GitHub). Se il repo cambia proprietario GitHub reindirizza da solo.
const RELEASES = { owner: 'matteo-marrella', repo: 'intorno' }
const newer = (a: string, b: string): boolean => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
let macDownload: string | null = null
/** Mac senza firma: niente installazione automatica, ma l'avviso e il link al .dmg sì. */
async function checkMacUpdate(): Promise<void> {
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES.owner}/${RELEASES.repo}/releases/latest`)
    if (!res.ok) return
    const rel = (await res.json()) as {
      tag_name: string
      assets: { name: string; browser_download_url: string }[]
    }
    const version = rel.tag_name.replace(/^v/, '')
    macDownload = rel.assets.find((a) => a.name.endsWith('-mac.dmg'))?.browser_download_url ?? null
    if (newer(version, app.getVersion())) lobby?.webContents.send('update:available', version)
  } catch {
    /* offline: riproverà */
  }
}

// ---------------------------------------------------------------------------------------------
// Durante una condivisione le bolle vanno in alto a destra (e tornano dopo); chi condivide vede una
// cornice rossa sottile, a LED, attorno allo schermo o alla finestra condivisa.
// ---------------------------------------------------------------------------------------------
let docked: { x: number; y: number } | null = null // posizione "normale" prima dello spostamento
let userMovedWhileDocked = false
let anim: ReturnType<typeof setInterval> | null = null

function animateTo(x: number, y: number, ms = 420): void {
  if (!bubbles) return
  if (anim) clearInterval(anim)
  const from = bubbles.getBounds()
  const t0 = Date.now()
  anim = setInterval(() => {
    if (!bubbles) return void (anim && clearInterval(anim))
    const t = Math.min(1, (Date.now() - t0) / ms)
    const e = 1 - Math.pow(1 - t, 3)
    const b = bubbles.getBounds()
    bubbles.setBounds({
      ...b,
      x: Math.round(from.x + (x - from.x) * e),
      y: Math.round(from.y + (y - from.y) * e)
    })
    if (t >= 1) {
      if (anim) clearInterval(anim)
      anim = null
      applyLayout()
    }
  }, 16)
}

function dockBubbles(on: boolean): void {
  if (!bubbles || !geo) return
  const b = bubbles.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  if (on && !docked) {
    docked = { x: b.x, y: flip ? b.y + RESERVED : b.y }
    userMovedWhileDocked = false
    let y = b.y
    if (flip) {
      // La barra deve stare sotto le bolle quando sono in alto: si toglie il ribaltamento prima di salire
      flip = false
      y = b.y + RESERVED
      geo = { ...geo, sy: geo.sy - RESERVED }
      bubbles.setBounds({ ...b, y })
      lastLayout = { flip: false, dx: lastLayout.dx }
      bubbles.webContents.send('bubbles:layout', lastLayout)
    }
    animateTo(wa.x + wa.width - geo.sx - geo.sw - 16, wa.y + 10 - geo.sy + 6)
  } else if (!on && docked) {
    const back = docked
    docked = null
    if (!userMovedWhileDocked) animateTo(back.x, back.y)
  }
}

let frameWin: BrowserWindow | null = null
let frameTracker: ChildProcess | ReturnType<typeof setInterval> | null = null
let lastChosen: { id: string; displayId?: string } | null = null

function setFrame(b: Rectangle, rounded: boolean): void {
  if (!frameWin) {
    frameWin = new BrowserWindow({
      ...b,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      enableLargerThanScreen: true, // sul Mac altrimenti la cornice non copre la barra dei menu
      backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
    })
    frameWin.setIgnoreMouseEvents(true)
    frameWin.setContentProtection(true) // la cornice non compare nello schermo che vedono gli altri
    frameWin.setAlwaysOnTop(true, 'screen-saver')
    frameWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    frameWin.once('ready-to-show', () => frameWin?.showInactive())
    load(frameWin, `/frame?r=${rounded ? 10 : 0}`)
  } else {
    frameWin.setBounds(b)
    if (!frameWin.isVisible()) frameWin.showInactive()
  }
}

function stopShareFrame(): void {
  if (frameTracker) {
    if (typeof (frameTracker as ChildProcess).kill === 'function') (frameTracker as ChildProcess).kill()
    else clearInterval(frameTracker as ReturnType<typeof setInterval>)
    frameTracker = null
  }
  frameWin?.destroy()
  frameWin = null
}

function startShareFrame(): void {
  stopShareFrame()
  const sel = lastChosen
  if (!sel) return
  if (sel.id.startsWith('screen:')) {
    const d = screen.getAllDisplays().find((x) => String(x.id) === sel.displayId) ?? screen.getPrimaryDisplay()
    setFrame(d.bounds, false)
    return
  }
  // Finestra: se ne segue la posizione (sul Mac dall'id CGWindowID, su Windows dall'HWND)
  const wid = Number(sel.id.split(':')[1])
  if (!wid) return
  if (process.platform === 'darwin') {
    const script =
      "ObjC.import('CoreGraphics');function run(a){const l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionIncludingWindow,Number(a[0]))));if(!l||!l.length)return '';const b=l[0].kCGWindowBounds;return JSON.stringify([b.X,b.Y,b.Width,b.Height]);}"
    let busy = false
    frameTracker = setInterval(() => {
      if (busy) return
      busy = true
      execFile('osascript', ['-l', 'JavaScript', '-e', script, String(wid)], (err, out) => {
        busy = false
        const txt = (out ?? '').trim()
        if (err || !txt) return void frameWin?.hide()
        const [x, y, w, h] = JSON.parse(txt) as number[]
        if (w < 40 || h < 40) return void frameWin?.hide()
        setFrame({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }, true)
      })
    }, 450)
  } else if (process.platform === 'win32') {
    const ps = `Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class W{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);
[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L,T,R,B;}}
'@
$h=[IntPtr]${wid}
while($true){$r=New-Object 'W+RECT'
if([W]::GetWindowRect($h,[ref]$r) -and -not [W]::IsIconic($h)){Write-Output "$($r.L),$($r.T),$($r.R-$r.L),$($r.B-$r.T)"}else{Write-Output 'none'}
Start-Sleep -Milliseconds 400}`
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
      windowsHide: true
    })
    frameTracker = child
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      const last = lines.filter(Boolean).pop()
      if (!last) return
      if (last === 'none') return void frameWin?.hide()
      const [x, y, w, h] = last.split(',').map(Number)
      if (!(w > 40 && h > 40)) return void frameWin?.hide()
      const dip = screen.screenToDipRect(null, { x, y, width: w, height: h })
      setFrame(dip, true)
    })
  }
}

let drag: { sx: number; sy: number; x: number; y: number } | null = null

// Geometria delle bolle dentro la finestra (la manda il renderer). La finestra ha sempre uno spazio
// riservato per barra + riquadri (RESERVED, in sync con app.css): sotto le bolle, o sopra se ribaltata.
interface Geo {
  sx: number
  sy: number
  sw: number
  sh: number
  barW: number
  flip: boolean // layout con cui il renderer ha misurato: scarta le misure vecchie
}
const RESERVED = 314 // dock 116 + margine 8 + riquadri 190 (in sync con app.css e Bubbles.tsx)
let geo: Geo | null = null
let flip = false
let lastLayout = { flip: false, dx: 0 }

/** Tiene le bolle (non tutta la finestra, che è più larga) dentro l'area utile dello schermo. */
function clampPos(b: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  if (!geo) return { x: b.x, y: b.y }
  const wa = screen.getDisplayMatching(b).workArea
  const x = Math.min(Math.max(b.x, wa.x - geo.sx), wa.x + wa.width - geo.sx - geo.sw)
  // In alto macOS non lascia salire sopra la barra dei menu; in basso le bolle devono restare visibili
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - geo.sy - geo.sh)
  return { x: Math.round(x), y: Math.round(y) }
}

/** Decide da che lato sta la barra e di quanto va spostata di lato per restare sullo schermo. */
function applyLayout(): void {
  if (!bubbles || !geo) return
  let b = bubbles.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const space = wa.y + wa.height - (b.y + geo.sy + geo.sh)
  const want = flip ? space < RESERVED + 96 : space < RESERVED + 16
  if (want !== flip) {
    flip = want
    const dy = want ? -RESERVED : RESERVED
    geo = { ...geo, sy: geo.sy - dy }
    b = { ...b, y: b.y + dy }
    bubbles.setBounds(b) // le bolle restano ferme sullo schermo
    if (drag) drag.y += dy
  }
  const center = b.x + geo.sx + geo.sw / 2
  const left = center - geo.barW / 2
  const clamped = Math.min(Math.max(left, wa.x + 8), wa.x + wa.width - 8 - geo.barW)
  const dx = Math.round(clamped - left)
  if (flip !== lastLayout.flip || dx !== lastLayout.dx) {
    lastLayout = { flip, dx }
    bubbles.webContents.send('bubbles:layout', lastLayout)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('it.crowdplus.intorno')

  // Alcuni router/DNS aziendali non risolvono *.supabase.co: l'app usa prima il DNS cifrato (DoH)
  // e ricade su quello di sistema solo se non risponde. Così non serve configurare nulla.
  app.configureHostResolver({
    secureDnsMode: 'automatic',
    secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query']
  })
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [join(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }

  // Solo permessi che servono all'app
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(['media', 'display-capture', 'mediaKeySystem'].includes(permission))
  )

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  ipcMain.handle('media:ensure', async () => {
    if (process.platform !== 'darwin') return { microphone: true, camera: true }
    const microphone = await systemPreferences.askForMediaAccess('microphone')
    const camera = await systemPreferences.askForMediaAccess('camera')
    return { microphone, camera }
  })
  ipcMain.handle('media:status', () =>
    process.platform === 'darwin'
      ? {
          microphone: systemPreferences.getMediaAccessStatus('microphone'),
          camera: systemPreferences.getMediaAccessStatus('camera')
        }
      : { microphone: 'granted', camera: 'granted' }
  )
  ipcMain.handle('shell:openPrivacy', (_e, pane: 'Microphone' | 'Camera' | 'ScreenCapture') => {
    if (process.platform === 'darwin')
      shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?Privacy_${pane}`)
    else if (pane !== 'ScreenCapture') shell.openExternal(`ms-settings:privacy-${pane.toLowerCase()}`)
  })

  // --- Condivisione schermo
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const id = pendingShareId
      pendingShareId = null
      if (!id) return callback({}) // solo dopo una scelta esplicita nel selettore
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const source = sources.find((x) => x.id === id)
      callback(source ? { video: source } : {})
    },
    { useSystemPicker: false }
  )
  ipcMain.on('share:pick', () => {
    console.log('[share] richiesta dal renderer')
    openPicker()
  })
  ipcMain.handle('share:status', () =>
    process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
  )
  ipcMain.handle('share:sources', async () => {
    const own = new Set(
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => w.getMediaSourceId())
    )
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 360, height: 225 },
        fetchWindowIcons: true
      })
      return sources
        .filter((x) => !own.has(x.id))
        .map((x) => ({
          id: x.id,
          name: x.name,
          screen: x.id.startsWith('screen:'),
          thumb: x.thumbnail.toDataURL(),
          icon: x.appIcon && !x.appIcon.isEmpty() ? x.appIcon.toDataURL() : null
        }))
    } catch (e) {
      // Su macOS capita quando manca il permesso Registrazione schermo
      console.warn('[share] getSources fallito:', (e as Error).message)
      return null
    }
  })
  ipcMain.on('share:choose', (_e, id: string) => {
    console.log('[share] scelta', id)
    pendingShareId = id
    lastChosen = { id }
    // Serve per sapere su quale schermo disegnare la cornice
    desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then((srcs) => {
        const src = srcs.find((x) => x.id === id)
        if (lastChosen?.id === id) lastChosen.displayId = src?.display_id
      })
      .catch(() => {})
    picker?.close()
    bubbles?.webContents.send('share:chosen')
  })
  ipcMain.on('share:cancel', () => picker?.close())
  ipcMain.on('share:started', () => startShareFrame())
  ipcMain.on('share:stopped', () => stopShareFrame())
  ipcMain.on('bubbles:dock', (_e, on: boolean) => dockBubbles(on))

  ipcMain.handle('call:current', () => currentRoom)
  ipcMain.on('call:join', (_e, room: { id: string; name: string }) => openBubbles(room))
  ipcMain.on('call:leave', () => bubbles?.close())

  ipcMain.on('bubbles:resize', (_e, w: number, h: number) => {
    if (!bubbles) return
    const b = bubbles.getBounds()
    const width = Math.max(80, Math.ceil(w))
    const height = Math.max(80, Math.ceil(h))
    if (b.width === width && b.height === height) return
    // Le bolle stanno al centro della finestra: se la larghezza cambia, restano ferme sullo schermo.
    const next = { ...b, width, height, x: Math.round(b.x - (width - b.width) / 2) }
    bubbles.setBounds(next)
    drag = drag && { ...drag, x: next.x }
  })
  ipcMain.on('bubbles:geometry', (_e, g: Geo) => {
    if (g.flip !== flip) return // misura fatta prima dell'ultimo ribaltamento: arriverà quella giusta
    geo = g
    if (!bubbles) return
    // Se la posizione salvata è fuori schermo, riporta le bolle dentro
    const b = bubbles.getBounds()
    const c = clampPos(b)
    if (c.x !== b.x || c.y !== b.y) bubbles.setBounds({ ...b, ...c })
    applyLayout()
  })
  ipcMain.on('bubbles:drag-start', (_e, sx: number, sy: number) => {
    if (!bubbles) return
    if (anim) (clearInterval(anim), (anim = null))
    const b = bubbles.getBounds()
    drag = { sx, sy, x: b.x, y: b.y }
  })
  ipcMain.on('bubbles:drag-move', (_e, sx: number, sy: number) => {
    if (!bubbles || !drag) return
    const b = bubbles.getBounds()
    const pos = clampPos({ ...b, x: Math.round(drag.x + sx - drag.sx), y: Math.round(drag.y + sy - drag.sy) })
    bubbles.setBounds({ ...b, ...pos })
    applyLayout()
  })
  ipcMain.on('bubbles:drag-end', () => {
    if (docked) userMovedWhileDocked = true // l'ha spostato lui: non lo riporto indietro da solo
    if (bubbles && drag) {
      const { x, y } = bubbles.getBounds()
      // Salvo la posizione "normale" (barra sotto): se è ribaltata la finestra sta più in alto
      state.bubbles = { x, y: flip ? y + RESERVED : y }
      saveState(state)
    }
    drag = null
  })
  ipcMain.on('bubbles:visible', (_e, visible: boolean) => {
    if (!bubbles) return
    if (visible) bubbles.showInactive()
    else bubbles.hide()
  })
  ipcMain.on('bubbles:ignore-mouse', (_e, ignore: boolean) =>
    bubbles?.setIgnoreMouseEvents(ignore, { forward: true })
  )

  ipcMain.handle('settings:get', () => ({
    autoLaunch: app.getLoginItemSettings().openAtLogin
  }))
  ipcMain.handle('settings:setAutoLaunch', (_e, on: boolean) => {
    app.setLoginItemSettings({ openAtLogin: on })
    return app.getLoginItemSettings().openAtLogin
  })

  globalShortcut.register('CommandOrControl+Shift+M', () =>
    bubbles?.webContents.send('shortcut:mute')
  )

  // Aggiornamenti automatici (Windows): l'app controlla all'avvio e ogni 4 ore, scarica e chiede di riavviare.
  // Su macOS senza firma del codice l'installazione automatica non è possibile: l'app avvisa soltanto.
  if (app.isPackaged) {
    autoUpdater.autoDownload = process.platform === 'win32'
    autoUpdater.on('update-downloaded', (info) => lobby?.webContents.send('update:ready', info.version))
    autoUpdater.on('error', (e) => console.warn('[update]', e.message))
    const check = (): void =>
      process.platform === 'win32'
        ? void autoUpdater.checkForUpdates().catch(() => {})
        : void checkMacUpdate()
    setTimeout(check, 8000)
    setInterval(check, 4 * 60 * 60 * 1000)
  }
  ipcMain.on('update:download', () => {
    if (macDownload) shell.openExternal(macDownload)
  })
  ipcMain.on('update:install', () => {
    quitting = true
    autoUpdater.quitAndInstall(false, true)
  })

  createLobby()
  const trayIcon = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 })
  tray = new Tray(trayIcon)
  tray.on('click', showLobby)
  refreshTray()
  app.on('activate', showLobby)
})

app.on('before-quit', () => (quitting = true))
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
