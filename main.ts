import '@angular/compiler';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideExperimentalZonelessChangeDetection, isDevMode, ErrorHandler } from '@angular/core';
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

bootstrapApplication(AppComponent, {
  providers: [
    provideExperimentalZonelessChangeDetection(),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withHashLocation() // 使用 hash 路由以兼容静态部署
    ),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
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
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:sans-serif;z-index:99999;';
  errorDiv.innerHTML = `
    <h1 style="color:#dc2626;">应用启动失败</h1>
    <p>抱歉，应用加载时遇到问题。</p>
    <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:12px;">${err?.message || err}</pre>
    <button onclick="location.reload()" style="padding:0.5rem 1rem;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;">刷新页面</button>
    <button onclick="caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n)))).then(()=>location.reload())" style="margin-left:1rem;padding:0.5rem 1rem;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;">清除缓存并刷新</button>
  `;
  document.body.appendChild(errorDiv);
});
