// 快速验证 504 错误处理
import { supabaseErrorToError } from './src/utils/supabase-error.ts';

// 测试 1: 504 错误，有 message
const error1 = { code: 504, message: 'Gateway timeout' };
const result1 = supabaseErrorToError(error1);
console.log('测试 1 - 504 with message:');
console.log('  errorType:', result1.errorType);
console.log('  isRetryable:', result1.isRetryable);
console.log('  message:', result1.message);
console.log('  ✓ 应该是 NetworkTimeoutError + isRetryable=true\n');

// 测试 2: 504 错误，无 message（实际场景）
const error2 = { code: 504 };
const result2 = supabaseErrorToError(error2);
console.log('测试 2 - 504 without message (实际场景):');
console.log('  errorType:', result2.errorType);
console.log('  isRetryable:', result2.isRetryable);
console.log('  message:', result2.message);
console.log('  ✓ 应该是 NetworkTimeoutError + isRetryable=true\n');

// 测试 3: 空错误对象
const error3 = {};
const result3 = supabaseErrorToError(error3);
console.log('测试 3 - 空对象:');
console.log('  errorType:', result3.errorType);
console.log('  isRetryable:', result3.isRetryable);
console.log('  message:', result3.message);
console.log('  ✓ 应该是 SupabaseError + isRetryable=false\n');

// 验证关键场景
const allPassed = 
  result1.isRetryable === true &&
  result2.isRetryable === true &&  // 关键测试
  result3.isRetryable === false;

console.log(allPassed ? '✅ 所有测试通过！' : '❌ 测试失败！');
