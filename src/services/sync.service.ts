import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import { concatMap, tap } from 'rxjs/operators';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';
import { TaskRepositoryService } from './task-repository.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { ConflictStorageService, ConflictRecord } from './conflict-storage.service';
import { Project, ProjectRow, SyncState, UserPreferences, ThemeType, Task, Connection } from '../models';
import { SYNC_CONFIG, CACHE_CONFIG } from '../config/constants';
import { nowISO } from '../utils/date';
import { extractErrorMessage } from '../utils/result';

/** 冲突元数据（持久化用 - 仅用于快速检查，完整数据在 IndexedDB） */
interface ConflictMetadata {
  projectId: string;
  localVersion?: number;
  remoteVersion?: number;
  localTaskCount?: number;
  remoteTaskCount?: number;
  savedAt?: string;
  /** 标记完整数据已保存到 IndexedDB */
  fullDataInIndexedDB?: boolean;
}

/** 生成唯一的 Tab ID，用于 Realtime 频道隔离 */
const TAB_ID = typeof crypto !== 'undefined' 
  ? crypto.randomUUID().substring(0, 8) 
  : Math.random().toString(36).substring(2, 10);

/**
 * 远程项目变更事件载荷
 */
export interface RemoteProjectChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  projectId: string;
  /** 原始数据（可能不完整，仅用于调试） */
  data?: Record<string, unknown>;
}

/**
 * 远程任务变更事件载荷
 * 
 * 设计说明：移除了 data 预留字段
 * 增量更新的复杂度（JSON Patch、数组乱序等）远超其带来的带宽节省
 * 在任务级别的数据量级下，全量替换是更简单可靠的选择
 */
export interface RemoteTaskChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  taskId: string;
  projectId: string;
}

/**
 * 数据同步服务
 * 负责与 Supabase 的数据同步、离线缓存、实时订阅
 * 使用 v2 独立表存储（tasks, connections 表）
 */
@Injectable({
  providedIn: 'root'
})
export class SyncService {
  private supabase = inject(SupabaseClientService);
  private taskRepo = inject(TaskRepositoryService);
  private logger = inject(LoggerService).category('Sync');
  private toast = inject(ToastService);
  private conflictStorage = inject(ConflictStorageService);
  
  /** 冲突数据持久化 key */
  private readonly CONFLICT_STORAGE_KEY = 'nanoflow.pending-conflicts';
  
  /** 同步状态 */
  readonly syncState = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof window !== 'undefined' ? navigator.onLine : true,
    offlineMode: false,
    sessionExpired: false,
    syncError: null,
    hasConflict: false,
    conflictData: null
  });
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = signal(false);
  
  /** 实时订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;
  
  /** 任务表订阅通道 */
  private tasksChannel: RealtimeChannel | null = null;
  
  /** 远程变更处理定时器 */
  private remoteChangeTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 网络状态监听器引用（用于清理） */
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  
  /** DestroyRef 用于自动清理 */
  private readonly destroyRef = inject(DestroyRef);
  
  /** 重试状态 */
  private retryState = {
    count: 0,
    maxRetries: 10,
    timer: null as ReturnType<typeof setTimeout> | null
  };
  
  /** 远程变更回调 - 支持增量更新 */
  private onRemoteChangeCallback: ((payload?: RemoteProjectChangePayload) => Promise<void>) | null = null;
  
  /** 任务级别的变更回调 - 用于细粒度更新 */
  private onTaskChangeCallback: ((payload: RemoteTaskChangePayload) => void) | null = null;
  
  /** 保存队列最大长度 - 防止内存泄漏 */
  private static readonly MAX_SAVE_QUEUE_SIZE = 50;
  
  /** 保存队列超时时间 (毫秒) - 8秒，超时后强制解锁 */
  private static readonly SAVE_QUEUE_TIMEOUT = 8000;
  
  /** 单次保存操作执行超时时间 (毫秒) - 30秒，防止网络挂起导致队列永久阻塞 */
  private static readonly SAVE_EXECUTION_TIMEOUT = 30000;
  
  // ========== RxJS 声明式保存队列 ==========
  // 使用 Subject + concatMap 替代手动锁，彻底消除死锁和忘记解锁的 Bug
  // 声明式队列：你只管往传送带上放东西，流水线自己控制速度
  
  /** 保存请求队列 Subject */
  private saveQueue$ = new Subject<{
    project: Project;
    userId: string;
    resolve: (value: { success: boolean; conflict?: boolean; remoteData?: Project }) => void;
    reject: (error: Error) => void;
    enqueuedAt: number;
  }>();
  
  /** 队列统计 */
  private saveQueueStats = {
    /** 溢出丢弃计数 */
    overflowCount: 0,
    /** 当前等待中的请求数 */
    pendingCount: 0
  };
  
  /** 是否暂停处理远程更新（队列同步期间） */
  private pauseRemoteUpdates = false;


  constructor() {
    this.setupNetworkListeners();
    // 恢复持久化的冲突数据
    this.restoreConflictData();
    // 初始化保存队列处理管道
    this.setupSaveQueuePipeline();
    
    // 注册 DestroyRef 自动清理
    this.destroyRef.onDestroy(() => this.destroy());
  }
  
  /**
   * 设置保存队列处理管道
   * 使用 RxJS concatMap 实现声明式的串行处理
   * 无需手动锁，彻底消除死锁风险
   */
  private setupSaveQueuePipeline(): void {
    this.saveQueue$.pipe(
      // 限流：如果队列积压过多，丢弃中间状态
      tap(() => this.saveQueueStats.pendingCount++),
      
      // 核心：concatMap 保证串行执行，前一个完成才处理下一个
      concatMap(async (request) => {
        this.saveQueueStats.pendingCount--;
        
        // 超时检查：如果请求等待太久，跳过并返回成功（数据已在本地）
        const waitTime = Date.now() - request.enqueuedAt;
        if (waitTime > SyncService.SAVE_QUEUE_TIMEOUT) {
          this.logger.warn('保存请求等待超时，跳过', {
            projectId: request.project.id,
            waitTime: `${waitTime}ms`
          });
          request.resolve({ success: true }); // 乐观返回成功，数据已在本地
          return;
        }
        
        try {
          const result = await this.doSaveProjectToCloud(request.project, request.userId);
          request.resolve(result);
        } catch (error) {
          request.reject(error as Error);
        }
      })
    ).subscribe({
      error: (err) => {
        this.logger.error('保存队列管道异常', err);
      }
    });
  }
  
  /**
   * 恢复持久化的冲突数据
   * 在页面刷新后恢复未解决的冲突
   * 优先从 IndexedDB 加载完整数据，降级到 localStorage 元数据
   */
  private restoreConflictData(): void {
    // 首先检查 IndexedDB 是否有完整数据
    void this.conflictStorage.hasConflicts().then(async (hasConflicts) => {
      if (hasConflicts) {
        const conflicts = await this.conflictStorage.getAllConflicts();
        if (conflicts.length > 0) {
          // 取最新的冲突
          const latestConflict = conflicts.sort((a, b) => 
            new Date(b.conflictedAt).getTime() - new Date(a.conflictedAt).getTime()
          )[0];
          
          this.logger.info('从 IndexedDB 恢复完整冲突数据', { 
            projectId: latestConflict.projectId,
            taskCount: latestConflict.localProject.tasks.length
          });
          
          // 设置待加载标记，等待用户登录后完成恢复
          this.pendingConflictReload = {
            projectId: latestConflict.projectId,
            localVersion: latestConflict.localVersion,
            remoteVersion: latestConflict.remoteVersion,
            fullDataInIndexedDB: true
          };
          return;
        }
      }
      
      // 降级：检查 localStorage
      if (typeof localStorage !== 'undefined') {
        try {
          const saved = localStorage.getItem(this.CONFLICT_STORAGE_KEY);
          if (saved) {
            const conflictMeta = JSON.parse(saved) as ConflictMetadata;
            if (conflictMeta?.projectId) {
              this.logger.info('从 localStorage 恢复冲突元数据', { projectId: conflictMeta.projectId });
              this.pendingConflictReload = conflictMeta;
            }
          }
        } catch (e) {
          this.logger.warn('恢复冲突数据失败', e);
          localStorage.removeItem(this.CONFLICT_STORAGE_KEY);
        }
      }
    });
  }
  
  /** 待加载的冲突元数据 */
  private pendingConflictReload: ConflictMetadata | null = null;
  
  /**
   * 尝试加载完整的冲突数据
   * 在用户登录后调用，用于恢复持久化的冲突
   */
  async tryReloadConflictData(userId: string, getLocalProject: (id: string) => Project | undefined): Promise<void> {
    if (!this.pendingConflictReload || !userId) return;
    
    const meta = this.pendingConflictReload;
    this.pendingConflictReload = null;
    
    try {
      this.logger.info('正在重新加载冲突数据', { projectId: meta.projectId });
      
      // 优先从 IndexedDB 加载本地完整数据
      let localProject: Project | undefined;
      
      if (meta.fullDataInIndexedDB) {
        const conflictRecord = await this.conflictStorage.getConflict(meta.projectId);
        if (conflictRecord) {
          localProject = conflictRecord.localProject;
          this.logger.info('从隔离区恢复本地项目数据', { 
            taskCount: localProject.tasks.length 
          });
        }
      }
      
      // 如果 IndexedDB 没有，尝试从当前内存获取
      if (!localProject) {
        localProject = getLocalProject(meta.projectId);
      }
      
      // 加载远程版本
      const remoteProject = await this.loadSingleProject(meta.projectId, userId);
      
      if (remoteProject && localProject) {
        const conflictData = {
          local: localProject,
          remote: remoteProject,
          projectId: meta.projectId,
          remoteData: remoteProject
        };
        
        this.syncState.update(s => ({
          ...s,
          hasConflict: true,
          conflictData
        }));
        
        this.logger.info('冲突数据已重新加载');
      } else {
        // 无法加载完整数据，清除冲突状态
        this.logger.warn('无法加载冲突数据，清除冲突状态');
        this.clearPersistedConflict();
      }
    } catch (e) {
      this.logger.error('重新加载冲突数据失败', e);
      this.clearPersistedConflict();
    }
  }
  
  /**
   * 持久化冲突数据到隔离区
   * 
   * 设计变更：不再只保存元数据，而是完整保存本地项目数据到 IndexedDB
   * 这样即使应用崩溃、网络断开，用户的心血都完好无损地等待处理
   * 
   * localStorage 仅用于快速检测是否有待处理冲突
   */
  private persistConflictData(conflictData: { local?: Project; remote?: Project; projectId: string }): void {
    if (!conflictData.local) {
      this.logger.warn('冲突数据缺少本地项目，无法持久化');
      return;
    }
    
    // 1. 完整数据保存到 IndexedDB（隔离区）
    const conflictRecord: ConflictRecord = {
      projectId: conflictData.projectId,
      localProject: conflictData.local,
      conflictedAt: new Date().toISOString(),
      localVersion: conflictData.local.version ?? 0,
      remoteVersion: conflictData.remote?.version,
      reason: 'version_mismatch'
    };
    
    // 异步保存到 IndexedDB，记录错误但不阻塞主流程
    this.conflictStorage.saveConflict(conflictRecord)
      .then(success => {
        if (success) {
          this.logger.info('冲突数据已保存到 IndexedDB 隔离区', { projectId: conflictData.projectId });
        }
      })
      .catch(e => {
        this.logger.error('保存冲突数据到 IndexedDB 失败', e);
        // IndexedDB 失败时，冲突元数据仍会保存到 localStorage（下面的代码）
        // 这是双重保险机制
      });
    
    // 2. 元数据保存到 localStorage（快速检测用）
    if (typeof localStorage !== 'undefined') {
      try {
        const metadata: ConflictMetadata = {
          projectId: conflictData.projectId,
          localVersion: conflictData.local.version,
          remoteVersion: conflictData.remote?.version,
          localTaskCount: conflictData.local.tasks?.length ?? 0,
          remoteTaskCount: conflictData.remote?.tasks?.length ?? 0,
          savedAt: new Date().toISOString(),
          fullDataInIndexedDB: true
        };
        
        localStorage.setItem(this.CONFLICT_STORAGE_KEY, JSON.stringify(metadata));
      } catch (e) {
        this.logger.warn('持久化冲突元数据到 localStorage 失败', e);
      }
    }
  }
  
  /**
   * 清除持久化的冲突数据
   */
  private clearPersistedConflict(projectId?: string): void {
    // 清除 localStorage 元数据
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(this.CONFLICT_STORAGE_KEY);
    }
    
    // 清除 IndexedDB 完整数据
    if (projectId) {
      void this.conflictStorage.deleteConflict(projectId).catch(e => {
        this.logger.warn('清除 IndexedDB 冲突数据失败', e);
      });
    }
  }

  /**
   * 设置网络状态监听
   */
  private setupNetworkListeners() {
    if (typeof window === 'undefined') return;
    
    this.onlineHandler = () => {
      this.syncState.update(s => ({ ...s, isOnline: true }));
    };
    
    this.offlineHandler = () => {
      this.syncState.update(s => ({ ...s, isOnline: false }));
    };
    
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }
  
  /**
   * 移除网络状态监听
   */
  private removeNetworkListeners() {
    if (typeof window === 'undefined') return;
    
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    
    if (this.offlineHandler) {
      window.removeEventListener('offline', this.offlineHandler);
      this.offlineHandler = null;
    }
  }

  /**
   * 设置远程变更回调
   */
  setRemoteChangeCallback(callback: (payload?: RemoteProjectChangePayload) => Promise<void>) {
    this.onRemoteChangeCallback = callback;
  }
  
  /**
   * 设置任务级变更回调（用于细粒度更新）
   */
  setTaskChangeCallback(callback: (payload: RemoteTaskChangePayload) => void) {
    this.onTaskChangeCallback = callback;
  }

  /**
   * 暂停处理远程更新
   * 在队列同步期间调用，避免竞态条件
   */
  pauseRealtimeUpdates() {
    this.pauseRemoteUpdates = true;
    this.logger.debug('远程更新已暂停');
  }

  /**
   * 恢复处理远程更新
   * 队列同步完成后调用
   */
  resumeRealtimeUpdates() {
    this.pauseRemoteUpdates = false;
    this.logger.debug('远程更新已恢复');
  }

  /**
   * 初始化实时订阅
   * 订阅项目级别和任务级别的变更
   * 使用订阅管理器模式防止重复订阅
   */
  async initRealtimeSubscription(userId: string) {
    if (!this.supabase.isConfigured || !userId) return;
    
    // 防止重复订阅：如果已经为同一个用户订阅了，直接返回
    if (this.currentSubscribedUserId === userId && 
        this.realtimeChannel !== null && 
        this.tasksChannel !== null) {
      this.logger.debug('已经为该用户建立了订阅，跳过重复订阅', { userId });
      return;
    }
    
    // 如果是不同用户或需要重新订阅，先清理旧订阅
    if (this.currentSubscribedUserId !== null && this.currentSubscribedUserId !== userId) {
      this.logger.info('用户已切换，清理旧订阅', { 
        oldUserId: this.currentSubscribedUserId, 
        newUserId: userId 
      });
    }
    
    this.teardownRealtimeSubscription();
    
    // 记录当前订阅的用户
    this.currentSubscribedUserId = userId;
    this.isDestroyed = false;

    // 项目级别订阅 - 使用 Tab ID 隔离避免多标签页频道冲突
    const channel = this.supabase.client()
      .channel(`user-${userId}-changes-${TAB_ID}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'projects',
          filter: `owner_id=eq.${userId}`
        },
        payload => {
          this.logger.debug('收到项目变更:', payload.eventType);
          this.handleRemoteChange(payload).catch(e => {
            this.logger.error('处理项目变更时发生错误', e);
          });
        }
      );

    this.realtimeChannel = channel;
    
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        this.logger.info('✅ Realtime channel ready');
        // 重置重试计数
        this.retryState.count = 0;
        if (this.retryState.timer) {
          clearTimeout(this.retryState.timer);
          this.retryState.timer = null;
        }
        this.syncState.update(s => ({
          ...s,
          isOnline: true,
          offlineMode: false
        }));
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        this.logger.warn('⚠️ Realtime channel error:', err);
        this.syncState.update(s => ({
          ...s,
          offlineMode: true
        }));
        // 通知用户连接状态变化（仅在首次断开时提示，避免重连期间频繁打扰）
        if (this.retryState.count === 0) {
          this.toast.warning(
            '实时同步已断开',
            '正在尝试重新连接，离线期间的更改将在恢复后同步'
          );
        }
        // 尝试自动重连
        this.scheduleReconnect(userId);
      }
    });
    
    // 任务级别订阅 - 使用 Tab ID 隔离
    // 注意：tasks 表需要通过 project_id 关联来过滤
    // 由于 Supabase Realtime 不支持 JOIN 过滤，我们在客户端过滤
    // 但为了减少不必要的数据传输，先获取用户的项目 ID 列表
    const tasksChannel = this.supabase.client()
      .channel(`user-${userId}-tasks-${TAB_ID}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks'
          // 注意：Supabase Realtime 对 tasks 表的过滤依赖 RLS 策略
          // 确保 tasks 表的 RLS 策略只允许用户访问自己项目的任务
        },
        payload => {
          // 客户端二次过滤：检查 project_id 是否属于当前用户的项目
          const newRecord = payload.new as Record<string, unknown>;
          const oldRecord = payload.old as Record<string, unknown>;
          const projectId = (newRecord?.project_id || oldRecord?.project_id) as string;
          
          // 如果没有 project_id，可能是删除事件，让 handler 处理
          if (projectId || payload.eventType === 'DELETE') {
            this.logger.debug('收到任务变更', { eventType: payload.eventType, projectId });
            this.handleTaskChange(payload).catch(e => {
              this.logger.error('处理任务变更时发生错误', e);
            });
          }
        }
      );
    
    this.tasksChannel = tasksChannel;
    tasksChannel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        this.logger.info('✅ Tasks Realtime channel ready');
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        this.logger.warn('⚠️ Tasks Realtime channel error:', err);
        // 任务通道错误不触发完全离线模式，只记录警告
        // 因为项目通道仍可能正常工作
        // 如果错误持续出现，在日志中记录详细信息以便调试
        if (err) {
          this.logger.error('Tasks channel subscription error details', {
            errorMessage: err.message || String(err),
            status
          });
        }
      }
    });
  }
  
  /** 当前用户 ID（用于重连时检查） */
  private currentSubscribedUserId: string | null = null;
  
  /** 是否已销毁 */
  private isDestroyed = false;

  /**
   * 计划重连
   * 使用指数退避策略
   * 修复：重连前检查用户是否仍然登录
   */
  private scheduleReconnect(userId: string) {
    // 检查服务是否已销毁
    if (this.isDestroyed) {
      this.logger.info('服务已销毁，取消重连');
      return;
    }
    
    // 检查用户是否仍然是当前订阅的用户
    if (this.currentSubscribedUserId !== userId) {
      this.logger.info('用户已变更，取消重连', { 
        originalUserId: userId, 
        currentUserId: this.currentSubscribedUserId 
      });
      return;
    }
    
    // 达到最大重试次数，放弃重连
    if (this.retryState.count >= this.retryState.maxRetries) {
      this.logger.warn('⚠️ 达到最大重连次数，放弃重连');
      return;
    }
    
    // 清除之前的重连定时器
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
    }
    
    // 指数退避：1s, 2s, 4s, 8s... 最大 30s
    const delay = Math.min(1000 * Math.pow(2, this.retryState.count), 30000);
    this.retryState.count++;
    
    this.logger.info(`🔄 计划在 ${delay / 1000}s 后重连 (尝试 ${this.retryState.count}/${this.retryState.maxRetries})`);
    
    this.retryState.timer = setTimeout(async () => {
      // 重连前再次检查用户状态
      if (this.isDestroyed || this.currentSubscribedUserId !== userId) {
        this.logger.info('重连时检测到状态变更，取消重连');
        return;
      }
      
      // 检查网络状态
      if (!this.syncState().isOnline) {
        this.logger.info('📶 网络离线，暂停重连');
        return;
      }
      
      this.logger.info('🔄 正在尝试重新连接...');
      try {
        await this.initRealtimeSubscription(userId);
      } catch (e) {
        this.logger.error('重连失败', e);
        // 继续重试（如果用户仍然相同）
        if (this.currentSubscribedUserId === userId) {
          this.scheduleReconnect(userId);
        }
      }
    }, delay);
  }

  /**
   * 处理远程变更
   */
  private async handleRemoteChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
    if (!this.onRemoteChangeCallback || this.pauseRemoteUpdates) return;
    
    // 防抖处理
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
    }
    
    this.remoteChangeTimer = setTimeout(async () => {
      // 再次检查是否暂停
      if (this.pauseRemoteUpdates) return;
      
      try {
        const eventType = payload.eventType;
        const newRecord = payload.new as Record<string, unknown>;
        const oldRecord = payload.old as Record<string, unknown>;
        const projectId = (newRecord?.id || oldRecord?.id) as string;
        
        await this.onRemoteChangeCallback!({
          eventType,
          projectId,
          data: newRecord
        });
      } catch (e) {
        this.logger.error('处理实时更新失败', e);
      } finally {
        this.remoteChangeTimer = null;
      }
    }, SYNC_CONFIG.REMOTE_CHANGE_DELAY);
  }

  /**
   * 处理任务级别变更
   */
  private async handleTaskChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
    if (!this.onTaskChangeCallback || this.pauseRemoteUpdates) return;
    
    const eventType = payload.eventType;
    const newRecord = payload.new as Record<string, unknown>;
    const oldRecord = payload.old as Record<string, unknown>;
    const taskId = (newRecord?.id || oldRecord?.id) as string;
    const projectId = (newRecord?.project_id || oldRecord?.project_id) as string;
    
    this.onTaskChangeCallback({
      eventType,
      taskId,
      projectId
    });
  }

  /**
   * 卸载实时订阅
   * 清理所有订阅通道、重试状态和相关资源
   */
  teardownRealtimeSubscription() {
    // 清除当前订阅的用户（阻止重连）
    this.currentSubscribedUserId = null;
    
    if (this.realtimeChannel) {
      if (this.supabase.isConfigured) {
        void this.supabase.client().removeChannel(this.realtimeChannel);
      }
      this.realtimeChannel = null;
    }
    if (this.tasksChannel) {
      if (this.supabase.isConfigured) {
        void this.supabase.client().removeChannel(this.tasksChannel);
      }
      this.tasksChannel = null;
    }
    
    // 重置重试状态
    this.retryState.count = 0;
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
      this.retryState.timer = null;
    }
    
    // 清理远程变更处理定时器
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
      this.remoteChangeTimer = null;
    }
  }

  /**
   * 从云端加载项目列表
   * 从独立的 tasks 和 connections 表加载数据
   * 添加超时保护，防止网络问题导致无限等待
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[]> {
    if (!userId || !this.supabase.isConfigured) {
      return [];
    }
    
    this.isLoadingRemote.set(true);
    
    // 超时保护
    const timeoutMs = SYNC_CONFIG.CLOUD_LOAD_TIMEOUT;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`云端数据加载超时（${timeoutMs / 1000}秒）`));
      }, timeoutMs);
    });
    
    const loadPromise = this.loadProjectsFromCloudInternal(userId);
    
    try {
      const projects = await Promise.race([loadPromise, timeoutPromise]);
      return projects;
    } catch (e: unknown) {
      this.logger.error('Loading from Supabase failed', e);
      this.syncState.update(s => ({
        ...s,
        syncError: extractErrorMessage(e),
        offlineMode: true
      }));
      return [];
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.isLoadingRemote.set(false);
    }
  }
  
  /**
   * 内部方法：实际执行云端数据加载
   */
  private async loadProjectsFromCloudInternal(userId: string): Promise<Project[]> {
    try {
      console.log('[Sync] 开始从云端加载项目，userId:', userId);
      
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('owner_id', userId)
        .order('created_date', { ascending: true });
      
      if (error) {
        console.error('[Sync] 加载项目失败:', error);
        throw error;
      }
      
      console.log('[Sync] 云端返回项目数量:', data?.length ?? 0);
      
      // 并行加载所有项目的任务和连接
      const projects = await Promise.all((data || []).map(async row => {
        const projectRow = row as ProjectRow;
        const [tasks, connections] = await Promise.all([
          this.taskRepo.loadTasks(projectRow.id),
          this.taskRepo.loadConnections(projectRow.id)
        ]);
        return this.mapRowToProject(projectRow, tasks, connections);
      }));
      
      this.syncState.update(s => ({
        ...s,
        syncError: null,
        offlineMode: false
      }));
      
      return projects;
    } catch (e: unknown) {
      // 重新抛出，让外层 loadProjectsFromCloud 统一处理
      throw e;
    }
  }

  /**
   * 加载单个项目（用于增量更新）
   */
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    if (!userId || !this.supabase.isConfigured || !projectId) {
      return null;
    }
    
    try {
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .eq('owner_id', userId)
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          // 项目不存在
          return null;
        }
        throw error;
      }
      
      const projectRow = data as ProjectRow;
      const [tasks, connections] = await Promise.all([
        this.taskRepo.loadTasks(projectRow.id),
        this.taskRepo.loadConnections(projectRow.id)
      ]);
      return this.mapRowToProject(projectRow, tasks, connections);
    } catch (e: unknown) {
      this.logger.error('Loading single project failed', e);
      return null;
    }
  }

  /**
   * 保存项目到云端（带冲突检测和并发控制）
   * 使用版本号 + 服务端时间戳双重检测机制
   * Token 过期时自动保存本地数据防止丢失
   * 使用 RxJS concatMap 声明式队列防止并发保存导致版本号冲突
   * @returns 成功时返回新版本号 newVersion，用于更新本地状态
   */
  async saveProjectToCloud(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number }> {
    if (!userId || !this.supabase.isConfigured) {
      return { success: true }; // 离线模式视为成功
    }
    
    // 检查队列是否溢出
    if (this.saveQueueStats.pendingCount >= SyncService.MAX_SAVE_QUEUE_SIZE) {
      this.saveQueueStats.overflowCount++;
      this.logger.warn(`保存队列溢出：丢弃请求（累计丢弃 ${this.saveQueueStats.overflowCount}）`, {
        pendingCount: this.saveQueueStats.pendingCount,
        maxSize: SyncService.MAX_SAVE_QUEUE_SIZE
      });
      
      // 通知用户同步压力过大（只在首次溢出时提示，避免刷屏）
      if (this.saveQueueStats.overflowCount === 1) {
        this.toast.warning(
          '同步队列繁忙',
          '部分中间状态已跳过，最新更改将继续同步'
        );
      }
      
      // 乐观返回成功，数据已在本地
      return { success: true };
    }
    
    // 将请求加入声明式队列
    return new Promise((resolve, reject) => {
      this.saveQueue$.next({
        project,
        userId,
        resolve,
        reject,
        enqueuedAt: Date.now()
      });
    });
  }
  
  /**
   * 实际执行保存操作（内部方法）
   * 使用数据库乐观锁解决竞态条件：
   * UPDATE ... WHERE version = expected_version
   * 添加执行超时控制防止网络挂起导致队列阻塞
   */
  private async doSaveProjectToCloud(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number }> {
    this.syncState.update(s => ({ ...s, isSyncing: true }));
    
    // 使用 Promise.race 添加执行超时控制
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`保存操作执行超时 (${SyncService.SAVE_EXECUTION_TIMEOUT / 1000}s)`));
      }, SyncService.SAVE_EXECUTION_TIMEOUT);
    });
    
    try {
      return await Promise.race([
        this.doSaveProjectToCloudInternal(project, userId),
        timeoutPromise
      ]);
    } catch (e: unknown) {
      this.logger.error('Sync project failed or timed out', e);
      
      // 任何同步失败都保存到本地缓存
      this.saveOfflineSnapshot([project]);
      
      this.syncState.update(s => ({
        ...s,
        syncError: extractErrorMessage(e),
        offlineMode: true
      }));
      return { success: false };
    } finally {
      this.syncState.update(s => ({ ...s, isSyncing: false }));
    }
  }
  
  /**
   * 保存操作的内部实现（不带超时控制）
   */
  private async doSaveProjectToCloudInternal(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number }> {
    console.log('[Sync] 开始保存项目到云端', { projectId: project.id, projectName: project.name, userId });
    
    try {
      const currentVersion = project.version ?? 0;
      const newVersion = currentVersion + 1;
      
      // 检查项目是否存在
      const { data: existingData, error: checkError } = await this.supabase.client()
        .from('projects')
        .select('id, version')
        .eq('id', project.id)
        .maybeSingle();
      
      if (checkError && checkError.code !== 'PGRST116') {
        console.error('[Sync] 检查项目是否存在时出错:', checkError);
        throw checkError;
      }
      
      const isUpdate = !!existingData;
      console.log('[Sync] 项目操作类型:', isUpdate ? '更新' : '创建', { existingData });
      
      if (isUpdate) {
        // 使用乐观锁更新：只有版本号匹配时才更新
        const { data: updateResult, error: updateError } = await this.supabase.client()
          .from('projects')
          .update({
            title: project.name,
            description: project.description,
            version: newVersion
          })
          .eq('id', project.id)
          .eq('version', currentVersion) // 乐观锁：只有版本匹配才更新
          .select('id')
          .maybeSingle();
        
        if (updateError) {
          this.handleSaveError(updateError, project);
          throw updateError;
        }
        
        // 如果没有返回数据，说明版本号不匹配（被其他客户端更新了）
        if (!updateResult) {
          this.logger.warn('版本冲突：远端数据已被更新', { projectId: project.id, localVersion: currentVersion });
          
          // 加载最新的远程数据
          const remoteProject = await this.loadSingleProject(project.id, userId);
          if (remoteProject) {
            const conflictData = { 
              local: project, 
              remote: remoteProject,
              projectId: project.id,
              remoteData: remoteProject
            };
            this.persistConflictData(conflictData);
            this.syncState.update(s => ({
              ...s,
              hasConflict: true,
              conflictData
            }));
            return { success: false, conflict: true, remoteData: remoteProject };
          }
        }
      } else {
        // 创建新项目
        console.log('[Sync] 创建新项目', { projectId: project.id, ownerId: userId });
        
        const { error: insertError } = await this.supabase.client()
          .from('projects')
          .insert({
            id: project.id,
            owner_id: userId,
            title: project.name,
            description: project.description,
            created_date: project.createdDate || nowISO(),
            version: newVersion
          });
        
        if (insertError) {
          console.error('[Sync] 创建项目失败:', insertError);
          this.handleSaveError(insertError, project);
          throw insertError;
        }
        
        console.log('[Sync] 项目创建成功');
      }
      
      // 批量保存任务
      console.log('[Sync] 保存任务，数量:', project.tasks.length);
      const tasksResult = await this.taskRepo.saveTasks(project.id, project.tasks);
      if (!tasksResult.success) {
        console.error('[Sync] 保存任务失败:', tasksResult.error);
        throw new Error(tasksResult.error);
      }
      
      // 同步连接
      const connectionsResult = await this.taskRepo.syncConnections(project.id, project.connections);
      if (!connectionsResult.success) {
        console.error('[Sync] 同步连接失败:', connectionsResult.error);
        throw new Error(connectionsResult.error);
      }
      
      console.log('[Sync] 项目保存完成', { projectId: project.id, newVersion });
      
      this.syncState.update(s => ({
        ...s,
        syncError: null,
        offlineMode: false,
        sessionExpired: false,
        hasConflict: false,
        conflictData: null
      }));
      
      // 返回新版本号，让调用方更新本地状态
      return { success: true, newVersion };
    } catch (e: unknown) {
      this.logger.error('Sync project failed', e);
      
      // 任何同步失败都保存到本地缓存
      this.saveOfflineSnapshot([project]);
      
      this.syncState.update(s => ({
        ...s,
        syncError: extractErrorMessage(e),
        offlineMode: true
      }));
      return { success: false };
    }
  }

  /**
   * 处理保存错误
   */
  private handleSaveError(error: { code?: string; message?: string }, project: Project): void {
    // 处理认证错误 - 先保存本地数据再报错
    if (error.code === 'PGRST301' || error.message?.includes('JWT') || error.code === '401') {
      this.saveOfflineSnapshot([project]);
      this.logger.warn('Token 过期，数据已保存到本地');
      
      this.syncState.update(s => ({ 
        ...s, 
        sessionExpired: true,
        offlineMode: true,
        syncError: '登录已过期，数据已保存在本地，请重新登录后同步'
      }));
    }
  }

  /**
   * 删除云端项目
   */
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    if (!userId || !this.supabase.isConfigured) {
      return true;
    }
    
    try {
      const { error } = await this.supabase.client()
        .from('projects')
        .delete()
        .eq('id', projectId)
        .eq('owner_id', userId);
      
      if (error) throw error;
      return true;
    } catch (e: unknown) {
      this.logger.error('Delete project from cloud failed', e);
      this.syncState.update(s => ({
        ...s,
        syncError: extractErrorMessage(e)
      }));
      return false;
    }
  }

  /**
   * 解决冲突（选择保留哪个版本）
   */
  resolveConflict(projectId: string, project: Project, choice: 'local' | 'remote'): void {
    // 清除持久化的冲突数据（包括 IndexedDB 和 localStorage）
    this.clearPersistedConflict(projectId);
    
    this.syncState.update(s => ({
      ...s,
      hasConflict: false,
      conflictData: null
    }));
    
    this.logger.info(`冲突已解决：${choice === 'local' ? '使用本地版本' : '使用远程版本'}`, { projectId });
  }

  /**
   * 加载用户偏好设置
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    if (!userId || !this.supabase.isConfigured) return null;
    
    try {
      const { data, error } = await this.supabase.client()
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      
      if (data) {
        return {
          theme: (data.theme as ThemeType) ?? 'default',
          layoutDirection: (data.layout_direction as 'ltr' | 'rtl') ?? 'ltr',
          floatingWindowPref: (data.floating_window_pref as 'auto' | 'fixed') ?? 'auto'
        };
      }
      return null;
    } catch (e) {
      this.logger.warn('加载用户偏好设置失败', e);
      return null;
    }
  }

  /**
   * 保存用户偏好设置
   */
  async saveUserPreferences(userId: string, prefs: Partial<UserPreferences>): Promise<boolean> {
    // 始终保存到本地
    if (prefs.theme) {
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, prefs.theme);
    }
    if (prefs.layoutDirection) {
      localStorage.setItem('nanoflow.layout-direction', prefs.layoutDirection);
    }
    if (prefs.floatingWindowPref) {
      localStorage.setItem('nanoflow.floating-window-pref', prefs.floatingWindowPref);
    }
    
    if (!userId || !this.supabase.isConfigured) return true;
    
    try {
      // 构建更新对象，只包含有值的字段
      const updateData: Record<string, string | undefined> = {
        user_id: userId,
        updated_at: nowISO()
      };
      
      if (prefs.theme !== undefined) {
        updateData.theme = prefs.theme;
      }
      if (prefs.layoutDirection !== undefined) {
        updateData.layout_direction = prefs.layoutDirection;
      }
      if (prefs.floatingWindowPref !== undefined) {
        updateData.floating_window_pref = prefs.floatingWindowPref;
      }
      
      const { error } = await this.supabase.client()
        .from('user_preferences')
        .upsert(updateData, { onConflict: 'user_id' });
      
      if (error) throw error;
      return true;
    } catch (e) {
      this.logger.warn('保存用户偏好设置到云端失败', e);
      return false;
    }
  }

  /**
   * 保存离线快照
   */
  saveOfflineSnapshot(projects: Project[]) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(CACHE_CONFIG.OFFLINE_CACHE_KEY, JSON.stringify({
        projects,
        version: CACHE_CONFIG.CACHE_VERSION
      }));
    } catch (e) {
      this.logger.warn('Offline cache write failed', e);
    }
  }

  /**
   * 加载离线快照
   * 包含版本检查和数据迁移逻辑
   */
  loadOfflineSnapshot(): Project[] | null {
    try {
      const cached = typeof localStorage !== 'undefined'
        ? localStorage.getItem(CACHE_CONFIG.OFFLINE_CACHE_KEY)
        : null;
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          const cachedVersion = parsed.version ?? 1;
          const currentVersion = CACHE_CONFIG.CACHE_VERSION;
          
          // 版本检查和数据迁移
          if (cachedVersion < currentVersion) {
            this.logger.info(`缓存版本升级: ${cachedVersion} -> ${currentVersion}`);
            const migratedProjects = this.migrateOfflineData(parsed.projects, cachedVersion);
            // 保存迁移后的数据
            this.saveOfflineSnapshot(migratedProjects);
            return migratedProjects;
          }
          
          return parsed.projects;
        }
      }
    } catch (e) {
      this.logger.warn('Offline cache read failed', e);
    }
    return null;
  }

  /**
   * 迁移离线数据到最新版本
   */
  private migrateOfflineData(projects: Project[], fromVersion: number): Project[] {
    let migrated = projects;
    
    // 版本 1 -> 2: 添加 version 字段、status 默认值等
    if (fromVersion < 2) {
      migrated = migrated.map(project => ({
        ...project,
        version: project.version ?? 0,
        updatedAt: project.updatedAt || nowISO(),
        tasks: project.tasks.map(task => ({
          ...task,
          status: task.status || 'active',
          rank: task.rank ?? 10000,
          displayId: task.displayId || '?',
          hasIncompleteTask: task.hasIncompleteTask ?? false,
          deletedAt: task.deletedAt ?? null
        })),
        connections: project.connections || []
      }));
      // 数据迁移完成记录由调用方的 logger.info 处理
    }
    
    return migrated;
  }

  /**
   * 清除离线缓存
   */
  clearOfflineCache() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(CACHE_CONFIG.OFFLINE_CACHE_KEY);
    }
  }

  /**
   * 映射数据库行到项目对象
   */
  private mapRowToProject(row: ProjectRow, tasks: Task[], connections: Connection[]): Project {
    return {
      id: row.id,
      name: row.title ?? 'Untitled project',
      description: row.description ?? '',
      createdDate: row.created_date ?? nowISO(),
      tasks,
      connections,
      updatedAt: row.updated_at ?? undefined,
      version: row.version ?? 0
    };
  }

  /**
   * 清理资源
   * 确保清理所有定时器和事件监听器，防止内存泄漏
   */
  destroy() {
    this.isDestroyed = true;
    this.currentSubscribedUserId = null;
    
    // 完成保存队列 Subject，释放所有订阅
    this.saveQueue$.complete();
    
    this.teardownRealtimeSubscription();
    this.removeNetworkListeners();
    
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
      this.remoteChangeTimer = null;
    }
    
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
      this.retryState.timer = null;
    }
    
    // 重置重试状态
    this.retryState.count = 0;
    
    this.onRemoteChangeCallback = null;
    this.onTaskChangeCallback = null;
  }
  
  // ========== 显式状态重置（用于测试和 HMR）==========
  
  /**
   * 显式重置服务状态
   * 用于测试环境的 afterEach 或 HMR 重载
   * 
   * 注意：与 destroy() 不同，reset() 只重置状态，不标记服务为已销毁
   */
  reset(): void {
    // 清理订阅和定时器
    this.teardownRealtimeSubscription();
    this.removeNetworkListeners();
    
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
      this.remoteChangeTimer = null;
    }
    
    if (this.retryState.timer) {
      clearTimeout(this.retryState.timer);
      this.retryState.timer = null;
    }
    
    // 重置状态
    this.syncState.set({
      isSyncing: false,
      isOnline: typeof window !== 'undefined' ? navigator.onLine : true,
      offlineMode: false,
      sessionExpired: false,
      syncError: null,
      hasConflict: false,
      conflictData: null
    });
    
    this.isLoadingRemote.set(false);
    this.retryState.count = 0;
    this.currentSubscribedUserId = null;
    this.isDestroyed = false;
    this.pauseRemoteUpdates = false;
    this.pendingConflictReload = null;
    
    // 清空保存队列统计
    this.saveQueueStats.pendingCount = 0;
    this.saveQueueStats.overflowCount = 0;
    
    // 清空回调
    this.onRemoteChangeCallback = null;
    this.onTaskChangeCallback = null;
    
    // 重新设置网络监听器（因为服务可能继续使用）
    this.setupNetworkListeners();
  }
}
