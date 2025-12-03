import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import rxjsX from 'eslint-plugin-rxjs-x';

/**
 * ESLint 配置
 * 
 * 重点规则说明：
 * 1. @typescript-eslint/no-floating-promises - 防止未处理的 Promise
 *    对于 fire-and-forget 场景，使用 void 前缀明确意图
 * 
 * 2. rxjs-x/no-ignored-subscription - 防止订阅泄漏
 *    强制订阅必须被赋值给变量或使用 takeUntil/takeUntilDestroyed
 * 
 * 如果这些规则报错过多，说明架构可能太依赖手动订阅，这是重构信号。
 */
export default [
  eslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/test-setup.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'rxjs-x': rxjsX
    },
    rules: {
      // ========== TypeScript 严格规则 ==========
      
      // 防止未处理的 Promise（代码异味探测器）
      // 对于刻意的 fire-and-forget，使用 void myAsyncFunc()
      '@typescript-eslint/no-floating-promises': 'warn',
      
      // 防止使用 any 类型
      '@typescript-eslint/no-explicit-any': 'warn',
      
      // 要求显式的函数返回类型（仅对导出函数）
      '@typescript-eslint/explicit-function-return-type': 'off',
      
      // 防止未使用的变量
      '@typescript-eslint/no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      
      // ========== RxJS 订阅安全规则 ==========
      
      // 防止忽略订阅（必须赋值给变量或管道中处理）
      // 这是内存泄漏的主要来源
      'rxjs-x/no-ignored-subscription': 'warn',
      
      // 防止在 subscribe 中嵌套 subscribe
      'rxjs-x/no-nested-subscribe': 'error',
      
      // 防止使用已废弃的 RxJS 特性
      'rxjs-x/no-internal': 'error',
      
      // 推荐使用 takeUntilDestroyed
      'rxjs-x/prefer-takeuntil': ['warn', {
        alias: ['takeUntilDestroyed']
      }],
      
      // ========== 基础规则覆盖 ==========
      
      // 允许使用 console（日志服务内部使用）
      'no-console': 'off',
      
      // 允许空函数（回调占位符）
      'no-empty-function': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      
      // 关闭原生规则，使用 TS 版本
      'no-unused-vars': 'off',
      'no-undef': 'off'
    }
  },
  {
    // 测试文件放宽规则
    files: ['**/*.spec.ts', '**/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'rxjs-x/no-ignored-subscription': 'off'
    }
  }
];
