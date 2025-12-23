#!/bin/bash
# 504 错误修复测试脚本
# 验证 Supabase 504 Gateway Timeout 和 429 Rate Limit 错误的修复

echo "===================================="
echo "504/429 错误修复验证"
echo "===================================="
echo ""

echo "1️⃣  检查错误分类..."
grep -n "RateLimitError" src/utils/supabase-error.ts
if [ $? -eq 0 ]; then
  echo "   ✅ RateLimitError 已添加到可重试错误列表"
else
  echo "   ❌ RateLimitError 未找到"
fi
echo ""

echo "2️⃣  检查重试机制..."
grep -n "retryWithBackoff" src/app/core/services/simple-sync.service.ts
if [ $? -eq 0 ]; then
  echo "   ✅ retryWithBackoff 方法已实现"
else
  echo "   ❌ retryWithBackoff 方法未找到"
fi
echo ""

echo "3️⃣  检查批量操作节流..."
grep -n "await this.delay(100)" src/app/core/services/simple-sync.service.ts
if [ $? -eq 0 ]; then
  echo "   ✅ 批量操作已添加 100ms 延迟"
else
  echo "   ❌ 批量操作延迟未找到"
fi
echo ""

echo "4️⃣  检查测试覆盖..."
grep -n "应该对 504 错误进行立即重试" src/app/core/services/simple-sync.service.spec.ts
if [ $? -eq 0 ]; then
  echo "   ✅ 504 错误重试测试已添加"
else
  echo "   ❌ 504 错误重试测试未找到"
fi
echo ""

echo "5️⃣  运行单元测试..."
npm run test:run -- src/utils/supabase-error.spec.ts --reporter=verbose
echo ""

echo "===================================="
echo "修复验证完成"
echo "===================================="
echo ""
echo "关键修复点："
echo "  - 504/502/503/408 错误现在会自动重试（指数退避：1s, 2s, 4s）"
echo "  - 429 速率限制错误现在会自动重试"
echo "  - 批量操作在请求间添加了 100ms 延迟，防止触发速率限制"
echo "  - 非可重试错误（如 401）立即失败，不浪费重试机会"
echo ""
