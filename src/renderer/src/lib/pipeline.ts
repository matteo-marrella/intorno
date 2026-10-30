import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'

const OUT = 640 // lato del video inviato (quadrato: serve solo per un cerchio)
const FPS = 30
const DETECT_EVERY = 2 // frame
const HEAD_ROOM = 3.0 // inquadratura larga (testa e spalle): le bolle zoomano un po' di più, Campfire resta largo
const MIN_CROP = 0.3 // ritaglio minimo, in frazione del lato corto della camera
const LOST_AFTER_MS = 1500
const TAU_S = 0.28 // costante di tempo dell'inseguimento (più alto = più morbido)
const DEAD_ZONE = 0.05 // oscillazioni sotto il 5% del ritaglio vengono ignorate
const FACE_Y_OFFSET = -0.2 // 0 = viso al centro; negativo = viso più in basso

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

/**
 * Camera → canvas quadrato centrato sul viso → track da inviare.
 * Il canvas è anche il punto in cui si aggancieranno i filtri video.
 */
export type VideoFilter = 'none' | 'bw'

export class VideoPipeline {
  readonly track: MediaStreamTrack
  filter: VideoFilter = 'bw' // default: bianco e nero (è una gag)
  private video = document.createElement('video')
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private running = true
  private last = performance.now()
  private detector: FaceDetector | null = null
  private frame = 0
  private lastFace = 0
  // Stato dell'inquadratura (coordinate sul frame sorgente), con target e valore smussato
  private cur = { cx: 0, cy: 0, size: 0 }
  private target = { cx: 0, cy: 0, size: 0 }
  private ready = false

  constructor(source: MediaStreamTrack) {
    this.video.muted = true
    this.video.playsInline = true
    this.video.srcObject = new MediaStream([source])
    this.video.play().catch(() => {})
    this.canvas.width = this.canvas.height = OUT
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

    const full = Math.min(vw, vh)
    if (!this.ready) {
      this.cur = this.target = { cx: vw / 2, cy: vh / 2, size: full }
      this.ready = true
    }

    if (this.detector && this.frame++ % DETECT_EVERY === 0) {
      try {
        const box = this.detector.detectForVideo(v, performance.now()).detections[0]?.boundingBox
        if (box) {
          const side = Math.max(box.width, box.height) * HEAD_ROOM
          const next = {
            cx: box.originX + box.width / 2,
            cy: box.originY + box.height / 2 + box.height * FACE_Y_OFFSET,
            size: Math.min(full, Math.max(full * MIN_CROP, side))
          }
          const ref = this.target.size
          // Filtro: ignora il rumore del rilevatore e addolcisce i campioni
          if (Math.abs(next.cx - this.target.cx) > ref * DEAD_ZONE || Math.abs(next.cy - this.target.cy) > ref * DEAD_ZONE)
            this.target = {
              cx: this.target.cx + (next.cx - this.target.cx) * 0.5,
              cy: this.target.cy + (next.cy - this.target.cy) * 0.5,
              size: this.target.size
            }
          if (Math.abs(next.size - this.target.size) > ref * DEAD_ZONE * 2)
            this.target.size += (next.size - this.target.size) * 0.5
          this.lastFace = performance.now()
        }
      } catch {
        /* frame saltato */
      }
    }
    if (performance.now() - this.lastFace > LOST_AFTER_MS)
      this.target = { cx: vw / 2, cy: vh / 2, size: full }

    // Movimento morbido, indipendente dal frame rate
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const k = 1 - Math.exp(-dt / TAU_S)
    this.cur.cx += (this.target.cx - this.cur.cx) * k
    this.cur.cy += (this.target.cy - this.cur.cy) * k
    this.cur.size += (this.target.size - this.cur.size) * k

    const s = this.cur.size
    const sx = Math.min(Math.max(0, this.cur.cx - s / 2), vw - s)
    const sy = Math.min(Math.max(0, this.cur.cy - s / 2), vh - s)
    this.ctx.filter = this.filter === 'bw' ? 'grayscale(1) contrast(1.08)' : 'none'
    this.ctx.drawImage(v, sx, sy, s, s, 0, 0, OUT, OUT)
  }
}
