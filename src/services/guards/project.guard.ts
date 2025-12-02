import { inject } from '@angular/core';
import { CanActivateFn, Router, ActivatedRouteSnapshot } from '@angular/router';
import { StoreService } from '../store.service';
import { AuthService } from '../auth.service';
import { ToastService } from '../toast.service';
import { GUARD_CONFIG } from '../../config/constants';

/**
 * 等待数据初始化完成
 * 使用响应式方式等待，避免低效的轮询
 * 包含超时保护和重试机制
 * @returns { loaded: true } 如果数据加载成功
 *          { loaded: false, reason: string } 如果超时或失败
 */
async function waitForDataInit(
  store: StoreService, 
  toast: ToastService,
  maxWaitMs: number = GUARD_CONFIG.DATA_INIT_TIMEOUT
): Promise<{ loaded: boolean; reason?: string }> {
  const startTime = Date.now();
  const checkInterval = GUARD_CONFIG.CHECK_INTERVAL;
  let lastCheckReason = '';
  let slowNetworkWarningShown = false;
  
  while (Date.now() - startTime < maxWaitMs) {
    // 如果已有项目数据，初始化完成
    if (store.projects().length > 0) {
      return { loaded: true };
    }
    // 如果不在加载中且没有数据，说明真的没数据
    if (!store.isLoadingRemote()) {
      return { loaded: true };
    }
    lastCheckReason = '数据正在加载中';
    
    // 超过慢网络阈值时显示提示（只显示一次）
    const elapsed = Date.now() - startTime;
    if (!slowNetworkWarningShown && elapsed >= GUARD_CONFIG.SLOW_NETWORK_THRESHOLD) {
      slowNetworkWarningShown = true;
      toast.info('正在加载', '网络较慢，请稍候...');
    }
    
    // 等待一小段时间再检查
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  // 超时，返回失败原因
  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  return { 
    loaded: false, 
    reason: `数据加载超时 (${elapsedSeconds}秒)，${lastCheckReason || '请检查网络连接'}` 
  };
}

/**
 * 项目存在性和权限守卫
 * 检查访问的项目是否存在，并验证用户是否有权限访问
 * 
 * 权限检查逻辑：
 * 1. 项目必须存在于用户的项目列表中（由 StoreService 加载的都是当前用户的项目）
 * 2. 未来实现多用户/团队功能时，需要检查 owner_id 和协作者列表
 */
export const projectExistsGuard: CanActivateFn = async (route: ActivatedRouteSnapshot, state) => {
  const store = inject(StoreService);
  const authService = inject(AuthService);
  const router = inject(Router);
  const toast = inject(ToastService);
  
  const projectId = route.params['projectId'];
  
  // 如果没有项目 ID 参数，允许访问（可能是项目列表页）
  if (!projectId) {
    return true;
  }
  
  // 等待数据初始化
  const initResult = await waitForDataInit(store, toast);
  
  // 如果超时且仍在加载中，重定向到项目列表并显示具体原因
  if (!initResult.loaded && store.isLoadingRemote()) {
    toast.warning('加载时间较长', '网络响应较慢，请检查网络连接后重试');
    void router.navigate(['/projects']);
    return false;
  }
  
  // 检查项目是否存在
  const projects = store.projects();
  const project = projects.find(p => p.id === projectId);
  
  if (!project) {
    // 项目确实不存在，重定向到项目列表并显示提示
    toast.error('项目不存在', '请求的项目可能已被删除或您没有访问权限');
    void router.navigate(['/projects']);
    return false;
  }
  
  // 权限检查：验证当前用户是否有权限访问该项目
  // 当前实现：StoreService 只加载当前用户的项目，所以如果项目存在于列表中，用户就有权限
  // 未来实现多用户功能时，需要检查 project.ownerId === currentUserId 或 project.collaborators.includes(currentUserId)
  const currentUserId = authService.currentUserId();
  
  // 如果用户已登录但项目列表为空，可能是数据还未同步或项目真的不属于该用户
  if (currentUserId && projects.length === 0) {
    // 允许访问，因为可能是首次登录还没有项目
    // 但如果指定了 projectId，则应该已经被上面的检查拦截
  }
  
  // TODO: 未来多用户/团队功能实现时，在此处添加以下检查：
  // const hasAccess = project.ownerId === currentUserId || 
  //                   project.collaborators?.includes(currentUserId) ||
  //                   project.isPublic;
  // if (!hasAccess) {
  //   toast.error('无权访问', '您没有权限访问此项目');
  //   void router.navigate(['/projects']);
  //   return false;
  // }
  
  return true;
};

/**
 * 项目权限守卫
 * 用于未来的多用户/团队功能
 * 
 * @deprecated 当前版本此守卫等同于 projectExistsGuard。
 * 新代码请直接使用 projectExistsGuard。
 * 保留此导出仅为向后兼容。
 */
export const projectAccessGuard: CanActivateFn = projectExistsGuard;
