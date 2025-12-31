import '@angular/compiler';
import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode, ErrorHandler, VERSION, NgZone, APP_INITIALIZER } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation, Router } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import * as Sentry from '@sentry/angular';
import { AppComponent } from './src/app.component';
import { routes } from './src/app.routes';
import { GlobalErrorHandler } from './src/services/global-error-handler.service';

// ============= Sentry 错误监控初始化 =============
// 生产环境采样率配置（PLAN.md 建议：降低采样率以减少性能开销）
const IS_DEV = isDevMode();
const TRACES_SAMPLE_RATE = IS_DEV ? 1.0 : 0.1;           // 生产 10%，开发 100%
const SESSION_REPLAY_RATE = IS_DEV ? 1.0 : 0.0;          // 生产关闭，开发 100%
const ERROR_REPLAY_RATE = 1.0;                           // 报错时 100% 录屏

Sentry.init({
  dsn: 'https://020afcbad58675a58fb58aa2e2cc8662@o4510578675941376.ingest.us.sentry.io/4510578712969216',
  integrations: [
    // 浏览器性能追踪
    Sentry.browserTracingIntegration(),
    // 会话回放 - 对复现 Bug 极其有用（个人项目的"闭路监控"）
    Sentry.replayIntegration({
      maskAllText: false,    // 关闭文字遮蔽，方便调试时看清界面内容
      blockAllMedia: false,  // 允许录制图片
    }),
  ],
  // 只允许来自我们域名的请求被追踪
  tracePropagationTargets: ['localhost', /^https:\/\/dde-psi\.vercel\.app/],
  // 采样率：生产环境降低以减少性能开销
  tracesSampleRate: TRACES_SAMPLE_RATE,
  // 正常会话录制
  replaysSessionSampleRate: SESSION_REPLAY_RATE,
  // 报错时 100% 录屏
  replaysOnErrorSampleRate: ERROR_REPLAY_RATE,
  // 环境标识
  environment: IS_DEV ? 'development' : 'production',
});

// ============= BUILD ID: 2025-12-04-v15-CACHE-FIX =============
const BUILD_ID = '2025-12-04-v15-CACHE-FIX';
const START_TIME = Date.now();
const VERSION_STORAGE_KEY = 'nanoflow.app-version';
const FORCE_CLEAR_KEY = 'nanoflow.force-clear-cache';

// 简化日志 - 仅开发模式输出，生产模式静默
const VERBOSE_LOGS = isDevMode() && localStorage.getItem('nanoflow.verbose') === 'true';
const log = (msg: string, _color = '#0f0') => {
  if (!VERBOSE_LOGS) return;
  const elapsed = Date.now() - START_TIME;
  console.log(`[NanoFlow +${elapsed}ms] ${msg}`);
};
const logError = (msg: string, err?: any) => {
  const elapsed = Date.now() - START_TIME;
  console.error(`[NanoFlow +${elapsed}ms] ❌ ${msg}`, err || '');
};

// ========== 版本检测与缓存清理 ==========
async function checkAndClearCacheIfNeeded(): Promise<boolean> {
  try {
    const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);
    const forceClear = localStorage.getItem(FORCE_CLEAR_KEY);
    
    log(`当前版本: ${BUILD_ID}, 存储版本: ${storedVersion || '无'}`);
    
    // 如果有强制清理标记，或者版本不匹配
    if (forceClear === 'true' || (storedVersion && storedVersion !== BUILD_ID)) {
      log('🔄 检测到版本更新或强制清理标记，正在清理缓存...');
      
      // 清除强制清理标记
      localStorage.removeItem(FORCE_CLEAR_KEY);
      
      // 清理所有 caches
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        log(`清理 ${cacheNames.length} 个缓存...`);
        await Promise.all(cacheNames.map(name => {
          log(`  删除缓存: ${name}`);
          return caches.delete(name);
        }));
      }
      
      // 注销所有 Service Worker
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        log(`注销 ${registrations.length} 个 Service Worker...`);
        await Promise.all(registrations.map(reg => reg.unregister()));
      }
      
      // 保存新版本号
      localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
      
      // 如果是版本更新（不是首次加载），需要刷新页面
      if (storedVersion && storedVersion !== BUILD_ID) {
        log('✅ 缓存已清理，即将刷新页面加载新版本...');
        // 使用 replace 避免产生历史记录循环
        setTimeout(() => {
          window.location.replace(window.location.href);
        }, 100);
        return true; // 表示需要刷新
      }
    } else if (!storedVersion) {
      // 首次加载，保存版本号
      localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
      log('首次加载，已保存版本号');
    }
    
    return false; // 不需要刷新
  } catch (e) {
    logError('版本检测失败', e);
    // 出错时保存版本号并继续
    try {
      localStorage.setItem(VERSION_STORAGE_KEY, BUILD_ID);
    } catch {}
    return false;
  }
}

// ========== 强制清理缓存工具函数（暴露到全局供紧急使用）==========
(window as any).__NANOFLOW_FORCE_CLEAR_CACHE__ = async function() {
  log('🧹 用户触发强制清理缓存...');
  localStorage.setItem(FORCE_CLEAR_KEY, 'true');
  
  try {
    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(reg => reg.unregister()));
    }
    // 清除可能导致问题的本地数据
    localStorage.removeItem('nanoflow.offline-cache-v2');
    localStorage.removeItem('nanoflow.escape-pod');
  } catch (e) {
    logError('强制清理失败', e);
  }
  
  window.location.reload();
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
  // Supabase Auth 多标签页/多实例场景的 LockManager 锁争用：
  // 不影响功能，但 Zone.js/浏览器默认处理会在控制台打印堆栈，造成噪音。
  const messageText = String(message ?? '');
  const isSupabaseAuthLockContention =
    /Navigator LockManager lock/i.test(messageText) ||
    /Acquiring an exclusive Navigator LockManager lock/i.test(messageText) ||
    /lock:sb-.*-auth-token/i.test(messageText);

  if (isSupabaseAuthLockContention) {
    return true; // 阻止默认处理（避免控制台噪音）
  }

  logError(`全局错误: ${message}`, { source, lineno, colno, error });
  return false; // 继续默认处理
};

window.addEventListener('unhandledrejection', (event) => {
  // Supabase Auth 在多标签页/多实例场景会用 Navigator LockManager 做互斥。
  // 当锁被其他实例占用时会出现立即失败的 rejection；这通常不影响登录态本身，
  // 但 Zone.js + 浏览器默认行为会把它打印成“未处理错误”，造成噪音。
  const reasonText = String((event as any)?.reason?.message ?? (event as any)?.reason ?? '');
  const isSupabaseAuthLockContention =
    /Navigator LockManager lock/i.test(reasonText) ||
    /Acquiring an exclusive Navigator LockManager lock/i.test(reasonText) ||
    /lock:sb-.*-auth-token/i.test(reasonText);

  if (isSupabaseAuthLockContention) {
    event.preventDefault();
    return;
  }

  logError('未处理的 Promise 拒绝', event.reason);
});

// ========== 应用启动函数 ==========
async function startApplication() {
  // 1. 先检查版本并清理缓存（如果需要）
  const needsRefresh = await checkAndClearCacheIfNeeded();
  if (needsRefresh) {
    log('等待页面刷新...');
    return; // 页面即将刷新，不继续启动
  }
  
  // 2. 注销所有 Service Worker（作为额外保障）
  if ('serviceWorker' in navigator) {
    log('🧹 注销所有 Service Worker...');
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        log('注销 SW: ' + reg.scope);
        await reg.unregister();
      }
      if (registrations.length === 0) {
        log('无 Service Worker 需要注销');
      }
    } catch (e) {
      logError('注销 SW 失败', e);
    }
  }
  
  log('🏗️ 准备启动 Angular...');
  
  // 3. 添加启动超时保护（15秒）
  const startupTimeout = setTimeout(() => {
    logError('Angular 启动超时！');
    showStartupError('启动超时', '应用启动时间过长，可能是缓存问题导致。', new Error('Startup timeout'));
  }, 15000);
  
  try {
    const appRef = await bootstrapApplication(AppComponent, {
      providers: [
        // Sentry 错误处理器 - 捕获所有 Angular 错误并上报
        {
          provide: ErrorHandler,
          useValue: Sentry.createErrorHandler({
            showDialog: false, // 不显示用户反馈对话框
          }),
        },
        // Sentry 性能追踪 - 追踪路由变化
        {
          provide: Sentry.TraceService,
          deps: [Router],
        },
        {
          provide: APP_INITIALIZER,
          useFactory: () => () => {},
          deps: [Sentry.TraceService],
          multi: true,
        },
        provideRouter(
          routes,
          withComponentInputBinding(),
          withHashLocation()
        ),
        // Service Worker: 启用以检测应用更新
        provideServiceWorker('ngsw-worker.js', {
          enabled: !isDevMode(),
          registrationStrategy: 'registerWhenStable:30000'
        })
      ]
    });
    
    clearTimeout(startupTimeout);
    
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
  } catch (err: any) {
    clearTimeout(startupTimeout);
    logError('❌ 启动失败', err);
    showStartupError('启动失败', '应用无法正常启动', err);
  }
}

// ========== 显示启动错误界面 ==========
function showStartupError(title: string, description: string, err: any) {
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
  } else if (errStr.includes('timeout') || errStr.includes('Timeout')) {
    diagnosis = '加载超时 - 可能是旧缓存导致';
    suggestion = '点击下方按钮清除缓存';
  }
  
  log('📋 诊断: ' + diagnosis);
  log('💡 建议: ' + suggestion);
  
  // 显示用户可见的错误界面
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'position:fixed;inset:0;background:#fff;color:#333;padding:2rem;font-family:"LXGW WenKai", sans-serif;z-index:99998;overflow:auto;';
  errorDiv.innerHTML = `
    <div style="max-width:600px;margin:0 auto;">
      <h1 style="color:#dc2626;margin-bottom:1rem;font-size:1.5rem;">${title}</h1>
      <p style="margin-bottom:0.5rem;color:#666;">Build: ${BUILD_ID}</p>
      <p style="margin-bottom:1rem;color:#666;">诊断: ${diagnosis}</p>
      <div style="background:#fef2f2;border:1px solid #fecaca;padding:1rem;border-radius:8px;margin-bottom:1rem;">
        <p style="font-size:0.9rem;color:#991b1b;margin:0;">💡 ${suggestion}</p>
      </div>
      <pre style="background:#f5f5f5;padding:1rem;overflow:auto;font-size:11px;max-height:200px;margin-bottom:1rem;white-space:pre-wrap;word-break:break-all;border-radius:8px;">${err?.stack || err?.message || err}</pre>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button onclick="location.reload()" style="padding:0.75rem 1.5rem;background:#4f46e5;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">刷新页面</button>
        <button onclick="window.__NANOFLOW_FORCE_CLEAR_CACHE__()" style="padding:0.75rem 1.5rem;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;">清除缓存并刷新</button>
      </div>
      <p style="margin-top:1rem;font-size:0.8rem;color:#999;">如果问题持续，请检查浏览器控制台获取更多信息</p>
    </div>
  `;
  document.body.appendChild(errorDiv);
}

// 启动应用
startApplication();
