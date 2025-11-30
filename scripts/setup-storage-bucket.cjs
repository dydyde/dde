/**
 * Supabase Storage 桶自动化配置脚本
 * 
 * 此脚本用于自动创建和配置 NanoFlow 所需的 Storage 桶
 * 可在 CI/CD 流程或本地开发中运行
 * 
 * 使用方法:
 *   node scripts/setup-storage-bucket.cjs
 * 
 * 环境变量要求:
 *   - NG_APP_SUPABASE_URL: Supabase 项目 URL
 *   - NG_APP_SUPABASE_ANON_KEY: Supabase Anon Key (用于验证桶是否存在)
 *   - SUPABASE_SERVICE_ROLE_KEY: Supabase Service Role Key (用于创建桶，可选)
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const BUCKET_CONFIG = {
  name: 'attachments',
  public: false,
  fileSizeLimit: 10 * 1024 * 1024, // 10MB
  allowedMimeTypes: [
    'image/jpeg',
    'image/png', 
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
};

async function main() {
  const supabaseUrl = process.env.NG_APP_SUPABASE_URL;
  const supabaseAnonKey = process.env.NG_APP_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // 验证基础配置
  if (!supabaseUrl || supabaseUrl === 'YOUR_SUPABASE_URL') {
    console.error('❌ 错误: 未配置 NG_APP_SUPABASE_URL');
    console.log('   请在 .env.local 文件中设置 Supabase 配置');
    process.exit(1);
  }

  if (!supabaseAnonKey || supabaseAnonKey === 'YOUR_SUPABASE_ANON_KEY') {
    console.error('❌ 错误: 未配置 NG_APP_SUPABASE_ANON_KEY');
    process.exit(1);
  }

  console.log('🚀 NanoFlow Storage 桶配置检查\n');
  console.log(`   项目 URL: ${supabaseUrl}`);

  // 使用 anon key 检查桶是否存在
  const anonClient = createClient(supabaseUrl, supabaseAnonKey);
  
  try {
    // 尝试列出桶（会失败如果没有权限，但可以尝试）
    const { data: buckets, error: listError } = await anonClient.storage.listBuckets();
    
    if (!listError && buckets) {
      const existingBucket = buckets.find(b => b.name === BUCKET_CONFIG.name);
      
      if (existingBucket) {
        console.log(`✅ Storage 桶 "${BUCKET_CONFIG.name}" 已存在`);
        console.log(`   - 公开: ${existingBucket.public ? '是' : '否'}`);
        console.log(`   - 创建时间: ${existingBucket.created_at}`);
        
        // 验证桶配置
        await validateBucketConfig(anonClient, existingBucket);
        return;
      }
    }
  } catch (e) {
    // 忽略权限错误，继续尝试其他方法
  }

  // 如果有 service role key，尝试创建桶
  if (serviceRoleKey) {
    console.log('\n📦 尝试创建 Storage 桶...');
    
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    
    try {
      const { data, error } = await adminClient.storage.createBucket(BUCKET_CONFIG.name, {
        public: BUCKET_CONFIG.public,
        fileSizeLimit: BUCKET_CONFIG.fileSizeLimit,
        allowedMimeTypes: BUCKET_CONFIG.allowedMimeTypes
      });

      if (error) {
        if (error.message.includes('already exists')) {
          console.log(`✅ Storage 桶 "${BUCKET_CONFIG.name}" 已存在`);
        } else {
          throw error;
        }
      } else {
        console.log(`✅ 成功创建 Storage 桶 "${BUCKET_CONFIG.name}"`);
        console.log(`   - 公开: ${BUCKET_CONFIG.public ? '是' : '否'}`);
        console.log(`   - 文件大小限制: ${BUCKET_CONFIG.fileSizeLimit / 1024 / 1024}MB`);
        console.log(`   - 允许的 MIME 类型: ${BUCKET_CONFIG.allowedMimeTypes.length} 种`);
      }

      console.log('\n✅ Storage 桶配置完成！');
      console.log('\n📋 下一步操作:');
      console.log('   1. 在 Supabase Dashboard SQL 编辑器中运行 scripts/storage-setup.sql');
      console.log('   2. 配置 RLS 策略以保护您的数据');
      
    } catch (e) {
      console.error('❌ 创建桶失败:', e.message);
      console.log('\n💡 请手动在 Supabase Dashboard 中创建桶:');
      printManualInstructions();
      process.exit(1);
    }
  } else {
    // 没有 service role key，提供手动指引
    console.log('\n⚠️  未提供 SUPABASE_SERVICE_ROLE_KEY，无法自动创建桶');
    console.log('\n💡 请手动在 Supabase Dashboard 中创建桶:');
    printManualInstructions();
  }
}

async function validateBucketConfig(client, bucket) {
  console.log('\n🔍 验证桶配置...');
  
  let warnings = [];
  
  if (bucket.public !== BUCKET_CONFIG.public) {
    warnings.push(`   ⚠️  桶公开状态不匹配: 当前=${bucket.public}, 期望=${BUCKET_CONFIG.public}`);
  }
  
  if (bucket.file_size_limit && bucket.file_size_limit !== BUCKET_CONFIG.fileSizeLimit) {
    warnings.push(`   ⚠️  文件大小限制不匹配: 当前=${bucket.file_size_limit}, 期望=${BUCKET_CONFIG.fileSizeLimit}`);
  }
  
  if (warnings.length > 0) {
    console.log('\n⚠️  发现配置差异:');
    warnings.forEach(w => console.log(w));
    console.log('\n   建议在 Supabase Dashboard 中更新桶配置');
  } else {
    console.log('✅ 桶配置符合预期');
  }
}

function printManualInstructions() {
  console.log(`
   1. 登录 Supabase Dashboard
   2. 进入 Storage > New bucket
   3. 配置如下:
      - Name: ${BUCKET_CONFIG.name}
      - Public: ${BUCKET_CONFIG.public ? 'Yes' : 'No'}
      - File size limit: ${BUCKET_CONFIG.fileSizeLimit / 1024 / 1024}MB
      - Allowed MIME types: 
        ${BUCKET_CONFIG.allowedMimeTypes.map(t => '• ' + t).join('\n        ')}
   
   4. 运行 scripts/storage-setup.sql 配置 RLS 策略
`);
}

main().catch(err => {
  console.error('❌ 脚本执行失败:', err);
  process.exit(1);
});
