import '@angular/compiler';
import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode, ErrorHandler, VERSION, NgZone } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { AppComponent } from './src/app.component';
import { routes } from './src/app.routes';
import { GlobalErrorHandler } from './src/services/global-error-handler.service';

// ============= BUILD ID: 2025-12-03-v10-DEBUG-STATE =============
const BUILD_ID = '2025-12-03-v10-DEBUG-STATE';
const START_TIME = Date.now();

// 🔥 移动端屏幕日志 - 始终显示（用于调试后移除）
(function() {
  const logDiv = document.createElement('div');
  logDiv.id = 'screen-debug-log';
  logDiv.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:150px;background:rgba(0,0,0,0.9);color:#0f0;font-size:11px;overflow:auto;z-index:999999;padding:4px;font-family:monospace;';
  document.body.appendChild(logDiv);

  const log = (msg: string, color = '#0f0') => {
    const p = document.createElement('div');
    p.style.color = color;
    p.style.marginBottom = '2px';
    const elapsed = Date.now() - START_TIME;
    p.textContent = `[+${elapsed}ms] ${msg}`;
    logDiv.appendChild(p);
    logDiv.scrollTop = logDiv.scrollHeight;
    // 同时输出到控制台
    console.log(`[+${elapsed}ms] ${msg}`);
  };

  (window as any).__LOG__ = log;
  (window as any).__LOG_ERROR__ = (msg: string) => log(msg, '#f00');
  
  log('Build: ' + BUILD_ID);
  log('UA: ' + navigator.userAgent.substring(0, 60));
})();

const log = (window as any).__LOG__ as (msg: string, color?: string) => void;
const logError = (window as any).__LOG_ERROR__ as (msg: string) => void;

log('🚀 main.ts 开始执行');
log('Angular 版本: ' + VERSION.full);

// 检查 Zone.js 是否已加载
const zoneLoaded = typeof (window as any).Zone !== 'undefined';
log('Zone.js: ' + (zoneLoaded ? '✅已加载' : '❌未加载'));

if (!zoneLoaded) {
  logError('Zone.js 未加载！Angular 无法工作！');
}

// 检测浏览器能力
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
log('设备: ' + (isMobile ? (isIOS ? 'iOS' : 'Android') : 'Desktop'));

log('🔧 变更检测: Zone.js (标准)');

// 强制注销所有 Service Worker - 避免缓存问题
if ('serviceWorker' in navigator) {
  log('🧹 注销所有 Service Worker...');
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(reg => {
      log('注销 SW: ' + reg.scope);
      reg.unregister();
    });
    if (registrations.length === 0) {
      log('无 Service Worker 需要注销');
    }
  }).catch(e => logError('注销 SW 失败: ' + e));
}

log('🏗️ 准备启动 Angular...');

log('⏳ 开始 bootstrapApplication...');

bootstrapApplication(AppComponent, {
  providers: [
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withHashLocation()
    ),
    // Service Worker: 提供 provider 但禁用功能，避免 SwUpdate 注入失败
    provideServiceWorker('ngsw-worker.js', {
      enabled: false,
      registrationStrategy: 'registerWhenStable:30000'
    })
  ]
}).then((appRef) => {
  const elapsed = Date.now() - START_TIME;
  log('✅ Angular 启动成功! 耗时: ' + elapsed + 'ms', '#0f0');
  
  // 标记应用就绪
  (window as any).__NANOFLOW_READY__ = true;
  
  // 隐藏初始加载器
  const loader = document.getElementById('initial-loader');
  if (loader) loader.style.display = 'none';
  
  // 检查应用状态
  setTimeout(() => {
    const appRoot = document.querySelector('app-root');
    log('📊 app-root children: ' + (appRoot?.children.length ?? 0));
    log('📊 body innerHTML length: ' + document.body.innerHTML.length);
    
    // 检测是否有遮挡层
    const overlays = document.querySelectorAll('[style*="position:fixed"], [style*="position: fixed"]');
    log('📊 Fixed overlays: ' + overlays.length);
    
    // 检测是否有 pointer-events:none
    const appContainer = document.querySelector('[data-testid="app-container"]');
    if (appContainer) {
      const style = getComputedStyle(appContainer);
      log('📊 app-container pointer-events: ' + style.pointerEvents);
      log('📊 app-container display: ' + style.display);
    }
  }, 500);
  
  // 10秒后隐藏调试日志面板（生产环境）
  setTimeout(() => {
    const debugLog = document.getElementById('screen-debug-log');
    if (debugLog) debugLog.style.display = 'none';
  }, 10000);
  
  log('🎉 应用完全就绪');
}).catch(err => {
  logError('❌ 启动失败: ' + (err?.message || err));
  logError('错误类型: ' + (err?.name || 'Unknown'));
  
  // 检查常见错误类型
  const errStr = String(err?.message || err);
  if (errStr.includes('NG0908')) {
    logError('诊断: Zone.js 冲突 (NG0908)');
  } else if (errStr.includes('inject')) {
    logError('诊断: 依赖注入错误');
  } else if (errStr.includes('NullInjector')) {
    logError('诊断: 缺少 Provider');
    // 尝试从堆栈中获取更多信息
    if (err?.stack) {
      const stackLines = err.stack.split('\n').slice(0, 5);
      stackLines.forEach((line: string, i: number) => {
        logError(`Stack[${i}]: ${line.trim().substring(0, 80)}`);
      });
    }
  }
  
  // 显示用户可见的错误界面
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:sans-serif;z-index:99998;overflow:auto;';
  errorDiv.innerHTML = `
    <h1 style="color:#dc2626;margin-bottom:1rem;">应用启动失败</h1>
    <p style="margin-bottom:1rem;">Build: ${BUILD_ID}</p>
    <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:11px;max-height:150px;margin-bottom:1rem;white-space:pre-wrap;word-break:break-all;">${err?.message || err}</pre>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button onclick="location.reload()" style="padding:0.5rem 1rem;background:#4f46e5;color:#fff;border:none;border-radius:4px;cursor:pointer;">刷新</button>
      <button onclick="caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n)))).then(()=>location.reload())" style="padding:0.5rem 1rem;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer;">清缓存刷新</button>
    </div>
  `;
  document.body.appendChild(errorDiv);
});
