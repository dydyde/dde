import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth.service';

/** 本地认证缓存 key */
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';

/** 匿名用户数据隔离 key */
const ANONYMOUS_DATA_KEY = 'nanoflow.anonymous-session';

/** 内存中的匿名会话 ID 缓存 */
let memoryAnonymousSessionId: string | null = null;

/**
 * 生成或获取匿名会话 ID
 * 用于隔离不同匿名用户的数据
 * 
 * 优先级：
 * 1. sessionStorage（正常浏览）
 * 2. localStorage（隐私模式 sessionStorage 不可用时的回退）
 * 3. 内存缓存（所有存储都不可用时的最终回退）
 */
function getOrCreateAnonymousSessionId(): string {
  // 首先尝试 sessionStorage
  try {
    let sessionId = sessionStorage.getItem(ANONYMOUS_DATA_KEY);
    if (sessionId) {
      return sessionId;
    }
  } catch {
    // sessionStorage 不可用，继续尝试其他方式
  }
  
  // 尝试 localStorage 作为回退（持久但跨会话）
  try {
    let sessionId = localStorage.getItem(ANONYMOUS_DATA_KEY);
    if (sessionId) {
      // 检查是否是有效的会话 ID（不超过 24 小时）
      const match = sessionId.match(/^anon_(\d+)_/);
      if (match) {
        const timestamp = parseInt(match[1], 10);
        const hoursSinceCreation = (Date.now() - timestamp) / (1000 * 60 * 60);
        if (hoursSinceCreation < 24) {
          return sessionId;
        }
      }
    }
    
    // 创建新的会话 ID
    sessionId = `anon_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    localStorage.setItem(ANONYMOUS_DATA_KEY, sessionId);
    
    // 同时尝试保存到 sessionStorage
    try {
      sessionStorage.setItem(ANONYMOUS_DATA_KEY, sessionId);
    } catch {
      // 忽略 sessionStorage 错误
    }
    
    return sessionId;
  } catch {
    // localStorage 也不可用，使用内存缓存
  }
  
  // 最终回退：使用内存缓存
  if (!memoryAnonymousSessionId) {
    memoryAnonymousSessionId = `anon_mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    console.warn('存储不可用，使用内存缓存的匿名会话 ID（刷新后将丢失）');
  }
  return memoryAnonymousSessionId;
}

/**
 * 检查本地缓存的认证状态
 * 用于离线模式下验证用户身份
 */
function checkLocalAuthCache(): { userId: string | null; expiredAt: number | null } {
  try {
    const cached = localStorage.getItem(AUTH_CACHE_KEY);
    if (cached) {
      const { userId, expiredAt } = JSON.parse(cached);
      // 检查缓存是否过期（默认 7 天）
      if (expiredAt && Date.now() < expiredAt) {
        return { userId, expiredAt };
      }
    }
  } catch (e) {
    // 解析失败时记录日志，方便调试
    console.warn('解析认证缓存失败:', e);
  }
  return { userId: null, expiredAt: null };
}

/**
 * 保存认证状态到本地缓存
 */
export function saveAuthCache(userId: string | null): void {
  try {
    if (userId) {
      const expiredAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 天
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ userId, expiredAt }));
    } else {
      localStorage.removeItem(AUTH_CACHE_KEY);
    }
  } catch (e) {
    // 存储失败时记录日志
    console.warn('保存认证缓存失败:', e);
  }
}

/**
 * 等待会话检查完成
 * 使用 Promise 和信号量代替轮询，更可靠
 */
async function waitForSessionCheck(authService: AuthService, maxWaitMs: number = 10000): Promise<void> {
  // 如果已经完成检查，直接返回
  if (!authService.authState().isCheckingSession) {
    return;
  }
  
  // 使用 Promise.race 实现超时控制
  return new Promise<void>((resolve) => {
    const startTime = Date.now();
    
    // 创建一个间隔检查器
    const checkInterval = setInterval(() => {
      // 检查是否完成
      if (!authService.authState().isCheckingSession) {
        clearInterval(checkInterval);
        resolve();
        return;
      }
      
      // 检查是否超时
      if (Date.now() - startTime >= maxWaitMs) {
        clearInterval(checkInterval);
        console.warn('会话检查超时，继续处理');
        resolve();
        return;
      }
    }, 50);
    
    // 额外的超时保护
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, maxWaitMs + 100);
  });
}

/**
 * 认证路由守卫（宽松模式 - 已废弃）
 * 
 * ⚠️ 废弃说明：
 * 此守卫允许匿名访问，会导致「幽灵数据」问题。
 * 请使用 requireAuthGuard 替代，确保数据归属权清晰。
 * 
 * 保留此守卫仅用于特殊场景：
 * - 公开只读页面
 * - Landing Page 预览
 * - 无需持久化的功能演示
 * 
 * @deprecated 请使用 requireAuthGuard
 */
export const authGuard: CanActivateFn = async (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  
  // 如果 Supabase 未配置，允许离线模式访问
  if (!authService.isConfigured) {
    return true;
  }
  
  // 等待会话检查完成（带超时保护）
  const authState = authService.authState();
  if (authState.isCheckingSession) {
    await waitForSessionCheck(authService);
  }
  
  // 检查是否有会话
  const userId = authService.currentUserId();
  if (userId) {
    // 保存认证状态到本地缓存
    saveAuthCache(userId);
    return true;
  }
  
  // 离线模式：检查本地缓存的认证状态
  const localAuth = checkLocalAuthCache();
  if (localAuth.userId) {
    // 有本地缓存的认证信息，允许离线访问
    console.info('使用本地缓存的认证状态（离线模式）');
    return true;
  }
  
  // 未登录且无本地缓存：
  // 生成匿名会话 ID 用于数据隔离，允许访问但功能受限
  const anonymousId = getOrCreateAnonymousSessionId();
  // 注意：不要输出会话 ID 到控制台，防止恶意脚本捕获
  console.warn('匿名用户数据仅保存在当前浏览器会话中，关闭浏览器后将丢失');
  
  return true;
};

/**
 * 获取当前数据隔离 ID
 * 用于确定数据存储的命名空间
 */
export function getDataIsolationId(authService: AuthService): string {
  const userId = authService.currentUserId();
  if (userId) {
    return userId;
  }
  
  const localAuth = checkLocalAuthCache();
  if (localAuth.userId) {
    return localAuth.userId;
  }
  
  return getOrCreateAnonymousSessionId();
}

/**
 * 强制登录守卫
 * 用于保护需要明确用户身份的路由和功能
 * 
 * 【已启用】此守卫已在核心路由中使用，确保数据归属权清晰。
 * 
 * 设计理念：
 * - 所有数据操作都需要 user_id，简化 RLS 策略
 * - 避免匿名数据迁移的复杂性（幽灵数据问题）
 * - 保障数据库安全，防止垃圾数据注入
 * 
 * 与 authGuard 的区别：
 * - authGuard：允许匿名访问，为匿名用户生成会话级数据隔离（已废弃）
 * - requireAuthGuard：强制要求登录，拒绝匿名访问（推荐使用）
 * 
 * 使用场景：
 * - 所有核心业务路由（/projects/*）
 * - 数据导出、分享功能
 * - 用户设置页面
 */
export const requireAuthGuard: CanActivateFn = async (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  
  if (!authService.isConfigured) {
    // Supabase 未配置，允许离线模式访问
    // 数据仅保存在本地 IndexedDB 中，不会同步到云端
    console.info('Supabase 未配置，以离线模式运行。数据仅保存在本地。');
    return true;
  }
  
  // 等待会话检查完成（带超时保护）
  const authState = authService.authState();
  if (authState.isCheckingSession) {
    await waitForSessionCheck(authService);
  }
  
  const userId = authService.currentUserId();
  if (userId) {
    // 保存认证状态到本地缓存（用于离线模式）
    saveAuthCache(userId);
    return true;
  }
  
  // 检查本地缓存的认证状态（离线模式支持）
  const localAuth = checkLocalAuthCache();
  if (localAuth.userId) {
    console.info('使用本地缓存的认证状态（离线模式）');
    return true;
  }
  
  // 未登录，重定向到项目页面并触发登录弹窗
  // 使用 queryParams 传递信息，让 AppComponent 显示登录模态框
  console.info('未登录，需要认证才能访问');
  void router.navigate(['/'], {
    queryParams: { authRequired: 'true', returnUrl: state.url }
  });
  return false;
};
