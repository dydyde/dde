import { Injectable, InjectionToken, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';

/**
 * 存储适配器接口
 * 定义了异步存储操作的标准接口
 * 所有存储实现（LocalStorage、IndexedDB）都需要实现此接口
 */
export interface StorageAdapter {
  /** 获取数据 */
  get<T>(key: string): Promise<T | null>;
  /** 设置数据 */
  set<T>(key: string, value: T): Promise<boolean>;
  /** 删除数据 */
  remove(key: string): Promise<boolean>;
  /** 清空所有数据 */
  clear(): Promise<boolean>;
  /** 获取所有键名 */
  keys(): Promise<string[]>;
  /** 检查键是否存在 */
  has(key: string): Promise<boolean>;
  /** 获取存储使用量（字节） */
  getUsedSpace(): Promise<number>;
  /** 获取存储配额（字节），返回 null 表示无法获取 */
  getQuota(): Promise<number | null>;
}

/**
 * 存储状态
 */
export interface StorageState {
  /** 当前使用的适配器类型 */
  adapterType: 'localStorage' | 'indexedDB' | 'memory';
  /** 是否可用 */
  isAvailable: boolean;
  /** 已使用空间（字节） */
  usedSpace: number;
  /** 配额（字节） */
  quota: number | null;
  /** 最近的错误 */
  lastError: string | null;
}

/**
 * 存储适配器注入令牌
 * 允许在测试中替换存储实现
 */
export const STORAGE_ADAPTER = new InjectionToken<StorageAdapter>('STORAGE_ADAPTER');

/**
 * LocalStorage 适配器
 * 使用 localStorage 作为底层存储
 * 注意：localStorage 是同步的，但接口保持异步以便未来迁移
 */
@Injectable()
export class LocalStorageAdapter implements StorageAdapter {
  private readonly PREFIX = 'nanoflow.';
  
  async get<T>(key: string): Promise<T | null> {
    try {
      const fullKey = this.PREFIX + key;
      const value = localStorage.getItem(fullKey);
      if (value === null) return null;
      return JSON.parse(value) as T;
    } catch (e) {
      console.warn(`[LocalStorageAdapter] Failed to get ${key}:`, e);
      return null;
    }
  }
  
  async set<T>(key: string, value: T): Promise<boolean> {
    try {
      const fullKey = this.PREFIX + key;
      const serialized = JSON.stringify(value);
      localStorage.setItem(fullKey, serialized);
      return true;
    } catch (e: unknown) {
      // 检测配额溢出
      const err = e as { name?: string; code?: number; message?: string };
      if (err?.name === 'QuotaExceededError' || err?.code === 22) {
        console.error(`[LocalStorageAdapter] Quota exceeded for ${key}`);
        throw new StorageQuotaError(`存储空间不足，无法保存 ${key}`);
      }
      console.warn(`[LocalStorageAdapter] Failed to set ${key}:`, e);
      return false;
    }
  }
  
  async remove(key: string): Promise<boolean> {
    try {
      const fullKey = this.PREFIX + key;
      localStorage.removeItem(fullKey);
      return true;
    } catch (e) {
      console.warn(`[LocalStorageAdapter] Failed to remove ${key}:`, e);
      return false;
    }
  }
  
  async clear(): Promise<boolean> {
    try {
      // 只清除带有前缀的键
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(this.PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
      return true;
    } catch (e) {
      console.warn('[LocalStorageAdapter] Failed to clear:', e);
      return false;
    }
  }
  
  async keys(): Promise<string[]> {
    const result: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.PREFIX)) {
        result.push(key.substring(this.PREFIX.length));
      }
    }
    return result;
  }
  
  async has(key: string): Promise<boolean> {
    const fullKey = this.PREFIX + key;
    return localStorage.getItem(fullKey) !== null;
  }
  
  async getUsedSpace(): Promise<number> {
    let totalSize = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.PREFIX)) {
        const value = localStorage.getItem(key) ?? '';
        // 计算 UTF-16 编码的字节数
        totalSize += (key.length + value.length) * 2;
      }
    }
    return totalSize;
  }
  
  async getQuota(): Promise<number | null> {
    // localStorage 通常限制为 5MB
    return 5 * 1024 * 1024;
  }
}

/**
 * IndexedDB 适配器
 * 使用 IndexedDB 作为底层存储
 * 支持更大的存储容量和异步操作
 */
@Injectable()
export class IndexedDBAdapter implements StorageAdapter {
  private readonly DB_NAME = 'nanoflow-storage';
  private readonly STORE_NAME = 'keyvalue';
  private readonly DB_VERSION = 1;
  
  private db: IDBDatabase | null = null;
  private initPromise: Promise<IDBDatabase> | null = null;
  
  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    
    if (!this.initPromise) {
      this.initPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this.db = request.result;
          resolve(request.result);
        };
        
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(this.STORE_NAME)) {
            db.createObjectStore(this.STORE_NAME);
          }
        };
      });
    }
    
    return this.initPromise;
  }
  
  async get<T>(key: string): Promise<T | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.STORE_NAME, 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.get(key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }
  
  async set<T>(key: string, value: T): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.STORE_NAME, 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.put(value, key);
      
      request.onerror = () => {
        if (request.error?.name === 'QuotaExceededError') {
          reject(new StorageQuotaError(`存储空间不足，无法保存 ${key}`));
        } else {
          reject(request.error);
        }
      };
      request.onsuccess = () => resolve(true);
    });
  }
  
  async remove(key: string): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.STORE_NAME, 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.delete(key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  }
  
  async clear(): Promise<boolean> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.STORE_NAME, 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.clear();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(true);
    });
  }
  
  async keys(): Promise<string[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.STORE_NAME, 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);
      const request = store.getAllKeys();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result.map(k => String(k)));
    });
  }
  
  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }
  
  async getUsedSpace(): Promise<number> {
    // IndexedDB 的使用量估算
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      return estimate.usage ?? 0;
    }
    return 0;
  }
  
  async getQuota(): Promise<number | null> {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      return estimate.quota ?? null;
    }
    return null;
  }
}

/**
 * 内存适配器
 * 仅用于测试或 SSR 环境
 */
@Injectable()
export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, unknown>();
  
  async get<T>(key: string): Promise<T | null> {
    return this.store.get(key) ?? null;
  }
  
  async set<T>(key: string, value: T): Promise<boolean> {
    this.store.set(key, value);
    return true;
  }
  
  async remove(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  
  async clear(): Promise<boolean> {
    this.store.clear();
    return true;
  }
  
  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
  
  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  
  async getUsedSpace(): Promise<number> {
    // 粗略估算
    let size = 0;
    this.store.forEach((v, k) => {
      size += k.length * 2 + JSON.stringify(v).length * 2;
    });
    return size;
  }
  
  async getQuota(): Promise<number | null> {
    return null;
  }
}

/**
 * 存储配额错误
 */
export class StorageQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

/**
 * 存储适配器服务
 * 提供统一的存储访问接口，自动选择最佳的存储后端
 * 
 * 特性：
 * - 自动检测 IndexedDB 可用性，优先使用
 * - 回退到 localStorage
 * - SSR 环境使用内存存储
 * - 配额溢出时自动清理旧数据（可配置）
 * - 状态监控
 */
@Injectable({
  providedIn: 'root'
})
export class StorageAdapterService {
  private readonly loggerService = inject(LoggerService);
  private logger = this.loggerService.category('Storage');
  
  /** 当前使用的适配器 */
  private adapter: StorageAdapter | null = null;
  
  /** 存储状态 */
  readonly state = signal<StorageState>({
    adapterType: 'memory',
    isAvailable: false,
    usedSpace: 0,
    quota: null,
    lastError: null
  });
  
  /** 是否使用 IndexedDB */
  readonly isUsingIndexedDB = computed(() => this.state().adapterType === 'indexedDB');
  
  /** 使用百分比 */
  readonly usagePercent = computed(() => {
    const { usedSpace, quota } = this.state();
    if (!quota) return 0;
    return Math.round((usedSpace / quota) * 100);
  });
  
  /** 初始化 Promise */
  private initPromise: Promise<void> | null = null;
  
  constructor() {
    void this.init();
  }
  
  /**
   * 初始化存储适配器
   * 按优先级尝试：IndexedDB -> localStorage -> memory
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    
    this.initPromise = this.doInit();
    return this.initPromise;
  }
  
  private async doInit(): Promise<void> {
    // SSR 检测
    if (typeof window === 'undefined') {
      this.adapter = new MemoryStorageAdapter();
      this.state.update(s => ({ ...s, adapterType: 'memory', isAvailable: true }));
      return;
    }
    
    // 尝试 IndexedDB
    if (await this.isIndexedDBAvailable()) {
      try {
        this.adapter = new IndexedDBAdapter();
        // 测试写入
        await this.adapter.set('_test', 'test');
        await this.adapter.remove('_test');
        
        this.state.update(s => ({ ...s, adapterType: 'indexedDB', isAvailable: true }));
        this.logger.info('使用 IndexedDB 存储');
        await this.updateStorageStats();
        return;
      } catch (e) {
        this.logger.warn('IndexedDB 初始化失败，回退到 localStorage', e);
      }
    }
    
    // 回退到 localStorage
    if (this.isLocalStorageAvailable()) {
      try {
        this.adapter = new LocalStorageAdapter();
        this.state.update(s => ({ ...s, adapterType: 'localStorage', isAvailable: true }));
        this.logger.info('使用 localStorage 存储');
        await this.updateStorageStats();
        return;
      } catch (e) {
        this.logger.warn('localStorage 初始化失败', e);
      }
    }
    
    // 最后回退到内存
    this.adapter = new MemoryStorageAdapter();
    this.state.update(s => ({ ...s, adapterType: 'memory', isAvailable: true }));
    this.logger.warn('使用内存存储（数据不会持久化）');
  }
  
  private async isIndexedDBAvailable(): Promise<boolean> {
    if (!('indexedDB' in window)) return false;
    
    try {
      // 测试 IndexedDB 是否真正可用（隐私模式可能阻止）
      const testRequest = indexedDB.open('_test_db');
      await new Promise<void>((resolve, reject) => {
        testRequest.onerror = () => reject(testRequest.error);
        testRequest.onsuccess = () => {
          testRequest.result.close();
          indexedDB.deleteDatabase('_test_db');
          resolve();
        };
      });
      return true;
    } catch {
      return false;
    }
  }
  
  private isLocalStorageAvailable(): boolean {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }
  
  private async updateStorageStats(): Promise<void> {
    if (!this.adapter) return;
    
    try {
      const [usedSpace, quota] = await Promise.all([
        this.adapter.getUsedSpace(),
        this.adapter.getQuota()
      ]);
      this.state.update(s => ({ ...s, usedSpace, quota }));
    } catch (e) {
      this.logger.warn('获取存储统计失败', e);
    }
  }
  
  // ========== 公共 API ==========
  
  /**
   * 获取数据
   */
  async get<T>(key: string): Promise<T | null> {
    await this.init();
    try {
      return await this.adapter!.get<T>(key);
    } catch (e: unknown) {
      const err = e as { message?: string };
      this.state.update(s => ({ ...s, lastError: err?.message ?? String(e) }));
      this.logger.error(`获取 ${key} 失败`, e);
      return null;
    }
  }
  
  /**
   * 设置数据
   * 配额溢出时抛出 StorageQuotaError
   */
  async set<T>(key: string, value: T): Promise<boolean> {
    await this.init();
    try {
      const result = await this.adapter!.set(key, value);
      if (result) {
        void this.updateStorageStats();
      }
      return result;
    } catch (e: unknown) {
      const err = e as { message?: string };
      this.state.update(s => ({ ...s, lastError: err?.message ?? String(e) }));
      
      if (e instanceof StorageQuotaError) {
        this.logger.error('存储配额已满', { key });
        throw e;
      }
      
      this.logger.error(`设置 ${key} 失败`, e);
      return false;
    }
  }
  
  /**
   * 删除数据
   */
  async remove(key: string): Promise<boolean> {
    await this.init();
    try {
      const result = await this.adapter!.remove(key);
      if (result) {
        void this.updateStorageStats();
      }
      return result;
    } catch (e: unknown) {
      const err = e as { message?: string };
      this.state.update(s => ({ ...s, lastError: err?.message ?? String(e) }));
      this.logger.error(`删除 ${key} 失败`, e);
      return false;
    }
  }
  
  /**
   * 清空所有数据
   */
  async clear(): Promise<boolean> {
    await this.init();
    try {
      const result = await this.adapter!.clear();
      if (result) {
        void this.updateStorageStats();
      }
      return result;
    } catch (e: unknown) {
      const err = e as { message?: string };
      this.state.update(s => ({ ...s, lastError: err?.message ?? String(e) }));
      this.logger.error('清空存储失败', e);
      return false;
    }
  }
  
  /**
   * 检查键是否存在
   */
  async has(key: string): Promise<boolean> {
    await this.init();
    try {
      return await this.adapter!.has(key);
    } catch {
      return false;
    }
  }
  
  /**
   * 获取所有键
   */
  async keys(): Promise<string[]> {
    await this.init();
    try {
      return await this.adapter!.keys();
    } catch {
      return [];
    }
  }
  
  // ========== 状态管理 ==========
  
  /**
   * 显式重置服务状态
   * 用于测试环境的 afterEach 或 HMR 重载
   */
  reset(): void {
    this.adapter = null;
    this.initPromise = null;
    this.state.set({
      adapterType: 'memory',
      isAvailable: false,
      usedSpace: 0,
      quota: null,
      lastError: null
    });
  }
}
