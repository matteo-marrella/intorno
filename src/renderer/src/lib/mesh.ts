import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Framing } from './pipeline'

export interface PeerInfo {
  /** identifica la sessione (utente + istanza): la stessa persona può essere su due computer */
  id: string
  userId: string
  name: string
  muted: boolean
  camOff: boolean
  /** id dello stream della condivisione schermo, se questa persona sta condividendo */
  sharing: string | null
  /** quando ha iniziato a condividere: chi inizia dopo prende il posto di chi condivideva */
  sharingAt: number | null
  hand: boolean
}

interface Signal {
  from: string
  to: string
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface Peer {
  pc: RTCPeerConnection
  dc: RTCDataChannel
  createdAt: number
  failTimer?: ReturnType<typeof setTimeout>
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  disconnectTimer?: ReturnType<typeof setTimeout>
}

export interface CallEvents {
  onPeers(peers: PeerInfo[]): void
  onStream(id: string, stream: MediaStream): void
  onPeerGone(id: string): void
  onJoin(p: PeerInfo): void
  onLeave(p: PeerInfo): void
  onReaction(from: string, emoji: string): void
  onChat(msg: { from: string; name: string; body: string; at: number }): void
  onChatClear(from: string): void
  onKick(by: string): void
  onFraming(id: string, f: Framing): void
}

/**
 * Mesh WebRTC con "perfect negotiation". Segnalazione via Supabase Broadcast,
 * presenza via Supabase Presence sullo stesso canale `call:<roomId>`.
 */
export class MeshCall {
  private ch!: RealtimeChannel
  private peers = new Map<string, Peer>()
  private known = new Map<string, PeerInfo>()
  private share: MediaStream | null = null
  private shareSenders = new Map<string, RTCRtpSender[]>()
  private onOnline = (): void => this.peers.forEach((p) => p.pc.restartIce())

  constructor(
    private roomId: string,
    private me: PeerInfo,
    private local: MediaStream,
    private ice: RTCIceServer[],
    private ev: CallEvents
  ) {}

  async join(): Promise<void> {
    this.ch = supabase.channel(`call:${this.roomId}`, {
      config: { presence: { key: this.me.id }, broadcast: { self: false } }
    })
    this.ch
      .on('presence', { event: 'sync' }, () => this.syncPresence())
      .on('broadcast', { event: 'signal' }, ({ payload }) => this.onSignal(payload as Signal))
      .on('broadcast', { event: 'reaction' }, ({ payload }) =>
        this.ev.onReaction(payload.from, payload.emoji)
      )
      .on('broadcast', { event: 'chat' }, ({ payload }) => this.ev.onChat(payload))
      .on('broadcast', { event: 'chat-clear' }, ({ payload }) => this.ev.onChatClear(payload.from))
      .on('broadcast', { event: 'kick' }, ({ payload }) => {
        if (payload.to === this.me.id) this.ev.onKick(payload.by)
      })

    await new Promise<void>((resolve, reject) => {
      this.ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
          reject(new Error(`Canale realtime: ${status}`))
      })
    })
    await this.ch.track(this.me)
    window.addEventListener('online', this.onOnline)
  }

  async leave(): Promise<void> {
    window.removeEventListener('online', this.onOnline)
    this.share?.getTracks().forEach((t) => t.stop()) // spegne l'indicatore di registrazione schermo
    this.share = null
    this.peers.forEach((_, id) => this.closePeer(id))
    await this.ch?.untrack()
    await supabase.removeChannel(this.ch)
  }

  updateMe(patch: Partial<Pick<PeerInfo, 'muted' | 'camOff' | 'sharing' | 'sharingAt' | 'hand'>>): void {
    this.me = { ...this.me, ...patch }
    this.ch.track(this.me)
  }

  sendReaction(emoji: string): void {
    this.ch.send({ type: 'broadcast', event: 'reaction', payload: { from: this.me.id, emoji } })
  }

  sendChat(body: string): { from: string; name: string; body: string; at: number } {
    const msg = { from: this.me.id, name: this.me.name, body, at: Date.now() }
    this.ch.send({ type: 'broadcast', event: 'chat', payload: msg })
    return msg
  }

  sendChatClear(): void {
    this.ch.send({ type: 'broadcast', event: 'chat-clear', payload: { from: this.me.id } })
  }

  sendKick(to: string): void {
    this.ch.send({ type: 'broadcast', event: 'kick', payload: { to, by: this.me.name } })
  }

  /** Dice agli altri dove sta il mio viso nell'immagine: ogni bolla fa lo zoom da sola. */
  sendFraming(f: Framing): void {
    const msg = JSON.stringify(f)
    this.peers.forEach((p) => {
      if (p.dc.readyState === 'open') p.dc.send(msg)
    })
  }

  /** Bolle piccole = video a bassa risoluzione/bitrate. */
  setBubbleSize(_px: number): void {
    this.peers.forEach((p) => this.tune(p.pc))
  }

  replaceVideoTrack(track: MediaStreamTrack): void {
    this.peers.forEach(({ pc }) => this.camSender(pc)?.replaceTrack(track))
  }

  private isShareTrack(t: MediaStreamTrack | null): boolean {
    return !!t && !!this.share?.getTracks().some((x) => x.id === t.id)
  }
  private camSender(pc: RTCPeerConnection): RTCRtpSender | undefined {
    return pc.getSenders().find((s) => s.track?.kind === 'video' && !this.isShareTrack(s.track))
  }

  /** Una condivisione alla volta per stanza: lo garantisce l'interfaccia guardando la presenza. */
  startShare(stream: MediaStream): void {
    this.share = stream
    this.peers.forEach((p, id) => this.attachShare(id, p.pc))
    this.updateMe({ sharing: stream.id, sharingAt: Date.now() })
  }

  stopShare(): void {
    this.shareSenders.forEach((senders, id) => {
      const pc = this.peers.get(id)?.pc
      senders.forEach((s) => {
        try {
          pc?.removeTrack(s)
        } catch {
          /* peer già chiuso */
        }
      })
    })
    this.shareSenders.clear()
    this.share?.getTracks().forEach((t) => t.stop())
    this.share = null
    this.updateMe({ sharing: null, sharingAt: null })
  }

  private attachShare(id: string, pc: RTCPeerConnection): void {
    const share = this.share
    if (!share) return
    this.shareSenders.set(
      id,
      share.getTracks().map((t) => pc.addTrack(t, share))
    )
  }

  private tune(pc: RTCPeerConnection): void {
    const sender = this.camSender(pc)
    if (sender) {
      const params = sender.getParameters()
      if (params.encodings?.length) {
        // Camera intera (Campfire la mostra grande, le bolle ne ritagliano il viso): qualità uguale per tutti
        params.encodings[0].maxBitrate = 650_000
        params.encodings[0].scaleResolutionDownBy = 1
        sender.setParameters(params).catch(() => {})
      }
    }
    // Schermo condiviso: nitido ma con un tetto, siamo in mesh
    pc.getSenders()
      .filter((s) => this.isShareTrack(s.track))
      .forEach((s) => {
        const params = s.getParameters()
        if (!params.encodings?.length) return
        params.encodings[0].maxBitrate = 1_500_000
        params.encodings[0].maxFramerate = 15
        s.setParameters(params).catch(() => {})
      })
  }

  private syncPresence(): void {
    const state = this.ch.presenceState<PeerInfo>()
    const next = new Map<string, PeerInfo>()
    for (const [id, metas] of Object.entries(state)) if (metas[0]) next.set(id, metas[0])

    for (const [id, info] of next) {
      if (id === this.me.id) continue
      if (!this.known.has(id)) {
        this.ev.onJoin(info)
        if (!this.peers.has(id)) this.createPeer(id)
      }
    }
    for (const [id, info] of this.known) {
      if (id !== this.me.id && !next.has(id)) {
        this.closePeer(id)
        this.ev.onLeave(info)
        this.ev.onPeerGone(id)
      }
    }
    // Un segnale in ritardo può creare un peer che poi non compare in presenza: si pulisce dopo un po'
    for (const [id, peer] of this.peers) {
      if (!next.has(id) && Date.now() - peer.createdAt > 15000) this.closePeer(id)
    }
    this.known = next
    this.ev.onPeers([...next.values()])
  }

  private send(to: string, body: Pick<Signal, 'description' | 'candidate'>): void {
    this.ch.send({
      type: 'broadcast',
      event: 'signal',
      payload: { from: this.me.id, to, ...body }
    })
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    // Canale dati leggero (id fisso, senza negoziazione) per l'inquadratura del viso
    const dc = pc.createDataChannel('framing', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 })
    dc.onmessage = (e) => {
      try {
        this.ev.onFraming(id, JSON.parse(e.data))
      } catch {
        /* messaggio non valido */
      }
    }
    const peer: Peer = { pc, dc, createdAt: Date.now(), polite: this.me.id < id, makingOffer: false, ignoreOffer: false }
    this.peers.set(id, peer)

    this.local.getTracks().forEach((t) => pc.addTrack(t, this.local))
    this.attachShare(id, pc)

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        this.send(id, { description: pc.localDescription!.toJSON() })
      } catch (e) {
        console.warn('negotiation', e)
      } finally {
        peer.makingOffer = false
      }
    }
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(id, { candidate: candidate.toJSON() })
    }
    pc.ontrack = ({ streams }) => {
      if (streams[0]) this.ev.onStream(id, streams[0])
    }
    pc.oniceconnectionstatechange = () => {
      clearTimeout(peer.disconnectTimer)
      const s = pc.iceConnectionState
      if (s === 'failed') {
        pc.restartIce()
        // Se dopo il riavvio ICE la connessione è ancora rotta, si ricrea da zero
        clearTimeout(peer.failTimer)
        peer.failTimer = setTimeout(() => {
          if (this.peers.get(id) === peer && pc.iceConnectionState === 'failed' && this.known.has(id)) {
            this.closePeer(id)
            this.createPeer(id)
          }
        }, 8000)
      }
      else if (s === 'disconnected')
        peer.disconnectTimer = setTimeout(() => {
          if (pc.iceConnectionState !== 'connected') pc.restartIce()
        }, 4000)
      else if (s === 'connected' || s === 'completed') this.tune(pc)
    }
    return peer
  }

  private closePeer(id: string): void {
    const p = this.peers.get(id)
    if (!p) return
    clearTimeout(p.disconnectTimer)
    clearTimeout(p.failTimer)
    p.pc.onnegotiationneeded = null
    this.shareSenders.delete(id)
    p.pc.close()
    this.peers.delete(id)
  }

  private async onSignal(s: Signal): Promise<void> {
    if (s.to !== this.me.id) return
    const peer = this.peers.get(s.from) ?? this.createPeer(s.from)
    const { pc } = peer
    try {
      if (s.description) {
        const collision =
          s.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable')
        peer.ignoreOffer = !peer.polite && collision
        if (peer.ignoreOffer) return
        await pc.setRemoteDescription(s.description)
        if (s.description.type === 'answer') this.tune(pc)
        if (s.description.type === 'offer') {
          await pc.setLocalDescription()
          this.send(s.from, { description: pc.localDescription!.toJSON() })
        }
      } else if (s.candidate) {
        try {
          await pc.addIceCandidate(s.candidate)
        } catch (e) {
          if (!peer.ignoreOffer) throw e
        }
      }
    } catch (e) {
      console.warn('signal', e)
    }
  }
}
