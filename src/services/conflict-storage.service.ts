/**
 * ConflictStorageService - 冲突数据持久化服务
 * 
 * 使用 IndexedDB 存储冲突时的完整本地数据，实现"隔离区"概念。
 * 
 * 设计原则：
 * - 当冲突发生且无法自动解决时，完整序列化本地脏数据
 * - 即使应用崩溃、网络断开，用户数据都在等待处理
 * - 只存元数据就像只留路标却清理了事故现场 —— 不负责任
 */
import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { Project } from '../models';

/** 冲突记录 */
export interface ConflictRecord {
  /** 项目 ID */
  projectId: string;
  /** 完整的本地项目数据（用户心血所在） */
  localProject: Project;
  /** 冲突发生时间 */
  conflictedAt: string;
  /** 本地版本号 */
  localVersion: number;
  /** 远程版本号（如果已知） */
  remoteVersion?: number;
  /** 冲突原因 */
  reason: 'version_mismatch' | 'concurrent_edit' | 'network_recovery';
}

const DB_NAME = 'nanoflow-conflicts';
const DB_VERSION = 1;
const STORE_NAME = 'conflicts';

@Injectable({
  providedIn: 'root'
})
export class ConflictStorageService {
  private readonly logger = inject(LoggerService).category('ConflictStorage');
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  
  /**
   * 初始化数据库连接
   * 使用懒加载，首次调用时才创建连接
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
        this.logger.info('IndexedDB 连接成功');
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 创建 conflicts 对象存储
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
          store.createIndex('conflictedAt', 'conflictedAt', { unique: false });
          this.logger.info('创建 conflicts 存储');
        }
      };
    });
    
    return this.dbPromise;
  }
  
  /**
   * 保存冲突数据到隔离区
   * 
   * 当检测到冲突时调用，完整保存本地数据
   * 这样即使用户下周才处理，数据也完好无损
   */
  async saveConflict(record: ConflictRecord): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        const request = store.put(record);
        
        request.onsuccess = () => {
          this.logger.info('冲突数据已保存到隔离区', {
            projectId: record.projectId,
            localVersion: record.localVersion,
            taskCount: record.localProject.tasks.length
          });
          resolve(true);
        };
        
        request.onerror = () => {
          this.logger.error('保存冲突数据失败', request.error);
          reject(request.error);
        };
      });
    } catch (e) {
      this.logger.error('保存冲突数据时发生异常', e);
      // 降级：尝试使用 localStorage
      return this.fallbackSaveToLocalStorage(record);
    }
  }
  
  /**
   * 获取指定项目的冲突数据
   */
  async getConflict(projectId: string): Promise<ConflictRecord | null> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        
        const request = store.get(projectId);
        
        request.onsuccess = () => {
          resolve(request.result || null);
        };
        
        request.onerror = () => {
          this.logger.error('读取冲突数据失败', request.error);
          reject(request.error);
        };
      });
    } catch (e) {
      this.logger.error('读取冲突数据时发生异常', e);
      // 降级：尝试从 localStorage 读取
      return this.fallbackLoadFromLocalStorage(projectId);
    }
  }
  
  /**
   * 获取所有待处理的冲突
   */
  async getAllConflicts(): Promise<ConflictRecord[]> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        
        const request = store.getAll();
        
        request.onsuccess = () => {
          resolve(request.result || []);
        };
        
        request.onerror = () => {
          this.logger.error('读取所有冲突数据失败', request.error);
          reject(request.error);
        };
      });
    } catch (e) {
      this.logger.error('读取所有冲突数据时发生异常', e);
      return [];
    }
  }
  
  /**
   * 冲突解决后删除记录
   */
  async deleteConflict(projectId: string): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        const request = store.delete(projectId);
        
        request.onsuccess = () => {
          this.logger.info('冲突数据已从隔离区移除', { projectId });
          // 同时清理可能存在的 localStorage 降级数据
          this.clearLocalStorageFallback(projectId);
          resolve(true);
        };
        
        request.onerror = () => {
          this.logger.error('删除冲突数据失败', request.error);
          reject(request.error);
        };
      });
    } catch (e) {
      this.logger.error('删除冲突数据时发生异常', e);
      return false;
    }
  }
  
  /**
   * 检查是否有待处理的冲突
   */
  async hasConflicts(): Promise<boolean> {
    try {
      const db = await this.getDb();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        
        const request = store.count();
        
        request.onsuccess = () => {
          resolve(request.result > 0);
        };
        
        request.onerror = () => {
          reject(request.error);
        };
      });
    } catch {
      // 检查 localStorage 降级
      return this.hasLocalStorageFallback();
    }
  }
  
  // ========== LocalStorage 降级处理 ==========
  
  private readonly FALLBACK_KEY_PREFIX = 'nanoflow.conflict.';
  
  private fallbackSaveToLocalStorage(record: ConflictRecord): boolean {
    try {
      const key = `${this.FALLBACK_KEY_PREFIX}${record.projectId}`;
      localStorage.setItem(key, JSON.stringify(record));
      this.logger.warn('使用 localStorage 降级保存冲突数据');
      return true;
    } catch (e) {
      this.logger.error('localStorage 降级保存也失败了', e);
      return false;
    }
  }
  
  private fallbackLoadFromLocalStorage(projectId: string): ConflictRecord | null {
    try {
      const key = `${this.FALLBACK_KEY_PREFIX}${projectId}`;
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }
  
  private clearLocalStorageFallback(projectId: string): void {
    try {
      const key = `${this.FALLBACK_KEY_PREFIX}${projectId}`;
      localStorage.removeItem(key);
    } catch {
      // 忽略清理失败
    }
  }
  
  private hasLocalStorageFallback(): boolean {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(this.FALLBACK_KEY_PREFIX)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
  
  // ========== 测试支持 ==========
  
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
}
