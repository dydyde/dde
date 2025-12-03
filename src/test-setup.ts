/**
 * Vitest 测试设置文件
 * 配置全局模拟和测试环境
 */
import { vi } from 'vitest';
import 'zone.js';
import 'zone.js/testing';
import { TestBed } from '@angular/core/testing';
import { 
  BrowserDynamicTestingModule, 
  platformBrowserDynamicTesting 
} from '@angular/platform-browser-dynamic/testing';

// 初始化 Angular TestBed 环境 (全局只初始化一次)
TestBed.initTestEnvironment(
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting(),
  { teardown: { destroyAfterEach: true } }
);

// 模拟 localStorage
const createLocalStorageMock = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] || null,
  };
};

const localStorageMock = createLocalStorageMock();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// 模拟 navigator.onLine
Object.defineProperty(globalThis.navigator, 'onLine', {
  value: true,
  writable: true,
  configurable: true,
});

// 模拟 crypto.randomUUID
if (!globalThis.crypto) {
  (globalThis as any).crypto = {};
}
if (!globalThis.crypto.randomUUID) {
  globalThis.crypto.randomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }) as `${string}-${string}-${string}-${string}-${string}`;
  };
}

// 模拟 IndexedDB（用于 ConflictStorageService）
const createIndexedDBMock = () => {
  const stores: Record<string, Record<string, unknown>> = {};
  
  const mockStore = (storeName: string) => ({
    put: vi.fn((record: { projectId: string }) => {
      const key = record.projectId;
      if (!stores[storeName]) stores[storeName] = {};
      stores[storeName][key] = record;
      return { onsuccess: null, onerror: null };
    }),
    get: vi.fn((key: string) => {
      const result = stores[storeName]?.[key] || null;
      return { onsuccess: null, onerror: null, result };
    }),
    getAll: vi.fn(() => {
      const result = Object.values(stores[storeName] || {});
      return { onsuccess: null, onerror: null, result };
    }),
    delete: vi.fn((key: string) => {
      if (stores[storeName]) delete stores[storeName][key];
      return { onsuccess: null, onerror: null };
    }),
    count: vi.fn(() => {
      const result = Object.keys(stores[storeName] || {}).length;
      return { onsuccess: null, onerror: null, result };
    }),
  });
  
  return {
    open: vi.fn(() => {
      const request = {
        result: {
          objectStoreNames: { contains: vi.fn(() => true) },
          transaction: vi.fn((storeNames: string[]) => ({
            objectStore: vi.fn((name: string) => mockStore(name)),
          })),
          close: vi.fn(),
        },
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as ((event: { target: { result: unknown } }) => void) | null,
      };
      // 模拟异步成功回调
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    }),
  };
};

Object.defineProperty(globalThis, 'indexedDB', {
  value: createIndexedDBMock(),
  writable: true,
  configurable: true,
});

// 清理函数 - 在每个测试后重置模拟
export function resetMocks() {
  localStorageMock.clear();
  vi.clearAllMocks();
}

// 设置全局清理
beforeEach(() => {
  resetMocks();
});
