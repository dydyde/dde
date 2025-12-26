import { Injectable, inject, signal } from '@angular/core';
import { SimpleSyncService } from '../app/core/services/simple-sync.service';
import { ToastService } from './toast.service';
import { Project, Task } from '../models';
import { CACHE_CONFIG } from '../config';

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
    
    try {
      switch (strategy) {
        case 'keep-local':
          // 将本地数据上传到云端，覆盖远程
          return await this.migrateLocalToCloud(localData, userId);
          
        case 'keep-remote':
          // 丢弃本地数据，使用远程
          this.clearLocalGuestData();
          return { success: true, migratedProjects: 0, strategy };
          
        case 'merge':
          // 智能合并本地和远程数据
          return await this.mergeLocalAndRemote(localData, remoteData, userId);
          
        case 'discard-local':
          // 彻底丢弃本地数据
          this.clearLocalGuestData();
          this.syncService.clearOfflineCache();
          return { success: true, migratedProjects: 0, strategy };
          
        default:
          return { success: false, migratedProjects: 0, strategy, error: '未知的迁移策略' };
      }
    } catch (e: any) {
      return {
        success: false,
        migratedProjects: 0,
        strategy,
        error: e?.message ?? String(e)
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
   * 将本地数据迁移到云端
   */
  private async migrateLocalToCloud(
    localProjects: Project[], 
    userId: string
  ): Promise<MigrationResult> {
    let migratedCount = 0;
    const failedProjects: string[] = [];
    
    for (const project of localProjects) {
      try {
        // 保存到云端
        const result = await this.syncService.saveProjectToCloud(project, userId);
        if (result.success) {
          migratedCount++;
        } else {
          failedProjects.push(project.name || project.id);
        }
      } catch (e) {
        console.warn('迁移项目失败:', project.id, e);
        failedProjects.push(project.name || project.id);
      }
    }
    
    // 清除访客数据标记
    this.clearLocalGuestData();
    
    if (failedProjects.length > 0) {
      this.toast.warning('部分项目迁移失败', `以下项目未能上传: ${failedProjects.join(', ')}`);
    }
    
    if (migratedCount > 0) {
      this.toast.success('数据迁移完成', `已将 ${migratedCount} 个项目上传到云端`);
    }
    
    return {
      success: migratedCount > 0 || failedProjects.length === 0,
      migratedProjects: migratedCount,
      strategy: 'keep-local',
      error: failedProjects.length > 0 ? `${failedProjects.length} 个项目迁移失败` : undefined
    };
  }
  
  /**
   * 智能合并本地和远程数据
   */
  private async mergeLocalAndRemote(
    localProjects: Project[],
    remoteProjects: Project[],
    userId: string
  ): Promise<MigrationResult> {
    const remoteIds = new Set(remoteProjects.map(p => p.id));
    let migratedCount = 0;
    
    for (const localProject of localProjects) {
      if (remoteIds.has(localProject.id)) {
        // 远程已存在，需要合并
        const remoteProject = remoteProjects.find(p => p.id === localProject.id);
        if (remoteProject) {
          const merged = this.mergeProjects(localProject, remoteProject);
          const result = await this.syncService.saveProjectToCloud(merged, userId);
          if (result.success) migratedCount++;
        }
      } else {
        // 远程不存在，直接上传
        const result = await this.syncService.saveProjectToCloud(localProject, userId);
        if (result.success) migratedCount++;
      }
    }
    
    this.clearLocalGuestData();
    
    this.toast.success('数据合并完成', `已合并 ${migratedCount} 个项目`);
    
    return {
      success: true,
      migratedProjects: migratedCount,
      strategy: 'merge'
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
}
