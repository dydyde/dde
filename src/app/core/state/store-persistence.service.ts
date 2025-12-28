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
      
      this.logger.debug('项目数据已保存', { 
        projectId, 
        tasksCount: tasks.length, 
        connectionsCount: connections.length 
      });
    } catch (err) {
      this.logger.error('保存项目数据失败', { projectId, error: err });
      Sentry.captureException(err, { tags: { operation: 'saveProjectData', projectId } });
      // 静默失败，不影响运行时
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
}
