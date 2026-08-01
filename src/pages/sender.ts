import { QrPlayer } from '../lib/qr-player.ts'
import { QrScanner } from '../lib/scanner.ts'
import { createSessionId, encodeSignal, SignalCollector } from '../lib/signal.ts'
import { FileSender, formatBytes, prepareFileMetadata, type FileMetadata } from '../lib/transfer.ts'
import { createOfferPeer } from '../lib/webrtc.ts'

export function renderSender(root: HTMLElement): void {
  root.innerHTML = `
    <section class="workspace">
      <div class="workspace-heading">
        <a href="./" class="back-link">← 返回</a>
        <span class="page-kicker">SEND A FILE</span>
        <h1>把文件交给这台设备</h1>
        <p>文件保留在本机，直到对方建立加密连接。</p>
      </div>

      <div class="workflow-grid">
        <section class="panel file-panel">
          <div class="panel-label"><span>1</span> 选择文件</div>
          <label class="drop-zone" id="drop-zone">
            <input id="file-input" type="file" />
            <span class="upload-glyph" aria-hidden="true">↑</span>
            <strong>点击选择，或拖放文件</strong>
            <small>不限格式 · 不上传云端</small>
          </label>
          <div class="selected-file is-hidden" id="selected-file">
            <span class="file-glyph" aria-hidden="true"></span>
            <div><strong id="file-name"></strong><small id="file-meta"></small></div>
            <button id="change-file" class="text-button" type="button">更换</button>
          </div>
        </section>

        <section class="panel signal-panel is-hidden" id="signal-panel">
          <div class="panel-label"><span>2</span> 让接收端扫码</div>
          <div class="status-line"><span class="pulse-dot"></span><strong id="signal-status">正在生成连接信令…</strong></div>
          <div class="qr-shell">
            <img id="offer-qr" alt="正在刷新的 WebRTC Offer 动态二维码" />
            <span class="qr-corner corner-a"></span><span class="qr-corner corner-b"></span>
            <span class="qr-corner corner-c"></span><span class="qr-corner corner-d"></span>
          </div>
          <div class="frame-meter"><span class="fps-badge">10 FPS</span><span id="frame-label">准备中</span></div>
          <p class="helper-copy">请让接收端选择“我要接收”，并将相机对准上方区域。</p>
          <button id="scan-answer" class="button button-primary" type="button" disabled>
            对方已扫完，扫描回传码 <span>→</span>
          </button>
        </section>

        <section class="panel scan-panel is-hidden" id="scan-panel">
          <div class="panel-label"><span>3</span> 扫描接收端的 Answer</div>
          <div class="camera-shell">
            <video id="answer-camera"></video>
            <div class="scan-reticle"><i></i><i></i><i></i><i></i></div>
            <div class="scan-sweep"></div>
          </div>
          <strong class="camera-status" id="camera-status">正在打开相机…</strong>
          <div class="scan-progress"><span id="scan-progress-bar"></span></div>
          <small id="scan-progress-text">将接收端的动态二维码放入框内</small>
        </section>

        <section class="panel transfer-panel is-hidden" id="transfer-panel">
          <div class="panel-label"><span>4</span> 点对点传输</div>
          <div class="transfer-visual"><span class="device-dot">发</span><i></i><span class="device-dot">收</span></div>
          <div class="transfer-title"><strong id="transfer-status">正在建立加密通道…</strong><span id="transfer-percent">0%</span></div>
          <div class="progress-track"><span id="transfer-progress"></span></div>
          <div class="transfer-stats"><span id="sent-bytes">0 B</span><span id="total-bytes">0 B</span></div>
          <div class="button-row">
            <button id="pause-transfer" class="button button-secondary" type="button">暂停</button>
            <button id="retry-transfer" class="button button-secondary is-hidden" type="button">重新生成连接码</button>
          </div>
        </section>
      </div>
      <div id="error-banner" class="error-banner is-hidden" role="alert"></div>
    </section>
  `

  const fileInput = getElement<HTMLInputElement>('#file-input')
  const dropZone = getElement<HTMLElement>('#drop-zone')
  const selectedFile = getElement<HTMLElement>('#selected-file')
  const fileName = getElement<HTMLElement>('#file-name')
  const fileMeta = getElement<HTMLElement>('#file-meta')
  const signalPanel = getElement<HTMLElement>('#signal-panel')
  const scanPanel = getElement<HTMLElement>('#scan-panel')
  const transferPanel = getElement<HTMLElement>('#transfer-panel')
  const signalStatus = getElement<HTMLElement>('#signal-status')
  const frameLabel = getElement<HTMLElement>('#frame-label')
  const offerQr = getElement<HTMLImageElement>('#offer-qr')
  const scanAnswer = getElement<HTMLButtonElement>('#scan-answer')
  const camera = getElement<HTMLVideoElement>('#answer-camera')
  const cameraStatus = getElement<HTMLElement>('#camera-status')
  const scanProgress = getElement<HTMLElement>('#scan-progress-bar')
  const scanProgressText = getElement<HTMLElement>('#scan-progress-text')
  const transferStatus = getElement<HTMLElement>('#transfer-status')
  const transferPercent = getElement<HTMLElement>('#transfer-percent')
  const transferProgress = getElement<HTMLElement>('#transfer-progress')
  const sentBytes = getElement<HTMLElement>('#sent-bytes')
  const totalBytes = getElement<HTMLElement>('#total-bytes')
  const pauseButton = getElement<HTMLButtonElement>('#pause-transfer')
  const retryButton = getElement<HTMLButtonElement>('#retry-transfer')
  const errorBanner = getElement<HTMLElement>('#error-banner')
  const qrPlayer = new QrPlayer(offerQr)
  const scanner = new QrScanner(camera)

  let file: File | undefined
  let metadata: FileMetadata | undefined
  let peer: RTCPeerConnection | undefined
  let dataChannel: RTCDataChannel | undefined
  let sender: FileSender | undefined
  let sessionId = ''
  let paused = false

  const showError = (message: string) => {
    errorBanner.textContent = message
    errorBanner.classList.remove('is-hidden')
  }

  const updateProgress = (current: number, total: number) => {
    const percent = total === 0 ? 100 : Math.min(100, (current / total) * 100)
    transferProgress.style.width = `${percent}%`
    transferPercent.textContent = `${Math.round(percent)}%`
    sentBytes.textContent = formatBytes(current)
    totalBytes.textContent = formatBytes(total)
  }

  const watchConnection = (connection: RTCPeerConnection) => {
    connection.addEventListener('connectionstatechange', () => {
      if (connection !== peer) return
      if (connection.connectionState === 'connected') {
        qrPlayer.stop()
        scanner.stop()
        scanPanel.classList.add('is-hidden')
        transferPanel.classList.remove('is-hidden')
        transferStatus.textContent = '加密通道已建立，正在协商续传位置…'
      }
      if (connection.connectionState === 'disconnected') {
        transferStatus.textContent = '连接暂时中断，正在自动恢复…'
      }
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        transferStatus.textContent = '连接已中断，可重新扫码续传'
        retryButton.classList.remove('is-hidden')
      }
    })
  }

  const prepare = async (nextFile: File) => {
    qrPlayer.stop()
    scanner.stop()
    sender?.cancel()
    peer?.close()
    errorBanner.classList.add('is-hidden')
    retryButton.classList.add('is-hidden')
    signalPanel.classList.remove('is-hidden')
    scanPanel.classList.add('is-hidden')
    transferPanel.classList.add('is-hidden')
    scanAnswer.disabled = true
    signalStatus.textContent = '正在生成连接信令…'

    file = nextFile
    fileName.textContent = file.name
    fileMeta.textContent = `${formatBytes(file.size)} · ${file.type || '通用文件'}`
    dropZone.classList.add('is-hidden')
    selectedFile.classList.remove('is-hidden')

    try {
      metadata = await prepareFileMetadata(file)
      const offer = await createOfferPeer()
      peer = offer.pc
      dataChannel = offer.channel
      sessionId = createSessionId()
      watchConnection(peer)

      sender = new FileSender(dataChannel, file, metadata, {
        onProgress: updateProgress,
        onStatus: (message) => {
          transferStatus.textContent = message
        },
        onComplete: () => {
          transferStatus.textContent = '已发出所有数据，等待对方下载'
        },
        onError: showError,
      })

      const frames = encodeSignal({
        v: 1,
        sessionId,
        kind: 'offer',
        description: offer.description,
      })
      await qrPlayer.play(frames, (index, total) => {
        frameLabel.textContent = `信令帧 ${index} / ${total}`
      })
      signalStatus.textContent = '动态连接码已就绪'
      scanAnswer.disabled = false
      updateProgress(0, file.size)
    } catch (error) {
      showError(error instanceof Error ? error.message : '生成连接信令失败')
    }
  }

  const selectFile = (nextFile?: File) => {
    if (nextFile) void prepare(nextFile)
  }

  fileInput.addEventListener('change', () => selectFile(fileInput.files?.[0]))
  getElement<HTMLButtonElement>('#change-file').addEventListener('click', () => fileInput.click())

  for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault()
      dropZone.classList.add('is-dragging')
    })
  }
  for (const eventName of ['dragleave', 'drop']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault()
      dropZone.classList.remove('is-dragging')
    })
  }
  dropZone.addEventListener('drop', (event) => selectFile(event.dataTransfer?.files[0]))

  scanAnswer.addEventListener('click', async () => {
    if (!peer || !sessionId) return
    qrPlayer.stop()
    signalPanel.classList.add('is-hidden')
    scanPanel.classList.remove('is-hidden')
    const collector = new SignalCollector('answer')

    try {
      cameraStatus.textContent = '正在寻找接收端信令…'
      await scanner.start((value) => {
        const result = collector.add(value)
        if (result.progress) {
          const percent = (result.progress.received / result.progress.total) * 100
          scanProgress.style.width = `${percent}%`
          scanProgressText.textContent = `已读取 ${result.progress.received} / ${result.progress.total} 帧`
        }
        if (!result.signal || result.signal.sessionId !== sessionId) return

        scanner.stop()
        cameraStatus.textContent = '已读取 Answer，正在建立连接…'
        void peer?.setRemoteDescription(result.signal.description).catch((error: unknown) => {
          showError(error instanceof Error ? error.message : '无法应用接收端信令')
        })
      })
    } catch (error) {
      showError(error instanceof Error ? error.message : '无法打开相机')
    }
  })

  pauseButton.addEventListener('click', () => {
    if (!sender) return
    paused = !paused
    if (paused) sender.pause()
    else sender.resume()
    pauseButton.textContent = paused ? '继续' : '暂停'
  })

  retryButton.addEventListener('click', () => {
    if (file) void prepare(file)
  })
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing element: ${selector}`)
  return element
}
