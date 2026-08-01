import {
  availableStorage,
  ensureTransfer,
  loadFileBlob,
  saveChunk,
  type TransferRecord,
} from './storage.ts'

export const FILE_CHUNK_SIZE = 16 * 1024
const CHUNK_HEADER_SIZE = 4
const BUFFER_HIGH_WATER = 2 * 1024 * 1024
const BUFFER_LOW_WATER = 512 * 1024
const APPLICATION_WINDOW = 4 * 1024 * 1024
const ACK_INTERVAL = 512 * 1024

export interface FileMetadata {
  id: string
  name: string
  size: number
  mimeType: string
  chunkSize: number
}

interface SenderCallbacks {
  onProgress: (acknowledgedBytes: number, totalBytes: number) => void
  onStatus: (message: string) => void
  onComplete: () => void
  onError: (message: string) => void
}

interface ReceiverCallbacks {
  onMetadata: (transfer: TransferRecord) => void
  onProgress: (receivedBytes: number, totalBytes: number) => void
  onStatus: (message: string) => void
  onComplete: (blob: Blob, transfer: TransferRecord) => void
  onError: (message: string) => void
}

type SenderControl =
  | { type: 'resume'; fileId: string; offset: number }
  | { type: 'ack'; fileId: string; receivedBytes: number }

type ReceiverControl =
  | ({ type: 'metadata' } & FileMetadata)
  | { type: 'done'; fileId: string; size: number }

function sendJson(channel: RTCDataChannel, value: SenderControl | ReceiverControl): void {
  if (channel.readyState === 'open') channel.send(JSON.stringify(value))
}

function fallbackFileId(value: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of value) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return `local-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export async function prepareFileMetadata(file: File): Promise<FileMetadata> {
  const sampleSize = 64 * 1024
  const head = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer())
  const tailStart = Math.max(head.byteLength, file.size - sampleSize)
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer())
  const identity = new TextEncoder().encode(`${file.name}\0${file.size}\0${file.type}\0`)
  const payload = new Uint8Array(identity.byteLength + head.byteLength + tail.byteLength)
  payload.set(identity)
  payload.set(head, identity.byteLength)
  payload.set(tail, identity.byteLength + head.byteLength)

  let id = fallbackFileId(payload)
  if (crypto.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload))
    id = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  return {
    id,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    chunkSize: FILE_CHUNK_SIZE,
  }
}

export class FileSender {
  readonly #channel: RTCDataChannel
  readonly #file: File
  readonly #metadata: FileMetadata
  readonly #callbacks: SenderCallbacks
  #paused = false
  #cancelled = false
  #epoch = 0
  #acknowledgedBytes = 0
  #waiters = new Set<() => void>()

  constructor(
    channel: RTCDataChannel,
    file: File,
    metadata: FileMetadata,
    callbacks: SenderCallbacks,
  ) {
    this.#channel = channel
    this.#file = file
    this.#metadata = metadata
    this.#callbacks = callbacks
    this.#channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER
    this.#channel.addEventListener('bufferedamountlow', this.#wake)
    this.#channel.addEventListener('message', this.#onMessage)
    this.#channel.addEventListener('close', () => {
      this.#epoch += 1
      this.#wake()
    })

    if (channel.readyState === 'open') this.#announce()
    else channel.addEventListener('open', this.#announce, { once: true })
  }

  pause(): void {
    this.#paused = true
    this.#callbacks.onStatus('传输已暂停')
  }

  resume(): void {
    this.#paused = false
    this.#callbacks.onStatus('正在继续传输…')
    this.#wake()
  }

  cancel(): void {
    this.#cancelled = true
    this.#epoch += 1
    this.#wake()
    this.#channel.close()
  }

  #announce = (): void => {
    sendJson(this.#channel, { type: 'metadata', ...this.#metadata })
    this.#callbacks.onStatus('已连接，正在检查可续传进度…')
  }

  #onMessage = (event: MessageEvent<unknown>): void => {
    if (typeof event.data !== 'string') return

    try {
      const message = JSON.parse(event.data) as Partial<SenderControl>
      if (message.fileId !== this.#metadata.id) return

      if (message.type === 'ack' && typeof message.receivedBytes === 'number') {
        this.#acknowledgedBytes = Math.max(this.#acknowledgedBytes, message.receivedBytes)
        this.#callbacks.onProgress(this.#acknowledgedBytes, this.#file.size)
        this.#wake()
      }

      if (message.type === 'resume' && typeof message.offset === 'number') {
        const offset = Math.max(0, Math.min(this.#file.size, message.offset))
        this.#acknowledgedBytes = offset
        this.#callbacks.onProgress(offset, this.#file.size)
        this.#epoch += 1
        void this.#sendFrom(offset, this.#epoch)
      }
    } catch {
      // Ignore messages that are not part of the AirBridge transfer protocol.
    }
  }

  async #sendFrom(offset: number, epoch: number): Promise<void> {
    if (offset > 0 && offset < this.#file.size) {
      this.#callbacks.onStatus(`已找到进度，从 ${formatBytes(offset)} 继续`)
    } else if (offset >= this.#file.size) {
      this.#callbacks.onStatus('接收端已有完整文件，正在校验…')
    } else {
      this.#callbacks.onStatus('正在加密传输…')
    }

    let position = offset
    let chunkIndex = Math.floor(position / this.#metadata.chunkSize)

    try {
      while (position < this.#file.size) {
        if (epoch !== this.#epoch || this.#cancelled) return
        await this.#waitForCapacity(position, epoch)
        if (epoch !== this.#epoch || this.#cancelled) return

        const end = Math.min(position + this.#metadata.chunkSize, this.#file.size)
        const content = new Uint8Array(await this.#file.slice(position, end).arrayBuffer())
        const packet = new ArrayBuffer(CHUNK_HEADER_SIZE + content.byteLength)
        const view = new DataView(packet)
        view.setUint32(0, chunkIndex)
        new Uint8Array(packet, CHUNK_HEADER_SIZE).set(content)
        this.#channel.send(packet)

        position = end
        chunkIndex += 1
      }

      if (epoch !== this.#epoch || this.#cancelled) return
      sendJson(this.#channel, { type: 'done', fileId: this.#metadata.id, size: this.#file.size })
      this.#callbacks.onStatus('数据已发送，等待接收端写入完成…')
      this.#callbacks.onComplete()
    } catch (error) {
      if (epoch === this.#epoch && !this.#cancelled) {
        this.#callbacks.onError(error instanceof Error ? error.message : '文件发送失败')
      }
    }
  }

  async #waitForCapacity(position: number, epoch: number): Promise<void> {
    while (
      epoch === this.#epoch &&
      !this.#cancelled &&
      (this.#paused ||
        this.#channel.bufferedAmount > BUFFER_HIGH_WATER ||
        position - this.#acknowledgedBytes > APPLICATION_WINDOW)
    ) {
      if (this.#channel.readyState !== 'open') throw new Error('连接已中断，请重新扫码续传')
      await new Promise<void>((resolve) => {
        this.#waiters.add(resolve)
        window.setTimeout(() => {
          this.#waiters.delete(resolve)
          resolve()
        }, 150)
      })
    }
  }

  #wake = (): void => {
    this.#waiters.forEach((resolve) => resolve())
    this.#waiters.clear()
  }
}

export class FileReceiver {
  readonly #channel: RTCDataChannel
  readonly #callbacks: ReceiverCallbacks
  #transfer: TransferRecord | undefined
  #queue = Promise.resolve()
  #lastAcknowledged = 0

  constructor(channel: RTCDataChannel, callbacks: ReceiverCallbacks) {
    this.#channel = channel
    this.#callbacks = callbacks
    this.#channel.binaryType = 'arraybuffer'
    this.#channel.addEventListener('message', (event) => {
      this.#queue = this.#queue
        .then(() => this.#handleMessage(event.data))
        .catch((error: unknown) => {
          this.#callbacks.onError(error instanceof Error ? error.message : '接收文件时出错')
        })
    })
  }

  async #handleMessage(data: unknown): Promise<void> {
    if (typeof data === 'string') {
      const message = JSON.parse(data) as Partial<ReceiverControl>
      if (message.type === 'metadata') await this.#handleMetadata(message)
      if (message.type === 'done') await this.#handleDone(message)
      return
    }

    let buffer: ArrayBuffer
    if (data instanceof ArrayBuffer) buffer = data
    else if (data instanceof Blob) buffer = await data.arrayBuffer()
    else return

    await this.#handleChunk(buffer)
  }

  async #handleMetadata(message: Partial<FileMetadata>): Promise<void> {
    if (
      typeof message.id !== 'string' ||
      typeof message.name !== 'string' ||
      typeof message.size !== 'number' ||
      typeof message.mimeType !== 'string' ||
      message.chunkSize !== FILE_CHUNK_SIZE ||
      message.size < 0
    ) {
      throw new Error('收到的文件信息无效')
    }

    this.#transfer = await ensureTransfer({
      id: message.id,
      name: message.name,
      size: message.size,
      mimeType: message.mimeType,
      chunkSize: message.chunkSize,
    })
    const freeBytes = await availableStorage()
    const remainingBytes = this.#transfer.size - this.#transfer.receivedBytes
    if (freeBytes !== undefined && freeBytes < remainingBytes * 1.05) {
      throw new Error('设备可用存储空间不足，无法安全续传该文件')
    }
    this.#lastAcknowledged = this.#transfer.receivedBytes
    this.#callbacks.onMetadata(this.#transfer)
    this.#callbacks.onProgress(this.#transfer.receivedBytes, this.#transfer.size)
    sendJson(this.#channel, {
      type: 'resume',
      fileId: this.#transfer.id,
      offset: this.#transfer.receivedBytes,
    })
  }

  async #handleChunk(packet: ArrayBuffer): Promise<void> {
    const transfer = this.#transfer
    if (!transfer || packet.byteLength <= CHUNK_HEADER_SIZE) return

    const index = new DataView(packet).getUint32(0)
    const expectedIndex = Math.floor(transfer.receivedBytes / transfer.chunkSize)

    if (index < expectedIndex) {
      this.#acknowledge(transfer)
      return
    }

    if (index > expectedIndex) {
      sendJson(this.#channel, {
        type: 'resume',
        fileId: transfer.id,
        offset: transfer.receivedBytes,
      })
      return
    }

    const content = packet.slice(CHUNK_HEADER_SIZE)
    if (content.byteLength > transfer.chunkSize || transfer.receivedBytes + content.byteLength > transfer.size) {
      throw new Error('收到的文件分块无效')
    }

    this.#transfer = await saveChunk(transfer, index, content)
    this.#callbacks.onProgress(this.#transfer.receivedBytes, this.#transfer.size)

    if (
      this.#transfer.receivedBytes - this.#lastAcknowledged >= ACK_INTERVAL ||
      this.#transfer.receivedBytes === this.#transfer.size
    ) {
      this.#acknowledge(this.#transfer)
    }
  }

  async #handleDone(message: { fileId?: string; size?: number }): Promise<void> {
    const transfer = this.#transfer
    if (!transfer || message.fileId !== transfer.id || message.size !== transfer.size) return

    if (transfer.receivedBytes !== transfer.size) {
      sendJson(this.#channel, { type: 'resume', fileId: transfer.id, offset: transfer.receivedBytes })
      return
    }

    this.#acknowledge(transfer)
    this.#callbacks.onStatus('已接收，正在准备下载…')
    const blob = await loadFileBlob(transfer)
    this.#callbacks.onComplete(blob, transfer)
  }

  #acknowledge(transfer: TransferRecord): void {
    this.#lastAcknowledged = transfer.receivedBytes
    sendJson(this.#channel, {
      type: 'ack',
      fileId: transfer.id,
      receivedBytes: transfer.receivedBytes,
    })
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]

  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }

  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}
