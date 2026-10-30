import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'

const MAX_W = 960 // larghezza massima del video inviato (camera intera, senza ritaglio)
const FPS = 30
const DETECT_EVERY = 2 // frame
const HEAD_ROOM = 2.4 // lato dell'inquadratura delle bolle = viso × questo valore (più alto = meno zoom)
const MIN_S = 0.38 // inquadratura minima, in frazione dell'altezza della camera
const FACE_Y_OFFSET = -0.12 // 0 = viso al centro della bolla; negativo = viso più in basso
const LOST_AFTER_MS = 1500
const DEAD_ZONE = 0.04 // oscillazioni sotto il 4% vengono ignorate
const SEND_EVERY_MS = 90

/** Dove inquadrare il viso, normalizzato: centro in frazioni di larghezza/altezza, lato in frazioni dell'altezza. */
export interface Framing {
  cx: number
  cy: number
  s: number
}
const CENTER: Framing = { cx: 0.5, cy: 0.5, s: 1 }

let detectorPromise: Promise<FaceDetector | null> | null = null
function loadDetector(): Promise<FaceDetector | null> {
  detectorPromise ??= (async () => {
    try {
      const fileset = await FilesetResolver.forVisionTasks('./mediapipe/wasm')
      return await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: './mediapipe/blaze_face_short_range.tflite', delegate: 'CPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5
      })
    } catch (e) {
      console.warn('Face detector non disponibile, uso inquadratura centrale', e)
      return null
    }
  })()
  return detectorPromise
}

export type VideoFilter = 'none' | 'bw'

/**
 * Camera → canvas con la camera INTERA (niente ritaglio, così Campfire non ha zoom) → track da inviare.
 * Il viso viene rilevato qui e la sua posizione (`framing`) viaggia a parte: ogni bolla fa lo zoom da sola.
 */
export class VideoPipeline {
  readonly track: MediaStreamTrack
  filter: VideoFilter = 'bw' // default: bianco e nero (è una gag)
  /** inquadratura attuale del viso (già filtrata dal rumore) */
  framing: Framing = { ...CENTER }
  onFraming?: (f: Framing) => void

  private video = document.createElement('video')
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private running = true
  private detector: FaceDetector | null = null
  private frame = 0
  private lastFace = 0
  private lastSent = 0
  private sentKey = ''

  constructor(source: MediaStreamTrack) {
    this.video.muted = true
    this.video.playsInline = true
    this.video.srcObject = new MediaStream([source])
    this.video.play().catch(() => {})
    this.canvas.width = 640
    this.canvas.height = 360
    this.ctx = this.canvas.getContext('2d', { alpha: false })!
    this.track = this.canvas.captureStream(FPS).getVideoTracks()[0]
    loadDetector().then((d) => (this.detector = d))
    this.loop()
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.track.stop()
    this.video.srcObject = null
  }

  /** Un disegno per ogni frame della camera: niente jitter di timer. */
  private loop = (): void => {
    if (!this.running) return
    this.tick()
    const v = this.video
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(this.loop)
    else this.raf = requestAnimationFrame(this.loop)
  }

  private tick(): void {
    const v = this.video
    const vw = v.videoWidth
    const vh = v.videoHeight
    if (!vw || !vh || v.readyState < 2) return

    // Camera intera, alla risoluzione che serve
    const w = Math.min(vw, MAX_W)
    const h = Math.round((w * vh) / vw)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.ctx.filter = this.filter === 'bw' ? 'grayscale(1) contrast(1.08)' : 'none'
    this.ctx.drawImage(v, 0, 0, w, h)

    // Rilevamento del viso → inquadratura
    if (this.detector && this.frame++ % DETECT_EVERY === 0) {
      try {
        const box = this.detector.detectForVideo(v, performance.now()).detections[0]?.boundingBox
        if (box) {
          const side = Math.max(box.width, box.height) * HEAD_ROOM
          const next: Framing = {
            cx: (box.originX + box.width / 2) / vw,
            cy: (box.originY + box.height / 2 + box.height * FACE_Y_OFFSET) / vh,
            s: Math.min(1, Math.max(MIN_S, side / vh))
          }
          const f = this.framing
          // Ignora il rumore del rilevatore; sopra la soglia segue con un filtro
          if (Math.abs(next.cx - f.cx) * (vw / vh) > DEAD_ZONE * f.s || Math.abs(next.cy - f.cy) > DEAD_ZONE * f.s)
            this.framing = { cx: f.cx + (next.cx - f.cx) * 0.5, cy: f.cy + (next.cy - f.cy) * 0.5, s: f.s }
          if (Math.abs(next.s - f.s) > DEAD_ZONE * 2) this.framing.s += (next.s - this.framing.s) * 0.5
          this.lastFace = performance.now()
        }
      } catch {
        /* frame saltato */
      }
    }
    if (performance.now() - this.lastFace > LOST_AFTER_MS) this.framing = { ...CENTER }

    // Mando l'inquadratura agli altri, a bassa frequenza e solo se cambia
    const now = performance.now()
    if (this.onFraming && now - this.lastSent > SEND_EVERY_MS) {
      const f = this.framing
      const key = `${f.cx.toFixed(3)},${f.cy.toFixed(3)},${f.s.toFixed(3)}`
      if (key !== this.sentKey) {
        this.sentKey = key
        this.lastSent = now
        this.onFraming(f)
      }
    }
  }
}
