const ICE_GATHER_TIMEOUT_MS = 12_000

function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: 'max-bundle',
  })
}

export async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return

  await new Promise<void>((resolve) => {
    let timeout = 0

    const finish = () => {
      window.clearTimeout(timeout)
      pc.removeEventListener('icegatheringstatechange', onStateChange)
      resolve()
    }

    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }

    pc.addEventListener('icegatheringstatechange', onStateChange)
    timeout = window.setTimeout(finish, ICE_GATHER_TIMEOUT_MS)
  })
}

export async function createOfferPeer(): Promise<{
  pc: RTCPeerConnection
  channel: RTCDataChannel
  description: RTCSessionDescriptionInit
}> {
  const pc = createPeerConnection()
  const channel = pc.createDataChannel('airbridge-file', {
    ordered: true,
  })
  channel.binaryType = 'arraybuffer'

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitForIceGathering(pc)

  if (!pc.localDescription) {
    pc.close()
    throw new Error('无法生成 WebRTC Offer')
  }

  return {
    pc,
    channel,
    description: pc.localDescription.toJSON(),
  }
}

export async function createAnswerPeer(
  offer: RTCSessionDescriptionInit,
  onDataChannel: (channel: RTCDataChannel) => void,
): Promise<{
  pc: RTCPeerConnection
  description: RTCSessionDescriptionInit
}> {
  const pc = createPeerConnection()
  pc.addEventListener(
    'datachannel',
    (event) => {
      event.channel.binaryType = 'arraybuffer'
      onDataChannel(event.channel)
    },
    { once: true },
  )

  await pc.setRemoteDescription(offer)
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitForIceGathering(pc)

  if (!pc.localDescription) {
    pc.close()
    throw new Error('无法生成 WebRTC Answer')
  }

  return {
    pc,
    description: pc.localDescription.toJSON(),
  }
}
