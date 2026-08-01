export function renderHome(root: HTMLElement): void {
  root.innerHTML = `
    <section class="hero-section">
      <div class="eyebrow"><span></span> ZERO SERVER · ZERO UPLOAD</div>
      <h1>跨过网络，<br><em>不经过任何人。</em></h1>
      <p class="hero-copy">用动态二维码让两台设备相认，再通过 WebRTC 建立加密直连。<br>无需注册，无需上传，关闭页面即结束。</p>

      <div class="role-grid" aria-label="选择操作">
        <a class="role-card role-card-primary" href="/?mode=send">
          <span class="role-index">01</span>
          <span class="role-icon send-icon" aria-hidden="true"><i></i></span>
          <span class="role-content">
            <strong>我要发送</strong>
            <small>选择文件，生成动态二维码</small>
          </span>
          <span class="arrow" aria-hidden="true">↗</span>
        </a>
        <a class="role-card" href="/?mode=receive">
          <span class="role-index">02</span>
          <span class="role-icon scan-icon" aria-hidden="true"><i></i></span>
          <span class="role-content">
            <strong>我要接收</strong>
            <small>打开相机，扫描发送端屏幕</small>
          </span>
          <span class="arrow" aria-hidden="true">↗</span>
        </a>
      </div>
    </section>

    <section class="how-section">
      <div class="section-heading">
        <span>HOW IT WORKS</span>
        <h2>三步完成直连</h2>
      </div>
      <ol class="steps-grid">
        <li>
          <span class="step-number">1</span>
          <strong>展示 Offer</strong>
          <p>发送端把压缩后的 WebRTC Offer 分片，以 10 FPS 循环展示。</p>
        </li>
        <li>
          <span class="step-number">2</span>
          <strong>扫码回传 Answer</strong>
          <p>接收端收齐信令后生成 Answer，发送端反向扫描即可相认。</p>
        </li>
        <li>
          <span class="step-number">3</span>
          <strong>加密直传</strong>
          <p>文件经 DataChannel 直达对方浏览器，中断后可从已保存位置继续。</p>
        </li>
      </ol>
    </section>

    <aside class="compatibility-strip">
      <span class="shield-mark" aria-hidden="true">✓</span>
      <div><strong>隐私是默认设置</strong><small>SDP 只在两块屏幕之间交换，文件通过 DTLS 加密。</small></div>
      <div class="platforms" aria-label="支持的平台"><span>iOS Safari</span><span>Android Chrome</span><span>Desktop</span></div>
    </aside>
  `
}
