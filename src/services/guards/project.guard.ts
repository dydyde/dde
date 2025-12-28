import { inject } from '@angular/core';
import { CanActivateFn, Router, ActivatedRouteSnapshot } from '@angular/router';
import { StoreService } from '../store.service';
import { ToastService } from '../toast.service';
import { GUARD_CONFIG } from '../../config';

/**
 * 【重构】本地优先的数据初始化检查
 * 
 * 新策略（来自高级顾问建议）：
 * - Guard 的职责仅是"检查是否有足够数据来绘制 UI"
 * - 不再等待云端同步完成
 * - 如果有本地缓存，立即放行
 * - 如果是首次安装（无缓存），也放行但标记 isFirstLoad
 * - 后台同步由组件 ngOnInit 触发，不阻塞 UI
 * 
 * @returns { loaded: true } 总是返回 true（不再阻塞）
 *          { isFirstLoad: boolean } 是否首次加载（无本地缓存）
 */
async function ensureDataAvailable(
  store: StoreService, 
  _toast: ToastService,
  _maxWaitMs: number = GUARD_CONFIG.DATA_INIT_TIMEOUT
): Promise<{ loaded: boolean; isFirstLoad: boolean }> {
  const startTime = Date.now();
  const checkInterval = 50; // 快速检查间隔
  const maxQuickWait = 200; // 最多等待 200ms 让本地数据加载完成
  
  // 1. 快速检查：Store 中是否已有数据
  if (store.projects().length > 0) {
    return { loaded: true, isFirstLoad: false };
  }
  
  // 2. 如果 Store 为空，等待本地缓存加载（最多 200ms）
  // 这是为了等待 loadOfflineSnapshot() 完成
  while (Date.now() - startTime < maxQuickWait) {
    if (store.projects().length > 0) {
      return { loaded: true, isFirstLoad: false };
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  
  // 3. 如果仍无数据，触发 loadProjects（会创建种子项目）
  // 但不等待云端同步完成
  if (store.projects().length === 0) {
    const isLoadingRemote = store.isLoadingRemote();
    
    // 如果没有在加载，触发加载
    if (!isLoadingRemote) {
      // 不阻塞等待 - loadProjects 内部会先加载本地缓存/种子数据
      store.loadProjects().catch(() => {
        // 静默处理，loadProjects 内部已有兜底
      });
      
      // 再等待一小段时间让种子数据生成
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // 如果还是没有数据，说明是首次加载或加载失败
    // 但仍然放行，让用户看到 UI（可能是骨架屏或空状态）
    if (store.projects().length === 0) {
      return { loaded: true, isFirstLoad: true };
    }
  }
  
  return { loaded: true, isFirstLoad: false };
}

/**
 * 【保留】传统等待函数（仅在特殊场景使用）
 * 用于需要确保数据加载完成的场景（如深链接直接访问项目）
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
    // 为避免误判"项目不存在"，主动触发一次加载（只触发一次）。
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
 * 
 * 【重构】本地优先策略：
 * - 优先使用本地缓存数据放行
 * - 项目不存在时，等待云端同步（给深链接一个机会）
 * - 超时后才认定项目不存在
 * 
 * 单用户场景：StoreService 加载的项目即为当前用户可访问的全部项目
 */
export const projectExistsGuard: CanActivateFn = async (route: ActivatedRouteSnapshot, _state) => {
  const store = inject(StoreService);
  const router = inject(Router);
  const toast = inject(ToastService);
  
  const projectId = route.params['projectId'];
  
  // 如果没有项目 ID 参数，允许访问（可能是项目列表页）
  if (!projectId) {
    return true;
  }
  
  // 【新策略】本地优先检查
  const dataResult = await ensureDataAvailable(store, toast);
  
  // 快速检查项目是否存在于本地
  let projects = store.projects();
  let project = projects.find(p => p.id === projectId);
  
  if (project) {
    // 项目存在于本地缓存，立即放行
    return true;
  }
  
  // 项目不在本地 - 这可能是：
  // 1. 深链接访问（项目在云端但未同步）
  // 2. 项目已被删除
  // 3. 首次安装
  
  if (dataResult.isFirstLoad) {
    // 首次安装，没有任何数据，重定向到项目列表
    void router.navigate(['/projects']);
    return false;
  }
  
  // 如果正在后台同步，等待同步完成后再检查一次
  if (store.isLoadingRemote()) {
    const waitResult = await waitForDataInit(store, toast, 5000); // 最多等 5 秒
    
    if (waitResult.loaded) {
      // 重新检查项目是否存在
      projects = store.projects();
      project = projects.find(p => p.id === projectId);
      
      if (project) {
        return true;
      }
    }
  }
  
  // 项目确实不存在
  toast.error('项目不存在', '请求的项目可能已被删除或您没有访问权限');
  void router.navigate(['/projects']);
  return false;
};

// projectAccessGuard 别名已移除
// 单用户场景下统一使用 projectExistsGuard
