import { useEffect, useRef } from 'react'
import { Hand, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff, LayoutGrid } from 'lucide-react'
import type { PeerInfo } from '../lib/mesh'

export interface CampfireProps {
  people: PeerInfo[]
  selfId: string
  streamOf: (p: PeerInfo) => MediaStream | null | undefined
  volumes: Record<string, number>
  sinkId?: string
  muted: boolean
  camOff: boolean
  sharing: boolean
  onMute: () => void
  onCam: () => void
  onShare: () => void
  onLeave: () => void
  onBack: () => void
}

/** Vista classica a griglia (Campfire): alternativa alle bolle, in una finestra normale. */
export function Campfire(p: CampfireProps): React.JSX.Element {
  const cols = Math.ceil(Math.sqrt(p.people.length || 1))
  return (
    <div className="campfire">
      <div className="camp-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {p.people.map((m) => (
          <Tile
            key={m.id}
            info={m}
            isSelf={m.id === p.selfId}
            stream={p.streamOf(m)}
            volume={p.volumes[m.id] ?? 1}
            sinkId={p.sinkId}
          />
        ))}
      </div>
      <div className="camp-bar">
        <button className={`ctl ${p.camOff ? 'off' : ''}`} onClick={p.onCam} title="Camera">
          {p.camOff ? <VideoOff size={18} /> : <Video size={18} />}
        </button>
        <button className={`ctl ${p.muted ? 'off' : ''}`} onClick={p.onMute} title="Microfono">
          {p.muted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <button className={`ctl ${p.sharing ? 'on' : ''}`} onClick={p.onShare} title="Condividi schermo">
          {p.sharing ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
        </button>
        <button className="ctl wide" onClick={p.onBack} title="Torna alle bolle">
          <LayoutGrid size={16} /> Bolle
        </button>
        <button className="ctl wide leave" onClick={p.onLeave}>
          <PhoneOff size={16} /> Esci
        </button>
      </div>
    </div>
  )
}

function Tile({
  info,
  isSelf,
  stream,
  volume,
  sinkId
}: {
  info: PeerInfo
  isSelf: boolean
  stream: MediaStream | null | undefined
  volume: number
  sinkId?: string
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (video.current) video.current.srcObject = stream ?? null
  }, [stream])
  useEffect(() => {
    if (video.current) video.current.volume = volume
  }, [volume])
  useEffect(() => {
    ;(video.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null)?.setSinkId?.(sinkId ?? '')?.catch(() => {})
  }, [sinkId])
  const showVideo = stream && stream.getVideoTracks().length > 0 && !info.camOff
  return (
    <div className="tile">
      <video ref={video} autoPlay playsInline muted={isSelf} className={isSelf ? 'mirror' : ''} style={{ opacity: showVideo ? 1 : 0 }} />
      {!showVideo && <span className="initial">{info.name.slice(0, 1).toUpperCase()}</span>}
      <span className="tile-name">
        {isSelf ? 'Tu' : info.name}
        {info.muted && <MicOff size={12} />}
        {info.hand && <Hand size={12} />}
      </span>
    </div>
  )
}
