import QRCode from 'qrcode'

const FRAME_INTERVAL_MS = 100

export class QrPlayer {
  readonly #image: HTMLImageElement
  #timer: number | undefined
  #frameUrls: string[] = []
  #current = 0
  #generation = 0

  constructor(image: HTMLImageElement) {
    this.#image = image
  }

  async play(frames: string[], onFrame?: (index: number, total: number) => void): Promise<void> {
    this.stop()
    const generation = this.#generation
    const frameUrls = await Promise.all(
      frames.map((frame) =>
        QRCode.toDataURL(frame, {
          width: 440,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#12231f', light: '#ffffff' },
        }),
      ),
    )
    if (generation !== this.#generation) return
    this.#frameUrls = frameUrls
    this.#current = 0

    const render = () => {
      if (this.#frameUrls.length === 0) return
      this.#image.src = this.#frameUrls[this.#current] ?? ''
      onFrame?.(this.#current + 1, this.#frameUrls.length)
      this.#current = (this.#current + 1) % this.#frameUrls.length
    }

    render()
    this.#timer = window.setInterval(render, FRAME_INTERVAL_MS)
  }

  stop(): void {
    this.#generation += 1
    if (this.#timer !== undefined) {
      window.clearInterval(this.#timer)
      this.#timer = undefined
    }
  }
}
