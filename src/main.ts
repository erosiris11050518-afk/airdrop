import './style.css'
import { renderHome } from './pages/home.ts'
import { renderReceiver } from './pages/receiver.ts'
import { renderSender } from './pages/sender.ts'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('找不到应用根节点')

app.innerHTML = `
  <header class="site-header">
    <a class="brand" href="/" aria-label="AirBridge 首页">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
      <span>AirBridge</span>
    </a>
    <div class="header-note"><span class="live-dot"></span> 文件不经过服务器</div>
  </header>
  <main id="page"></main>
  <footer class="site-footer">
    <span>WebRTC 点对点加密传输</span>
    <span>·</span>
    <span>动态二维码离线交换信令</span>
  </footer>
`

const page = document.querySelector<HTMLElement>('#page')
if (!page) throw new Error('找不到页面容器')

const path = window.location.pathname.replace(/\/+$/u, '') || '/'
const mode = new URLSearchParams(window.location.search).get('mode')

if (mode === 'send' || path === '/send') renderSender(page)
else if (mode === 'receive' || path === '/receive') renderReceiver(page)
else renderHome(page)
