import { inject } from '@angular/core';
import { CanActivateFn, Router, ActivatedRouteSnapshot } from '@angular/router';
import { StoreService } from '../store.service';
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
  let loadTriggered = false;
  
  while (Date.now() - startTime < maxWaitMs) {
    const projectCount = store.projects().length;
    const isLoadingRemote = store.isLoadingRemote();

    // 如果已有项目数据，初始化完成
    if (projectCount > 0) {
      return { loaded: true };
    }

    // 有时导航触发得比数据加载更早：此时 isLoadingRemote 仍为 false。
    // 为避免误判“项目不存在”，主动触发一次加载（只触发一次）。
    if (!loadTriggered && !isLoadingRemote) {
      loadTriggered = true;
      try {
        await store.loadProjects();
      } catch {
        // loadProjects 内部已有兜底，这里不再额外处理
      }
      continue;
    }

    // 已触发过加载且当前不在加载中，说明初始化流程已经走完（即使项目列表为空）
    if (loadTriggered && !isLoadingRemote) {
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
 * 项目存在性守卫
 * 检查访问的项目是否存在于当前用户的项目列表中
 * 
 * 单用户场景：StoreService 加载的项目即为当前用户可访问的全部项目
 */
export const projectExistsGuard: CanActivateFn = async (route: ActivatedRouteSnapshot, state) => {
  const store = inject(StoreService);
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
  
  // 权限检查：StoreService 只加载当前用户的项目
  // 如果项目存在于列表中，说明用户有权限访问
  // 单用户场景下无需额外权限检查
  
  return true;
};

// projectAccessGuard 别名已移除
// 单用户场景下统一使用 projectExistsGuard
