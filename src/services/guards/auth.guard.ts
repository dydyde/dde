import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth.service';

/** 本地认证缓存 key */
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';

/** 匿名用户数据隔离 key */
const ANONYMOUS_DATA_KEY = 'nanoflow.anonymous-session';

/**
 * 生成或获取匿名会话 ID
 * 用于隔离不同匿名用户的数据
 */
function getOrCreateAnonymousSessionId(): string {
  try {
    let sessionId = sessionStorage.getItem(ANONYMOUS_DATA_KEY);
    if (!sessionId) {
      sessionId = `anon_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      sessionStorage.setItem(ANONYMOUS_DATA_KEY, sessionId);
    }
    return sessionId;
  } catch {
    // sessionStorage 不可用时使用内存中的临时 ID
    return `anon_temp_${Date.now()}`;
  }
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
 * 添加超时保护，防止无限等待
 */
async function waitForSessionCheck(authService: AuthService, maxWaitMs: number = 10000): Promise<void> {
  const startTime = Date.now();
  const checkInterval = 50;
  
  while (Date.now() - startTime < maxWaitMs) {
    if (!authService.authState().isCheckingSession) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  // 超时后继续，不阻塞用户
  console.warn('会话检查超时，继续处理');
}

/**
 * 认证路由守卫
 * 保护需要登录才能访问的路由
 * 
 * 数据隔离机制：
 * - 已登录用户：使用用户 ID 隔离数据
 * - 离线缓存用户：使用缓存的用户 ID
 * - 匿名用户：使用会话级别的匿名 ID，数据仅在当前浏览器会话有效
 * 
 * 修复：正确等待会话检查完成，避免竞态条件
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
  console.info('匿名访问模式，会话 ID:', anonymousId);
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
 * 用于必须登录才能访问的功能（如导出、分享等）
 */
export const requireAuthGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  
  if (!authService.isConfigured) {
    // Supabase 未配置，不允许访问需要认证的功能
    void router.navigate(['/projects'], {
      queryParams: { authRequired: 'true' }
    });
    return false;
  }
  
  const userId = authService.currentUserId();
  if (userId) {
    return true;
  }
  
  // 未登录，重定向到项目页面并提示需要登录
  void router.navigate(['/projects'], {
    queryParams: { authRequired: 'true', returnUrl: state.url }
  });
  return false;
};
