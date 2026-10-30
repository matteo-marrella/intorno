let ctx: AudioContext | null = null
const audioCtx = (): AudioContext => (ctx ??= new AudioContext())

/** Livello audio 0..1 di uno stream, letto a ogni frame. Ritorna la funzione di stop. */
export function watchLevel(stream: MediaStream, onLevel: (l: number) => void): () => void {
  if (!stream.getAudioTracks().length) return () => {}
  const c = audioCtx()
  const src = c.createMediaStreamSource(stream)
  const an = c.createAnalyser()
  an.fftSize = 512
  an.smoothingTimeConstant = 0.6
  src.connect(an)
  const buf = new Uint8Array(an.fftSize)
  let raf = 0
  let smooth = 0
  const tick = (): void => {
    an.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    const rms = Math.sqrt(sum / buf.length)
    const target = Math.min(1, rms * 5)
    smooth += (target - smooth) * 0.35
    onLevel(smooth < 0.04 ? 0 : smooth)
    raf = requestAnimationFrame(tick)
  }
  tick()
  return () => {
    cancelAnimationFrame(raf)
    src.disconnect()
  }
}

/** Suoni discreti di entrata/uscita (due note brevi). */
export function blip(kind: 'join' | 'leave'): void {
  const c = audioCtx()
  const notes = kind === 'join' ? [523.25, 783.99] : [659.25, 440]
  const t0 = c.currentTime
  notes.forEach((f, i) => {
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.value = f
    g.gain.setValueAtTime(0, t0 + i * 0.09)
    g.gain.linearRampToValueAtTime(0.06, t0 + i * 0.09 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.22)
    o.connect(g).connect(c.destination)
    o.start(t0 + i * 0.09)
    o.stop(t0 + i * 0.09 + 0.25)
  })
}

/** Sceglie l'uscita audio anche per i suoni di entrata/uscita (id vuoto = predefinita). */
export function setOutputDevice(id: string): void {
  ;(audioCtx() as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(id).catch(() => {})
}
