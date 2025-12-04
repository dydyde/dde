import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth.service';
import { ModalService } from '../modal.service';
import { GUARD_CONFIG, AUTH_CONFIG } from '../../config/constants';

/** 本地认证缓存 key */
const AUTH_CACHE_KEY = 'nanoflow.auth-cache';

/**
 * 检查是否处于本地模式
 * 本地模式允许用户在不登录的情况下使用应用（数据仅保存在本地）
 */
export function isLocalModeEnabled(): boolean {
  try {
    return localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * 启用本地模式
 * 允许用户跳过登录，使用本地存储进行数据隔离
 */
export function enableLocalMode(): void {
  try {
    localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
  } catch (e) {
    console.warn('启用本地模式失败:', e);
  }
}

/**
 * 禁用本地模式
 * 用户登录成功后应调用此方法
 */
export function disableLocalMode(): void {
  try {
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
  } catch (e) {
    console.warn('禁用本地模式失败:', e);
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
      const expiredAt = Date.now() + AUTH_CONFIG.REMEMBER_ME_EXPIRY;
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
 * 使用递归 setTimeout 代替 setInterval，更可靠且避免内存泄漏
 * 添加明确的超时错误处理
 */
async function waitForSessionCheck(
  authService: AuthService, 
  maxWaitMs: number = GUARD_CONFIG.SESSION_CHECK_TIMEOUT
): Promise<void> {
  // 如果已经完成检查，直接返回
  if (!authService.authState().isCheckingSession) {
    console.log('[Guard] 会话检查已完成，直接返回');
    return;
  }
  
  console.log('[Guard] 开始等待会话检查...');
  
  return new Promise<void>((resolve) => {
    const startTime = Date.now();
    let resolved = false;
    
    const doResolve = (timeout = false) => {
      if (resolved) return;
      resolved = true;
      
      const elapsed = Date.now() - startTime;
      if (timeout) {
        // 超时但仍允许继续，记录警告
        console.warn(`[Guard] 会话检查超时 (${elapsed}ms)，继续处理`);
      } else {
        console.log(`[Guard] 会话检查完成 (${elapsed}ms)`);
      }
      resolve();
    };
    
    // 使用递归 setTimeout 代替 setInterval，避免内存泄漏
    const checkSession = () => {
      if (resolved) return;
      
      // 检查是否完成
      if (!authService.authState().isCheckingSession) {
        doResolve();
        return;
      }
      
      // 检查是否超时
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitMs) {
        doResolve(true);
        return;
      }
      
      // 继续等待，使用指数退避（使用集中配置）
      const nextDelay = Math.min(
        GUARD_CONFIG.SESSION_CHECK_POLL_INTERVAL + Math.floor(elapsed / 200) * 50, 
        GUARD_CONFIG.SESSION_CHECK_POLL_MAX_INTERVAL
      );
      setTimeout(checkSession, nextDelay);
    };
    
    // 开始检查
    checkSession();
  });
}

/**
 * 获取当前数据隔离 ID
 * 用于确定数据存储的命名空间
 * 
 * 优先级：
 * 1. 已登录用户的 ID
 * 2. 本地缓存的认证状态
 * 3. 本地模式用户 ID（如果启用了本地模式）
 * 4. null（无法确定用户身份）
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
  
  // 如果启用了本地模式，返回本地模式用户 ID
  if (isLocalModeEnabled()) {
    return AUTH_CONFIG.LOCAL_MODE_USER_ID;
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
 * 【离线/本地模式策略】守卫数据流，而非 UI：
 * - 离线时允许完全的读写访问，用户体验不受阻断
 * - 本地缓存的认证状态用于确定数据命名空间
 * - 本地模式允许用户跳过登录，数据仅保存在本地
 * - 写操作通过 ActionQueueService 进入离线队列
 * - 网络恢复后，SyncCoordinator 统一处理队列同步
 * - 冲突处理和 ID 生成由 sync 层负责，守卫不介入
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
  
  console.log('[Guard] requireAuthGuard 开始执行，目标路由:', state.url);
  
  if (!authService.isConfigured) {
    // Supabase 未配置，允许完全离线模式访问
    // 数据存储在本地 IndexedDB，用户可以正常进行所有操作
    // 这不是"限制功能"的降级模式，而是完整的本地优先体验
    console.log('[Guard] Supabase 未配置，允许离线模式访问');
    return true;
  }
  
  // 检查是否已启用本地模式（用户选择跳过登录）
  if (isLocalModeEnabled()) {
    console.log('[Guard] 本地模式已启用，允许访问');
    return true;
  }
  
  // 等待会话检查完成（带超时保护）
  // 注意：checkSession 现在会自动尝试开发环境自动登录
  const authState = authService.authState();
  console.log('[Guard] 当前认证状态:', { isCheckingSession: authState.isCheckingSession, userId: authState.userId });
  
  if (authState.isCheckingSession) {
    await waitForSessionCheck(authService);
  }
  
  const userId = authService.currentUserId();
  console.log('[Guard] 检查用户ID:', userId);
  
  if (userId) {
    // 保存认证状态到本地缓存（用于离线模式）
    saveAuthCache(userId);
    console.log('[Guard] 用户已登录，允许访问');
    return true;
  }
  
  // 检查本地缓存的认证状态（离线模式支持）
  // 这允许用户在网络恢复前继续使用应用的全部功能
  const localAuth = checkLocalAuthCache();
  console.log('[Guard] 本地缓存认证:', localAuth);
  
  if (localAuth.userId) {
    console.log('[Guard] 使用本地缓存认证，允许离线访问');
    return true;
  }
  
  // 未登录且无本地缓存，这是阻断性场景：需要用户首次登录
  // 只有这种情况才需要显式的交互提示
  console.log('[Guard] 需要登录，显示登录模态框（不重定向，避免循环）');
  
  // 直接显示登录模态框，不做导航重定向（避免无限循环）
  // 用户登录成功后会自动刷新当前路由
  modalService.show('login', { returnUrl: state.url, message: '请登录以访问此页面' });
  
  // 返回 false 阻止导航，但不做重定向
  return false;
};

/**
 * 认证路由守卫（宽松模式）
 * 
 * ⚠️ 已移除 - 请使用 requireAuthGuard
 * 
 * 此守卫允许匿名访问，会导致「幽灵数据」问题：
 * - 匿名用户数据无法归属到任何账户
 * - RLS 策略需要特殊处理 auth.uid() is null
 * - 数据迁移复杂且容易出错
 * 
 * 如果您的代码仍在使用 authGuard，请立即迁移到 requireAuthGuard
 * 
 * @deprecated 已移除，请使用 requireAuthGuard
 * @see requireAuthGuard
 */
