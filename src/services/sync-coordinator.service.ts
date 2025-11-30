import { Injectable, inject, signal } from '@angular/core';
import { SyncService, RemoteProjectChangePayload } from './sync.service';
import { ActionQueueService } from './action-queue.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project } from '../models';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';

/**
 * 同步协调配置
 */
const SYNC_COORDINATOR_CONFIG = {
  /** 保存防抖延迟（毫秒） */
  DEBOUNCE_DELAY: 500,
  /** 编辑状态超时（毫秒） */
  EDITING_TIMEOUT: 2000,
  /** 最大重试次数 */
  MAX_RETRY_COUNT: 5,
  /** 初始重试延迟（毫秒） */
  INITIAL_RETRY_DELAY: 1000,
} as const;

/**
 * 同步协调服务
 * 从 StoreService 拆分出来，专注于数据同步协调
 * 职责：
 * - 本地保存与云端同步的协调
 * - 编辑状态管理
 * - 离线操作队列协调
 * - 同步重试逻辑
 */
@Injectable({
  providedIn: 'root'
})
export class SyncCoordinatorService {
  private syncService = inject(SyncService);
  private actionQueue = inject(ActionQueueService);
  private toast = inject(ToastService);
  private logger = inject(LoggerService).category('SyncCoordinator');
  
  // ========== 状态 ==========
  
  /** 是否正在编辑（防止同步覆盖） */
  private isEditing = false;
  
  /** 是否有待保存的本地变更 */
  private hasPendingLocalChanges = false;
  
  /** 上次保存时间戳 */
  private lastPersistAt = 0;
  
  /** 保存防抖定时器 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 编辑状态定时器 */
  private editingTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 同步重试状态 */
  private retryState = {
    count: 0,
    timer: null as ReturnType<typeof setTimeout> | null
  };

  // ========== 代理访问 SyncService 状态 ==========
  
  readonly isSyncing = this.syncService.syncState;
  readonly isOnline = () => this.syncService.syncState().isOnline;
  readonly offlineMode = () => this.syncService.syncState().offlineMode;
  readonly syncError = () => this.syncService.syncState().syncError;
  readonly isLoadingRemote = this.syncService.isLoadingRemote;

  // ========== 公共方法 ==========

  /**
   * 标记开始编辑
   * 在编辑期间阻止远程更新覆盖本地数据
   */
  markEditing() {
    this.isEditing = true;
    this.hasPendingLocalChanges = true;
    
    if (this.editingTimer) {
      clearTimeout(this.editingTimer);
    }
    
    this.editingTimer = setTimeout(() => {
      this.isEditing = false;
      this.editingTimer = null;
    }, SYNC_COORDINATOR_CONFIG.EDITING_TIMEOUT);
  }

  /**
   * 检查是否处于编辑状态
   */
  get isUserEditing(): boolean {
    return this.isEditing || this.hasPendingLocalChanges;
  }

  /**
   * 检查是否可以应用远程更新
   */
  canApplyRemoteUpdate(): boolean {
    return !this.isEditing && 
           !this.hasPendingLocalChanges && 
           Date.now() - this.lastPersistAt >= 800;
  }

  /**
   * 调度保存操作（带防抖）
   */
  schedulePersist(callback: () => Promise<void>) {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    
    this.persistTimer = setTimeout(async () => {
      this.persistTimer = null;
      try {
        await callback();
        this.hasPendingLocalChanges = false;
        this.lastPersistAt = Date.now();
        this.retryState.count = 0; // 成功后重置重试计数
      } catch (error) {
        this.handlePersistError(error, callback);
      }
    }, SYNC_COORDINATOR_CONFIG.DEBOUNCE_DELAY);
  }

  /**
   * 处理保存失败，实现指数退避重试
   */
  private handlePersistError(error: unknown, callback: () => Promise<void>) {
    this.logger.error('保存失败', error);
    
    if (this.retryState.count >= SYNC_COORDINATOR_CONFIG.MAX_RETRY_COUNT) {
      this.logger.error('达到最大重试次数，放弃重试');
      this.toast.error('保存失败', '已达到最大重试次数，请检查网络连接');
      this.retryState.count = 0;
      return;
    }
    
    this.retryState.count++;
    const delay = SYNC_COORDINATOR_CONFIG.INITIAL_RETRY_DELAY * Math.pow(2, this.retryState.count - 1);
    
    this.logger.info(`将在 ${delay}ms 后重试（第 ${this.retryState.count} 次）`);
    
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
    }
    
    this.retryState.timer = setTimeout(() => {
      this.retryState.timer = null;
      this.schedulePersist(callback);
    }, delay);
  }

  /**
   * 保存项目到云端
   * 失败时自动加入离线操作队列
   */
  async saveProjectToCloud(
    project: Project, 
    userId: string
  ): Promise<Result<void, OperationError>> {
    if (!userId) {
      // 未登录，仅保存到本地
      this.syncService.saveOfflineSnapshot([project]);
      return success(undefined);
    }
    
    const result = await this.syncService.saveProjectToCloud(project, userId);
    
    if (!result.success && !result.conflict) {
      // 同步失败（非冲突），加入重试队列
      this.actionQueue.enqueue({
        type: 'update',
        entityType: 'project',
        entityId: project.id,
        payload: { project }
      });
      
      this.toast.info('离线保存', '数据将在网络恢复后自动同步');
      return failure(ErrorCodes.SYNC_OFFLINE, '网络不可用，数据已保存到本地');
    }
    
    if (result.conflict) {
      return failure(
        ErrorCodes.SYNC_CONFLICT, 
        '数据冲突，请选择保留的版本',
        { remoteData: result.remoteData }
      );
    }
    
    return success(undefined);
  }

  /**
   * 删除云端项目
   * 失败时自动加入离线操作队列
   */
  async deleteProjectFromCloud(
    projectId: string, 
    userId: string
  ): Promise<Result<void, OperationError>> {
    if (!userId) {
      return success(undefined);
    }
    
    const deleted = await this.syncService.deleteProjectFromCloud(projectId, userId);
    
    if (!deleted && !this.isOnline()) {
      this.actionQueue.enqueue({
        type: 'delete',
        entityType: 'project',
        entityId: projectId,
        payload: { projectId, userId }
      });
      
      this.toast.info('离线删除', '项目将在网络恢复后同步删除');
      return failure(ErrorCodes.SYNC_OFFLINE, '网络不可用，删除将在网络恢复后同步');
    }
    
    return success(undefined);
  }

  /**
   * 设置远程变更回调
   */
  setRemoteChangeCallback(callback: (payload?: RemoteProjectChangePayload) => Promise<void>) {
    this.syncService.setRemoteChangeCallback(async (payload) => {
      if (this.canApplyRemoteUpdate()) {
        await callback(payload);
      }
    });
  }

  /**
   * 初始化实时订阅
   */
  async initRealtimeSubscription(userId: string) {
    await this.syncService.initRealtimeSubscription(userId);
  }

  /**
   * 卸载实时订阅
   */
  teardownRealtimeSubscription() {
    this.syncService.teardownRealtimeSubscription();
  }

  /**
   * 保存离线快照
   */
  saveOfflineSnapshot(projects: Project[]) {
    this.syncService.saveOfflineSnapshot(projects);
  }

  /**
   * 加载离线快照
   */
  loadOfflineSnapshot(): Project[] | null {
    return this.syncService.loadOfflineSnapshot();
  }

  /**
   * 从云端加载项目
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[]> {
    return this.syncService.loadProjectsFromCloud(userId);
  }

  /**
   * 加载单个项目
   */
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    return this.syncService.loadSingleProject(projectId, userId);
  }

  /**
   * 清理资源
   */
  destroy() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    
    if (this.editingTimer) {
      clearTimeout(this.editingTimer);
      this.editingTimer = null;
    }
    
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
      this.retryState.timer = null;
    }
    
    this.syncService.destroy();
  }
}
