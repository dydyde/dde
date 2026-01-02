/**
 * Vitest 测试设置文件
 * 配置全局模拟和测试环境
 * 
 * 优化策略（参考 PLAN.md 架构审核）：
 * - 全局 Sentry mock：避免每个测试文件重复定义
 * - 轻量级浏览器 API mock（单例模式）
 * - Angular TestBed 全局初始化（仅一次）
 * - 减少 beforeEach 开销
 */
import { vi, beforeEach } from 'vitest';

// ============================================
// 🔒 全局模块 Mock（在任何导入之前）
// ============================================

// 全局 Sentry Mock - 避免 SDK 初始化和网络调用
vi.mock('@sentry/angular', () => {
  const mockScope = { setExtras: vi.fn(), setTag: vi.fn(), setLevel: vi.fn() };
  return {
    init: vi.fn(),
    captureException: vi.fn().mockReturnValue('mock-event-id'),
    captureMessage: vi.fn().mockReturnValue('mock-event-id'),
    addBreadcrumb: vi.fn(),
    withScope: vi.fn((callback: (scope: unknown) => void) => callback(mockScope)),
    setUser: vi.fn(),
    setTag: vi.fn(),
    setExtra: vi.fn(),
    setContext: vi.fn(),
    browserTracingIntegration: vi.fn(() => ({})),
    replayIntegration: vi.fn(() => ({})),
    ErrorBoundary: vi.fn(({ children }: { children: unknown }) => children),
    TraceService: class MockTraceService {},
  };
});

// ============================================
// Angular TestBed 环境（条件初始化）
// ============================================
import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import { 
  BrowserDynamicTestingModule, 
  platformBrowserDynamicTesting 
} from '@angular/platform-browser-dynamic/testing';

// 初始化 Angular TestBed 环境 (全局只初始化一次)
const testBed = getTestBed();
if (!(testBed as unknown as { _initCalled?: boolean })._initCalled) {
  (testBed as unknown as { _initCalled: boolean })._initCalled = true;
  TestBed.initTestEnvironment(
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting(),
    { teardown: { destroyAfterEach: true } }
  );
}

// ============================================
// 浏览器 API Mock（轻量级，单例）
// ============================================

// localStorage mock
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => { localStorageStore[key] = value; },
  removeItem: (key: string) => { delete localStorageStore[key]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
  get length() { return Object.keys(localStorageStore).length; },
  key: (index: number) => Object.keys(localStorageStore)[index] || null,
};

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// navigator.onLine mock
Object.defineProperty(globalThis.navigator, 'onLine', {
  value: true,
  writable: true,
  configurable: true,
});

// crypto.randomUUID mock
if (!globalThis.crypto) {
  (globalThis as { crypto: object }).crypto = {};
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

// ============================================
// IndexedDB Mock（轻量级）
// ============================================
const indexedDBStores: Record<string, Record<string, unknown>> = {};

const createMockStore = (storeName: string) => ({
  put: vi.fn((record: { projectId: string }) => {
    const key = record.projectId;
    if (!indexedDBStores[storeName]) indexedDBStores[storeName] = {};
    indexedDBStores[storeName][key] = record;
    return { onsuccess: null, onerror: null };
  }),
  get: vi.fn((key: string) => {
    const result = indexedDBStores[storeName]?.[key] || null;
    return { onsuccess: null, onerror: null, result };
  }),
  getAll: vi.fn(() => {
    const result = Object.values(indexedDBStores[storeName] || {});
    return { onsuccess: null, onerror: null, result };
  }),
  delete: vi.fn((key: string) => {
    if (indexedDBStores[storeName]) delete indexedDBStores[storeName][key];
    return { onsuccess: null, onerror: null };
  }),
  count: vi.fn(() => {
    const result = Object.keys(indexedDBStores[storeName] || {}).length;
    return { onsuccess: null, onerror: null, result };
  }),
});

const indexedDBMock = {
  open: vi.fn(() => {
    const request = {
      result: {
        objectStoreNames: { contains: vi.fn(() => true) },
        transaction: vi.fn((_storeNames: string[]) => ({
          objectStore: vi.fn((name: string) => createMockStore(name)),
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

Object.defineProperty(globalThis, 'indexedDB', {
  value: indexedDBMock,
  writable: true,
  configurable: true,
});

// ============================================
// 清理函数
// ============================================
export function resetMocks() {
  localStorageMock.clear();
  // 清空 IndexedDB stores
  Object.keys(indexedDBStores).forEach(k => delete indexedDBStores[k]);
  vi.clearAllMocks();
}

// 设置全局清理（每个测试前重置）
beforeEach(() => {
  resetMocks();
});
