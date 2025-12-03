/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 使用 happy-dom 作为测试环境
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
  },
  
  // 解析配置
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
