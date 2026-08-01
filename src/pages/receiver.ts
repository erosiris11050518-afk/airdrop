import { QrPlayer } from '../lib/qr-player.ts'
import { QrScanner } from '../lib/scanner.ts'
import { deleteTransfer, requestPersistentStorage, type TransferRecord } from '../lib/storage.ts'
import { encodeSignal, SignalCollector } from '../lib/signal.ts'
import { FileReceiver, formatBytes } from '../lib/transfer.ts'
import { createAnswerPeer } from '../lib/webrtc.ts'

export function renderReceiver(root: HTMLElement): void {
  root.innerHTML = `
    <section class="workspace receiver-workspace">
      <div class="workspace-heading">
        <a href="./" class="back-link">← 返回</a>
        <span class="page-kicker">RECEIVE A FILE</span>
        <h1>扫描发送端的屏幕</h1>
        <p>收齐动态信令后，这台设备会自动生成回传码。</p>
      </div>

      <div class="receiver-stage">
        <section class="panel receive-scan-panel" id="offer-scan-panel">
          <div class="panel-label"><span>1</span> 读取发送端 Offer</div>
          <div class="camera-shell camera-idle" id="receiver-camera-shell">
            <video id="offer-camera"></video>
            <div class="camera-placeholder">
              <span class="scan-icon-large" aria-hidden="true"><i></i></span>
              <strong>相机将在这里打开</strong>
              <small>只用于识别 AirBridge 信令码</small>
            </div>
            <div class="scan-reticle"><i></i><i></i><i></i><i></i></div>
            <div class="scan-sweep"></div>
          </div>
          <button id="start-camera" class="button button-primary" type="button">开启相机并扫描 <span>→</span></button>
          <strong class="camera-status" id="offer-camera-status">等待开始</strong>
          <div class="scan-progress"><span id="offer-progress-bar"></span></div>
          <small id="offer-progress-text">动态码会自动分片，请保持镜头稳定</small>
        </section>

        <section class="panel answer-panel is-hidden" id="answer-panel">
          <div class="panel-label"><span>2</span> 让发送端扫描 Answer</div>
          <div class="status-line"><span class="pulse-dot"></span><strong id="answer-status">正在生成回传信令…</strong></div>
          <div class="qr-shell">
            <img id="answer-qr" alt="正在刷新的 WebRTC Answer 动态二维码" />
            <span class="qr-corner corner-a"></span><span class="qr-corner corner-b"></span>
            <span class="qr-corner corner-c"></span><span class="qr-corner corner-d"></span>
          </div>
          <div class="frame-meter"><span class="fps-badge">10 FPS</span><span id="answer-frame-label">准备中</span></div>
          <p class="helper-copy">现在请在发送端点击“扫描回传码”，然后对准这块屏幕。</p>
        </section>

        <section class="panel receive-transfer-panel is-hidden" id="receive-transfer-panel">
          <div class="panel-label"><span>3</span> 接收文件</div>
          <div class="incoming-file">
            <span class="file-glyph" aria-hidden="true"></span>
            <div><strong id="incoming-name">等待文件信息…</strong><small id="incoming-meta">已建立点对点连接</small></div>
          </div>
          <div class="transfer-title"><strong id="receive-status">正在协商续传位置…</strong><span id="receive-percent">0%</span></div>
          <div class="progress-track"><span id="receive-progress"></span></div>
          <div class="transfer-stats"><span id="received-bytes">0 B</span><span id="receive-total">0 B</span></div>
          <a id="download-file" class="button button-primary is-hidden" href="#">下载文件 <span>↓</span></a>
          <div class="button-row">
            <button id="clear-cache" class="text-button is-hidden" type="button">下载后清除续传缓存</button>
            <button id="receive-retry" class="button button-secondary is-hidden" type="button">重新扫码续传</button>
          </div>
        </section>
      </div>
      <div id="receive-error" class="error-banner is-hidden" role="alert"></div>
    </section>
  `

  const scanPanel = getElement<HTMLElement>('#offer-scan-panel')
  const answerPanel = getElement<HTMLElement>('#answer-panel')
  const transferPanel = getElement<HTMLElement>('#receive-transfer-panel')
  const cameraShell = getElement<HTMLElement>('#receiver-camera-shell')
  const camera = getElement<HTMLVideoElement>('#offer-camera')
  const startCamera = getElement<HTMLButtonElement>('#start-camera')
  const cameraStatus = getElement<HTMLElement>('#offer-camera-status')
  const offerProgress = getElement<HTMLElement>('#offer-progress-bar')
  const offerProgressText = getElement<HTMLElement>('#offer-progress-text')
  const answerQr = getElement<HTMLImageElement>('#answer-qr')
  const answerStatus = getElement<HTMLElement>('#answer-status')
  const answerFrameLabel = getElement<HTMLElement>('#answer-frame-label')
  const incomingName = getElement<HTMLElement>('#incoming-name')
  const incomingMeta = getElement<HTMLElement>('#incoming-meta')
  const receiveStatus = getElement<HTMLElement>('#receive-status')
  const receivePercent = getElement<HTMLElement>('#receive-percent')
  const receiveProgress = getElement<HTMLElement>('#receive-progress')
  const receivedBytes = getElement<HTMLElement>('#received-bytes')
  const receiveTotal = getElement<HTMLElement>('#receive-total')
  const downloadFile = getElement<HTMLAnchorElement>('#download-file')
  const clearCache = getElement<HTMLButtonElement>('#clear-cache')
  const retry = getElement<HTMLButtonElement>('#receive-retry')
  const errorBanner = getElement<HTMLElement>('#receive-error')
  const scanner = new QrScanner(camera)
  const qrPlayer = new QrPlayer(answerQr)

  let peer: RTCPeerConnection | undefined
  let currentTransfer: TransferRecord | undefined
  let downloadUrl: string | undefined

  const showError = (message: string) => {
    errorBanner.textContent = message
    errorBanner.classList.remove('is-hidden')
    retry.classList.remove('is-hidden')
  }

  const updateProgress = (current: number, total: number) => {
    const percent = total === 0 ? 100 : Math.min(100, (current / total) * 100)
    receiveProgress.style.width = `${percent}%`
    receivePercent.textContent = `${Math.round(percent)}%`
    receivedBytes.textContent = formatBytes(current)
    receiveTotal.textContent = formatBytes(total)
  }

  const attachReceiver = (channel: RTCDataChannel) => {
    channel.addEventListener('open', () => {
      qrPlayer.stop()
      answerPanel.classList.add('is-hidden')
      transferPanel.classList.remove('is-hidden')
      receiveStatus.textContent = '加密通道已建立，等待文件信息…'
    })
    new FileReceiver(channel, {
      onMetadata: (transfer) => {
        currentTransfer = transfer
        incomingName.textContent = transfer.name
        incomingMeta.textContent = `${formatBytes(transfer.size)} · ${transfer.mimeType}`
        receiveStatus.textContent = transfer.receivedBytes > 0
          ? `已找到 ${formatBytes(transfer.receivedBytes)} 续传进度`
          : '正在接收并保存到本机…'
      },
      onProgress: updateProgress,
      onStatus: (message) => {
        receiveStatus.textContent = message
      },
      onComplete: (blob, transfer) => {
        if (downloadUrl) URL.revokeObjectURL(downloadUrl)
        downloadUrl = URL.createObjectURL(blob)
        downloadFile.href = downloadUrl
        downloadFile.download = transfer.name
        downloadFile.classList.remove('is-hidden')
        clearCache.classList.remove('is-hidden')
        receiveStatus.textContent = '文件已完整接收'
        updateProgress(transfer.size, transfer.size)
      },
      onError: showError,
    })
  }

  const createAnswer = async (sessionId: string, offer: RTCSessionDescriptionInit) => {
    scanner.stop()
    cameraStatus.textContent = '已收齐 Offer'
    scanPanel.classList.add('is-hidden')
    answerPanel.classList.remove('is-hidden')

    try {
      const answer = await createAnswerPeer(offer, attachReceiver)
      peer = answer.pc
      peer.addEventListener('connectionstatechange', () => {
        if (peer?.connectionState === 'failed' || peer?.connectionState === 'closed') {
          receiveStatus.textContent = '连接已中断，重新扫码可从已保存位置继续'
          retry.classList.remove('is-hidden')
        }
      })
      const frames = encodeSignal({
        v: 1,
        sessionId,
        kind: 'answer',
        description: answer.description,
      })
      await qrPlayer.play(frames, (index, total) => {
        answerFrameLabel.textContent = `信令帧 ${index} / ${total}`
      })
      answerStatus.textContent = '回传动态码已就绪'
    } catch (error) {
      showError(error instanceof Error ? error.message : '无法生成 Answer')
    }
  }

  startCamera.addEventListener('click', async () => {
    errorBanner.classList.add('is-hidden')
    startCamera.disabled = true
    cameraShell.classList.remove('camera-idle')
    cameraStatus.textContent = '正在打开相机…'
    const collector = new SignalCollector('offer')
    void requestPersistentStorage()

    try {
      await scanner.start((value) => {
        const result = collector.add(value)
        if (result.progress) {
          const percent = (result.progress.received / result.progress.total) * 100
          offerProgress.style.width = `${percent}%`
          offerProgressText.textContent = `已读取 ${result.progress.received} / ${result.progress.total} 帧`
          cameraStatus.textContent = '检测到信令，请保持稳定…'
        }
        if (result.signal) void createAnswer(result.signal.sessionId, result.signal.description)
      })
      cameraStatus.textContent = '正在寻找发送端信令…'
    } catch (error) {
      startCamera.disabled = false
      showError(error instanceof Error ? error.message : '无法打开相机')
    }
  })

  clearCache.addEventListener('click', async () => {
    if (!currentTransfer) return
    await deleteTransfer(currentTransfer.id)
    clearCache.textContent = '续传缓存已清除'
    clearCache.disabled = true
  })

  retry.addEventListener('click', () => window.location.reload())
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing element: ${selector}`)
  return element
}
