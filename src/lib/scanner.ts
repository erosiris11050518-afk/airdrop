import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

const SCAN_SIZE = 640
const MIN_SCAN_INTERVAL_MS = 80

let moduleReady: Promise<unknown> | undefined

function prepareScanner(): Promise<unknown> {
  moduleReady ??= prepareZXingModule({
    overrides: {
      locateFile: () => wasmUrl,
    },
    fireImmediately: true,
  })
  return moduleReady
}

export class QrScanner {
  readonly #video: HTMLVideoElement
  readonly #canvas = document.createElement('canvas')
  #stream: MediaStream | undefined
  #animationFrame: number | undefined
  #busy = false
  #lastScanAt = 0
  #onCode: ((value: string) => void) | undefined

  constructor(video: HTMLVideoElement) {
    this.#video = video
    this.#canvas.width = SCAN_SIZE
    this.#canvas.height = SCAN_SIZE
  }

  async start(onCode: (value: string) => void): Promise<void> {
    this.stop()

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持相机访问，请在 HTTPS 页面中使用新版 Safari 或 Chrome。')
    }

    await prepareScanner()
    this.#onCode = onCode
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
    this.#video.srcObject = this.#stream
    this.#video.setAttribute('playsinline', 'true')
    this.#video.muted = true
    await this.#video.play()
    this.#animationFrame = requestAnimationFrame(this.#scan)
  }

  stop(): void {
    if (this.#animationFrame !== undefined) {
      cancelAnimationFrame(this.#animationFrame)
      this.#animationFrame = undefined
    }

    this.#stream?.getTracks().forEach((track) => track.stop())
    this.#stream = undefined
    this.#video.srcObject = null
    this.#onCode = undefined
    this.#busy = false
  }

  #scan = (timestamp: number): void => {
    this.#animationFrame = requestAnimationFrame(this.#scan)

    if (
      this.#busy ||
      timestamp - this.#lastScanAt < MIN_SCAN_INTERVAL_MS ||
      this.#video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return
    }

    const width = this.#video.videoWidth
    const height = this.#video.videoHeight
    if (width === 0 || height === 0) return

    this.#busy = true
    this.#lastScanAt = timestamp

    const context = this.#canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      this.#busy = false
      return
    }

    const sourceSize = Math.min(width, height)
    const sourceX = (width - sourceSize) / 2
    const sourceY = (height - sourceSize) / 2
    context.drawImage(
      this.#video,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      SCAN_SIZE,
      SCAN_SIZE,
    )

    const imageData = context.getImageData(0, 0, SCAN_SIZE, SCAN_SIZE)
    void readBarcodes(imageData, {
      formats: ['QRCode'],
      maxNumberOfSymbols: 1,
      tryHarder: true,
      tryRotate: true,
    })
      .then((results) => {
        const text = results[0]?.text
        if (text) this.#onCode?.(text)
      })
      .finally(() => {
        this.#busy = false
      })
  }
}
