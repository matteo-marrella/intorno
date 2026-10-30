import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Eye,
  EyeOff,
  Hand,
  LayoutGrid,
  MessageCircle,
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
import { VideoPipeline, type VideoFilter } from '../lib/pipeline'
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

type Panel = 'fx' | 'chat' | null
const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()

export default function Bubbles(): React.JSX.Element {
  const q = useMemo(() => new URLSearchParams(location.hash.split('?')[1]), [])
  const roomId = q.get('roomId')!
  const roomName = q.get('roomName') ?? ''
  const { me } = useMe()
  // Id di sessione: la stessa persona può entrare da due computer senza sovrapporsi
  const instance = useRef(Math.random().toString(36).slice(2, 8))
  const selfId = me ? `${me.id}:${instance.current}` : ''
  const [prefs] = usePrefs()
  const px = BUBBLE_PX[prefs.size]

  const [peers, setPeers] = useState<PeerInfo[]>([])
  // peer → (id stream → stream): la camera e l'eventuale schermo condiviso arrivano come stream distinti
  const [streams, setStreams] = useState<Record<string, Record<string, MediaStream>>>({})
  const [myShare, setMyShare] = useState<string | null>(null)
  const shareWin = useRef<Window | null>(null)
  const [local, setLocal] = useState<MediaStream | null>(null)
  const [muted, setMuted] = useState(false)
  const mutedRef = useRef(false)
  const [camOff, setCamOff] = useState(false)
  const [hand, setHand] = useState(false)
  const [place, setPlace] = useState('')
  const [hideSelf, setHideSelf] = useState(false)
  const [campfire, setCampfire] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [hover, setHover] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [filter, setFilter] = useState<VideoFilter>('bw')
  const pipelineRef = useRef<VideoPipeline | null>(null)
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
  const levels = useRef<Record<string, number>>({})

  mutedRef.current = muted

  // --- Avvio chiamata
  useEffect(() => {
    if (!me?.ready) return // aspetta il nome definitivo dal profilo
    let cancelled = false
    let stream: MediaStream | null = null
    let mesh: MeshCall | null = null
    let pipeline: VideoPipeline | null = null
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
      const outgoing = new MediaStream([
        ...stream.getAudioTracks(),
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
          hand: false,
          place: null
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
            delete levels.current[id]
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
          onKick: () => window.api.call.leave()
        }
      )
      call.current = mesh
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
  const toggleHand = useCallback(() => {
    setHand((h) => {
      call.current?.updateMe({ hand: !h })
      return !h
    })
  }, [])
  const changePlace = (v: string): void => {
    setPlace(v)
    call.current?.updateMe({ place: v.trim() ? v.trim() : null })
  }
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

  // --- "Stessa stanza" (EchoTerminator): chi è nello stesso luogo non si sente via rete e
  // resta aperto solo il microfono di chi parla in quel momento.
  const myPlace = norm(place)
  const mates = useMemo(
    () => (myPlace ? peers.filter((p) => p.id !== selfId && norm(p.place) === myPlace) : []),
    [peers, myPlace, selfId]
  )
  const isMate = (p: PeerInfo): boolean => mates.some((m) => m.id === p.id)

  // Livello del mio microfono, misurato su una copia: la traccia inviata può essere chiusa dal gate
  useEffect(() => {
    const track = local?.getAudioTracks()[0]
    if (!track || !selfId) return
    const probe = track.clone()
    probe.enabled = true
    const stop = watchLevel(new MediaStream([probe]), (l) => (levels.current[selfId] = mutedRef.current ? 0 : l))
    return () => {
      stop()
      probe.stop()
    }
  }, [local, selfId])

  const speaker = useRef<{ id: string; since: number } | null>(null)
  useEffect(() => {
    const track = local?.getAudioTracks()[0]
    if (!track) return
    if (!mates.length) {
      speaker.current = null
      track.enabled = !mutedRef.current
      return
    }
    const ids = [selfId, ...mates.map((m) => m.id)]
    const iv = setInterval(() => {
      const now = performance.now()
      const lvl = (id: string): number => levels.current[id] ?? 0
      const top = ids.reduce((a, b) => (lvl(b) > lvl(a) ? b : a), ids[0])
      const cur = speaker.current
      if (!cur || !ids.includes(cur.id)) speaker.current = { id: top, since: now }
      else if (top !== cur.id && lvl(top) > Math.max(0.1, lvl(cur.id) * 1.4) && now - cur.since > 600)
        speaker.current = { id: top, since: now }
      track.enabled = !mutedRef.current && speaker.current!.id === selfId
    }, 100)
    return () => {
      clearInterval(iv)
      track.enabled = !mutedRef.current
    }
  }, [local, mates, selfId])

  // --- Condivisione schermo: chi inizia dopo prende il posto di chi condivideva (come Around)
  const stopShare = useCallback(() => {
    call.current?.stopShare()
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
        hand,
        place: place.trim() || null
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
            silenced={isMate(p)}
            sharing={!!p.sharing}
            onOpenShare={p.id === selfId ? stopShare : openShareWindow}
            volume={volumes[p.id] ?? 1}
            reactions={floating.filter((f) => f.from === p.id)}
            chat={chats[p.id]}
            onDismissChat={() => dismissChat(p.id)}
            onLevel={(l) => (levels.current[p.id] = l)}
            onContext={() => setMenuFor(p.id)}
          />
        ))}
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
              <div className="bar two" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                <span className="bar-title">{roomName}</span>
                {/* Gruppo base: camera, microfono, schermo */}
                <div className="bar-row">
                  <button className={`ctl ${camOff ? 'off' : ''}`} onClick={toggleCam} title="Camera">
                    {camOff ? <VideoOff size={18} /> : <Video size={18} />}
                  </button>
                  <button className={`ctl ${muted ? 'off' : ''}`} onClick={toggleMute} title="Microfono (⌘⇧M)">
                    {muted ? <MicOff size={18} /> : <Mic size={18} />}
                  </button>
                  <button
                    className={`ctl ${myShare ? 'on' : ''}`}
                    onClick={toggleShare}
                    title={myShare ? 'Interrompi condivisione' : 'Condividi schermo'}
                  >
                    {myShare ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
                  </button>
                </div>
                {/* Effetti, chat e uscita */}
                <div className="bar-row">
                  <button
                    className={`ctl wide ${panel === 'fx' || filter !== 'none' ? 'on' : ''}`}
                    onClick={() => setPanel((p) => (p === 'fx' ? null : 'fx'))}
                    title="Reazioni, filtri e altro"
                  >
                    <Sparkles size={16} /> Effetti
                  </button>
                  <button
                    className={`ctl ${panel === 'chat' ? 'on' : ''}`}
                    onClick={() => setPanel((p) => (p === 'chat' ? null : 'chat'))}
                    title="Chat"
                  >
                    <MessageCircle size={18} />
                  </button>
                  <button className="ctl wide leave" onClick={leaveCall} title="Esci dalla stanza">
                    <PhoneOff size={16} /> Esci
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Spazio riservato ai riquadri: sotto la barra, o sopra se la barra è ribaltata. */}
          <div className={`tray ${panel ? 'show' : ''}`}>
            {panel === 'fx' && (
              <div className="fx-pop" data-hit onMouseEnter={enter} onMouseLeave={leave}>
                <div className="fx-section">
                  <small>Reazioni</small>
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
                <div className="fx-section">
                  <small>Nello stesso posto? Scrivete lo stesso nome</small>
                  <div className="chips">
                    <input
                      className="field mini"
                      value={place}
                      maxLength={30}
                      placeholder="Es. Ufficio"
                      onChange={(e) => changePlace(e.target.value)}
                    />
                    <button onClick={() => setCampfire((c) => !c)} title="Vista a griglia in una finestra">
                      <LayoutGrid size={13} /> {campfire ? 'Bolle' : 'Campfire'}
                    </button>
                  </div>
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
            silenced={isMate}
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
  silenced,
  volume,
  reactions,
  sharing,
  onOpenShare,
  chat,
  onDismissChat,
  onLevel,
  onContext
}: {
  info: PeerInfo
  isSelf: boolean
  stream: MediaStream | null | undefined
  silenced: boolean
  volume: number
  reactions: Floating[]
  sharing: boolean
  onOpenShare?: () => void
  chat?: ChatMsg
  onDismissChat: () => void
  onLevel: (l: number) => void
  onContext: () => void
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const ring = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (video.current) video.current.srcObject = stream ?? null
  }, [stream])
  useEffect(() => {
    if (video.current) video.current.volume = volume
  }, [volume])

  // Anello della voce (e livello per il gate di "Stessa stanza")
  useEffect(() => {
    if (!stream || info.muted) {
      ring.current?.style.setProperty('--level', '0')
      onLevel(0)
      return
    }
    const stop = watchLevel(stream, (l) => {
      ring.current?.style.setProperty('--level', String(l))
      if (!isSelf) onLevel(l)
    })
    return () => {
      stop()
      if (!isSelf) onLevel(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, info.muted])

  const showVideo = stream && stream.getVideoTracks().length > 0 && !info.camOff
  return (
    <div className="bubble-wrap" onContextMenu={(e) => (e.preventDefault(), onContext())}>
      <div ref={ring} className="ring">
        <div className="bubble">
          <video
            ref={video}
            autoPlay
            playsInline
            muted={isSelf || silenced}
            className={isSelf ? 'mirror' : ''}
            style={{ opacity: showVideo ? 1 : 0 }}
          />
          {!showVideo && <span className="initial">{info.name.slice(0, 1).toUpperCase()}</span>}
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
