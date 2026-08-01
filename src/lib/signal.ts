import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'

export type SignalKind = 'offer' | 'answer'

export interface SignalEnvelope {
  v: 1
  sessionId: string
  kind: SignalKind
  description: RTCSessionDescriptionInit
}

export interface SignalProgress {
  received: number
  total: number
  sessionId: string
}

interface SignalFrame {
  sessionId: string
  kind: SignalKind
  index: number
  total: number
  checksum: string
  payload: string
}

const FRAME_PREFIX = 'AB1'
const FRAME_PAYLOAD_SIZE = 360

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const blockSize = 0x8000

  for (let index = 0; index < bytes.length; index += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + blockSize))
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function checksum(value: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(36)
}

function compactKind(kind: SignalKind): 'O' | 'A' {
  return kind === 'offer' ? 'O' : 'A'
}

function expandKind(kind: string): SignalKind | null {
  if (kind === 'O') return 'offer'
  if (kind === 'A') return 'answer'
  return null
}

function formatFrame(frame: SignalFrame): string {
  return [
    FRAME_PREFIX,
    frame.sessionId,
    compactKind(frame.kind),
    frame.index.toString(36),
    frame.total.toString(36),
    frame.checksum,
    frame.payload,
  ].join(':')
}

function parseFrame(value: string): SignalFrame | null {
  const parts = value.split(':')
  if (parts.length !== 7 || parts[0] !== FRAME_PREFIX) return null

  const kind = expandKind(parts[2] ?? '')
  const index = Number.parseInt(parts[3] ?? '', 36)
  const total = Number.parseInt(parts[4] ?? '', 36)
  const payload = parts[6] ?? ''

  if (
    !kind ||
    !parts[1] ||
    !parts[5] ||
    !payload ||
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    index < 0 ||
    total < 1 ||
    index >= total ||
    checksum(payload) !== parts[5]
  ) {
    return null
  }

  return {
    sessionId: parts[1],
    kind,
    index,
    total,
    checksum: parts[5],
    payload,
  }
}

export function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function encodeSignal(envelope: SignalEnvelope): string[] {
  const json = JSON.stringify(envelope)
  const encoded = toBase64Url(zlibSync(strToU8(json), { level: 9 }))
  const total = Math.max(1, Math.ceil(encoded.length / FRAME_PAYLOAD_SIZE))
  const frames: string[] = []

  for (let index = 0; index < total; index += 1) {
    const payload = encoded.slice(index * FRAME_PAYLOAD_SIZE, (index + 1) * FRAME_PAYLOAD_SIZE)
    frames.push(
      formatFrame({
        sessionId: envelope.sessionId,
        kind: envelope.kind,
        index,
        total,
        checksum: checksum(payload),
        payload,
      }),
    )
  }

  return frames
}

export class SignalCollector {
  readonly #expectedKind: SignalKind
  #sessionId = ''
  #total = 0
  #parts = new Map<number, string>()

  constructor(expectedKind: SignalKind) {
    this.#expectedKind = expectedKind
  }

  add(value: string): { progress?: SignalProgress; signal?: SignalEnvelope } {
    const frame = parseFrame(value)
    if (!frame || frame.kind !== this.#expectedKind) return {}

    if (this.#sessionId && frame.sessionId !== this.#sessionId) {
      this.reset()
    }

    if (!this.#sessionId) {
      this.#sessionId = frame.sessionId
      this.#total = frame.total
    }

    if (frame.total !== this.#total) return {}

    this.#parts.set(frame.index, frame.payload)
    const progress = {
      received: this.#parts.size,
      total: this.#total,
      sessionId: this.#sessionId,
    }

    if (this.#parts.size !== this.#total) return { progress }

    try {
      const encoded = Array.from({ length: this.#total }, (_, index) => this.#parts.get(index) ?? '').join('')
      const json = strFromU8(unzlibSync(fromBase64Url(encoded)))
      const signal = JSON.parse(json) as Partial<SignalEnvelope>

      if (
        signal.v !== 1 ||
        signal.sessionId !== this.#sessionId ||
        signal.kind !== this.#expectedKind ||
        !signal.description ||
        signal.description.type !== this.#expectedKind ||
        typeof signal.description.sdp !== 'string'
      ) {
        throw new Error('信令内容无效')
      }

      return { progress, signal: signal as SignalEnvelope }
    } catch {
      this.reset()
      return {}
    }
  }

  reset(): void {
    this.#sessionId = ''
    this.#total = 0
    this.#parts.clear()
  }
}
