import '@angular/compiler';
import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode, ErrorHandler } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { AppComponent } from './src/app.component';
import { provideServiceWorker } from '@angular/service-worker';
import { routes } from './src/app.routes';
import { GlobalErrorHandler } from './src/services/global-error-handler.service';

// 🔍 调试：记录启动时间点
console.log('[NanoFlow] 🚀 开始启动应用...', new Date().toISOString());

// 🔍 调试：检测浏览器能力
const browserInfo = {
  userAgent: navigator.userAgent,
  isMobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
  isIOS: /iPhone|iPad|iPod/i.test(navigator.userAgent),
  isAndroid: /Android/i.test(navigator.userAgent),
  supportsSignal: typeof AbortController !== 'undefined',
  supportsProxy: typeof Proxy !== 'undefined',
  language: navigator.language
};
console.log('[NanoFlow] 📱 浏览器信息:', browserInfo);

// 检查 URL 参数
const urlParams = new URLSearchParams(window.location.search);
const skipServiceWorker = urlParams.has('nosw') || urlParams.has('skipSw');

// 使用标准的 Zone.js 变更检测（Angular 默认）
// 注意：Zoneless 模式需要在 angular.json 中配置 polyfills 排除 zone.js
// 为了稳定性，我们使用默认的 Zone.js 模式
console.log('[NanoFlow] ⚙️ 变更检测模式: Zone.js (标准)', { isDevMode: isDevMode() });

// 如果请求跳过 Service Worker，先注销现有的
if (skipServiceWorker && 'serviceWorker' in navigator) {
  console.log('[NanoFlow] 🔧 跳过 Service Worker (URL 参数 nosw)');
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(reg => {
      console.log('[NanoFlow] 注销 Service Worker:', reg.scope);
      reg.unregister();
    });
  }).catch(e => console.warn('[NanoFlow] 注销 SW 失败:', e));
}

bootstrapApplication(AppComponent, {
  providers: [
    // 使用 Angular 默认的 Zone.js 变更检测（不需要显式提供 provider）
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withHashLocation() // 使用 hash 路由以兼容静态部署
    ),
    // Service Worker 只在生产环境且没有 skipServiceWorker 时启用
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode() && !skipServiceWorker,
      // 改为更积极的注册策略，避免阻塞应用启动
      registrationStrategy: 'registerImmediately'
    })
  ]
}).then(() => {
  console.log('[NanoFlow] ✅ Angular 应用启动成功', new Date().toISOString());
}).catch(err => {
  console.error('[NanoFlow] ❌ Angular 应用启动失败:', err);
  // 显示用户可见的错误信息
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:sans-serif;z-index:99999;overflow:auto;';
  errorDiv.innerHTML = `
    <h1 style="color:#dc2626;margin-bottom:1rem;">应用启动失败</h1>
    <p style="margin-bottom:1rem;">抱歉，应用加载时遇到问题。</p>
    <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:12px;max-height:200px;margin-bottom:1rem;">${err?.message || err}\n\n${err?.stack || ''}</pre>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button onclick="location.reload()" style="padding:0.5rem 1rem;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;">刷新页面</button>
      <button onclick="caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n)))).then(()=>location.reload())" style="padding:0.5rem 1rem;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;">清除缓存并刷新</button>
    </div>
    <p style="margin-top:1rem;color:#666;font-size:12px;">浏览器: ${navigator.userAgent}</p>
  `;
  document.body.appendChild(errorDiv);
});
