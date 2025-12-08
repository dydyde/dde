/**
 * BaseSnapshotService - 基准快照存储服务
 * 
 * 实现三路合并（3-Way Merge）中的 Base（基准版本）管理。
 * Base 是上一次成功同步时的"快照"，是 Local 和 Remote 的共同祖先。
 * 
 * 设计原则：
 * - 每次 Pull 或 Push 成功后，将当前数据写入 Base
 * - Base 作为下次同步的参照标准
 * - 通过对比 Base、Local、Remote 三方，可以精确判断"谁改了什么"
 * 
 * 存储策略：
 * - 使用 IndexedDB 存储完整的项目快照
 * - 按项目 ID 索引，支持快速查询
 * - 自动清理过期数据（超过30天未访问的项目）
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';

/** Base 快照记录 */
export interface BaseSnapshot {
  /** 项目 ID */
  projectId: string;
  /** 完整的项目数据快照 */
  project: Project;
  /** 快照创建时间 */
  createdAt: string;
  /** 快照时的版本号 */
  version: number;
  /** 最后访问时间（用于清理策略） */
  lastAccessedAt: string;
}

/** 任务级别的快照（用于细粒度合并） */
export interface TaskSnapshot {
  taskId: string;
  projectId: string;
  task: Task;
  version: number;
  createdAt: string;
}

const DB_NAME = 'nanoflow-base-snapshots';
const DB_VERSION = 1;
const PROJECT_STORE_NAME = 'project-snapshots';
const TASK_STORE_NAME = 'task-snapshots';

/** 快照过期时间：30天 */
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable({
  providedIn: 'root'
})
export class BaseSnapshotService {
  private readonly logger = inject(LoggerService).category('BaseSnapshot');
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  
  /**
   * 初始化数据库连接
   */
  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    
    if (this.dbPromise) return this.dbPromise;
    
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => {
        this.logger.error('打开 IndexedDB 失败', request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        this.logger.info('Base Snapshot IndexedDB 连接成功');
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 创建项目快照存储
        if (!db.objectStoreNames.contains(PROJECT_STORE_NAME)) {
          const projectStore = db.createObjectStore(PROJECT_STORE_NAME, { keyPath: 'projectId' });
          projectStore.createIndex('createdAt', 'createdAt', { unique: false });
          projectStore.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
          this.logger.info('创建 project-snapshots 存储');
        }
        
        // 创建任务快照存储（用于任务级别的细粒度合并）
        if (!db.objectStoreNames.contains(TASK_STORE_NAME)) {
          const taskStore = db.createObjectStore(TASK_STORE_NAME, { keyPath: ['projectId', 'taskId'] });
          taskStore.createIndex('projectId', 'projectId', { unique: false });
          taskStore.createIndex('createdAt', 'createdAt', { unique: false });
          this.logger.info('创建 task-snapshots 存储');
        }
      };
    });
    
    return this.dbPromise;
  }
  
  // ========== 项目级别操作 ==========
  
  /**
   * 保存项目的 Base 快照
   * 
   * 调用时机：
   * - Pull 成功后：将拉取的远程数据作为 Base
   * - Push 成功后：将推送的本地数据作为 Base
   * 
   * @param project 项目数据
   * @returns 是否保存成功
   */
  async saveProjectSnapshot(project: Project): Promise<boolean> {
    try {
      const db = await this.getDb();
      const now = new Date().toISOString();
      
      const snapshot: BaseSnapshot = {
        projectId: project.id,
        project: this.cloneProject(project),
        createdAt: now,
        version: project.version ?? 0,
        lastAccessedAt: now
      };
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECT_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PROJECT_STORE_NAME);
        
        const request = store.put(snapshot);
        
        request.onsuccess = () => {
          this.logger.debug('Base 快照已保存', {
            projectId: project.id,
            version: project.version,
            taskCount: project.tasks.length
          });
          resolve(true);
        };
        
        request.onerror = () => {
          this.logger.error('保存 Base 快照失败', request.error);
          reject(request.error);
        };
      });
    } catch (e) {
      this.logger.error('保存 Base 快照时发生异常', e);
      return false;
    }
  }
  
  /**
   * 获取项目的 Base 快照
   * 
   * @param projectId 项目 ID
   * @returns Base 快照，如果不存在则返回 null
   */
  async getProjectSnapshot(projectId: string): Promise<Project | null> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECT_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PROJECT_STORE_NAME);
        
        const request = store.get(projectId);
        
        request.onsuccess = () => {
          const snapshot = request.result as BaseSnapshot | undefined;
          if (snapshot) {
            // 更新最后访问时间
            snapshot.lastAccessedAt = new Date().toISOString();
            store.put(snapshot);
            
            this.logger.debug('读取 Base 快照', {
              projectId,
              version: snapshot.version,
              taskCount: snapshot.project.tasks.length
            });
            resolve(snapshot.project);
          } else {
            resolve(null);
          }
        };
        
        request.onerror = () => {
          this.logger.error('读取 Base 快照失败', request.error);
          reject(request.error);
        };
      });
    } catch (e) {
      this.logger.error('读取 Base 快照时发生异常', e);
      return null;
    }
  }
  
  /**
   * 获取 Base 快照的版本号
   * 快速检查，不加载完整数据
   */
  async getSnapshotVersion(projectId: string): Promise<number | null> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECT_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PROJECT_STORE_NAME);
        
        const request = store.get(projectId);
        
        request.onsuccess = () => {
          const snapshot = request.result as BaseSnapshot | undefined;
          resolve(snapshot?.version ?? null);
        };
        
        request.onerror = () => {
          reject(request.error);
        };
      });
    } catch {
      return null;
    }
  }
  
  /**
   * 删除项目的 Base 快照
   */
  async deleteProjectSnapshot(projectId: string): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECT_STORE_NAME, TASK_STORE_NAME], 'readwrite');
        const projectStore = transaction.objectStore(PROJECT_STORE_NAME);
        const taskStore = transaction.objectStore(TASK_STORE_NAME);
        
        // 删除项目快照
        projectStore.delete(projectId);
        
        // 删除该项目的所有任务快照
        const taskIndex = taskStore.index('projectId');
        const taskRequest = taskIndex.openCursor(IDBKeyRange.only(projectId));
        
        taskRequest.onsuccess = () => {
          const cursor = taskRequest.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        
        transaction.oncomplete = () => {
          this.logger.info('Base 快照已删除', { projectId });
          resolve(true);
        };
        
        transaction.onerror = () => {
          reject(transaction.error);
        };
      });
    } catch (e) {
      this.logger.error('删除 Base 快照时发生异常', e);
      return false;
    }
  }
  
  // ========== 任务级别操作 ==========
  
  /**
   * 保存单个任务的快照
   * 用于任务级别的细粒度合并
   */
  async saveTaskSnapshot(projectId: string, task: Task, version: number): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      const snapshot: TaskSnapshot = {
        taskId: task.id,
        projectId,
        task: { ...task },
        version,
        createdAt: new Date().toISOString()
      };
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([TASK_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(TASK_STORE_NAME);
        
        const request = store.put(snapshot);
        
        request.onsuccess = () => resolve(true);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return false;
    }
  }
  
  /**
   * 获取任务的 Base 快照
   */
  async getTaskSnapshot(projectId: string, taskId: string): Promise<Task | null> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([TASK_STORE_NAME], 'readonly');
        const store = transaction.objectStore(TASK_STORE_NAME);
        
        const request = store.get([projectId, taskId]);
        
        request.onsuccess = () => {
          const snapshot = request.result as TaskSnapshot | undefined;
          resolve(snapshot?.task ?? null);
        };
        
        request.onerror = () => {
          reject(request.error);
        };
      });
    } catch {
      return null;
    }
  }
  
  // ========== 清理操作 ==========
  
  /**
   * 清理过期的快照
   * 删除超过30天未访问的项目快照
   */
  async cleanupExpiredSnapshots(): Promise<number> {
    try {
      const db = await this.getDb();
      const expiryTime = new Date(Date.now() - SNAPSHOT_TTL_MS).toISOString();
      let deletedCount = 0;
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECT_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(PROJECT_STORE_NAME);
        const index = store.index('lastAccessedAt');
        
        const range = IDBKeyRange.upperBound(expiryTime);
        const request = index.openCursor(range);
        
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            deletedCount++;
            cursor.continue();
          }
        };
        
        transaction.oncomplete = () => {
          if (deletedCount > 0) {
            this.logger.info('清理过期快照', { deletedCount });
          }
          resolve(deletedCount);
        };
        
        transaction.onerror = () => {
          reject(transaction.error);
        };
      });
    } catch (e) {
      this.logger.error('清理过期快照时发生异常', e);
      return 0;
    }
  }
  
  /**
   * 检查是否存在 Base 快照
   */
  async hasSnapshot(projectId: string): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECT_STORE_NAME], 'readonly');
        const store = transaction.objectStore(PROJECT_STORE_NAME);
        
        const request = store.count(projectId);
        
        request.onsuccess = () => {
          resolve(request.result > 0);
        };
        
        request.onerror = () => {
          reject(request.error);
        };
      });
    } catch {
      return false;
    }
  }
  
  // ========== 工具方法 ==========
  
  /**
   * 深拷贝项目数据
   * 确保存储的是独立副本，不会被外部修改影响
   */
  private cloneProject(project: Project): Project {
    return {
      ...project,
      tasks: project.tasks.map(t => ({ ...t, attachments: t.attachments?.map(a => ({ ...a })) })),
      connections: project.connections.map(c => ({ ...c }))
    };
  }
  
  /**
   * 重置服务状态（用于测试）
   */
  reset(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.dbPromise = null;
  }
  
  /**
   * 清空所有快照（用于测试或用户请求）
   */
  async clearAll(): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([PROJECT_STORE_NAME, TASK_STORE_NAME], 'readwrite');
        
        transaction.objectStore(PROJECT_STORE_NAME).clear();
        transaction.objectStore(TASK_STORE_NAME).clear();
        
        transaction.oncomplete = () => {
          this.logger.info('所有 Base 快照已清空');
          resolve(true);
        };
        
        transaction.onerror = () => {
          reject(transaction.error);
        };
      });
    } catch (e) {
      this.logger.error('清空 Base 快照时发生异常', e);
      return false;
    }
  }
}
