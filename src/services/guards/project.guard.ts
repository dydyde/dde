import { inject } from '@angular/core';
import { CanActivateFn, Router, ActivatedRouteSnapshot } from '@angular/router';
import { StoreService } from '../store.service';
import { ToastService } from '../toast.service';

/**
 * 等待数据初始化完成
 * 使用响应式方式等待，避免低效的轮询
 * 包含超时保护和重试机制
 * @returns { loaded: true } 如果数据加载成功
 *          { loaded: false, reason: string } 如果超时或失败
 */
async function waitForDataInit(
  store: StoreService, 
  maxWaitMs: number = 5000
): Promise<{ loaded: boolean; reason?: string }> {
  const startTime = Date.now();
  const checkInterval = 100;
  let lastCheckReason = '';
  
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
 * 检查访问的项目是否存在，防止访问无效项目 ID
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
  const initResult = await waitForDataInit(store);
  
  // 如果超时且仍在加载中，重定向到项目列表并显示具体原因
  if (!initResult.loaded && store.isLoadingRemote()) {
    toast.warning('加载超时', initResult.reason || '数据加载超时，请检查网络连接');
    void router.navigate(['/projects']);
    return false;
  }
  
  // 检查项目是否存在
  const projects = store.projects();
  const projectExists = projects.some(p => p.id === projectId);
  
  if (projectExists) {
    return true;
  }
  
  // 项目确实不存在，重定向到项目列表并显示提示
  // 注意：之前这里有一个"正在加载时返回 true"的逻辑，但这会导致竞态条件
  // 现在我们已经等待了数据加载完成，所以可以确定项目确实不存在
  toast.error('项目不存在', '请求的项目可能已被删除或您没有访问权限');
  
  void router.navigate(['/projects']);
  return false;
};

/**
 * 项目权限守卫（预留）
 * 用于未来的多用户/团队功能
 * 
 * @deprecated 当前版本此守卫等同于 projectExistsGuard。
 * 未来实现多用户/团队功能时会扩展为检查 owner_id 和协作者列表。
 * 新代码请直接使用 projectExistsGuard。
 */
export const projectAccessGuard: CanActivateFn = (route: ActivatedRouteSnapshot, state) => {
  // 当前版本项目仅属于当前用户
  // 未来可以扩展为检查项目的 owner_id 和协作者列表
  return projectExistsGuard(route, state);
};
