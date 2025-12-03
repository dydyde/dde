import '@angular/compiler';
import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode, ErrorHandler, VERSION, NgZone } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { AppComponent } from './src/app.component';
import { routes } from './src/app.routes';
import { GlobalErrorHandler } from './src/services/global-error-handler.service';

// ============= BUILD ID: 2025-12-03-v13-VERCEL-FIX =============
const BUILD_ID = '2025-12-03-v13-VERCEL-FIX';
const START_TIME = Date.now();

// 简化日志 - 仅输出到控制台，不创建屏幕浮层
const log = (msg: string, color = '#0f0') => {
  const elapsed = Date.now() - START_TIME;
  console.log(`[NanoFlow +${elapsed}ms] ${msg}`);
};
const logError = (msg: string, err?: any) => {
  const elapsed = Date.now() - START_TIME;
  console.error(`[NanoFlow +${elapsed}ms] ❌ ${msg}`, err || '');
};

log('Build: ' + BUILD_ID);
log('🚀 main.ts 开始执行');
log('Angular 版本: ' + VERSION.full);
log('当前 URL: ' + window.location.href);
log('User Agent: ' + navigator.userAgent.substring(0, 80) + '...');

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

// 全局错误捕获 - 在 Angular 启动前就开始捕获
window.onerror = (message, source, lineno, colno, error) => {
  logError(`全局错误: ${message}`, { source, lineno, colno, error });
  return false; // 继续默认处理
};

window.addEventListener('unhandledrejection', (event) => {
  logError('未处理的 Promise 拒绝', event.reason);
});

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
  }).catch(e => logError('注销 SW 失败', e));
}

log('🏗️ 准备启动 Angular...');

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
  log('✅ Angular 启动成功! 耗时: ' + elapsed + 'ms');
  
  // 标记应用就绪
  (window as any).__NANOFLOW_READY__ = true;
  
  // 隐藏初始加载器
  const loader = document.getElementById('initial-loader');
  if (loader) loader.style.display = 'none';
  
  // 检查 Zone.js 是否正常工作 - 尝试触发变更检测
  try {
    const zone = appRef.injector.get(NgZone);
    zone.run(() => {
      log('🎉 应用完全就绪，Zone.js 正常工作');
    });
  } catch (e) {
    logError('Zone.js 运行时检查失败', e);
  }
}).catch(err => {
  logError('❌ 启动失败', err);
  
  // 详细错误分析
  const errStr = String(err?.message || err);
  let diagnosis = '未知错误';
  let suggestion = '请尝试清除浏览器缓存并刷新';
  
  if (errStr.includes('NG0908')) {
    diagnosis = 'Zone.js 冲突 (NG0908) - 可能存在多个 Zone.js 实例';
    suggestion = '请确保只有一个 Zone.js 加载';
  } else if (errStr.includes('inject') || errStr.includes('NullInjector')) {
    diagnosis = '依赖注入错误 - 某个服务无法注入';
    suggestion = '检查所有服务是否正确配置';
  } else if (errStr.includes('chunk') || errStr.includes('Loading chunk')) {
    diagnosis = '代码块加载失败 - 网络问题或文件缺失';
    suggestion = '检查网络连接，或清除缓存重试';
  } else if (errStr.includes('Template') || errStr.includes('template')) {
    diagnosis = '模板编译错误';
    suggestion = '请检查组件模板语法';
  } else if (errStr.includes('Cannot read') || errStr.includes('undefined')) {
    diagnosis = '运行时空指针错误';
    suggestion = '某个对象为 undefined';
  }
  
  log('📋 诊断: ' + diagnosis);
  log('💡 建议: ' + suggestion);
  
  // 显示用户可见的错误界面
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:sans-serif;z-index:99998;overflow:auto;';
  errorDiv.innerHTML = `
    <div style="max-width:600px;margin:0 auto;">
      <h1 style="color:#dc2626;margin-bottom:1rem;font-size:1.5rem;">应用启动失败</h1>
      <p style="margin-bottom:0.5rem;color:#666;">Build: ${BUILD_ID}</p>
      <p style="margin-bottom:1rem;color:#666;">诊断: ${diagnosis}</p>
      <div style="background:#fef2f2;border:1px solid #fecaca;padding:1rem;border-radius:8px;margin-bottom:1rem;">
        <p style="font-size:0.9rem;color:#991b1b;margin:0;">💡 ${suggestion}</p>
      </div>
      <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:11px;max-height:200px;margin-bottom:1rem;white-space:pre-wrap;word-break:break-all;border-radius:8px;">${err?.stack || err?.message || err}</pre>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button onclick="location.reload()" style="padding:0.75rem 1.5rem;background:#4f46e5;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">刷新页面</button>
        <button onclick="caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n)))).then(()=>location.reload())" style="padding:0.75rem 1.5rem;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">清除缓存并刷新</button>
      </div>
      <p style="margin-top:1rem;font-size:0.8rem;color:#999;">如果问题持续，请检查浏览器控制台获取更多信息</p>
    </div>
  `;
  document.body.appendChild(errorDiv);
});
