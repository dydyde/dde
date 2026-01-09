/**
 * Store 持久化服务
 * 
 * 职责：
 * - 将 Store 数据持久化到 IndexedDB
 * - 首屏加载时从本地恢复数据
 * - 后台静默同步，不阻塞 UI
 * 
 * 策略：
 * - 按项目分别持久化，避免全量读写
 * - 使用防抖减少写入频率
 * - 出错时静默降级，不影响运行时
 * 
 * @see .github/copilot-instructions.md 极简架构原则
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { TaskStore, ProjectStore, ConnectionStore } from './stores';
import { LoggerService } from '../../../services/logger.service';
import { Project, Task, Connection } from '../../../models';
import { validateProject } from '../../../utils/validation';
import * as Sentry from '@sentry/angular';

/** 存储键前缀（保留用于未来扩展） */
const _STORAGE_PREFIX = 'nanoflow.store';

/** 存储版本号（用于数据迁移） */
const STORAGE_VERSION = 1;

/** 防抖延迟（毫秒） */
const DEBOUNCE_DELAY = 1000;

/** IndexedDB 数据库配置 */
const DB_CONFIG = {
  name: 'nanoflow-store-cache',
  version: 1,
  stores: {
    projects: 'projects',
    tasks: 'tasks',
    connections: 'connections',
    meta: 'meta'
  }
} as const;

/**
 * 持久化的项目数据结构
 * @internal 保留用于类型文档
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface PersistedProjectData {
  version: number;
  timestamp: string;
  project: Project;
  tasks: Task[];
  connections: Connection[];
}

/**
 * 元数据结构
 */
interface StoreMeta {
  version: number;
  lastSyncTime: string;
  activeProjectId: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class StorePersistenceService {
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly connectionStore = inject(ConnectionStore);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('StorePersistence');
  private readonly destroyRef = inject(DestroyRef);
  
  /** 防抖计时器 */
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  
  /** IndexedDB 数据库实例 */
  private db: IDBDatabase | null = null;
  private dbInitPromise: Promise<IDBDatabase> | null = null;
  
  /** 是否正在恢复数据（避免循环保存） */
  private isRestoring = false;
  
  constructor() {
    // 初始化 IndexedDB
    this.initDatabase().catch(err => {
      this.logger.warn('IndexedDB 初始化失败，将使用内存存储', err);
    });
  }
  
  /**
   * 初始化 IndexedDB
   */
  private async initDatabase(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    
    if (!this.dbInitPromise) {
      this.dbInitPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB 不可用'));
          return;
        }
        
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);
        
        request.onerror = () => {
          this.logger.error('IndexedDB 打开失败', request.error);
          reject(request.error);
        };
        
        request.onsuccess = () => {
          this.db = request.result;
          this.logger.debug('IndexedDB 初始化成功');
          resolve(request.result);
        };
        
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          
          // 创建对象存储
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
            db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
            const taskStore = db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
            taskStore.createIndex('projectId', 'projectId', { unique: false });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
            const connStore = db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
            connStore.createIndex('projectId', 'projectId', { unique: false });
          }
          if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
            db.createObjectStore(DB_CONFIG.stores.meta);
          }
          
          this.logger.info('IndexedDB 模式升级完成');
        };
      });
    }
    
    return this.dbInitPromise;
  }
  
  /**
   * 保存项目数据到 IndexedDB（带防抖）
   */
  async saveProject(projectId: string): Promise<void> {
    // 恢复期间不保存
    if (this.isRestoring) return;
    
    // 防抖：取消之前的计时器
    const existingTimer = this.saveTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // 设置新计时器
    const timer = setTimeout(async () => {
      this.saveTimers.delete(projectId);
      await this.doSaveProject(projectId);
    }, DEBOUNCE_DELAY);
    
    this.saveTimers.set(projectId, timer);
  }
  
  /**
   * 实际执行保存
   */
  private async doSaveProject(projectId: string): Promise<void> {
    try {
      const db = await this.initDatabase();
      const project = this.projectStore.getProject(projectId);
      
      if (!project) {
        this.logger.warn('项目不存在，跳过保存', { projectId });
        return;
      }
      
      const tasks = this.taskStore.getTasksByProject(projectId);
      const connections = this.connectionStore.getConnectionsByProject(projectId);
      
      // 使用事务批量写入
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readwrite'
      );
      
      const projectStore = transaction.objectStore(DB_CONFIG.stores.projects);
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const connectionStore = transaction.objectStore(DB_CONFIG.stores.connections);
      
      // 保存项目
      projectStore.put(project);
      
      // 保存任务（带 projectId 索引）
      for (const task of tasks) {
        taskStore.put({ ...task, projectId });
      }
      
      // 保存连接（带 projectId 索引）
      for (const connection of connections) {
        connectionStore.put({ ...connection, projectId });
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      // 【v5.8 新增】写入后完整性校验
      const verifyResult = await this.verifyWriteIntegrity(db, projectId, tasks.length, connections.length);
      if (!verifyResult.valid) {
        this.logger.error('IndexedDB 写入校验失败', { 
          projectId, 
          expected: { tasks: tasks.length, connections: connections.length },
          actual: verifyResult.actual,
          errors: verifyResult.errors
        });
        
        // 【Senior Consultant P1】自动重试一次
        this.logger.info('IndexedDB 写入校验失败，尝试重试...', { projectId });
        const retrySuccess = await this.retryWriteOnce(projectId, project, tasks, connections);
        
        if (!retrySuccess) {
          // 【降级策略】写入 localStorage 作为备份
          this.logger.warn('IndexedDB 重试失败，降级到 localStorage 备份', { projectId });
          this.fallbackToLocalStorage(projectId, project, tasks, connections);
        }
        
        Sentry.captureMessage('IndexedDB 写入校验失败', {
          level: 'error',
          tags: { operation: 'writeIntegrityCheck', projectId, retried: String(retrySuccess) },
          extra: { 
            expected: { tasks: tasks.length, connections: connections.length },
            actual: verifyResult.actual,
            errors: verifyResult.errors
          }
        });
        return;
      }
      
      this.logger.debug('项目数据已保存', { 
        projectId, 
        tasksCount: tasks.length, 
        connectionsCount: connections.length,
        verified: verifyResult.valid
      });
    } catch (err) {
      this.logger.error('保存项目数据失败', { projectId, error: err });
      Sentry.captureException(err, { tags: { operation: 'saveProjectData', projectId } });
      // 【Senior Consultant P1】降级到 localStorage
      const project = this.projectStore.getProject(projectId);
      const tasks = this.taskStore.getTasksByProject(projectId);
      const connections = this.connectionStore.getConnectionsByProject(projectId);
      if (project) {
        this.fallbackToLocalStorage(projectId, project, tasks, connections);
      }
    }
  }
  
  /**
   * 【Senior Consultant P1】重试写入一次
   */
  private async retryWriteOnce(
    projectId: string,
    project: Project,
    tasks: Task[],
    connections: Connection[]
  ): Promise<boolean> {
    try {
      const db = await this.initDatabase();
      
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readwrite'
      );
      
      const projectStore = transaction.objectStore(DB_CONFIG.stores.projects);
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const connectionStore = transaction.objectStore(DB_CONFIG.stores.connections);
      
      // 清除旧数据后重写
      projectStore.put(project);
      for (const task of tasks) {
        taskStore.put({ ...task, projectId });
      }
      for (const connection of connections) {
        connectionStore.put({ ...connection, projectId });
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      // 再次验证
      const verifyResult = await this.verifyWriteIntegrity(db, projectId, tasks.length, connections.length);
      if (verifyResult.valid) {
        this.logger.info('IndexedDB 重试写入成功', { projectId });
        return true;
      }
      
      return false;
    } catch (err) {
      this.logger.error('IndexedDB 重试写入失败', { projectId, error: err });
      return false;
    }
  }
  
  /**
   * 【Senior Consultant P1】降级到 localStorage 备份
   */
  private fallbackToLocalStorage(
    projectId: string,
    project: Project,
    tasks: Task[],
    connections: Connection[]
  ): void {
    if (typeof localStorage === 'undefined') return;
    
    const FALLBACK_KEY = `nanoflow.idb-fallback.${projectId}`;
    
    try {
      const fallbackData = {
        version: 1,
        timestamp: new Date().toISOString(),
        project,
        tasks,
        connections
      };
      
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(fallbackData));
      this.logger.info('已降级保存到 localStorage', { 
        projectId, 
        tasksCount: tasks.length,
        connectionsCount: connections.length
      });
    } catch (e) {
      this.logger.error('localStorage 降级保存也失败', { projectId, error: e });
      Sentry.captureException(e, { 
        tags: { operation: 'fallbackToLocalStorage', projectId },
        level: 'fatal'
      });
    }
  }
  
  /**
   * 【v5.8 新增】验证 IndexedDB 写入完整性
   * 回读数据确保写入成功
   */
  private async verifyWriteIntegrity(
    db: IDBDatabase, 
    projectId: string, 
    expectedTaskCount: number, 
    expectedConnectionCount: number
  ): Promise<{ valid: boolean; actual: { tasks: number; connections: number }; errors: string[] }> {
    const errors: string[] = [];
    
    try {
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readonly'
      );
      
      const projectStore = transaction.objectStore(DB_CONFIG.stores.projects);
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const connectionStore = transaction.objectStore(DB_CONFIG.stores.connections);
      
      // 1. 验证项目存在
      const savedProject = await new Promise<Project | undefined>((resolve, reject) => {
        const request = projectStore.get(projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (!savedProject) {
        errors.push('项目未成功写入');
      } else if (!savedProject.id || !savedProject.name) {
        errors.push('项目关键字段丢失');
      }
      
      // 2. 验证任务数量（使用索引计数）
      const taskIndex = taskStore.index('projectId');
      const savedTaskCount = await new Promise<number>((resolve, reject) => {
        const request = taskIndex.count(IDBKeyRange.only(projectId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (savedTaskCount !== expectedTaskCount) {
        errors.push(`任务数量不匹配：期望 ${expectedTaskCount}，实际 ${savedTaskCount}`);
      }
      
      // 3. 验证连接数量（使用索引计数）
      const connectionIndex = connectionStore.index('projectId');
      const savedConnectionCount = await new Promise<number>((resolve, reject) => {
        const request = connectionIndex.count(IDBKeyRange.only(projectId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (savedConnectionCount !== expectedConnectionCount) {
        errors.push(`连接数量不匹配：期望 ${expectedConnectionCount}，实际 ${savedConnectionCount}`);
      }
      
      return {
        valid: errors.length === 0,
        actual: { tasks: savedTaskCount, connections: savedConnectionCount },
        errors
      };
    } catch (err) {
      errors.push(`读取验证失败: ${err instanceof Error ? err.message : String(err)}`);
      return {
        valid: false,
        actual: { tasks: -1, connections: -1 },
        errors
      };
    }
  }
  
  /**
   * 保存所有项目数据
   */
  async saveAllProjects(): Promise<void> {
    const projects = this.projectStore.projects();
    for (const project of projects) {
      await this.doSaveProject(project.id);
    }
  }
  
  /**
   * 保存元数据
   */
  async saveMeta(): Promise<void> {
    if (this.isRestoring) return;
    
    try {
      const db = await this.initDatabase();
      const meta: StoreMeta = {
        version: STORAGE_VERSION,
        lastSyncTime: new Date().toISOString(),
        activeProjectId: this.projectStore.activeProjectId()
      };
      
      const transaction = db.transaction(DB_CONFIG.stores.meta, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.meta);
      store.put(meta, 'meta');
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      this.logger.error('保存元数据失败', err);
      Sentry.captureException(err, { tags: { operation: 'saveMeta' } });
    }
  }
  
  /**
   * 从 IndexedDB 恢复项目数据
   * 
   * 【Week 2 增强】添加 schema 验证，防止损坏的缓存导致运行时异常
   * 验证失败时：
   * - Critical 错误：返回 false，让调用者从云端拉取新数据
   * - 警告：尝试修复并继续加载
   */
  async loadProject(projectId: string): Promise<boolean> {
    try {
      const db = await this.initDatabase();
      this.isRestoring = true;
      
      // 读取项目
      const project = await this.getFromStore<Project>(db, DB_CONFIG.stores.projects, projectId);
      if (!project) {
        this.logger.debug('本地无缓存项目', { projectId });
        return false;
      }
      
      // 读取任务
      const tasks = await this.getByIndex<Task & { projectId: string }>(
        db, 
        DB_CONFIG.stores.tasks, 
        'projectId', 
        projectId
      );
      
      // 读取连接
      const connections = await this.getByIndex<Connection & { projectId: string }>(
        db, 
        DB_CONFIG.stores.connections, 
        'projectId', 
        projectId
      );
      
      // 【Week 2 - Schema 验证】验证恢复的数据完整性
      // 组装完整项目用于验证
      const fullProject: Partial<Project> = {
        ...project,
        tasks: tasks.map(t => {
          const { projectId: _, ...task } = t;
          return task as Task;
        }),
        connections: connections.map(c => {
          const { projectId: _, ...conn } = c;
          return conn as Connection;
        })
      };
      
      const validation = validateProject(fullProject);
      
      // 记录验证结果
      if (validation.warnings.length > 0) {
        this.logger.warn('项目数据验证警告', { 
          projectId, 
          warnings: validation.warnings.slice(0, 10) // 只记录前 10 个警告
        });
      }
      
      if (!validation.valid) {
        // Critical 验证失败 - 返回 false，让调用者从云端重新获取
        this.logger.error('项目数据验证失败，缓存可能已损坏', { 
          projectId, 
          errors: validation.errors.slice(0, 10)
        });
        Sentry.captureMessage('IndexedDB 缓存数据验证失败', {
          level: 'error',
          tags: { operation: 'loadProject', projectId },
          extra: { errors: validation.errors }
        });
        // 清理损坏的缓存
        await this.deleteProject(projectId);
        return false;
      }
      
      // 恢复到 Store
      this.projectStore.setProject(project);
      
      // 【关键修复】过滤已删除的任务，防止从 IndexedDB 恢复时复活已删除任务
      // 只恢复 deletedAt 为空的任务
      const activeTasks = tasks.filter(t => !t.deletedAt);
      const filteredCount = tasks.length - activeTasks.length;
      if (filteredCount > 0) {
        this.logger.debug('已过滤已删除任务', { projectId, filteredCount });
      }
      
      this.taskStore.setTasks(activeTasks.map(t => {
        const { projectId: _, ...task } = t;
        return task as Task;
      }), projectId);
      this.connectionStore.setConnections(connections.map(c => {
        const { projectId: _, ...conn } = c;
        return conn as Connection;
      }), projectId);
      
      this.logger.info('项目数据已从本地恢复', { 
        projectId, 
        tasksCount: activeTasks.length, 
        connectionsCount: connections.length 
      });
      
      return true;
    } catch (err) {
      this.logger.error('恢复项目数据失败', { projectId, error: err });
      Sentry.captureException(err, { tags: { operation: 'loadProject', projectId } });
      return false;
    } finally {
      this.isRestoring = false;
    }
  }
  
  /**
   * 恢复所有项目列表（仅项目元数据）
   */
  async loadAllProjects(): Promise<Project[]> {
    try {
      const db = await this.initDatabase();
      const projects = await this.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      
      this.logger.debug('已加载项目列表', { count: projects.length });
      return projects;
    } catch (err) {
      this.logger.error('加载项目列表失败', err);
      return [];
    }
  }
  
  /**
   * 恢复元数据
   */
  async loadMeta(): Promise<StoreMeta | null> {
    try {
      const db = await this.initDatabase();
      const meta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');
      return meta;
    } catch (err) {
      this.logger.error('加载元数据失败', err);
      return null;
    }
  }
  
  /**
   * 【新增】获取上次活动的项目 ID
   * 
   * 来自高级顾问建议：
   * - 恢复用户上次打开的项目，提升体验
   * - 如果该项目已被删除，自动回退到第一个可用项目
   * 
   * @param availableProjectIds 当前可用的项目 ID 列表
   * @returns 有效的 activeProjectId 或 null
   */
  async getLastActiveProjectId(availableProjectIds: string[]): Promise<string | null> {
    try {
      const meta = await this.loadMeta();
      const lastActiveId = meta?.activeProjectId;
      
      if (!lastActiveId) {
        this.logger.debug('没有保存的 lastActiveProjectId');
        return availableProjectIds[0] ?? null;
      }
      
      // 检查该项目是否仍然存在
      if (availableProjectIds.includes(lastActiveId)) {
        this.logger.debug('恢复上次活动项目', { projectId: lastActiveId });
        return lastActiveId;
      }
      
      // 项目已被删除（可能在其他设备上）
      this.logger.info('上次活动的项目已不存在，回退到第一个可用项目', { 
        lastActiveId, 
        availableCount: availableProjectIds.length 
      });
      return availableProjectIds[0] ?? null;
    } catch (err) {
      this.logger.error('获取 lastActiveProjectId 失败', err);
      return availableProjectIds[0] ?? null;
    }
  }
  
  /**
   * 【新增】保存当前活动项目 ID（立即保存，不防抖）
   */
  async saveActiveProjectId(projectId: string | null): Promise<void> {
    if (this.isRestoring) return;
    
    try {
      const db = await this.initDatabase();
      const existingMeta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');
      
      const meta: StoreMeta = {
        version: existingMeta?.version ?? STORAGE_VERSION,
        lastSyncTime: existingMeta?.lastSyncTime ?? new Date().toISOString(),
        activeProjectId: projectId
      };
      
      const transaction = db.transaction(DB_CONFIG.stores.meta, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.meta);
      store.put(meta, 'meta');
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('activeProjectId 已保存', { projectId });
    } catch (err) {
      this.logger.error('保存 activeProjectId 失败', err);
    }
  }
  
  /**
   * 删除项目的本地缓存
   */
  async deleteProject(projectId: string): Promise<void> {
    try {
      const db = await this.initDatabase();
      
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readwrite'
      );
      
      // 删除项目
      transaction.objectStore(DB_CONFIG.stores.projects).delete(projectId);
      
      // 删除相关任务
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const taskIndex = taskStore.index('projectId');
      const taskKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = taskIndex.getAllKeys(projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const key of taskKeys) {
        taskStore.delete(key);
      }
      
      // 删除相关连接
      const connStore = transaction.objectStore(DB_CONFIG.stores.connections);
      const connIndex = connStore.index('projectId');
      const connKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = connIndex.getAllKeys(projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const key of connKeys) {
        connStore.delete(key);
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.info('项目本地缓存已删除', { projectId });
    } catch (err) {
      this.logger.error('删除项目缓存失败', { projectId, error: err });
    }
  }
  
  /**
   * 清除所有本地缓存
   */
  async clearAll(): Promise<void> {
    try {
      const db = await this.initDatabase();
      
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections, DB_CONFIG.stores.meta],
        'readwrite'
      );
      
      transaction.objectStore(DB_CONFIG.stores.projects).clear();
      transaction.objectStore(DB_CONFIG.stores.tasks).clear();
      transaction.objectStore(DB_CONFIG.stores.connections).clear();
      transaction.objectStore(DB_CONFIG.stores.meta).clear();
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.info('所有本地缓存已清除');
    } catch (err) {
      this.logger.error('清除缓存失败', err);
    }
  }
  
  // ========== 辅助方法 ==========
  
  private async getFromStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
  
  private async getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }
  
  private async getByIndex<T>(
    db: IDBDatabase, 
    storeName: string, 
    indexName: string, 
    key: IDBValidKey
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(key);
      
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================
  // 【Stingy Hoarder Protocol】Delta Sync 支持
  // @see docs/plan_save.md Phase 2
  // ============================================================

  /**
   * 从本地 IndexedDB 加载项目的所有任务
   * 
   * @param projectId 项目 ID
   * @returns 该项目的所有任务（包含已删除的）
   */
  async loadTasksFromLocal(projectId: string): Promise<Task[]> {
    try {
      const db = await this.initDatabase();
      const tasks = await this.getByIndex<Task & { projectId: string }>(
        db, 
        DB_CONFIG.stores.tasks, 
        'projectId', 
        projectId
      );
      
      // 移除 projectId 属性（仅用于索引）
      return tasks.map(t => {
        const { projectId: _, ...task } = t;
        return task as Task;
      });
    } catch (err) {
      this.logger.error('加载本地任务失败', { projectId, error: err });
      Sentry.captureException(err, { tags: { operation: 'loadTasksFromLocal', projectId } });
      return [];
    }
  }

  /**
   * 获取指定时间后更新的任务（Delta Sync）
   * 
   * 用于增量同步：只返回 updated_at > sinceTime 的任务
   * 
   * @param projectId 项目 ID
   * @param sinceTime ISO 时间字符串（例如 "2025-12-31T12:00:00Z"）
   * @returns 在 sinceTime 之后更新的活跃任务（排除软删除）
   * 
   * @see docs/plan_save.md Layer 2.2
   */
  async getTasksUpdatedSince(projectId: string, sinceTime: string): Promise<Task[]> {
    try {
      const allTasks = await this.loadTasksFromLocal(projectId);
      const sinceDate = new Date(sinceTime);  // 🔒 使用 Date 对象比较，避免时区问题
      
      return allTasks.filter(t => 
        t.updatedAt && new Date(t.updatedAt) > sinceDate && !t.deletedAt  // 🔒 过滤软删除
      );
    } catch (err) {
      this.logger.error('获取增量更新任务失败', { projectId, sinceTime, error: err });
      Sentry.captureException(err, { tags: { operation: 'getTasksUpdatedSince', projectId } });
      return [];
    }
  }

  /**
   * 获取本地最新的 updated_at 时间戳
   * 
   * 用于 Delta Sync：确定从服务端拉取的起始时间点
   * 
   * @param projectId 项目 ID
   * @returns 最新时间戳，若无数据则返回 null（确保类型安全）
   * 
   * @see docs/plan_save.md Layer 2.2
   */
  async getLatestLocalTimestamp(projectId: string): Promise<string | null> {
    try {
      const tasks = await this.loadTasksFromLocal(projectId);
      if (tasks.length === 0) return null;
      
      // 🔒 过滤掉无 updatedAt 的任务，确保类型安全
      const tasksWithTimestamp = tasks.filter((t): t is Task & { updatedAt: string } => 
        typeof t.updatedAt === 'string' && t.updatedAt.length > 0
      );
      
      if (tasksWithTimestamp.length === 0) return null;
      
      // 按 updatedAt 降序排列，取最新
      tasksWithTimestamp.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return tasksWithTimestamp[0].updatedAt;
    } catch (err) {
      this.logger.error('获取本地最新时间戳失败', { projectId, error: err });
      Sentry.captureException(err, { tags: { operation: 'getLatestLocalTimestamp', projectId } });
      return null;
    }
  }

  /**
   * 保存单个任务到本地 IndexedDB
   * 
   * 用于 Realtime 推送：收到服务端变更后立即持久化
   * 
   * @param task 要保存的任务
   * @param projectId 项目 ID（用于索引）
   */
  async saveTaskToLocal(task: Task, projectId: string): Promise<void> {
    try {
      const db = await this.initDatabase();
      const transaction = db.transaction(DB_CONFIG.stores.tasks, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.tasks);
      
      // 添加 projectId 用于索引
      store.put({ ...task, projectId });
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('任务已保存到本地', { taskId: task.id, projectId });
    } catch (err) {
      this.logger.error('保存任务到本地失败', { taskId: task.id, projectId, error: err });
      Sentry.captureException(err, { tags: { operation: 'saveTaskToLocal', taskId: task.id, projectId } });
    }
  }

  /**
   * 从本地 IndexedDB 删除单个任务
   * 
   * 用于 Realtime 推送：收到 DELETE 事件后删除本地数据
   * 
   * @param taskId 任务 ID
   */
  async deleteTaskFromLocal(taskId: string): Promise<void> {
    try {
      const db = await this.initDatabase();
      const transaction = db.transaction(DB_CONFIG.stores.tasks, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.tasks);
      
      store.delete(taskId);
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('任务已从本地删除', { taskId });
    } catch (err) {
      this.logger.error('从本地删除任务失败', { taskId, error: err });
      Sentry.captureException(err, { tags: { operation: 'deleteTaskFromLocal', taskId } });
    }
  }

  /**
   * 批量更新本地任务（Delta Sync 增量合并）
   * 
   * 用于 Delta Sync：将服务端增量数据合并到本地
   * 
   * @param tasks 要合并的任务列表
   * @param projectId 项目 ID
   */
  async bulkMergeTasksToLocal(tasks: Task[], projectId: string): Promise<void> {
    if (tasks.length === 0) return;
    
    try {
      const db = await this.initDatabase();
      const transaction = db.transaction(DB_CONFIG.stores.tasks, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.tasks);
      
      for (const task of tasks) {
        // 如果是软删除的任务，从本地删除
        if (task.deletedAt) {
          store.delete(task.id);
        } else {
          store.put({ ...task, projectId });
        }
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('批量合并任务完成', { count: tasks.length, projectId });
    } catch (err) {
      this.logger.error('批量合并任务失败', { count: tasks.length, projectId, error: err });
      Sentry.captureException(err, { tags: { operation: 'bulkMergeTasksToLocal', projectId } });
    }
  }

  // ============================================================
  // 【v5.9】离线数据完整性校验
  // ============================================================

  /**
   * 【v5.9】全面验证离线数据完整性
   * 检查：
   * 1. 任务是否属于有效项目
   * 2. 连接是否指向有效任务
   * 3. 父子关系是否有效
   * 4. 数据索引一致性
   */
  async validateOfflineDataIntegrity(): Promise<{
    valid: boolean;
    issues: Array<{
      type: string;
      entityId: string;
      projectId?: string;
      message: string;
      severity: 'error' | 'warning';
    }>;
    stats: {
      projectCount: number;
      taskCount: number;
      connectionCount: number;
      orphanedTasks: number;
      brokenConnections: number;
    };
  }> {
    const issues: Array<{
      type: string;
      entityId: string;
      projectId?: string;
      message: string;
      severity: 'error' | 'warning';
    }> = [];
    
    let orphanedTasks = 0;
    let brokenConnections = 0;
    
    try {
      const db = await this.initDatabase();
      
      // 1. 加载所有数据
      const allProjects = await this.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      const allTasks = await this.getAllFromStore<Task>(db, DB_CONFIG.stores.tasks);
      const allConnections = await this.getAllFromStore<Connection>(db, DB_CONFIG.stores.connections);
      
      const projectIds = new Set(allProjects.map(p => p.id));
      const tasksByProject = new Map<string, Set<string>>();
      
      // 2. 构建任务索引
      for (const task of allTasks) {
        const taskProjectId = (task as Task & { projectId?: string }).projectId;
        if (taskProjectId) {
          if (!tasksByProject.has(taskProjectId)) {
            tasksByProject.set(taskProjectId, new Set());
          }
          tasksByProject.get(taskProjectId)!.add(task.id);
        }
      }
      
      // 3. 检查任务
      for (const task of allTasks) {
        const taskProjectId = (task as Task & { projectId?: string }).projectId;
        
        // 检查任务是否属于有效项目
        if (!taskProjectId || !projectIds.has(taskProjectId)) {
          issues.push({
            type: 'orphaned-task',
            entityId: task.id,
            projectId: taskProjectId,
            message: `任务 "${task.title || task.id}" 不属于任何有效项目`,
            severity: 'error'
          });
          orphanedTasks++;
          continue;
        }
        
        // 检查父任务是否存在
        if (task.parentId) {
          const projectTasks = tasksByProject.get(taskProjectId);
          if (!projectTasks?.has(task.parentId)) {
            issues.push({
              type: 'invalid-data',
              entityId: task.id,
              projectId: taskProjectId,
              message: `任务 "${task.title || task.id}" 的父任务 ${task.parentId} 不存在`,
              severity: 'warning'
            });
          }
        }
        
        // 检查必要字段
        if (!task.id) {
          issues.push({
            type: 'invalid-data',
            entityId: 'unknown',
            projectId: taskProjectId,
            message: '发现无 ID 的任务',
            severity: 'error'
          });
        }
      }
      
      // 4. 检查连接
      for (const conn of allConnections) {
        const connProjectId = (conn as Connection & { projectId?: string }).projectId;
        
        if (!connProjectId || !projectIds.has(connProjectId)) {
          issues.push({
            type: 'broken-connection',
            entityId: conn.id,
            projectId: connProjectId,
            message: `连接 ${conn.id} 不属于任何有效项目`,
            severity: 'error'
          });
          brokenConnections++;
          continue;
        }
        
        const projectTasks = tasksByProject.get(connProjectId);
        
        // 检查源任务
        if (!projectTasks?.has(conn.source)) {
          issues.push({
            type: 'broken-connection',
            entityId: conn.id,
            projectId: connProjectId,
            message: `连接 ${conn.id} 的源任务 ${conn.source} 不存在`,
            severity: 'warning'
          });
          brokenConnections++;
        }
        
        // 检查目标任务
        if (!projectTasks?.has(conn.target)) {
          issues.push({
            type: 'broken-connection',
            entityId: conn.id,
            projectId: connProjectId,
            message: `连接 ${conn.id} 的目标任务 ${conn.target} 不存在`,
            severity: 'warning'
          });
          brokenConnections++;
        }
      }
      
      // 5. 记录结果
      const hasErrors = issues.some(i => i.severity === 'error');
      
      if (issues.length > 0) {
        this.logger.warn('离线数据完整性检查发现问题', {
          issueCount: issues.length,
          errorCount: issues.filter(i => i.severity === 'error').length,
          warningCount: issues.filter(i => i.severity === 'warning').length
        });
        
        if (hasErrors) {
          Sentry.captureMessage('离线数据完整性检查发现严重问题', {
            level: 'error',
            tags: { operation: 'validateOfflineDataIntegrity' },
            extra: { 
              errorCount: issues.filter(i => i.severity === 'error').length,
              sampleIssues: issues.slice(0, 5)
            }
          });
        }
      } else {
        this.logger.debug('离线数据完整性检查通过', {
          projectCount: allProjects.length,
          taskCount: allTasks.length,
          connectionCount: allConnections.length
        });
      }
      
      return {
        valid: !hasErrors,
        issues,
        stats: {
          projectCount: allProjects.length,
          taskCount: allTasks.length,
          connectionCount: allConnections.length,
          orphanedTasks,
          brokenConnections
        }
      };
    } catch (err) {
      this.logger.error('离线数据完整性检查失败', err);
      Sentry.captureException(err, {
        tags: { operation: 'validateOfflineDataIntegrity' }
      });
      
      return {
        valid: false,
        issues: [{
          type: 'invalid-data',
          entityId: 'system',
          message: `检查过程出错: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'error'
        }],
        stats: {
          projectCount: 0,
          taskCount: 0,
          connectionCount: 0,
          orphanedTasks: 0,
          brokenConnections: 0
        }
      };
    }
  }
  
  /**
   * 【v5.9】清理孤立数据
   * 删除不属于任何项目的任务和连接
   */
  async cleanupOrphanedData(): Promise<{ removedTasks: number; removedConnections: number }> {
    let removedTasks = 0;
    let removedConnections = 0;
    
    try {
      const db = await this.initDatabase();
      
      // 获取有效项目 ID
      const allProjects = await this.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      const projectIds = new Set(allProjects.map(p => p.id));
      
      // 清理孤立任务
      const allTasks = await this.getAllFromStore<Task>(db, DB_CONFIG.stores.tasks);
      const orphanedTaskIds: string[] = [];
      
      for (const task of allTasks) {
        const taskProjectId = (task as Task & { projectId?: string }).projectId;
        if (!taskProjectId || !projectIds.has(taskProjectId)) {
          orphanedTaskIds.push(task.id);
        }
      }
      
      if (orphanedTaskIds.length > 0) {
        const taskTx = db.transaction(DB_CONFIG.stores.tasks, 'readwrite');
        const taskStore = taskTx.objectStore(DB_CONFIG.stores.tasks);
        
        for (const taskId of orphanedTaskIds) {
          await new Promise<void>((resolve, reject) => {
            const request = taskStore.delete(taskId);
            request.onsuccess = () => {
              removedTasks++;
              resolve();
            };
            request.onerror = () => reject(request.error);
          });
        }
      }
      
      // 清理孤立连接
      const allConnections = await this.getAllFromStore<Connection>(db, DB_CONFIG.stores.connections);
      const orphanedConnectionIds: string[] = [];
      
      for (const conn of allConnections) {
        const connProjectId = (conn as Connection & { projectId?: string }).projectId;
        if (!connProjectId || !projectIds.has(connProjectId)) {
          orphanedConnectionIds.push(conn.id);
        }
      }
      
      if (orphanedConnectionIds.length > 0) {
        const connTx = db.transaction(DB_CONFIG.stores.connections, 'readwrite');
        const connStore = connTx.objectStore(DB_CONFIG.stores.connections);
        
        for (const connId of orphanedConnectionIds) {
          await new Promise<void>((resolve, reject) => {
            const request = connStore.delete(connId);
            request.onsuccess = () => {
              removedConnections++;
              resolve();
            };
            request.onerror = () => reject(request.error);
          });
        }
      }
      
      if (removedTasks > 0 || removedConnections > 0) {
        this.logger.info('孤立数据清理完成', { removedTasks, removedConnections });
      }
      
      return { removedTasks, removedConnections };
    } catch (err) {
      this.logger.error('孤立数据清理失败', err);
      return { removedTasks: 0, removedConnections: 0 };
    }
  }

  // ============================================================
  // 【Stingy Hoarder Protocol】迁移回滚支持
  // @see docs/plan_save.md Phase 2.5
  // ============================================================

  /** 备份数据库名称前缀 */
  private static readonly BACKUP_DB_PREFIX = 'nanoflow-db-backup-';
  
  /** 备份保留天数 */
  private static readonly BACKUP_RETENTION_DAYS = 7;

  /**
   * 创建当前数据库的备份
   * 
   * 用于 Delta Sync 启用前的数据保护
   * 备份以日期为后缀存储在单独的 IndexedDB 中
   * 
   * @returns 备份数据库名称，失败返回 null
   */
  async createBackup(): Promise<string | null> {
    let backupDb: IDBDatabase | null = null;
    
    try {
      const db = await this.initDatabase();
      const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const backupDbName = `${StorePersistenceService.BACKUP_DB_PREFIX}${dateStr}`;
      
      // 检查是否已存在今天的备份
      const databases = await indexedDB.databases?.() || [];
      const existingBackup = databases.find(d => d.name === backupDbName);
      if (existingBackup) {
        this.logger.debug('今天的备份已存在', { backupDbName });
        return backupDbName;
      }
      
      // 读取所有数据
      const allProjects = await this.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      const allTasks = await this.getAllFromStore<Task>(db, DB_CONFIG.stores.tasks);
      const allConnections = await this.getAllFromStore<Connection>(db, DB_CONFIG.stores.connections);
      const meta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');
      
      // 创建备份数据库
      backupDb = await this.createBackupDatabase(backupDbName);
      
      // 写入备份
      const tx = backupDb.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections, DB_CONFIG.stores.meta],
        'readwrite'
      );
      
      const projectStore = tx.objectStore(DB_CONFIG.stores.projects);
      const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
      const connStore = tx.objectStore(DB_CONFIG.stores.connections);
      const metaStore = tx.objectStore(DB_CONFIG.stores.meta);
      
      for (const project of allProjects) {
        projectStore.put(project);
      }
      for (const task of allTasks) {
        taskStore.put(task);
      }
      for (const conn of allConnections) {
        connStore.put(conn);
      }
      if (meta) {
        metaStore.put({ ...meta, backupTime: new Date().toISOString() }, 'meta');
      }
      
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      
      this.logger.info('数据库备份创建成功', { 
        backupDbName,
        projectCount: allProjects.length,
        taskCount: allTasks.length,
        connectionCount: allConnections.length
      });
      
      // 清理过期备份
      await this.cleanupOldBackups();
      
      return backupDbName;
    } catch (err) {
      this.logger.error('创建数据库备份失败', err);
      Sentry.captureException(err, { tags: { operation: 'createBackup' } });
      return null;
    } finally {
      // 【修复】确保备份数据库连接被关闭，防止资源泄漏
      backupDb?.close();
    }
  }

  /**
   * 创建备份数据库结构
   */
  private createBackupDatabase(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 复制主数据库的结构
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
          db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
          const taskStore = db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
          taskStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
          const connStore = db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
          connStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
          db.createObjectStore(DB_CONFIG.stores.meta);
        }
      };
    });
  }

  /**
   * 从备份恢复数据
   * 
   * @param backupDbName 备份数据库名称
   * @returns 是否恢复成功
   */
  async restoreFromBackup(backupDbName: string): Promise<boolean> {
    try {
      // 打开备份数据库
      const backupDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(backupDbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      
      // 读取备份数据
      const allProjects = await this.getAllFromStore<Project>(backupDb, DB_CONFIG.stores.projects);
      const allTasks = await this.getAllFromStore<Task>(backupDb, DB_CONFIG.stores.tasks);
      const allConnections = await this.getAllFromStore<Connection>(backupDb, DB_CONFIG.stores.connections);
      const meta = await this.getFromStore<StoreMeta>(backupDb, DB_CONFIG.stores.meta, 'meta');
      
      backupDb.close();
      
      // 清空当前数据库
      await this.clearAll();
      
      // 恢复数据
      const db = await this.initDatabase();
      const tx = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections, DB_CONFIG.stores.meta],
        'readwrite'
      );
      
      const projectStore = tx.objectStore(DB_CONFIG.stores.projects);
      const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
      const connStore = tx.objectStore(DB_CONFIG.stores.connections);
      const metaStore = tx.objectStore(DB_CONFIG.stores.meta);
      
      for (const project of allProjects) {
        projectStore.put(project);
      }
      for (const task of allTasks) {
        taskStore.put(task);
      }
      for (const conn of allConnections) {
        connStore.put(conn);
      }
      if (meta) {
        metaStore.put(meta, 'meta');
      }
      
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      
      this.logger.info('数据库已从备份恢复', { 
        backupDbName,
        projectCount: allProjects.length,
        taskCount: allTasks.length,
        connectionCount: allConnections.length
      });
      
      return true;
    } catch (err) {
      this.logger.error('从备份恢复失败', err);
      Sentry.captureException(err, { tags: { operation: 'restoreFromBackup', backupDbName } });
      return false;
    }
  }

  /**
   * 获取所有备份列表
   */
  async listBackups(): Promise<Array<{ name: string; date: string }>> {
    try {
      const databases = await indexedDB.databases?.() || [];
      return databases
        .filter(d => d.name?.startsWith(StorePersistenceService.BACKUP_DB_PREFIX))
        .map(d => ({
          name: d.name!,
          date: d.name!.replace(StorePersistenceService.BACKUP_DB_PREFIX, '')
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch (err) {
      this.logger.error('获取备份列表失败', err);
      return [];
    }
  }

  /**
   * 清理过期备份（保留 7 天）
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const backups = await this.listBackups();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - StorePersistenceService.BACKUP_RETENTION_DAYS);
      const cutoffStr = cutoffDate.toISOString().split('T')[0].replace(/-/g, '');
      
      for (const backup of backups) {
        if (backup.date < cutoffStr) {
          await this.deleteBackup(backup.name);
        }
      }
    } catch (err) {
      this.logger.warn('清理过期备份失败', err);
    }
  }

  /**
   * 删除指定备份
   */
  async deleteBackup(backupDbName: string): Promise<boolean> {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(backupDbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
      this.logger.info('备份已删除', { backupDbName });
      return true;
    } catch (err) {
      this.logger.error('删除备份失败', { backupDbName, error: err });
      return false;
    }
  }
}

// ============================================================
// 【v5.9】离线数据完整性校验 - 类型定义（导出供外部使用）
// ============================================================

/**
 * 【v5.9】数据完整性校验结果
 */
export interface OfflineIntegrityResult {
  valid: boolean;
  issues: OfflineIntegrityIssue[];
  stats: {
    projectCount: number;
    taskCount: number;
    connectionCount: number;
    orphanedTasks: number;
    brokenConnections: number;
  };
  timestamp: number;
}

export interface OfflineIntegrityIssue {
  type: 'orphaned-task' | 'broken-connection' | 'missing-project' | 'invalid-data' | 'index-mismatch';
  entityId: string;
  projectId?: string;
  message: string;
  severity: 'error' | 'warning';
}