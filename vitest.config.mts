/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 使用 cacheDir 替代弃用的 cache.dir
  cacheDir: 'node_modules/.vitest',
  
  test: {
    // 使用 happy-dom 作为测试环境（比 jsdom 更快）
    environment: 'happy-dom',
    
    // 全局 API 无需导入
    globals: true,
    
    // 包含测试文件
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    
    // 排除的文件
    exclude: ['node_modules', 'dist', 'e2e'],
    
    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/services/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.test.ts',
        'src/**/index.ts',
      ],
    },
    
    // ============================================
    // 超时配置（性能优化）
    // ============================================
    // 标准测试超时：2 秒足够（使用 fake timers 模拟长时间操作）
    testTimeout: 2000,
    // 钩子超时：每个 beforeEach/afterEach 限制 1 秒
    hookTimeout: 1000,
    
    // 模拟 localStorage 和其他浏览器 API
    setupFiles: ['./src/test-setup.ts'],
    
    // ============================================
    // 性能优化配置（参考架构审核报告）
    // ============================================
    
    // 使用 threads 池模式，比 forks 更快（共享内存）
    pool: 'threads',
    poolOptions: {
      threads: {
        // 并行模式：充分利用多核 CPU
        minThreads: 4,
        maxThreads: 8,
        // 隔离：共享 worker 减少初始化开销
        isolate: false,
        // 单线程模式可提高稳定性
        singleThread: false,
      },
    },
    
    // 减少隔离开销：文件间共享环境
    // 注意：需确保测试不互相污染状态
    fileParallelism: true,
    
    // 序列化运行以减少内存压力和初始化开销
    sequence: {
      // 按文件名排序，使缓存更有效
      shuffle: false,
    },
    
    // 减少日志噪音
    reporters: ['default'],
    
    // 禁用 watch 模式下的类型检查（加速）
    typecheck: {
      enabled: false,
    },
    
    // 依赖优化：减少模块解析时间
    deps: {
      // 内联转换常用依赖（加速模块解析）
      optimizer: {
        web: {
          include: ['@angular/*', 'rxjs', 'zone.js'],
        },
      },
      // 依赖外部化配置
      moduleDirectories: ['node_modules'],
    },
    
    // ============================================
    // 环境缓存优化
    // ============================================
    // 单次全局 setup（减少重复初始化）
    globalSetup: undefined, // 使用 setupFiles 代替
    
    // 禁用 CSS 处理（加速）
    css: {
      include: [],
    },
    
    // 快照配置
    snapshotFormat: {
      printBasicPrototype: false,
    },
  },
  
  // 解析配置
  resolve: {
    alias: {
      '@': '/src',
    },
    // 减少模块解析尝试
    extensions: ['.ts', '.js', '.json'],
  },
  
  // 优化依赖预构建
  optimizeDeps: {
    // 强制预构建（避免运行时转换）
    force: false,
    include: [
      // Angular 核心测试模块
      'zone.js', 
      'zone.js/testing', 
      '@angular/core',
      '@angular/core/testing',
      '@angular/platform-browser',
      '@angular/platform-browser-dynamic',
      '@angular/platform-browser-dynamic/testing',
      '@angular/common',
      '@angular/router',
      '@angular/router/testing',
      // RxJS (常用)
      'rxjs',
      'rxjs/operators',
    ],
    // 排除已被 mock 的模块
    exclude: ['@sentry/angular'],
    // 条目限制
    entries: ['src/**/*.spec.ts'],
  },
  
  // ESBuild 配置优化
  esbuild: {
    // 目标平台
    target: 'es2022',
    // 保留名称（便于调试）
    keepNames: true,
  },
  
  // 构建优化
  build: {
    // 使用 esbuild 压缩
    minify: 'esbuild',
    // 目标
    target: 'es2022',
  },
});
