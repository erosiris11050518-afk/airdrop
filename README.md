# AirBridge

AirBridge 是一个完全运行在浏览器中的跨平台文件传输工具。两台设备通过动态二维码交换 WebRTC Offer/Answer，然后通过加密的 `RTCDataChannel` 点对点传输文件。

项目不包含信令服务器、文件服务器、STUN 或 TURN 服务。部署时只需要一个可提供 HTTPS 的静态站点。

## 特性

- 发送端选择文件后，自动生成包含完整 ICE 候选信息的 SDP Offer。
- Offer 和 Answer 都会压缩、分片和校验，并以 10 FPS 动态二维码循环展示。
- 接收端使用 `zxing-wasm` 在本地识别二维码，WASM 文件由 Vite 一起打包，不依赖 CDN。
- 文件使用可靠、有序的 WebRTC DataChannel 分块传输。
- 同时使用 `bufferedAmount` 和应用层 ACK 窗口做背压，避免大文件压垮移动浏览器内存。
- 接收到的分块持久化到 IndexedDB。连接中断后，发送端重新选择同一文件并再扫一次码，即可从已确认的字节位置继续。
- 适配 iOS Safari、Android Chrome 和现代桌面浏览器。
- 发送页和接收页使用查询参数路由，静态托管时无需 SPA rewrite 规则。

## 技术栈

- TypeScript 6
- Vite 8
- WebRTC / RTCDataChannel
- `zxing-wasm` 3：二维码识别
- `qrcode` 1（node-qrcode）：二维码生成
- `fflate`：SDP 信令压缩
- IndexedDB：分块持久化与断点续传

## 本地运行

需要 Node.js 22 或兼容当前 Vite 版本的 Node.js 版本。

```bash
npm install
npm run dev
```

桌面端在本机访问 Vite 输出的 `http://localhost:5173`。`localhost` 在浏览器中属于安全上下文，可以使用相机。

如需让同一局域网的手机打开开发服务：

```bash
npm run dev -- --host 0.0.0.0
```

> 注意：手机直接访问 `http://<电脑局域网 IP>:5173` 通常不是安全上下文，Safari/Chrome 会禁止调用相机。跨设备实测建议使用 HTTPS 静态部署，或使用两台设备都信任的本地 HTTPS 证书。

## 生产构建

```bash
npm run build
npm run preview
```

`dist/` 是完整的静态产物，可部署到任意 HTTPS 静态托管服务。静态托管只用于下载 HTML/JS/CSS/WASM；信令和文件数据都不会经过托管服务。

项目提供以下页面：

- 首页：`/`
- 发送端：`/?mode=send`
- 接收端：`/?mode=receive`

## 使用流程

1. 在发送设备打开发送页，选择文件。
2. 页面等待本地 ICE gathering 完成，然后以 10 FPS 循环显示 Offer 信令帧。
3. 在接收设备打开接收页，点击“开启相机并扫描”，对准发送端屏幕。
4. 接收端收齐 Offer 后会自动显示 Answer 动态码。
5. 在发送端点击“对方已扫完，扫描回传码”，对准接收端屏幕。
6. DataChannel 建立后会自动开始传输。接收完成后，在接收端点击“下载文件”。
7. 确认下载无误后，可点击“清除续传缓存”释放 IndexedDB 空间。

## 断点续传原理

发送端会使用文件名、文件大小、MIME 类型、头部 64 KiB 和尾部 64 KiB 计算稳定的 SHA-256 标识。接收端以该标识为主键，将每个 16 KiB 分块和连续已收字节数存入 IndexedDB。

重新建立连接后，协议如下：

1. 发送端发送 `metadata`。
2. 接收端查询 IndexedDB，返回 `resume { offset }`。
3. 发送端直接从 `File.slice(offset)` 继续。
4. 接收端每持久化约 512 KiB 或到达文件末尾时发送 `ack`。
5. 发送端最多允许 4 MiB 未确认数据，并在浏览器输出缓冲超过 2 MiB 时暂停写入。

发送端重连时必须重新选择同一文件；浏览器不会在页面重载后保留原文件的读取权限。

## 动态二维码协议

SDP 包装为如下对象：

```ts
interface SignalEnvelope {
  v: 1
  sessionId: string
  kind: 'offer' | 'answer'
  description: RTCSessionDescriptionInit
}
```

JSON 使用 zlib 压缩后转为 Base64URL，再按 360 个字符分片。每帧格式为：

```text
AB1:<sessionId>:<O|A>:<index36>:<total36>:<checksum36>:<payload>
```

接收端会根据 `sessionId` 隔离不同会话，校验每一帧，并允许乱序、重复和丢帧。收齐后才会解压并应用 SDP。

## 目录结构

```text
.
├── index.html
├── src/
│   ├── main.ts                 # 入口与页面路由
│   ├── style.css              # 响应式视觉与移动端适配
│   ├── pages/
│   │   ├── home.ts           # 首页
│   │   ├── sender.ts         # 发送端页面
│   │   └── receiver.ts       # 接收端页面
│   └── lib/
│       ├── signal.ts         # SDP 压缩、分帧、校验与重组
│       ├── qr-player.ts      # node-qrcode 10 FPS 循环播放
│       ├── scanner.ts        # zxing-wasm 摄像头识别
│       ├── webrtc.ts         # Offer/Answer 与 ICE gathering
│       ├── transfer.ts       # 分块、背压、ACK 和续传协议
│       └── storage.ts        # IndexedDB 持久化
├── package.json
└── tsconfig.json
```

## 浏览器与网络限制

### HTTPS 是必需的

除 `localhost` 外，现代浏览器只会在 HTTPS 安全上下文中暴露相机 API。这不是 AirBridge 的限制，而是浏览器安全策略。

### 无 STUN/TURN 的影响

为了满足“无服务器”要求，`RTCPeerConnection` 的 `iceServers` 为空。因此应用依赖浏览器收集的本地 host candidates，最适合两台设备处于同一局域网的场景。以下情况可能无法直连：

- 两台设备不在同一局域网。
- Wi-Fi 开启了 AP/client isolation。
- 系统防火墙禁止 WebRTC UDP 流量。
- VPN、企业网络策略或严格 NAT 阻断直连。

如果需要稳定的跨公网传输，就必须配置 STUN，并在无法直连时使用 TURN。这会改变本项目的纯无服务器定位。

### iOS 注意事项

- 使用较新的 Safari，并允许站点使用相机。
- 扫码和传输时保持 Safari 在前台，iOS 可能冻结后台页面。
- 接收分块保存在站点 IndexedDB 配额中。超大文件受可用存储和浏览器生成最终 Blob 时的内存限制。
- “私密浏览”可能提供更小的 IndexedDB 配额，不建议用于大文件。

## 安全说明

- WebRTC DataChannel 强制使用 DTLS 加密。
- 信令仅通过屏幕和相机交换，不离开本地设备。
- 二维码帧带有会话 ID 和完整性校验，不同会话的信令不会混用。
- 续传缓存留在接收端 IndexedDB 中，需要用户在下载后主动清除，或通过浏览器的站点数据设置删除。

## 常见问题

### 点击扫描后无法打开相机

确认页面使用 HTTPS（或在 `localhost`），并在浏览器站点权限中允许相机。iOS 中还要确认 Safari 的系统相机权限已开启。

### 二维码一直扫不全

提高对方屏幕亮度，避免反光，让二维码完整位于扫描框内，并保持约 20–40 cm 距离。页面显示的“已读取 x / y 帧”会反映当前进度。

### 收齐 Answer 后仍无法连接

确认两台设备位于同一 Wi-Fi，关闭 VPN，并检查路由器是否开启了设备隔离。由于项目不使用 STUN/TURN，它不能穿过所有 NAT 和防火墙。

### 如何续传

不要在接收端清除缓存。两端重新进入对应页面，发送端重新选择同一文件，再完成一次动态二维码交换。接收端会自动回复已保存的偏移量。

## 可用命令

```bash
npm run dev      # 启动 Vite 开发服务
npm run check    # TypeScript 静态检查
npm run build    # 类型检查并生成 dist/
npm run preview  # 在局域网地址预览 dist/
```
