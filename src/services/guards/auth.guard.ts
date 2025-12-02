import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth.service';
import { ModalService } from '../modal.service';

/** 本地认证缓存 key */
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';

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
 * 获取当前数据隔离 ID
 * 用于确定数据存储的命名空间
 * 
 * 注意：此函数现在仅返回已登录用户的 ID
 * 不再支持匿名会话，符合「强制认证」策略
 */
export function getDataIsolationId(authService: AuthService): string | null {
  const userId = authService.currentUserId();
  if (userId) {
    return userId;
  }
  
  const localAuth = checkLocalAuthCache();
  if (localAuth.userId) {
    return localAuth.userId;
  }
  
  // 不再返回匿名会话 ID，返回 null 表示无法确定用户身份
  return null;
}

/**
 * 强制登录守卫
 * 用于保护需要明确用户身份的路由和功能
 * 
 * 【核心策略】所有数据操作都需要 user_id：
 * - 简化 Supabase RLS 策略 - 所有操作都有明确的数据归属
 * - 避免「幽灵数据」问题 - 无需处理匿名数据到正式账户的迁移
 * - 保障数据安全 - 防止未授权访问和垃圾数据注入
 * 
 * 开发环境便利：
 * - 配置 environment.devAutoLogin 后，应用启动时会自动登录
 * - Guard 仍然存在且生效，只是登录过程被自动化
 * - 避免"关掉 Guard"的懒惰做法，保持代码路径一致
 * 
 * 使用场景：
 * - 所有核心业务路由（/projects/*）
 * - 数据导出、分享功能
 * - 用户设置页面
 */
export const requireAuthGuard: CanActivateFn = async (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const modalService = inject(ModalService);
  
  if (!authService.isConfigured) {
    // Supabase 未配置，允许离线模式访问
    // 数据仅保存在本地 IndexedDB 中，不会同步到云端
    console.info('Supabase 未配置，以离线模式运行。数据仅保存在本地。');
    return true;
  }
  
  // 等待会话检查完成（带超时保护）
  // 注意：checkSession 现在会自动尝试开发环境自动登录
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
  
  // 未登录，直接通过 ModalService 触发登录弹窗
  // 相比使用 queryParams 更直接，避免 URL 残留参数
  console.info('未登录，需要认证才能访问');
  
  // 导航到首页并显示登录模态框
  void router.navigate(['/']);
  
  // 使用 setTimeout 确保导航完成后再显示模态框
  // 这样模态框会在正确的路由上下文中打开
  setTimeout(() => {
    modalService.show('login', { returnUrl: state.url, message: '请登录以访问此页面' });
  }, 0);
  
  return false;
};

/**
 * 认证路由守卫（宽松模式）
 * 
 * ⚠️ 已废弃 - 请使用 requireAuthGuard
 * 
 * 此守卫允许匿名访问，会导致「幽灵数据」问题：
 * - 匿名用户数据无法归属到任何账户
 * - RLS 策略需要特殊处理 auth.uid() is null
 * - 数据迁移复杂且容易出错
 * 
 * 保留此守卫仅用于向后兼容，新路由请使用 requireAuthGuard
 * 
 * @deprecated 请使用 requireAuthGuard
 */
export const authGuard: CanActivateFn = (route, state) => {
  console.warn('⚠️ authGuard 已废弃，请迁移到 requireAuthGuard');
  return requireAuthGuard(route, state);
};
