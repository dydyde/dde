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
    
    // 设置超时
    testTimeout: 10000,
    
    // 模拟 localStorage 和其他浏览器 API
    setupFiles: ['./src/test-setup.ts'],
    
    // ============================================
    // 性能优化配置（参考 PLAN.md 架构审核）
    // ============================================
    
    // 使用 threads 池模式，比 forks 更快（共享内存）
    pool: 'threads',
    poolOptions: {
      threads: {
        // 并行模式：利用多核 CPU
        minThreads: 1,
        maxThreads: 4,
        // 单线程模式测试稳定性（Angular 可能需要）
        // singleThread: true,
      },
    },
    
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
  },
  
  // 解析配置
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  
  // 优化依赖预构建
  optimizeDeps: {
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
      // RxJS (常用)
      'rxjs',
      'rxjs/operators',
    ],
    // 排除已被 mock 的模块
    exclude: ['@sentry/angular'],
  },
  
  // ESBuild 配置优化
  esbuild: {
    // 移除测试中的 console 语句（可选，减少输出）
    // drop: ['console'],
  },
});
