/**
 * Service Worker —— 只为「离线能打开」这一件事存在。
 *
 * 刻意不做的事：
 *   1. 不缓存任何 /api 响应。经期数据和 AI 回答缓存到磁盘上，
 *      既有隐私问题（别人拿到设备能翻出来），也会让同步逻辑变得难以推理。
 *   2. 不做推送通知。iOS 上 Web Push 不可靠，承诺了做不到更糟。
 *      提醒改成打开应用时的横幅。
 *
 * 策略：
 *   - 应用外壳（HTML/JS/图标）按版本整套缓存；升级时必须递增 VERSION。
 *     新版本的所有资源下载成功才激活，避免新旧同步协议混用。
 *   - 其他一律网络优先，失败才回缓存。
 */

const VERSION = 'v4-ai-privacy';
const SHELL_CACHE = `nebula-shell-${VERSION}`;

const SHELL = [
  './',
  'js/period.js',
  'js/storage.js',
  'js/api.js',
  'js/app.js',
  'assets/tailwind.js',
  'assets/backdrop.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // 全套资源齐备才启用新版，避免离线时混用新旧同步代码。
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('nebula-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域（模型服务）不插手

  // API 一律直连，永不缓存
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const fetching = fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(() => null);

      const fresh = await fetching;
      if (fresh) return fresh;
      // 导航请求离线兜底：给外壳，应用自己从 IndexedDB 读数据
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html') || await cache.match('./');
        if (shell) return shell;
      }
      return new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
    })
  );
});

// 前端点「检查更新」时用
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
