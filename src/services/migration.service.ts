import { Injectable, inject, signal } from '@angular/core';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';
import { CACHE_CONFIG } from '../config';
import * as Sentry from '@sentry/angular';

/**
 * 迁移快照配置
 * 【Week 2】sessionStorage 5MB 限制处理
 */
const MIGRATION_SNAPSHOT_CONFIG = {
  /** sessionStorage 最大大小（字节）- 预留 1MB 给其他用途 */
  MAX_SESSION_STORAGE_SIZE: 4 * 1024 * 1024,
  /** 主 sessionStorage key */
  PRIMARY_KEY: 'nanoflow.migration-snapshot',
  /** 备份 localStorage key */
  FALLBACK_KEY: 'nanoflow.migration-snapshot-fallback',
  /** 迁移状态 key */
  STATUS_KEY: 'nanoflow.migration-status',
} as const;

/**
 * 【v5.9】迁移状态枚举
 * 用于跟踪迁移过程中的各个阶段，确保原子性
 */
export type MigrationStatus = 
  | 'idle'           // 空闲状态
  | 'preparing'      // 准备中（创建快照）
  | 'validating'     // 验证本地数据
  | 'uploading'      // 上传中
  | 'verifying'      // 验证远程数据
  | 'cleaning'       // 清理本地数据
  | 'completed'      // 完成
  | 'failed'         // 失败
  | 'rollback';      // 回滚中

/**
 * 【v5.9】迁移状态记录
 */
export interface MigrationStatusRecord {
  status: MigrationStatus;
  startedAt: string;
  lastUpdatedAt: string;
  phase: number;        // 当前阶段 (1-5)
  totalPhases: number;  // 总阶段数
  projectsTotal: number;
  projectsCompleted: number;
  projectsFailed: string[];
  error?: string;
}

/**
 * 【v5.9】数据完整性检查结果
 */
export interface IntegrityCheckResult {
  valid: boolean;
  issues: IntegrityIssue[];
  projectCount: number;
  taskCount: number;
  connectionCount: number;
}

export interface IntegrityIssue {
  type: 'missing-id' | 'orphan-task' | 'broken-connection' | 'invalid-field' | 'duplicate-id';
  entityType: 'project' | 'task' | 'connection';
  entityId?: string;
  message: string;
  severity: 'warning' | 'error';
}

/**
 * 本地数据迁移策略
 */
export type MigrationStrategy = 'keep-local' | 'keep-remote' | 'merge' | 'discard-local';

/**
 * 迁移结果
 */
export interface MigrationResult {
  success: boolean;
  migratedProjects: number;
  strategy: MigrationStrategy;
  error?: string;
}

/**
 * 本地数据迁移服务
 * 
 * 处理用户从"访客模式"转换为"已登录状态"时的数据迁移：
 * - 检测本地是否有未同步的项目数据
 * - 提供多种迁移策略供用户选择
 * - 执行数据迁移或合并
 */
@Injectable({
  providedIn: 'root'
})
export class MigrationService {
  private syncService = inject(SimpleSyncService);
  private toast = inject(ToastService);
  private loggerService = inject(LoggerService);
  private logger = this.loggerService.category('Migration');
  
  /** 是否需要迁移（有本地数据且用户刚登录） */
  readonly needsMigration = signal(false);
  
  /** 本地项目数据（待迁移） */
  readonly localProjects = signal<Project[]>([]);
  
  /** 远程项目数据（用于比较） */
  readonly remoteProjects = signal<Project[]>([]);
  
  /** 迁移对话框是否显示 */
  readonly showMigrationDialog = signal(false);
  
  private readonly GUEST_DATA_KEY = 'nanoflow.guest-data';
  private readonly DATA_VERSION = 2; // 数据结构版本号
  private readonly GUEST_DATA_EXPIRY_DAYS = 30; // 访客数据过期天数
  
  /**
   * 检查是否需要数据迁移
   * 在用户登录时调用
   */
  checkMigrationNeeded(remoteProjects: Project[]): boolean {
    const localData = this.getLocalGuestData();
    
    if (!localData || localData.length === 0) {
      this.needsMigration.set(false);
      return false;
    }
    
    // 有本地数据，检查是否与远程数据不同
    const hasLocalOnlyProjects = localData.some(local => 
      !remoteProjects.some(remote => remote.id === local.id)
    );
    
    // 检查是否有本地修改但远程存在的项目（可能需要合并）
    const hasPendingChanges = localData.some(local => {
      const remote = remoteProjects.find(r => r.id === local.id);
      if (!remote) return false;
      // 简单的版本比较
      return (local.version ?? 0) > (remote.version ?? 0);
    });
    
    if (hasLocalOnlyProjects || hasPendingChanges) {
      this.needsMigration.set(true);
      this.localProjects.set(localData);
      this.remoteProjects.set(remoteProjects);
      return true;
    }
    
    this.needsMigration.set(false);
    return false;
  }
  
  /**
   * 显示迁移选择对话框
   */
  showMigrationOptions() {
    if (this.needsMigration()) {
      this.showMigrationDialog.set(true);
    }
  }
  
  /**
   * 执行数据迁移
   * 
   * 【Week 2 安全增强】迁移前创建快照
   * - 优先使用 sessionStorage（会话结束自动清理）
   * - 超过 5MB 限制时降级到 localStorage
   * - 提供恢复能力
   * - 【v5.9】加入数据完整性检查和状态跟踪
   */
  async executeMigration(
    strategy: MigrationStrategy, 
    userId: string
  ): Promise<MigrationResult> {
    const localData = this.localProjects();
    const remoteData = this.remoteProjects();
    
    if (!localData || localData.length === 0) {
      return { success: true, migratedProjects: 0, strategy };
    }
    
    // 【v5.9】初始化迁移状态
    this.updateMigrationStatus('preparing', {
      projectsTotal: localData.length,
      projectsCompleted: 0,
      projectsFailed: []
    });
    
    // 【v5.9】迁移前数据完整性检查
    this.updateMigrationStatus('validating');
    const integrityCheck = this.validateDataIntegrity(localData);
    if (!integrityCheck.valid) {
      const errorIssues = integrityCheck.issues.filter(i => i.severity === 'error');
      this.updateMigrationStatus('failed', {
        error: `数据完整性检查失败: ${errorIssues.length} 个严重问题`
      });
      this.toast.error('数据完整性检查失败', `发现 ${errorIssues.length} 个严重问题，请检查数据后重试`);
      return {
        success: false,
        migratedProjects: 0,
        strategy,
        error: `数据完整性检查失败: ${errorIssues.map(i => i.message).join('; ')}`
      };
    }
    
    // 警告级别问题：记录但继续
    const warningIssues = integrityCheck.issues.filter(i => i.severity === 'warning');
    if (warningIssues.length > 0) {
      this.logger.warn('数据完整性检查发现警告', { warnings: warningIssues.length });
    }
    
    // 【Week 2】迁移前保存快照
    const snapshotSaved = this.saveMigrationSnapshot(localData);
    if (!snapshotSaved) {
      // 快照保存失败，提示用户但允许继续（非阻塞性警告）
      this.toast.warning('无法保存迁移快照', '建议先手动导出数据再继续');
    }
    
    try {
      let result: MigrationResult;
      
      switch (strategy) {
        case 'keep-local':
          // 将本地数据上传到云端，覆盖远程
          this.updateMigrationStatus('uploading');
          result = await this.migrateLocalToCloud(localData, userId);
          break;
          
        case 'keep-remote':
          // 丢弃本地数据，使用远程
          this.updateMigrationStatus('cleaning');
          this.clearLocalGuestData();
          this.updateMigrationStatus('completed');
          result = { success: true, migratedProjects: 0, strategy };
          break;
          
        case 'merge':
          // 智能合并本地和远程数据
          result = await this.mergeLocalAndRemote(localData, remoteData, userId);
          break;
          
        case 'discard-local':
          // 彻底丢弃本地数据
          this.updateMigrationStatus('cleaning');
          this.clearLocalGuestData();
          this.syncService.clearOfflineCache();
          this.updateMigrationStatus('completed');
          result = { success: true, migratedProjects: 0, strategy };
          break;
          
        default:
          this.updateMigrationStatus('failed', { error: '未知的迁移策略' });
          result = { success: false, migratedProjects: 0, strategy, error: '未知的迁移策略' };
      }
      
      // 【v5.9】迁移成功后验证
      if (result.success && (strategy === 'keep-local' || strategy === 'merge')) {
        const verification = await this.verifyMigrationSuccess(localData, userId);
        if (!verification.success) {
          this.logger.error('迁移验证失败，但数据已上传', { missingItems: verification.missingItems });
          // 不回滚，但记录警告
          this.toast.warning('部分数据可能未完全同步', '请检查您的项目列表');
        }
      }
      
      // 迁移成功后清理快照和状态
      if (result.success) {
        this.clearMigrationSnapshot();
        this.clearMigrationStatus();
      }
      
      return result;
    } catch (e: unknown) {
      const err = e as { message?: string };
      this.updateMigrationStatus('failed', { error: err?.message ?? String(e) });
      Sentry.captureException(e, { 
        tags: { operation: 'executeMigration', strategy },
        extra: { projectCount: localData.length }
      });
      return {
        success: false,
        migratedProjects: 0,
        strategy,
        error: err?.message ?? String(e)
      };
    } finally {
      // 清理迁移状态，释放大型数据对象防止内存泄漏
      this.needsMigration.set(false);
      this.showMigrationDialog.set(false);
      this.localProjects.set([]);
      this.remoteProjects.set([]);
    }
  }
  
  /**
   * 【Week 2】保存迁移快照
   * 
   * 策略：
   * 1. 先尝试 sessionStorage（会话自动清理）
   * 2. 如果超过 5MB 限制，降级到 localStorage
   * 3. 如果 localStorage 也失败，提示用户手动导出
   * 
   * @returns true 如果成功保存，false 如果失败
   */
  private saveMigrationSnapshot(projects: Project[]): boolean {
    if (typeof sessionStorage === 'undefined') return false;
    
    const snapshotData = JSON.stringify({
      projects,
      savedAt: new Date().toISOString(),
      version: this.DATA_VERSION
    });
    
    const dataSize = new Blob([snapshotData]).size;
    
    try {
      // 先尝试 sessionStorage
      if (dataSize <= MIGRATION_SNAPSHOT_CONFIG.MAX_SESSION_STORAGE_SIZE) {
        sessionStorage.setItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY, snapshotData);
        console.log(`[Migration] 快照已保存到 sessionStorage (${(dataSize / 1024).toFixed(2)} KB)`);
        return true;
      }
      
      // 超过限制，尝试 localStorage（并提示用户）
      this.toast.info(
        '数据量较大', 
        `数据大小 ${(dataSize / 1024 / 1024).toFixed(2)} MB，已使用持久化存储保存快照`
      );
      
      localStorage.setItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY, snapshotData);
      console.log(`[Migration] 快照已保存到 localStorage (${(dataSize / 1024 / 1024).toFixed(2)} MB)`);
      return true;
    } catch (e) {
      // 存储失败（可能是配额用尽）
      console.error('[Migration] 保存快照失败:', e);
      
      // 尝试提供文件下载作为最后手段
      this.offerSnapshotDownload(projects);
      return false;
    }
  }
  
  /**
   * 【Week 2】提供快照文件下载
   * 当 sessionStorage 和 localStorage 都失败时的降级方案
   */
  private offerSnapshotDownload(projects: Project[]): void {
    try {
      const snapshotData = JSON.stringify({
        projects,
        savedAt: new Date().toISOString(),
        version: this.DATA_VERSION,
        type: 'migration-snapshot'
      }, null, 2);
      
      const blob = new Blob([snapshotData], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `nanoflow-migration-snapshot-${timestamp}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      this.toast.warning(
        '请保存备份文件', 
        '由于存储空间不足，已下载迁移快照文件。如迁移失败，可使用此文件恢复数据。'
      );
    } catch (e) {
      console.error('[Migration] 下载快照失败:', e);
    }
  }
  
  /**
   * 【Week 2】清理迁移快照
   */
  private clearMigrationSnapshot(): void {
    try {
      sessionStorage.removeItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY);
      localStorage.removeItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY);
    } catch (e) {
      console.warn('[Migration] 清理快照失败:', e);
    }
  }
  
  /**
   * 【Week 2】从快照恢复数据（公开方法，供错误恢复使用）
   */
  recoverFromSnapshot(): Project[] | null {
    try {
      // 先检查 sessionStorage
      const sessionData = sessionStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.PRIMARY_KEY);
      if (sessionData) {
        const parsed = JSON.parse(sessionData);
        console.log('[Migration] 从 sessionStorage 恢复快照');
        return parsed.projects || null;
      }
      
      // 再检查 localStorage
      const localData = localStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.FALLBACK_KEY);
      if (localData) {
        const parsed = JSON.parse(localData);
        console.log('[Migration] 从 localStorage 恢复快照');
        return parsed.projects || null;
      }
      
      return null;
    } catch (e) {
      console.error('[Migration] 恢复快照失败:', e);
      return null;
    }
  }
  
  /**
   * 将本地数据迁移到云端
   * 【v5.9】加入状态跟踪
   */
  private async migrateLocalToCloud(
    localProjects: Project[], 
    userId: string
  ): Promise<MigrationResult> {
    let migratedCount = 0;
    const failedProjects: string[] = [];
    
    // 更新迁移状态
    this.updateMigrationStatus('uploading', {
      projectsTotal: localProjects.length,
      projectsCompleted: 0,
      projectsFailed: []
    });
    
    for (const project of localProjects) {
      try {
        // 保存到云端
        const result = await this.syncService.saveProjectToCloud(project, userId);
        if (result.success) {
          migratedCount++;
        } else {
          failedProjects.push(project.name || project.id);
        }
        
        // 更新进度
        this.updateMigrationStatus('uploading', {
          projectsCompleted: migratedCount + failedProjects.length,
          projectsFailed: failedProjects
        });
      } catch (e) {
        this.logger.warn('迁移项目失败:', { projectId: project.id, error: e });
        failedProjects.push(project.name || project.id);
      }
    }
    
    // 【v5.8 迁移原子性修复】仅在全部成功时才清除本地数据
    // 部分失败时保留本地数据，允许用户重试
    if (failedProjects.length === 0) {
      this.updateMigrationStatus('cleaning');
      this.clearLocalGuestData();
      this.updateMigrationStatus('completed');
    } else {
      // 部分失败：保留快照，不清除本地数据
      this.updateMigrationStatus('failed', {
        projectsFailed: failedProjects,
        error: `${failedProjects.length} 个项目迁移失败`
      });
      this.logger.warn('迁移部分失败，保留本地数据供重试', {
        migratedCount,
        failedCount: failedProjects.length,
        failedProjects
      });
      Sentry.captureMessage('数据迁移部分失败', {
        level: 'warning',
        tags: { operation: 'migrateLocalToCloud' },
        extra: { migratedCount, failedProjects }
      });
    }
    
    if (failedProjects.length > 0) {
      this.toast.warning('部分项目迁移失败', `以下项目未能上传: ${failedProjects.join(', ')}。本地数据已保留，您可以稍后重试。`);
    }
    
    if (migratedCount > 0) {
      this.toast.success('数据迁移完成', `已将 ${migratedCount} 个项目上传到云端`);
    }
    
    return {
      // 仅当没有失败时才返回成功
      success: failedProjects.length === 0,
      migratedProjects: migratedCount,
      strategy: 'keep-local',
      error: failedProjects.length > 0 ? `${failedProjects.length} 个项目迁移失败，本地数据已保留` : undefined
    };
  }
  
  /**
   * 智能合并本地和远程数据
   * 【v5.9 原子性修复】仅在全部成功时才清除本地数据
   */
  private async mergeLocalAndRemote(
    localProjects: Project[],
    remoteProjects: Project[],
    userId: string
  ): Promise<MigrationResult> {
    const remoteIds = new Set(remoteProjects.map(p => p.id));
    let migratedCount = 0;
    const failedProjects: string[] = [];
    
    // 更新迁移状态
    this.updateMigrationStatus('uploading', {
      projectsTotal: localProjects.length,
      projectsCompleted: 0,
      projectsFailed: []
    });
    
    for (const localProject of localProjects) {
      try {
        if (remoteIds.has(localProject.id)) {
          // 远程已存在，需要合并
          const remoteProject = remoteProjects.find(p => p.id === localProject.id);
          if (remoteProject) {
            const merged = this.mergeProjects(localProject, remoteProject);
            const result = await this.syncService.saveProjectToCloud(merged, userId);
            if (result.success) {
              migratedCount++;
            } else {
              failedProjects.push(localProject.name || localProject.id);
            }
          }
        } else {
          // 远程不存在，直接上传
          const result = await this.syncService.saveProjectToCloud(localProject, userId);
          if (result.success) {
            migratedCount++;
          } else {
            failedProjects.push(localProject.name || localProject.id);
          }
        }
        
        // 更新进度
        this.updateMigrationStatus('uploading', {
          projectsCompleted: migratedCount + failedProjects.length,
          projectsFailed: failedProjects
        });
      } catch (e) {
        this.logger.warn('合并项目失败:', { projectId: localProject.id, error: e });
        failedProjects.push(localProject.name || localProject.id);
      }
    }
    
    // 【v5.9 原子性修复】仅在全部成功时才清除本地数据
    if (failedProjects.length === 0) {
      this.updateMigrationStatus('cleaning');
      this.clearLocalGuestData();
      this.updateMigrationStatus('completed');
      this.toast.success('数据合并完成', `已合并 ${migratedCount} 个项目`);
    } else {
      // 部分失败：保留快照，不清除本地数据
      this.updateMigrationStatus('failed', {
        projectsFailed: failedProjects,
        error: `${failedProjects.length} 个项目合并失败`
      });
      this.logger.warn('合并部分失败，保留本地数据供重试', {
        migratedCount,
        failedCount: failedProjects.length,
        failedProjects
      });
      Sentry.captureMessage('数据合并部分失败', {
        level: 'warning',
        tags: { operation: 'mergeLocalAndRemote' },
        extra: { migratedCount, failedProjects }
      });
      this.toast.warning('部分项目合并失败', `以下项目未能上传: ${failedProjects.join(', ')}。本地数据已保留，您可以稍后重试。`);
    }
    
    return {
      success: failedProjects.length === 0,
      migratedProjects: migratedCount,
      strategy: 'merge',
      error: failedProjects.length > 0 ? `${failedProjects.length} 个项目合并失败，本地数据已保留` : undefined
    };
  }
  
  /**
   * 合并两个项目（保留双方的新增内容）
   */
  private mergeProjects(local: Project, remote: Project): Project {
    // 创建任务 ID 集合
    const localTaskIds = new Set(local.tasks.map(t => t.id));
    const remoteTaskIds = new Set(remote.tasks.map(t => t.id));
    
    // 合并任务：保留两边都有的，加入只有一边有的
    const mergedTasks: Task[] = [];
    
    // 添加本地任务
    for (const task of local.tasks) {
      if (remoteTaskIds.has(task.id)) {
        // 双方都有，比较更新时间，取较新的
        const remoteTask = remote.tasks.find(t => t.id === task.id);
        if (remoteTask) {
          const localCreated = new Date(task.createdDate || 0).getTime();
          const remoteCreated = new Date(remoteTask.createdDate || 0).getTime();
          mergedTasks.push(localCreated >= remoteCreated ? task : remoteTask);
        } else {
          mergedTasks.push(task);
        }
      } else {
        // 只有本地有
        mergedTasks.push(task);
      }
    }
    
    // 添加只有远程有的任务
    for (const task of remote.tasks) {
      if (!localTaskIds.has(task.id)) {
        mergedTasks.push(task);
      }
    }
    
    // 合并连接
    const connectionKeys = new Set<string>();
    const mergedConnections = [...local.connections, ...remote.connections].filter(conn => {
      const key = `${conn.source}->${conn.target}`;
      if (connectionKeys.has(key)) return false;
      connectionKeys.add(key);
      return true;
    });
    
    return {
      ...local,
      tasks: mergedTasks,
      connections: mergedConnections,
      updatedAt: new Date().toISOString(),
      version: Math.max(local.version ?? 0, remote.version ?? 0) + 1
    };
  }
  
  /**
   * 保存访客数据标记（在用户登出或未登录时创建数据时调用）
   * 数据将在 GUEST_DATA_EXPIRY_DAYS 天后过期
   */
  saveGuestData(projects: Project[]) {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + this.GUEST_DATA_EXPIRY_DAYS);
      
      localStorage.setItem(this.GUEST_DATA_KEY, JSON.stringify({
        projects,
        version: this.DATA_VERSION,
        savedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString()
      }));
    } catch (e) {
      console.warn('保存访客数据失败:', e);
    }
  }
  
  /**
   * 获取本地访客数据
   * 包含版本检查、数据迁移和过期检查
   */
  getLocalGuestData(): Project[] | null {
    if (typeof localStorage === 'undefined') return null;
    
    try {
      // 先尝试从访客数据 key 读取
      const guestData = localStorage.getItem(this.GUEST_DATA_KEY);
      if (guestData) {
        const parsed = JSON.parse(guestData);
        const dataVersion = parsed.version ?? 1;
        let projects = parsed.projects || null;
        
        // 过期检查 - 使用 UTC 时间戳比较，避免时区问题
        if (parsed.expiresAt) {
          const expiresAtTimestamp = new Date(parsed.expiresAt).getTime();
          const nowTimestamp = Date.now();
          if (expiresAtTimestamp < nowTimestamp) {
            console.log('访客数据已过期，清理中...');
            this.clearLocalGuestData();
            return null;
          }
        }
        
        // 版本检查和迁移
        if (projects && dataVersion < this.DATA_VERSION) {
          projects = this.migrateLocalData(projects, dataVersion);
          // 保存迁移后的数据
          this.saveGuestData(projects);
        }
        
        return projects;
      }
      
      // 回退到离线缓存
      const offlineCache = localStorage.getItem(CACHE_CONFIG.OFFLINE_CACHE_KEY);
      if (offlineCache) {
        const parsed = JSON.parse(offlineCache);
        return parsed.projects || null;
      }
      
      return null;
    } catch (e) {
      console.warn('读取访客数据失败:', e);
      return null;
    }
  }
  
  /**
   * 迁移本地数据到最新版本
   */
  private migrateLocalData(projects: Project[], fromVersion: number): Project[] {
    let migrated = projects;
    
    // 版本 1 -> 2: 添加 version 字段、status 默认值等
    if (fromVersion < 2) {
      migrated = migrated.map(project => ({
        ...project,
        version: project.version ?? 0,
        tasks: project.tasks.map(task => ({
          ...task,
          status: task.status || 'active',
          rank: task.rank ?? 10000
        }))
      }));
    }
    
    return migrated;
  }
  
  /**
   * 清除访客数据标记
   */
  clearLocalGuestData() {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.GUEST_DATA_KEY);
  }
  
  /**
   * 获取迁移摘要信息
   */
  getMigrationSummary(): {
    localCount: number;
    remoteCount: number;
    localOnlyCount: number;
    conflictCount: number;
  } {
    const local = this.localProjects();
    const remote = this.remoteProjects();
    const remoteIds = new Set(remote.map(p => p.id));
    
    const localOnlyCount = local.filter(p => !remoteIds.has(p.id)).length;
    const conflictCount = local.filter(p => remoteIds.has(p.id)).length;
    
    return {
      localCount: local.length,
      remoteCount: remote.length,
      localOnlyCount,
      conflictCount
    };
  }
  
  // ============================================================
  // 【v5.9】迁移状态跟踪与数据完整性检查
  // ============================================================
  
  /**
   * 更新迁移状态（持久化到 sessionStorage）
   */
  private updateMigrationStatus(
    status: MigrationStatus,
    partial: Partial<Omit<MigrationStatusRecord, 'status' | 'startedAt' | 'lastUpdatedAt'>> = {}
  ): void {
    try {
      const existing = this.getMigrationStatus();
      const now = new Date().toISOString();
      
      const record: MigrationStatusRecord = {
        status,
        startedAt: existing?.startedAt || now,
        lastUpdatedAt: now,
        phase: this.statusToPhase(status),
        totalPhases: 5,
        projectsTotal: partial.projectsTotal ?? existing?.projectsTotal ?? 0,
        projectsCompleted: partial.projectsCompleted ?? existing?.projectsCompleted ?? 0,
        projectsFailed: partial.projectsFailed ?? existing?.projectsFailed ?? [],
        error: partial.error ?? existing?.error
      };
      
      sessionStorage.setItem(
        MIGRATION_SNAPSHOT_CONFIG.STATUS_KEY,
        JSON.stringify(record)
      );
      
      this.logger.debug('迁移状态更新', { status, phase: record.phase });
    } catch (e) {
      this.logger.warn('无法保存迁移状态', { error: e });
    }
  }
  
  /**
   * 获取当前迁移状态
   */
  getMigrationStatus(): MigrationStatusRecord | null {
    try {
      const data = sessionStorage.getItem(MIGRATION_SNAPSHOT_CONFIG.STATUS_KEY);
      if (!data) return null;
      return JSON.parse(data) as MigrationStatusRecord;
    } catch {
      return null;
    }
  }
  
  /**
   * 清除迁移状态
   */
  clearMigrationStatus(): void {
    try {
      sessionStorage.removeItem(MIGRATION_SNAPSHOT_CONFIG.STATUS_KEY);
    } catch {
      // 忽略错误
    }
  }
  
  /**
   * 检查是否有未完成的迁移
   */
  hasUnfinishedMigration(): boolean {
    const status = this.getMigrationStatus();
    if (!status) return false;
    return !['idle', 'completed'].includes(status.status);
  }
  
  /**
   * 状态转换为阶段号
   */
  private statusToPhase(status: MigrationStatus): number {
    const phaseMap: Record<MigrationStatus, number> = {
      'idle': 0,
      'preparing': 1,
      'validating': 2,
      'uploading': 3,
      'verifying': 4,
      'cleaning': 5,
      'completed': 5,
      'failed': -1,
      'rollback': -1
    };
    return phaseMap[status] ?? 0;
  }
  
  /**
   * 【v5.9】数据完整性检查
   * 在迁移前验证数据一致性，防止部分数据丢失
   */
  validateDataIntegrity(projects: Project[]): IntegrityCheckResult {
    const issues: IntegrityIssue[] = [];
    let taskCount = 0;
    let connectionCount = 0;
    const allTaskIds = new Set<string>();
    const allProjectIds = new Set<string>();
    
    for (const project of projects) {
      // 检查项目 ID
      if (!project.id) {
        issues.push({
          type: 'missing-id',
          entityType: 'project',
          message: `项目缺少 ID: ${project.name || '未命名'}`,
          severity: 'error'
        });
        continue;
      }
      
      // 检查项目 ID 重复
      if (allProjectIds.has(project.id)) {
        issues.push({
          type: 'duplicate-id',
          entityType: 'project',
          entityId: project.id,
          message: `项目 ID 重复: ${project.id}`,
          severity: 'error'
        });
      }
      allProjectIds.add(project.id);
      
      // 收集任务 ID
      const projectTaskIds = new Set<string>();
      for (const task of project.tasks || []) {
        taskCount++;
        
        if (!task.id) {
          issues.push({
            type: 'missing-id',
            entityType: 'task',
            message: `任务缺少 ID: ${task.title || '未命名'} (项目: ${project.name})`,
            severity: 'error'
          });
          continue;
        }
        
        // 检查任务 ID 在项目内重复
        if (projectTaskIds.has(task.id)) {
          issues.push({
            type: 'duplicate-id',
            entityType: 'task',
            entityId: task.id,
            message: `任务 ID 在项目内重复: ${task.id}`,
            severity: 'error'
          });
        }
        projectTaskIds.add(task.id);
        allTaskIds.add(task.id);
        
        // 检查孤儿任务（有 parentId 但父任务不存在）
        if (task.parentId && !projectTaskIds.has(task.parentId)) {
          // 延迟检查，需要在项目所有任务加载后
        }
        
        // 检查必要字段
        if (typeof task.stage !== 'number' && task.stage !== null) {
          issues.push({
            type: 'invalid-field',
            entityType: 'task',
            entityId: task.id,
            message: `任务 stage 字段类型无效: ${typeof task.stage}`,
            severity: 'warning'
          });
        }
      }
      
      // 二次遍历检查孤儿任务
      for (const task of project.tasks || []) {
        if (task.parentId && !projectTaskIds.has(task.parentId)) {
          issues.push({
            type: 'orphan-task',
            entityType: 'task',
            entityId: task.id,
            message: `任务 "${task.title || task.id}" 的父任务不存在: ${task.parentId}`,
            severity: 'warning'
          });
        }
      }
      
      // 检查连接
      for (const conn of project.connections || []) {
        connectionCount++;
        
        if (!conn.id) {
          issues.push({
            type: 'missing-id',
            entityType: 'connection',
            message: `连接缺少 ID: ${conn.source} -> ${conn.target}`,
            severity: 'warning'
          });
        }
        
        // 检查断开的连接
        if (!projectTaskIds.has(conn.source)) {
          issues.push({
            type: 'broken-connection',
            entityType: 'connection',
            entityId: conn.id,
            message: `连接源任务不存在: ${conn.source}`,
            severity: 'warning'
          });
        }
        if (!projectTaskIds.has(conn.target)) {
          issues.push({
            type: 'broken-connection',
            entityType: 'connection',
            entityId: conn.id,
            message: `连接目标任务不存在: ${conn.target}`,
            severity: 'warning'
          });
        }
      }
    }
    
    // 记录检查结果
    const hasErrors = issues.some(i => i.severity === 'error');
    if (issues.length > 0) {
      this.logger.warn('数据完整性检查发现问题', {
        issueCount: issues.length,
        errorCount: issues.filter(i => i.severity === 'error').length,
        warningCount: issues.filter(i => i.severity === 'warning').length
      });
      
      if (hasErrors) {
        Sentry.captureMessage('数据完整性检查发现严重问题', {
          level: 'error',
          tags: { operation: 'validateDataIntegrity' },
          extra: { issues: issues.filter(i => i.severity === 'error') }
        });
      }
    }
    
    return {
      valid: !hasErrors,
      issues,
      projectCount: projects.length,
      taskCount,
      connectionCount
    };
  }
  
  /**
   * 【v5.9】验证迁移后数据一致性
   * 比较本地数据和远程数据，确保没有数据丢失
   */
  async verifyMigrationSuccess(
    localProjects: Project[],
    userId: string
  ): Promise<{ success: boolean; missingItems: string[] }> {
    const missingItems: string[] = [];
    
    try {
      this.updateMigrationStatus('verifying');
      
      // 重新从远程获取数据
      const remoteProjects = await this.syncService.loadProjectsFromCloud(userId);
      if (!remoteProjects) {
        return { success: false, missingItems: ['无法验证：远程数据获取失败'] };
      }
      
      const remoteProjectIds = new Set(remoteProjects.map((p: { id: string }) => p.id));
      const remoteTaskIds = new Map<string, Set<string>>();
      
      for (const project of remoteProjects) {
        remoteTaskIds.set(project.id, new Set(project.tasks.map((t: { id: string }) => t.id)));
      }
      
      // 检查每个本地项目是否在远程存在
      for (const localProject of localProjects) {
        if (!remoteProjectIds.has(localProject.id)) {
          missingItems.push(`项目: ${localProject.name || localProject.id}`);
          continue;
        }
        
        // 检查任务
        const remoteTasks = remoteTaskIds.get(localProject.id);
        if (!remoteTasks) continue;
        
        for (const task of localProject.tasks || []) {
          if (!remoteTasks.has(task.id)) {
            missingItems.push(`任务: ${task.title || task.id} (项目: ${localProject.name})`);
          }
        }
      }
      
      if (missingItems.length > 0) {
        this.logger.error('迁移验证失败：存在未同步的数据', { missingItems });
        Sentry.captureMessage('迁移验证失败', {
          level: 'error',
          tags: { operation: 'verifyMigrationSuccess' },
          extra: { missingItems }
        });
        return { success: false, missingItems };
      }
      
      this.logger.info('迁移验证成功：所有数据已同步');
      return { success: true, missingItems: [] };
    } catch (e) {
      this.logger.error('迁移验证过程出错', { error: e });
      return { success: false, missingItems: ['验证过程出错'] };
    }
  }
}
