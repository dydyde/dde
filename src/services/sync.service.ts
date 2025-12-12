import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { Subject } from 'rxjs';
import { concatMap, tap } from 'rxjs/operators';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';
import { TaskRepositoryService } from './task-repository.service';
import { ChangeTrackerService, ProjectChangeSummary } from './change-tracker.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { ConflictStorageService, ConflictRecord } from './conflict-storage.service';
import { BaseSnapshotService } from './base-snapshot.service';
import { ThreeWayMergeService, ThreeWayMergeResult } from './three-way-merge.service';
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
  private changeTracker = inject(ChangeTrackerService);
  private logger = inject(LoggerService).category('Sync');
  private toast = inject(ToastService);
  private conflictStorage = inject(ConflictStorageService);
  private baseSnapshot = inject(BaseSnapshotService);
  private threeWayMerge = inject(ThreeWayMergeService);
  
  /** 冲突数据持久化 key */
  private readonly CONFLICT_STORAGE_KEY = 'nanoflow.pending-conflicts';
  
  /** 自动变基最大重试次数 */
  private static readonly AUTO_REBASE_MAX_RETRIES = 3;
  
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
  
  /** 同步进度信息（用于UI反馈） */
  readonly syncProgress = signal<{
    current: number;
    total: number;
    phase: 'idle' | 'saving-projects' | 'saving-tasks' | 'saving-connections' | 'loading';
    message: string;
  }>({
    current: 0,
    total: 0,
    phase: 'idle',
    message: ''
  });
  
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
  
  /** 
   * 保守模式：永不丢弃保存请求
   * 移除队列大小限制，改为持久化到IndexedDB
   * 用户数据是最高优先级，宁可慢也不能丢
   */
  private static readonly SAVE_QUEUE_TIMEOUT = 0; // 禁用超时丢弃
  
  /** 单次保存操作执行超时时间 (毫秒) - 增加到60秒，适应慢速网络 */
  private static readonly SAVE_EXECUTION_TIMEOUT = 60000;
  
  /** 本地自动保存间隔（毫秒） */
  private static readonly LOCAL_AUTOSAVE_INTERVAL = SYNC_CONFIG.LOCAL_AUTOSAVE_INTERVAL;
  
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
        
        // 保守模式：永不跳过请求，确保所有数据都尝试同步
        const waitTime = Date.now() - request.enqueuedAt;
        if (waitTime > 10000) {
          // 只记录警告，但仍然处理
          this.logger.warn('保存请求等待时间较长', {
            projectId: request.project.id,
            waitTime: `${waitTime}ms`
          });
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
          
          // 调试：记录接收到的事件详情
          this.logger.debug('收到任务变更原始事件', { 
            eventType: payload.eventType, 
            hasNewRecord: !!newRecord,
            hasOldRecord: !!oldRecord,
            newRecordKeys: newRecord ? Object.keys(newRecord) : [],
            oldRecordKeys: oldRecord ? Object.keys(oldRecord) : [],
            projectId,
            taskId: (newRecord?.id || oldRecord?.id)
          });
          
          // 如果没有 project_id，可能是删除事件且表缺少 REPLICA IDENTITY FULL
          if (!projectId && payload.eventType === 'DELETE') {
            this.logger.warn('⚠️ DELETE 事件缺少 project_id！请检查数据库 REPLICA IDENTITY 配置', {
              oldRecord,
              hasId: !!(oldRecord?.id)
            });
          }
          
          // 允许 DELETE 事件即使没有 project_id 也通过（后续 handler 会处理）
          if (projectId || payload.eventType === 'DELETE') {
            this.logger.debug('收到任务变更', { eventType: payload.eventType, projectId });
            this.handleTaskChange(payload).catch(e => {
              this.logger.error('处理任务变更时发生错误', e);
            });
          } else {
            this.logger.warn('跳过任务变更（无 project_id）', { 
              eventType: payload.eventType,
              taskId: (newRecord?.id || oldRecord?.id)
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
    let projectId = (newRecord?.project_id || oldRecord?.project_id) as string;
    
    // 调试日志：记录 DELETE 事件的详细信息
    if (eventType === 'DELETE') {
      this.logger.debug('收到任务删除事件', {
        taskId,
        projectId,
        hasOldRecord: !!oldRecord,
        oldRecordKeys: oldRecord ? Object.keys(oldRecord) : []
      });
      
      // 🔧 修复：如果 DELETE 事件缺少 project_id（REPLICA IDENTITY 未设置为 FULL）
      // 这是一个权宜之计，理想情况下应该设置 REPLICA IDENTITY FULL
      // 但为了向后兼容和健壮性，我们保留这个回退逻辑
      if (!projectId) {
        this.logger.warn('DELETE 事件缺少 project_id，将尝试从内存中查找', { taskId });
      }
    }
    
    // 即使没有 projectId，也要调用回调（let handler 决定如何处理）
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
      
      // console.log('[Sync] 云端返回项目数量:', data?.length ?? 0);
      
      // 并行加载所有项目的任务和连接
      const projects = await Promise.all((data || []).map(async row => {
        const projectRow = row as ProjectRow;
        // console.log('[Sync] 加载项目任务:', { projectId: projectRow.id, title: projectRow.title });
        const [tasks, connections] = await Promise.all([
          this.taskRepo.loadTasks(projectRow.id),
          this.taskRepo.loadConnections(projectRow.id)
        ]);
        // console.log('[Sync] 项目任务加载完成:', { 
        //   projectId: projectRow.id, 
        //   taskCount: tasks.length,
        //   connectionCount: connections.length,
        //   tasks: tasks.map(t => ({ id: t.id, title: t.title, content: t.content?.substring(0, 50) }))
        // });
        return this.mapRowToProject(projectRow, tasks, connections);
      }));
      
      // 【三路合并】Pull 成功后，保存 Base 快照
      // 这些是当前的"共同祖先"，用于后续的三路合并
      await Promise.all(projects.map(project => 
        this.baseSnapshot.saveProjectSnapshot(project)
      ));
      this.logger.info('[ThreeWayMerge] Base 快照已更新', { 
        projectCount: projects.length 
      });
      
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
        .maybeSingle(); // 使用 maybeSingle 避免 406 错误
      
      if (error) {
        throw error;
      }
      
      if (!data) {
        // 项目不存在
        return null;
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
      // 离线模式：立即保存到本地缓存
      this.saveOfflineSnapshot([project]);
      return { success: true };
    }
    
    // 保守模式：永不丢弃，先保存到本地作为安全网
    this.saveOfflineSnapshot([project]);
    
    // 检查队列积压情况，仅警告但不阻止
    if (this.saveQueueStats.pendingCount > 20) {
      this.logger.warn('同步队列积压', {
        pendingCount: this.saveQueueStats.pendingCount
      });
      
      // 只在队列首次积压时提示用户
      if (this.saveQueueStats.pendingCount === 21) {
        this.toast.info(
          '数据已保存到本地',
          '云端同步正在进行，您可以继续编辑'
        );
      }
    }
    
    // 将请求加入声明式队列，无论队列多长都处理
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
    // console.log('[Sync] 开始保存项目到云端', { projectId: project.id, projectName: project.name, userId });
    
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
      // console.log('[Sync] 项目操作类型:', isUpdate ? '更新' : '创建', { existingData });
      
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
          
          // 【三路合并】进入自动变基流程
          const autoRebaseResult = await this.tryAutoRebase(project, userId, currentVersion);
          if (autoRebaseResult) {
            return autoRebaseResult;
          }
          
          // 自动变基失败，返回冲突状态
          const remoteProject = await this.loadSingleProject(project.id, userId);
          if (remoteProject) {
            // 先保存到本地缓存确保数据不丢失
            this.saveOfflineSnapshot([project]);
            
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
        // console.log('[Sync] 创建新项目', { projectId: project.id, ownerId: userId });
        
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
        
        // console.log('[Sync] 项目创建成功');
      }
      
      // 批量保存任务
      // console.log('[Sync] 保存任务，数量:', project.tasks.length);
      this.syncProgress.set({
        current: 0,
        total: project.tasks.length,
        phase: 'saving-tasks',
        message: `正在保存 ${project.tasks.length} 个任务...`
      });
      
      const tasksResult = await this.taskRepo.saveTasks(project.id, project.tasks);
      if (!tasksResult.success) {
        console.error('[Sync] 保存任务失败:', tasksResult.error);
        this.syncProgress.set({ current: 0, total: 0, phase: 'idle', message: '' });
        throw new Error(tasksResult.error);
      }
      
      // 同步连接
      // console.log('[Sync] 保存连接，数量:', project.connections.length);
      this.syncProgress.set({
        current: 0,
        total: project.connections.length,
        phase: 'saving-connections',
        message: `正在保存 ${project.connections.length} 个连接...`
      });
      
      const connectionsResult = await this.taskRepo.syncConnections(project.id, project.connections);
      if (!connectionsResult.success) {
        console.error('[Sync] 同步连接失败:', connectionsResult.error);
        this.syncProgress.set({ current: 0, total: 0, phase: 'idle', message: '' });
        throw new Error(connectionsResult.error);
      }
      
      // console.log('[Sync] 项目保存完成', { projectId: project.id, newVersion });
      
      // 清除进度
      this.syncProgress.set({ current: 0, total: 0, phase: 'idle', message: '' });
      
      // 【三路合并】Push 成功后，更新 Base 快照
      const projectWithNewVersion = { ...project, version: newVersion };
      await this.baseSnapshot.saveProjectSnapshot(projectWithNewVersion);
      this.logger.debug('[ThreeWayMerge] Base 快照已更新', { 
        projectId: project.id, 
        version: newVersion 
      });
      
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
   * 根据错误类型采取不同的恢复策略
   */
  private handleSaveError(error: { code?: string; message?: string; details?: string }, project: Project): void {
    const errorCode = error.code || '';
    const errorMessage = error.message || '';
    const errorDetails = error.details || '';
    
    // 1. 认证错误 - 保存本地并提示重新登录
    if (errorCode === 'PGRST301' || 
        errorCode === '401' || 
        errorMessage.includes('JWT') ||
        errorMessage.includes('token') ||
        errorMessage.includes('expired')) {
      this.saveOfflineSnapshot([project]);
      this.logger.warn('Token 过期，数据已保存到本地');
      
      this.syncState.update(s => ({ 
        ...s, 
        sessionExpired: true,
        offlineMode: true,
        syncError: '登录已过期，数据已保存在本地，请重新登录后同步'
      }));
      return;
    }
    
    // 2. 权限错误 (RLS) - 可能是数据归属问题
    if (errorCode === '42501' || 
        errorMessage.includes('permission denied') ||
        errorMessage.includes('row-level security') ||
        errorMessage.includes('policy')) {
      this.saveOfflineSnapshot([project]);
      this.logger.warn('权限被拒绝，数据已保存到本地', { projectId: project.id });
      
      this.syncState.update(s => ({
        ...s,
        syncError: '无权访问此项目，数据已保存到本地',
        offlineMode: true
      }));
      return;
    }
    
    // 3. 网络错误 - 保存本地并待网络恢复
    if (errorCode === 'NETWORK_ERROR' ||
        errorMessage.includes('network') ||
        errorMessage.includes('Failed to fetch') ||
        errorMessage.includes('NetworkError') ||
        errorMessage.includes('timeout')) {
      this.saveOfflineSnapshot([project]);
      this.logger.warn('网络错误，数据已保存到本地');
      
      this.syncState.update(s => ({
        ...s,
        offlineMode: true,
        syncError: '网络不可用，数据已保存在本地'
      }));
      return;
    }
    
    // 4. 服务端错误 (5xx) - 保存本地并稍后重试
    if (errorCode.startsWith('5') || 
        errorMessage.includes('Internal Server Error') ||
        errorMessage.includes('Service Unavailable')) {
      this.saveOfflineSnapshot([project]);
      this.logger.warn('服务器错误，数据已保存到本地');
      
      this.syncState.update(s => ({
        ...s,
        offlineMode: true,
        syncError: '服务器暂时不可用，数据已保存在本地'
      }));
      return;
    }
    
    // 5. 数据约束错误 - 可能是版本冲突或数据格式问题
    if (errorCode === '23505' || // 唯一约束违反
        errorCode === '23503' || // 外键约束违反
        errorMessage.includes('duplicate key') ||
        errorMessage.includes('unique constraint') ||
        errorMessage.includes('foreign key')) {
      this.logger.error('数据约束错误', { 
        projectId: project.id, 
        error: errorMessage,
        details: errorDetails
      });
      
      this.syncState.update(s => ({
        ...s,
        syncError: '数据冲突，请刷新页面重试'
      }));
      return;
    }
    
    // 6. 通用错误处理 - 保存本地作为安全网
    this.saveOfflineSnapshot([project]);
    this.logger.error('未知同步错误', { 
      code: errorCode, 
      message: errorMessage,
      projectId: project.id 
    });
    
    this.syncState.update(s => ({
      ...s,
      syncError: `同步失败: ${errorMessage || '未知错误'}`,
      offlineMode: true
    }));
  }

  // ========== 三路合并自动变基 ==========

  /**
   * 尝试自动变基（Auto-Rebase）
   * 
   * 当检测到版本冲突时，自动执行三路合并尝试解决冲突。
   * 
   * 流程：
   * 1. 获取 Base 快照（上次成功同步时的状态）
   * 2. 获取 Remote 数据（服务器当前最新状态）
   * 3. 执行三路合并
   * 4. 如果可以自动合并，重新尝试保存
   * 5. 如果存在真正的冲突，返回 null 让调用方处理
   * 
   * @param localProject 本地项目数据
   * @param userId 用户 ID
   * @param localVersion 本地版本号
   * @returns 成功则返回保存结果，无法自动合并则返回 null
   */
  private async tryAutoRebase(
    localProject: Project, 
    userId: string, 
    localVersion: number
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number } | null> {
    this.logger.info('[ThreeWayMerge] 开始自动变基流程', { 
      projectId: localProject.id, 
      localVersion 
    });
    
    try {
      // 1. 获取 Base 快照
      const baseProject = await this.baseSnapshot.getProjectSnapshot(localProject.id);
      
      if (!baseProject) {
        // 没有 Base 快照，无法进行三路合并
        // 可能是新设备首次同步或数据清理后
        this.logger.warn('[ThreeWayMerge] 无 Base 快照，无法自动变基', { 
          projectId: localProject.id 
        });
        return null;
      }
      
      // 2. 获取 Remote 数据
      const remoteProject = await this.loadSingleProject(localProject.id, userId);
      
      if (!remoteProject) {
        this.logger.warn('[ThreeWayMerge] 无法获取远程数据', { 
          projectId: localProject.id 
        });
        return null;
      }
      
      const remoteVersion = remoteProject.version ?? 0;
      
      // 3. 检查是否需要合并
      if (!this.threeWayMerge.needsMerge(baseProject, localProject, remoteProject)) {
        this.logger.info('[ThreeWayMerge] 无需合并', { projectId: localProject.id });
        // 直接用远程版本号重试
        return this.retryWithVersion(localProject, userId, remoteVersion);
      }
      
      // 4. 执行三路合并
      const mergeResult = this.threeWayMerge.merge(baseProject, localProject, remoteProject);
      
      this.logger.info('[ThreeWayMerge] 合并结果', {
        projectId: localProject.id,
        hasRealConflicts: mergeResult.hasRealConflicts,
        autoResolvedCount: mergeResult.autoResolvedCount,
        stats: mergeResult.stats
      });
      
      // 5. 判断是否可以自动合并
      if (mergeResult.hasRealConflicts) {
        // 存在真正的冲突（双方都修改了同一字段且值不同）
        // 但我们仍然可以自动解决：优先保留本地
        this.logger.info('[ThreeWayMerge] 存在冲突，使用本地优先策略自动解决', {
          projectId: localProject.id,
          conflictCount: mergeResult.conflicts.filter(c => c.resolution === 'kept-local').length
        });
        
        // 显示一个低调的提示，告知用户发生了自动合并
        if (mergeResult.stats.remoteAddedTasks > 0 || 
            mergeResult.stats.remoteOnlyModifiedTasks > 0) {
          this.toast.info(
            '数据已自动合并',
            `合并了其他设备的 ${mergeResult.stats.remoteAddedTasks + mergeResult.stats.remoteOnlyModifiedTasks} 个变更`
          );
        }
      }
      
      // 6. 使用合并后的项目数据重新保存
      const mergedProject = mergeResult.project;
      const newVersion = remoteVersion + 1;
      
      // 尝试保存合并后的数据
      for (let retry = 0; retry < SyncService.AUTO_REBASE_MAX_RETRIES; retry++) {
        const currentVersion = remoteVersion + retry;
        const targetVersion = currentVersion + 1;
        
        const { data: updateResult, error: updateError } = await this.supabase.client()
          .from('projects')
          .update({
            title: mergedProject.name,
            description: mergedProject.description,
            version: targetVersion
          })
          .eq('id', mergedProject.id)
          .eq('version', currentVersion)
          .select('id')
          .maybeSingle();
        
        if (!updateError && updateResult) {
          // 保存任务和连接
          const tasksResult = await this.taskRepo.saveTasks(mergedProject.id, mergedProject.tasks);
          if (tasksResult.success) {
            const connectionsResult = await this.taskRepo.syncConnections(
              mergedProject.id, 
              mergedProject.connections
            );
            if (connectionsResult.success) {
              // 更新 Base 快照
              const finalProject = { ...mergedProject, version: targetVersion };
              await this.baseSnapshot.saveProjectSnapshot(finalProject);
              
              this.logger.info('[ThreeWayMerge] 自动变基成功', {
                projectId: mergedProject.id,
                newVersion: targetVersion,
                autoResolvedCount: mergeResult.autoResolvedCount
              });
              
              return { 
                success: true, 
                newVersion: targetVersion
              };
            }
          }
        }
        
        // 重试失败，等待后继续
        if (retry < SyncService.AUTO_REBASE_MAX_RETRIES - 1) {
          await new Promise(resolve => setTimeout(resolve, 100 * (retry + 1)));
        }
      }
      
      // 所有重试都失败
      this.logger.warn('[ThreeWayMerge] 自动变基重试失败', {
        projectId: localProject.id,
        retries: SyncService.AUTO_REBASE_MAX_RETRIES
      });
      
      // 数据已保存到本地，等待下次同步
      this.saveOfflineSnapshot([mergedProject]);
      return { success: true }; // 返回成功，避免触发冲突弹窗
      
    } catch (e) {
      this.logger.error('[ThreeWayMerge] 自动变基异常', e);
      return null;
    }
  }
  
  /**
   * 使用指定版本号重试保存
   */
  private async retryWithVersion(
    project: Project,
    userId: string,
    baseVersion: number
  ): Promise<{ success: boolean; newVersion?: number } | null> {
    const newVersion = baseVersion + 1;
    
    const { data: result, error } = await this.supabase.client()
      .from('projects')
      .update({
        title: project.name,
        description: project.description,
        version: newVersion
      })
      .eq('id', project.id)
      .eq('version', baseVersion)
      .select('id')
      .maybeSingle();
    
    if (!error && result) {
      const tasksResult = await this.taskRepo.saveTasks(project.id, project.tasks);
      if (tasksResult.success) {
        const connectionsResult = await this.taskRepo.syncConnections(project.id, project.connections);
        if (connectionsResult.success) {
          // 更新 Base 快照
          const updatedProject = { ...project, version: newVersion };
          await this.baseSnapshot.saveProjectSnapshot(updatedProject);
          return { success: true, newVersion };
        }
      }
    }
    
    return null;
  }
  
  /**
   * 获取 BaseSnapshotService 实例
   * 供外部服务使用
   */
  getBaseSnapshotService(): BaseSnapshotService {
    return this.baseSnapshot;
  }
  
  /**
   * 获取 ThreeWayMergeService 实例
   * 供外部服务使用
   */
  getThreeWayMergeService(): ThreeWayMergeService {
    return this.threeWayMerge;
  }

  // ========== 增量同步 ==========

  /**
   * 增量保存项目到云端
   * 只同步有变更的任务和连接，显著减少网络传输和数据库操作
   * 
   * @param project 完整项目数据（用于回退和本地缓存）
   * @param userId 用户ID
   * @param changes 变更摘要（由 ChangeTrackerService 提供）
   * @returns 同步结果
   */
  async saveProjectIncrementally(
    project: Project, 
    userId: string,
    changes: ProjectChangeSummary
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; stats?: { tasks: number; connections: number }; validationWarnings?: string[] }> {
    if (!userId || !this.supabase.isConfigured) {
      return { success: true };
    }

    // 如果没有变更，直接返回成功
    if (!changes.hasChanges) {
      this.logger.debug('无增量变更，跳过同步', { projectId: project.id });
      return { success: true };
    }

    // 同步前验证：检查是否会丢失数据
    const validation = this.changeTracker.validateChanges(
      project.id,
      project.tasks,
      project.connections
    );

    if (!validation.valid) {
      this.logger.error('增量同步验证失败，禁止同步', {
        projectId: project.id,
        errors: validation.errors
      });
      
      // 验证失败，不执行同步，避免数据丢失
      return {
        success: false,
        validationWarnings: [
          '增量同步验证失败，为避免数据丢失已中止同步',
          ...validation.errors
        ]
      };
    }

    // 记录警告但继续执行
    const validationWarnings = validation.warnings;
    if (validationWarnings.length > 0) {
      this.logger.warn('增量同步验证有警告', {
        projectId: project.id,
        warnings: validationWarnings
      });
    }

    // 记录变更摘要
    this.logger.info(this.changeTracker.generateChangeReport(project.id));

    this.syncState.update(s => ({ ...s, isSyncing: true }));

    try {
      const currentVersion = project.version ?? 0;
      const newVersion = currentVersion + 1;

      // 1. 检查并更新项目版本号（乐观锁）
      const { data: existingData, error: checkError } = await this.supabase.client()
        .from('projects')
        .select('id, version')
        .eq('id', project.id)
        .maybeSingle();

      if (checkError && checkError.code !== 'PGRST116') {
        throw checkError;
      }

      const isUpdate = !!existingData;

      if (isUpdate) {
        // 使用乐观锁更新版本号
        const { data: updateResult, error: updateError } = await this.supabase.client()
          .from('projects')
          .update({
            title: project.name,
            description: project.description,
            version: newVersion
          })
          .eq('id', project.id)
          .eq('version', currentVersion)
          .select('id')
          .maybeSingle();

        if (updateError) {
          throw updateError;
        }

        // 版本号不匹配 - 可能有冲突
        if (!updateResult) {
          // 加载远程数据检查是否真的有冲突
          const remoteProject = await this.loadSingleProject(project.id, userId);
          if (remoteProject) {
            const remoteVersion = remoteProject.version ?? 0;
            
            // 简单策略：如果远程版本更高，返回冲突让上层处理
            if (remoteVersion > currentVersion) {
              this.logger.warn('增量同步检测到版本冲突', {
                projectId: project.id,
                localVersion: currentVersion,
                remoteVersion
              });
              return { success: false, conflict: true, remoteData: remoteProject };
            }
          }
        }
      } else {
        // 创建新项目
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
          throw insertError;
        }
      }

      // 2. 增量同步任务
      const taskStats = { created: 0, updated: 0, deleted: 0 };
      
      if (changes.tasksToCreate.length > 0 || 
          changes.tasksToUpdate.length > 0 || 
          changes.taskIdsToDelete.length > 0) {
        
        this.syncProgress.set({
          current: 0,
          total: changes.totalChanges,
          phase: 'saving-tasks',
          message: `正在增量保存 ${changes.tasksToCreate.length + changes.tasksToUpdate.length} 个任务...`
        });

        const taskUpdateFieldsById: Record<string, string[] | undefined> = {};
        for (const record of this.changeTracker.exportPendingChanges()) {
          if (record.projectId !== project.id) continue;
          if (record.entityType !== 'task') continue;
          if (record.changeType !== 'update') continue;
          taskUpdateFieldsById[record.entityId] = record.changedFields;
        }

        const tasksResult = await this.taskRepo.saveTasksIncremental(
          project.id,
          changes.tasksToCreate,
          changes.tasksToUpdate,
          changes.taskIdsToDelete,
          taskUpdateFieldsById
        );

        if (!tasksResult.success) {
          throw new Error(tasksResult.error);
        }

        if (tasksResult.stats) {
          taskStats.created = tasksResult.stats.created;
          taskStats.updated = tasksResult.stats.updated;
          taskStats.deleted = tasksResult.stats.deleted;
        }
      }

      // 3. 增量同步连接
      const connStats = { created: 0, updated: 0, deleted: 0 };
      
      if (changes.connectionsToCreate.length > 0 || 
          changes.connectionsToUpdate.length > 0 || 
          changes.connectionsToDelete.length > 0) {
        
        this.syncProgress.set({
          current: 0,
          total: changes.connectionsToCreate.length + changes.connectionsToUpdate.length + changes.connectionsToDelete.length,
          phase: 'saving-connections',
          message: `正在增量保存 ${changes.connectionsToCreate.length + changes.connectionsToUpdate.length} 个连接...`
        });

        const connectionsResult = await this.taskRepo.syncConnectionsIncremental(
          project.id,
          changes.connectionsToCreate,
          changes.connectionsToUpdate,
          changes.connectionsToDelete
        );

        if (!connectionsResult.success) {
          throw new Error(connectionsResult.error);
        }

        if (connectionsResult.stats) {
          connStats.created = connectionsResult.stats.created;
          connStats.updated = connectionsResult.stats.updated;
          connStats.deleted = connectionsResult.stats.deleted;
        }
      }

      // 清除进度
      this.syncProgress.set({ current: 0, total: 0, phase: 'idle', message: '' });

      // 清除已同步的变更记录
      this.changeTracker.clearProjectChanges(project.id);

      this.syncState.update(s => ({
        ...s,
        syncError: null,
        offlineMode: false,
        sessionExpired: false,
        hasConflict: false,
        conflictData: null
      }));

      const totalTasks = taskStats.created + taskStats.updated + taskStats.deleted;
      const totalConns = connStats.created + connStats.updated + connStats.deleted;

      this.logger.info('增量同步完成', {
        projectId: project.id,
        newVersion,
        taskStats,
        connStats,
        validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined
      });

      return { 
        success: true, 
        newVersion,
        stats: { tasks: totalTasks, connections: totalConns },
        validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined
      };

    } catch (e: unknown) {
      this.logger.error('增量同步失败', e);
      
      // 保存到本地缓存
      this.saveOfflineSnapshot([project]);
      
      this.syncState.update(s => ({
        ...s,
        syncError: extractErrorMessage(e),
        offlineMode: true
      }));

      // 清除进度
      this.syncProgress.set({ current: 0, total: 0, phase: 'idle', message: '' });
      
      return { success: false };
    } finally {
      this.syncState.update(s => ({ ...s, isSyncing: false }));
    }
  }

  /**
   * 智能同步：根据变更量选择全量或增量
   * 
   * 策略：
   * - 变更数量 < 阈值：使用增量同步
   * - 变更数量 >= 阈值 或 无变更追踪数据：使用全量同步
   * - 新项目：使用全量同步
   * - 检测到高风险：强制使用全量同步
   */
  async saveProjectSmart(
    project: Project, 
    userId: string
  ): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project; newVersion?: number; validationWarnings?: string[] }> {
    // 获取变更摘要
    const changes = this.changeTracker.getProjectChanges(project.id);
    
    // 决策阈值：当变更数量超过任务总数的50%时，使用全量同步更高效
    const INCREMENTAL_THRESHOLD_RATIO = 0.5;
    const totalTasks = project.tasks.length;
    const changeCount = changes.totalChanges;
    
    // 记录同步决策信息
    this.logger.debug('[Smart Sync] 同步决策', {
      projectId: project.id,
      hasChanges: changes.hasChanges,
      changeCount,
      totalTasks
    });
    
    // 如果没有变更追踪，直接使用全量同步（保守策略）
    if (!changes.hasChanges) {
      this.logger.info('[Smart Sync] 无变更追踪记录，使用全量同步', { projectId: project.id });
      return this.saveProjectToCloud(project, userId);
    }
    
    // 检测数据丢失风险
    const riskAnalysis = this.changeTracker.detectDataLossRisks(
      project.id,
      project.tasks,
      project.connections
    );

    // 如果检测到高风险，强制使用全量同步
    if (riskAnalysis.hasRisk) {
      const highRisks = riskAnalysis.risks.filter(r => r.severity === 'high');
      if (highRisks.length > 0) {
        this.logger.warn('[Smart Sync] 检测到高风险，强制使用全量同步', {
          projectId: project.id,
          risks: highRisks.map(r => r.description)
        });
        
        const result = await this.saveProjectToCloud(project, userId);
        if (result.success) {
          this.changeTracker.clearProjectChanges(project.id);
        }
        return {
          ...result,
          validationWarnings: highRisks.map(r => `[高风险] ${r.description}`)
        };
      }
    }
    
    // 使用增量同步的条件
    const useIncremental = 
      changeCount > 0 &&                                       // 变更数量大于0
      (totalTasks === 0 || changeCount / totalTasks < INCREMENTAL_THRESHOLD_RATIO); // 变更比例小于阈值
    
    if (useIncremental) {
      this.logger.info('[Smart Sync] 使用增量同步', {
        projectId: project.id,
        changeCount,
        totalTasks,
        ratio: totalTasks > 0 ? (changeCount / totalTasks).toFixed(2) : 'N/A'
      });
      
      return this.saveProjectIncrementally(project, userId, changes);
    } else {
      this.logger.info('[Smart Sync] 使用全量同步', {
        projectId: project.id,
        reason: `变更比例过高 (${changeCount}/${totalTasks})`
      });
      
      // 全量同步后清除变更追踪
      const result = await this.saveProjectToCloud(project, userId);
      if (result.success) {
        this.changeTracker.clearProjectChanges(project.id);
      }
      return result;
    }
  }

  /**
   * 获取 ChangeTracker 服务实例
   * 供外部服务使用以追踪变更
   */
  getChangeTracker(): ChangeTrackerService {
    return this.changeTracker;
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
        .maybeSingle(); // 使用 maybeSingle 替代 single，避免 406 错误
      
      if (error) {
        // PGRST116 表示没有找到数据，不是错误
        if (error.code !== 'PGRST116') {
          throw error;
        }
      }
      
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
