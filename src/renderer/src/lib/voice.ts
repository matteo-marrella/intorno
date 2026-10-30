import { NoiseGateWorkletNode, RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import gateWorkletPath from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

/** Carica un AudioWorklet; con file:// (app installata) il caricamento diretto può essere bloccato: ripiega su un blob. */
async function addWorklet(ctx: AudioContext, url: string): Promise<void> {
  try {
    await ctx.audioWorklet.addModule(url)
  } catch {
    const code = await (await fetch(url)).text()
    const blob = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(blob)
  }
}

/**
 * Isolamento della voce: rete neurale RNNoise + noise gate, tutto in locale. Toglie rumore di fondo,
 * tastiera, ventole e gran parte di ciò che esce dalle casse (musica, video) e finisce nel microfono.
 * Con le cuffie il suono del computer non entra proprio nel microfono: è la soluzione migliore.
 */
export class VoiceIsolator {
  private constructor(
    private ctx: AudioContext,
    private src: MediaStreamAudioSourceNode,
    private rnnoise: RnnoiseWorkletNode,
    private gate: NoiseGateWorkletNode,
    private dest: MediaStreamAudioDestinationNode
  ) {
    this.track = dest.stream.getAudioTracks()[0]
  }
  readonly track: MediaStreamTrack
  private on = false

  static async create(mic: MediaStreamTrack): Promise<VoiceIsolator | null> {
    try {
      const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      await addWorklet(ctx, rnnoiseWorkletPath)
      await addWorklet(ctx, gateWorkletPath)
      const wasmBinary = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdPath })
      const src = ctx.createMediaStreamSource(new MediaStream([mic]))
      const rnnoise = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 })
      const gate = new NoiseGateWorkletNode(ctx, { openThreshold: -58, closeThreshold: -64, holdMs: 220, maxChannels: 1 })
      const dest = ctx.createMediaStreamDestination()
      const iso = new VoiceIsolator(ctx, src, rnnoise, gate, dest)
      iso.setEnabled(true)
      return iso
    } catch (e) {
      console.warn('Isolamento voce non disponibile, uso il microfono così com’è', e)
      return null
    }
  }

  setEnabled(on: boolean): void {
    if (on === this.on) return
    this.on = on
    this.src.disconnect()
    this.rnnoise.disconnect()
    this.gate.disconnect()
    if (on) this.src.connect(this.rnnoise).connect(this.gate).connect(this.dest)
    else this.src.connect(this.dest)
  }

  stop(): void {
    this.rnnoise.destroy()
    this.track.stop()
    this.ctx.close().catch(() => {})
  }
}
