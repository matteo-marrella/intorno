import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AudioLines,
  Eye,
  EyeOff,
  Hand,
  LayoutGrid,
  MessageCircle,
  MoreHorizontal,
  Smile,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Send,
  Sparkles,
  UserMinus,
  Video,
  VideoOff,
  Volume2,
  X
} from 'lucide-react'
import { iceServers, supabase } from '../lib/supabase'
import { useMe } from '../lib/session'
import { BUBBLE_PX, usePrefs } from '../lib/prefs'
import { MeshCall, type PeerInfo } from '../lib/mesh'
import { blip, watchLevel } from '../lib/audio'
import { VideoPipeline, type Framing, type VideoFilter } from '../lib/pipeline'
import { VoiceIsolator } from '../lib/voice'
import { useChildWindow } from '../lib/childWindow'
import { Campfire } from './Campfire'

const EMOJI = ['👍', '😂', '🔥', 'ok.']
const CALM_EMOJI = '🙄'
const CALM_PHRASE = 'sì però stai calmo'

interface Floating {
  key: number
  from: string
  emoji: string
  x: number
}
interface ChatMsg {
  id: string
  from: string
  name: string
  body: string
  at: number
}

type Panel = 'react' | 'fx' | 'chat' | 'more' | null
// Altezza riservata a barra + riquadri (in sync con RESERVED nel processo principale)
const RESERVED = 314
/** Diametro massimo perché tutte le bolle stiano nello schermo (da soli: quasi tutta l'altezza). */
function fitMax(n: number): number {
  const w = window.screen.availWidth
  const h = window.screen.availHeight
  return Math.max(64, Math.floor(Math.min((w - 60) / Math.max(1, n) - 36, h - RESERVED - 70)))
}

export default function Bubbles(): React.JSX.Element {
  const q = useMemo(() => new URLSearchParams(location.hash.split('?')[1]), [])
  const roomId = q.get('roomId')!
  const roomName = q.get('roomName') ?? ''
  const { me } = useMe()
  // Id di sessione: la stessa persona può entrare da due computer senza sovrapporsi
  const instance = useRef(Math.random().toString(36).slice(2, 8))
  const selfId = me ? `${me.id}:${instance.current}` : ''
  const [prefs, setPrefs] = usePrefs()

  const [peers, setPeers] = useState<PeerInfo[]>([])
  const maxPx = fitMax(peers.length)
  const px = Math.min(Math.max(prefs.px ?? BUBBLE_PX[prefs.size], 64), maxPx)
  const pxRef = useRef(px)
  pxRef.current = px
  const setPx = (v: number): void => setPrefs({ px: Math.round(Math.min(Math.max(v, 64), fitMax(peers.length))) })
  const setPxRef = useRef(setPx)
  setPxRef.current = setPx
  // peer → (id stream → stream): la camera e l'eventuale schermo condiviso arrivano come stream distinti
  const [streams, setStreams] = useState<Record<string, Record<string, MediaStream>>>({})
  const [myShare, setMyShare] = useState<string | null>(null)
  const shareWin = useRef<Window | null>(null)
  const [local, setLocal] = useState<MediaStream | null>(null)
  const [muted, setMuted] = useState(false)
  const mutedRef = useRef(false)
  const [camOff, setCamOff] = useState(false)
  const [hand, setHand] = useState(false)
  const [isolation, setIsolation] = useState(true) // isolamento della voce
  const isoRef = useRef<VoiceIsolator | null>(null)
  const [hideSelf, setHideSelf] = useState(false)
  const [campfire, setCampfire] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [hover, setHover] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [filter, setFilter] = useState<VideoFilter>('bw')
  const pipelineRef = useRef<VideoPipeline | null>(null)
  const framings = useRef<Record<string, Framing>>({}) // inquadratura del viso di ciascuno
  const stripRef = useRef<HTMLDivElement>(null)
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const [layout, setLayout] = useState({ flip: false, dx: 0 }) // deciso dal processo principale
  const [dragging, setDragging] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [volumes, setVolumes] = useState<Record<string, number>>({})
  const [floating, setFloating] = useState<Floating[]>([])
  const [chats, setChats] = useState<Record<string, ChatMsg>>({}) // ultimo messaggio accanto a ogni bolla
  const [history, setHistory] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState('')
  const call = useRef<MeshCall | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  mutedRef.current = muted

  // --- Avvio chiamata
  useEffect(() => {
    if (!me?.ready) return // aspetta il nome definitivo dal profilo
    let cancelled = false
    let stream: MediaStream | null = null
    let mesh: MeshCall | null = null
    let pipeline: VideoPipeline | null = null
    let iso: VoiceIsolator | null = null
    ;(async () => {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio,
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        })
      } catch (camErr) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio })
          setCamOff(true)
          const e = camErr as DOMException
          setNotice(`Camera non disponibile (${e.name}${e.message ? ': ' + e.message : ''}). Entri solo con l’audio.`)
        } catch {
          setError('Microfono non disponibile. Controlla i permessi di sistema.')
          return
        }
      }
      if (cancelled) return stream.getTracks().forEach((t) => t.stop())
      // Audio originale + video ritagliato sul viso (canvas) = ciò che vedono gli altri.
      const camTrack = stream.getVideoTracks()[0]
      if (camTrack) pipeline = pipelineRef.current = new VideoPipeline(camTrack)
      // Voce isolata (rete neurale in locale): via rumore di fondo e suoni del computer
      const mic = stream.getAudioTracks()[0]
      if (mic) iso = isoRef.current = await VoiceIsolator.create(mic)
      if (cancelled) {
        iso?.stop()
        return stream.getTracks().forEach((t) => t.stop())
      }
      const outgoing = new MediaStream([
        ...(iso ? [iso.track] : stream.getAudioTracks()),
        ...(pipeline ? [pipeline.track] : [])
      ])
      setLocal(outgoing)
      mesh = new MeshCall(
        roomId,
        {
          id: selfId,
          userId: me.id,
          name: me.name,
          muted: false,
          camOff: !pipeline,
          sharing: null,
          sharingAt: null,
          hand: false
        },
        outgoing,
        iceServers(),
        {
          onPeers: setPeers,
          onStream: (id, s) => setStreams((m) => ({ ...m, [id]: { ...m[id], [s.id]: s } })),
          onPeerGone: (id) => {
            setStreams((m) => {
              const { [id]: _drop, ...rest } = m
              return rest
            })
            setChats((c) => {
              const { [id]: _drop, ...rest } = c
              return rest
            })
            delete framings.current[id]
          },
          onJoin: () => blip('join'),
          onLeave: () => blip('leave'),
          onReaction: (from, emoji) => addReaction(from, emoji),
          onChat: (m) => receiveChat({ id: `${m.from}:${m.at}`, ...m }),
          onChatClear: (from) =>
            setChats((c) => {
              const { [from]: _drop, ...rest } = c
              return rest
            }),
          onKick: () => window.api.call.leave(),
          onFraming: (id, f) => (framings.current[id] = f)
        }
      )
      call.current = mesh
      if (pipeline) pipeline.onFraming = (f) => mesh?.sendFraming(f)
      mesh.setBubbleSize(px)
      try {
        await mesh.join()
      } catch (e) {
        setError(`Connessione non riuscita: ${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      mesh?.leave()
      pipeline?.stop()
      pipelineRef.current = null
      iso?.stop()
      isoRef.current = null
      stream?.getTracks().forEach((t) => t.stop())
      call.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, me?.ready])

  useEffect(() => call.current?.setBubbleSize(px), [px])

  // --- Mic / camera / mano / luogo
  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m
      mutedRef.current = next
      local?.getAudioTracks().forEach((t) => (t.enabled = !next))
      call.current?.updateMe({ muted: next })
      return next
    })
  }, [local])
  const toggleCam = (): void => {
    const tracks = local?.getVideoTracks() ?? []
    if (!tracks.length) return
    const next = !camOff
    tracks.forEach((t) => (t.enabled = !next))
    setCamOff(next)
    call.current?.updateMe({ camOff: next })
  }
  useEffect(() => isoRef.current?.setEnabled(isolation), [isolation, local])
  const toggleHand = useCallback(() => {
    setHand((h) => {
      call.current?.updateMe({ hand: !h })
      return !h
    })
  }, [])
  useEffect(() => window.api.bubbles.onMuteShortcut(toggleMute), [toggleMute])
  // Tasto H = mano alzata (come in Around)
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (e.key.toLowerCase() !== 'h' || e.metaKey || e.ctrlKey || e.altKey) return
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return
      toggleHand()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [toggleHand])

  const leaveCall = (): void => {
    if (prefs.confirmLeave && !window.confirm('Vuoi uscire dalla stanza?')) return
    window.api.call.leave()
  }

  // --- Condivisione schermo: chi inizia dopo prende il posto di chi condivideva (come Around)
  const stopShare = useCallback(() => {
    call.current?.stopShare()
    window.api.share.stopped()
    setMyShare(null)
  }, [])
  const toggleShare = (): void => {
    if (myShare) return stopShare()
    window.api.share.pick()
  }
  useEffect(
    () =>
      window.api.share.onChosen(async () => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 15 } },
            audio: false
          })
          stream.getVideoTracks().forEach((t) => ((t as MediaStreamTrack & { contentHint: string }).contentHint = 'detail'))
          stream.getVideoTracks()[0].addEventListener('ended', stopShare)
          call.current?.startShare(stream)
          window.api.share.started() // cornice rossa attorno a ciò che condividi
          setMyShare(stream.id)
        } catch (e) {
          setNotice(`Condivisione non riuscita (${(e as DOMException).name}). Controlla il permesso Registrazione schermo.`)
        }
      }),
    [stopShare]
  )
  // Se qualcun altro inizia dopo di me, cedo il posto
  useEffect(() => {
    if (!myShare) return
    const mine = peers.find((p) => p.id === selfId)?.sharingAt ?? 0
    const newer = peers.find((p) => p.id !== selfId && p.sharing && (p.sharingAt ?? 0) > mine)
    if (newer) {
      stopShare()
      setNotice(`${newer.name} ha iniziato a condividere lo schermo.`)
    }
  }, [peers, myShare, selfId, stopShare])

  // Chi guarda: lo schermo condiviso si apre a tutto schermo; le bolle restano sopra su ogni desktop.
  const sharer = peers
    .filter((p) => p.sharing && p.id !== selfId)
    .sort((a, b) => (b.sharingAt ?? 0) - (a.sharingAt ?? 0))[0]
  const shareStream = sharer ? streams[sharer.id]?.[sharer.sharing!] : undefined
  const openShareWindow = useCallback(() => {
    if (!sharer || !shareStream) return
    const w =
      shareWin.current && !shareWin.current.closed
        ? shareWin.current
        : window.open('', 'intorno-share', 'width=960,height=600')
    if (!w) return
    shareWin.current = w
    w.document.title = `Schermo di ${sharer.name}`
    w.document.body.style.cssText = 'margin:0;background:#080f11;height:100vh;overflow:hidden'
    let v = w.document.querySelector('video')
    if (!v) {
      v = w.document.createElement('video')
      v.autoplay = true
      v.muted = true
      v.playsInline = true
      v.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block'
      w.document.body.append(v)
    }
    v.srcObject = shareStream
    w.focus()
  }, [sharer, shareStream])
  const openedFor = useRef<string | null>(null)
  useEffect(() => {
    if (shareStream && openedFor.current !== shareStream.id) {
      openedFor.current = shareStream.id
      openShareWindow()
    }
    if (!sharer && shareWin.current) {
      shareWin.current.close()
      shareWin.current = null
      openedFor.current = null
    }
  }, [shareStream, sharer, openShareWindow])
  useEffect(() => () => shareWin.current?.close(), [])

  // Durante una condivisione (mia o di altri) le bolle vanno in alto a destra e poi tornano
  const anyShare = !!myShare || !!sharer
  useEffect(() => {
    window.api.bubbles.dock(anyShare)
  }, [anyShare])

  // --- Campfire: vista a griglia in una finestra normale
  const campWin = useChildWindow(campfire, 'intorno-campfire', 'width=920,height=640', `Intorno · ${roomName}`, () =>
    setCampfire(false)
  )
  // Le bolle si nascondono mentre c'è Campfire, ma restano visibili sopra uno schermo condiviso
  useEffect(() => {
    window.api.bubbles.setVisible(!campfire || !!sharer)
  }, [campfire, sharer])

  // --- Reazioni, filtri
  function addReaction(from: string, emoji: string): void {
    const key = Date.now() + Math.random()
    setFloating((f) => [...f, { key, from, emoji, x: Math.random() * 40 - 20 }])
    setTimeout(() => setFloating((f) => f.filter((r) => r.key !== key)), 3200)
  }
  const chooseFilter = (f: VideoFilter): void => {
    setFilter(f)
    if (pipelineRef.current) pipelineRef.current.filter = f
  }
  const react = (emoji: string): void => {
    if (!me) return
    call.current?.sendReaction(emoji)
    addReaction(selfId, emoji)
    setPanel(null)
  }
  const calm = (): void => react(CALM_PHRASE)

  // --- Chat: il messaggio resta accanto alla bolla finché non lo togli; lo storico è nel database
  function receiveChat(m: ChatMsg): void {
    setChats((c) => ({ ...c, [m.from]: m }))
    setHistory((h) => [...h.slice(-49), m])
  }
  useEffect(() => {
    if (panel !== 'chat' || history.length) return
    supabase
      .from('room_messages')
      .select('id,body,created_at,profiles(display_name)')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        const rows = (data ?? []).reverse().map((r) => ({
          id: String(r.id),
          from: '',
          name: (r.profiles as unknown as { display_name?: string } | null)?.display_name ?? '…',
          body: r.body as string,
          at: new Date(r.created_at as string).getTime()
        }))
        setHistory((h) => (h.length ? h : rows))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel])
  const sendChat = (e: React.FormEvent): void => {
    e.preventDefault()
    const body = draft.trim()
    if (!body || !me || !call.current) return
    const m = call.current.sendChat(body)
    receiveChat({ id: `${m.from}:${m.at}`, ...m })
    supabase
      .from('room_messages')
      .insert({ room_id: roomId, user_id: me.id, body })
      .then(({ error }) => error && console.warn('chat', error.message))
    setDraft('')
  }
  const dismissChat = (id: string): void => {
    if (id === selfId) call.current?.sendChatClear()
    setChats((c) => {
      const { [id]: _drop, ...rest } = c
      return rest
    })
  }

  // --- Ridimensionare le bolle: rotella/pizzico sopra le bolle, oppure la maniglia che compare in hover
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setPxRef.current(pxRef.current - e.deltaY * (e.ctrlKey ? 2.2 : 0.7))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const gripStart = useRef<{ x: number; px: number } | null>(null)
  const onGripDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    gripStart.current = { x: e.screenX + e.screenY, px }
  }
  const onGripMove = (e: React.PointerEvent): void => {
    const g = gripStart.current
    if (g) setPx(g.px + (e.screenX + e.screenY - g.x) / 2)
  }
  const onGripUp = (): void => {
    gripStart.current = null
  }

  // --- Dimensione finestra = contenuto
  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(() => window.api.bubbles.resize(el.offsetWidth, el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- Click-through sulle zone trasparenti
  useEffect(() => {
    let ignoring = false
    const set = (v: boolean): void => {
      if (v !== ignoring) {
        ignoring = v
        window.api.bubbles.ignoreMouse(v)
      }
    }
    const onMove = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      set(!t.closest('[data-hit]'))
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  // --- Trascinamento del gruppo
  const onDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('button,input')) return
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    window.api.bubbles.dragStart(e.screenX, e.screenY)
    downAt.current = { x: e.screenX, y: e.screenY }
  }
  const onMove = (e: React.PointerEvent): void => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    window.api.bubbles.dragMove(e.screenX, e.screenY)
    const d = downAt.current
    if (d && !dragging && Math.hypot(e.screenX - d.x, e.screenY - d.y) > 4) setDragging(true) // un semplice click non è un trascinamento
  }
  const onUp = (e: React.PointerEvent): void => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      window.api.bubbles.dragEnd()
      setDragging(false)
    }
  }

  useEffect(() => window.api.bubbles.onLayout(setLayout), [])

  // Comunica al processo principale dove stanno le bolle nella finestra: serve a tenerle dentro lo schermo
  const lastGeo = useRef('')
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const r = strip.getBoundingClientRect()
    const barW = root.current?.querySelector<HTMLElement>('.bar')?.offsetWidth ?? 340
    const g = {
      sx: Math.round(r.left),
      sy: Math.round(r.top),
      sw: Math.round(r.width),
      sh: Math.round(r.height),
      barW,
      flip: layout.flip
    }
    const key = JSON.stringify(g)
    if (key !== lastGeo.current) {
      lastGeo.current = key
      window.api.bubbles.geometry(g)
    }
  })

  const showControls = !prefs.compact && !dragging && (hover || panel !== null || menuFor !== null)
  const enter = (): void => {
    clearTimeout(hideTimer.current)
    setHover(true)
  }
  const leave = (): void => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      setHover(false)
      setPanel(null)
      setMenuFor(null)
    }, 1200)
  }

  if (error)
    return (
      <div ref={root} className="bubbles">
        <div className="toast" data-hit>
          {error}
          <button className="btn" onClick={() => window.api.call.leave()}>
            Chiudi
          </button>
        </div>
      </div>
    )

  const self: PeerInfo | null = me
    ? {
        id: selfId,
        userId: me.id,
        name: me.name,
        muted,
        camOff,
        sharing: myShare,
        sharingAt: null,
        hand
      }
    : null
  const remote = peers.filter((p) => p.id !== selfId)
  const everyone = self ? [self, ...remote] : remote
  const visible = hideSelf && remote.length > 0 ? remote : everyone // l'anteprima si nasconde solo se non sei solo
  const camStream = (p: PeerInfo): MediaStream | undefined => {
    if (p.id === selfId) return local ?? undefined
    const set = Object.values(streams[p.id] ?? {}).filter((s) => s.id !== p.sharing)
    return set.find((s) => s.getAudioTracks().length) ?? set[0]
  }
  const menuTarget = everyone.find((p) => p.id === menuFor)
  const kick = (p: PeerInfo): void => {
    if (!window.confirm(`Rimuovere ${p.name} dalla stanza?`)) return
    call.current?.sendKick(p.id)
    setMenuFor(null)
  }

  return (
    <div
      ref={root}
      className={`bubbles ${layout.flip ? 'flip' : ''} ${dragging ? 'dragging' : ''}`}
      style={{ ['--bubble' as string]: `${px}px` }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {notice && (
        <div className="toast" data-hit style={{ marginBottom: 8 }}>
          {notice}
          <button className="btn" onClick={() => setNotice('')}>
            OK
          </button>
        </div>
      )}
      <div ref={stripRef} className="strip" data-hit onMouseEnter={enter} onMouseLeave={leave}>
        {visible.map((p) => (
          <Bubble
            key={p.id}
            info={p}
            isSelf={p.id === selfId}
            stream={camStream(p)}
            sharing={!!p.sharing}
            onOpenShare={p.id === selfId ? stopShare : openShareWindow}
            volume={volumes[p.id] ?? 1}
            reactions={floating.filter((f) => f.from === p.id)}
            chat={chats[p.id]}
            getFraming={() => (p.id === selfId ? pipelineRef.current?.framing : framings.current[p.id])}
            onDismissChat={() => dismissChat(p.id)}
            onContext={() => setMenuFor(p.id)}
          />
        ))}
        <button
          className="grip"
          title="Trascina o usa la rotella per ridimensionare"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
        />
      </div>

      {!prefs.compact && (
        <div className="controls" style={{ ['--dx' as string]: `${layout.dx}px` }}>
          <div className={`dock ${showControls ? 'show' : ''}`}>
            {menuTarget ? (
              <div className="bar" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                {menuTarget.id === selfId ? (
                  <>
                    <span className="bar-name">Tu</span>
                    <button
                      className="ctl wide"
                      disabled={remote.length === 0}
                      onClick={() => (setHideSelf((h) => !h), setMenuFor(null))}
                    >
                      {hideSelf ? <Eye size={16} /> : <EyeOff size={16} />}
                      {hideSelf ? 'Mostra la mia anteprima' : 'Nascondi la mia anteprima'}
                    </button>
                  </>
                ) : (
                  <>
                    <Volume2 size={16} />
                    <span className="bar-name">{menuTarget.name}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={volumes[menuTarget.id] ?? 1}
                      onChange={(e) => setVolumes((v) => ({ ...v, [menuTarget.id]: Number(e.target.value) }))}
                    />
                    <button className="ctl wide leave" onClick={() => kick(menuTarget)} title="Rimuovi dalla stanza">
                      <UserMinus size={16} /> Rimuovi
                    </button>
                  </>
                )}
                <button className="ctl" onClick={() => setMenuFor(null)}>
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div className="bar pro" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                <span className="bar-title">{roomName}</span>
                {/* Le funzioni principali, grandi: microfono, camera, schermo e il cambio di vista (bolle ⇄ Campfire) */}
                <div
                  className="bar-main"
                  onMouseEnter={() => setPanel((p) => (p === 'react' || p === 'fx' ? null : p))}
                >
                  <button className={`ctl big ${muted ? 'off' : ''}`} onClick={toggleMute} title="Microfono (⌘⇧M)">
                    {muted ? <MicOff size={22} /> : <Mic size={22} />}
                  </button>
                  <button className={`ctl big ${camOff ? 'off' : ''}`} onClick={toggleCam} title="Camera">
                    {camOff ? <VideoOff size={22} /> : <Video size={22} />}
                  </button>
                  <button
                    className={`ctl big ${myShare ? 'on' : ''}`}
                    onClick={toggleShare}
                    title={myShare ? 'Interrompi condivisione' : 'Condividi schermo'}
                  >
                    {myShare ? <ScreenShareOff size={22} /> : <ScreenShare size={22} />}
                  </button>
                  <button
                    className={`ctl big ${campfire ? 'on' : ''}`}
                    onClick={() => setCampfire((c) => !c)}
                    title={campfire ? 'Torna alle bolle' : 'Vista Campfire'}
                  >
                    <LayoutGrid size={22} />
                  </button>
                </div>
                {/* Il resto: piccolo. Effetti e reazioni si aprono passandoci sopra */}
                <div className="bar-sub">
                  <button
                    className={`ctl sm ${panel === 'fx' || filter !== 'none' ? 'on' : ''}`}
                    onMouseEnter={() => setPanel('fx')}
                    onClick={() => setPanel((p) => (p === 'fx' ? null : 'fx'))}
                    title="Effetti e filtri"
                  >
                    <Sparkles size={16} />
                  </button>
                  <button
                    className={`ctl sm ${panel === 'react' ? 'on' : ''}`}
                    onMouseEnter={() => setPanel('react')}
                    onClick={() => setPanel((p) => (p === 'react' ? null : 'react'))}
                    title="Reazioni"
                  >
                    <Smile size={16} />
                  </button>
                  <button
                    className={`ctl sm ${panel === 'chat' ? 'on' : ''}`}
                    onMouseEnter={() => setPanel((p) => (p === 'react' || p === 'fx' ? null : p))}
                    onClick={() => setPanel((p) => (p === 'chat' ? null : 'chat'))}
                    title="Chat"
                  >
                    <MessageCircle size={16} />
                  </button>
                  <button
                    className={`ctl sm ${panel === 'more' ? 'on' : ''}`}
                    onMouseEnter={() => setPanel((p) => (p === 'react' || p === 'fx' ? null : p))}
                    onClick={() => setPanel((p) => (p === 'more' ? null : 'more'))}
                    title="Altro"
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  <span className="sep" />
                  <button className="ctl sm leave" onClick={leaveCall} title="Esci dalla stanza">
                    <PhoneOff size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Spazio riservato ai riquadri: sotto la barra, o sopra se la barra è ribaltata. */}
          <div className={`tray ${panel ? 'show' : ''}`}>
            {panel === 'react' && (
              <div className="fx-pop" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                <div className="emoji-row">
                  {EMOJI.map((e) => (
                    <button key={e} className={e.length > 2 && /^\w/.test(e) ? 'txt' : ''} onClick={() => react(e)}>
                      {e}
                    </button>
                  ))}
                  <button onClick={calm}>{CALM_EMOJI}</button>
                  <button className={hand ? 'sel' : ''} onClick={toggleHand} title="Mano alzata (H)">
                    <Hand size={20} />
                  </button>
                </div>
              </div>
            )}
            {panel === 'fx' && (
              <div className="fx-pop" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                <div className="fx-section">
                  <small>Scegli tra i numerosi filtri</small>
                  <div className="chips">
                    <button className={filter === 'none' ? 'sel' : ''} onClick={() => chooseFilter('none')}>
                      Nessuno
                    </button>
                    <button className={filter === 'bw' ? 'sel' : ''} onClick={() => chooseFilter('bw')}>
                      Bianco e nero
                    </button>
                  </div>
                </div>
              </div>
            )}
            {panel === 'more' && (
              <div className="fx-pop" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                <div className="chips">
                  <button
                    className={isolation ? 'sel' : ''}
                    onClick={() => setIsolation((v) => !v)}
                    title="Toglie rumore di fondo e suoni del computer dal tuo microfono"
                  >
                    <AudioLines size={13} /> Isolamento voce
                  </button>
                </div>
                <div className="chips">
                  <button disabled={remote.length === 0} onClick={() => setHideSelf((h) => !h)}>
                    {hideSelf ? <Eye size={13} /> : <EyeOff size={13} />} {hideSelf ? 'Mostra me' : 'Nascondi me'}
                  </button>
                </div>
              </div>
            )}
            {panel === 'chat' && (
              <div className="fx-pop chat-pop" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                <div className="chat-list">
                  {history.length === 0 && <span className="soft">Nessun messaggio</span>}
                  {history.slice(-20).map((m) => (
                    <p key={m.id}>
                      <strong>{m.from === selfId ? 'Tu' : m.name}</strong> {m.body}
                    </p>
                  ))}
                </div>
                <form className="chat-form" onSubmit={sendChat}>
                  <input
                    className="field mini"
                    autoFocus
                    maxLength={500}
                    placeholder="Scrivi un messaggio"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button className="ctl on" disabled={!draft.trim()} title="Invia">
                    <Send size={16} />
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}

      {campWin &&
        createPortal(
          <Campfire
            people={everyone}
            selfId={selfId}
            streamOf={camStream}
            volumes={volumes}
            muted={muted}
            camOff={camOff}
            sharing={!!myShare}
            onMute={toggleMute}
            onCam={toggleCam}
            onShare={toggleShare}
            onLeave={leaveCall}
            onBack={() => setCampfire(false)}
          />,
          campWin.document.body
        )}
    </div>
  )
}

function Bubble({
  info,
  isSelf,
  stream,
  volume,
  reactions,
  sharing,
  onOpenShare,
  chat,
  getFraming,
  onDismissChat,
  onContext
}: {
  info: PeerInfo
  isSelf: boolean
  stream: MediaStream | null | undefined
  volume: number
  reactions: Floating[]
  sharing: boolean
  onOpenShare?: () => void
  chat?: ChatMsg
  getFraming: () => Framing | undefined
  onDismissChat: () => void
  onContext: () => void
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const ring = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (video.current) video.current.srcObject = stream ?? null
  }, [stream])

  // Zoom sul viso: solo qui nella bolla. Si ritaglia il quadrato attorno al viso, con movimento morbido.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const cur = { cx: 0.5, cy: 0.5, s: 1, init: false }
    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      const v = video.current
      const b = box.current
      if (!v || !b || !v.videoWidth) return
      const t = getFraming() ?? { cx: 0.5, cy: 0.5, s: 1 }
      const now = performance.now()
      const k = 1 - Math.exp(-Math.min(0.1, (now - last) / 1000) / 0.25)
      last = now
      if (!cur.init) Object.assign(cur, t, { init: true })
      else {
        cur.cx += (t.cx - cur.cx) * k
        cur.cy += (t.cy - cur.cy) * k
        cur.s += (t.s - cur.s) * k
      }
      const vw = v.videoWidth
      const vh = v.videoHeight
      const side = Math.min(cur.s * vh, vw, vh)
      const cx = Math.min(Math.max(cur.cx * vw, side / 2), vw - side / 2)
      const cy = Math.min(Math.max(cur.cy * vh, side / 2), vh - side / 2)
      const B = b.clientWidth
      const sc = B / side
      v.style.width = `${vw}px`
      v.style.height = `${vh}px`
      v.style.transform = `translate(${B / 2 - cx * sc}px, ${B / 2 - cy * sc}px) scale(${sc})`
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (video.current) video.current.volume = volume
  }, [volume])

  // Anello della voce
  useEffect(() => {
    if (!stream || info.muted) {
      ring.current?.style.setProperty('--level', '0')
      return
    }
    return watchLevel(stream, (l) => ring.current?.style.setProperty('--level', String(l)))
  }, [stream, info.muted])

  const showVideo = stream && stream.getVideoTracks().length > 0 && !info.camOff
  return (
    <div className="bubble-wrap" onContextMenu={(e) => (e.preventDefault(), onContext())}>
      <div ref={ring} className="ring">
        <div className="bubble" ref={box}>
          <div className={`vid ${isSelf ? 'mirror' : ''}`}>
            <video ref={video} autoPlay playsInline muted={isSelf} style={{ opacity: showVideo ? 1 : 0 }} />
          </div>
          {!showVideo && <span className="initial">{info.name.slice(0, 1).toUpperCase()}</span>}
        </div>
        {/* I badge stanno fuori dal cerchio ritagliato, altrimenti il bordo li taglia */}
        {sharing && (
          <button
            className={`badge share ${isSelf ? 'live' : ''}`}
            onClick={onOpenShare}
            title={isSelf ? 'Interrompi condivisione' : 'Guarda lo schermo condiviso'}
          >
            <ScreenShare size={12} />
          </button>
        )}
        {info.hand && <span className="badge hand">✋</span>}
        {info.muted && (
          <span className="badge">
            <MicOff size={12} />
          </span>
        )}
      </div>
      <span className="name">{isSelf ? 'Tu' : info.name}</span>
      {chat && (
        <div className="chat-pill" title={chat.body}>
          <span>{chat.body}</span>
          <button onClick={onDismissChat} title="Togli">
            <X size={11} />
          </button>
        </div>
      )}
      {reactions.map((r) => (
        <span key={r.key} className={`float ${r.emoji.length > 4 ? 'phrase' : ''}`} style={{ ['--dx' as string]: `${r.x}px` }}>
          {r.emoji}
        </span>
      ))}
    </div>
  )
}
