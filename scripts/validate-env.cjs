#!/usr/bin/env node
/**
 * validate-env.cjs - 构建前环境变量验证脚本
 * 
 * 【设计理念】
 * Fail Fast（快速失败）：
 * - 在构建最前面检查关键环境变量
 * - 缺少必要变量时直接 exit(1) 阻断构建
 * - 避免部署配置错误的残次品到生产环境
 * 
 * 【使用方式】
 * 在 package.json 的 build 命令中添加：
 * "build": "node scripts/validate-env.cjs --production && npm run config && ng build"
 * 
 * 或在 CI/CD 流程中直接调用：
 * node scripts/validate-env.cjs --production
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// 颜色输出
const colors = {
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

// 解析命令行参数
const args = process.argv.slice(2);
const isProduction = args.includes('--production') || args.includes('-p');
const isStrict = args.includes('--strict') || args.includes('-s');
const isDryRun = args.includes('--dry-run');

// 加载环境变量
const envLocalPath = path.resolve(__dirname, '../.env.local');
const localEnv = fs.existsSync(envLocalPath)
  ? dotenv.config({ path: envLocalPath }).parsed || {}
  : {};

// 合并环境变量（进程环境优先，方便 CI/CD）
const env = {
  ...localEnv,
  ...process.env,
};

/**
 * 环境变量定义
 * required: 必需的变量（缺少则阻断构建）
 * optional: 可选的变量（缺少则警告）
 */
const envDefinitions = {
  // 必需变量（生产环境）
  required: [
    {
      name: 'NG_APP_SUPABASE_URL',
      description: 'Supabase 项目 URL',
      validate: (value) => {
        if (!value) return '未设置';
        if (!value.startsWith('https://')) return '必须以 https:// 开头';
        if (value === 'YOUR_SUPABASE_URL') return '仍然是占位符值，请设置真实的 URL';
        return null; // null 表示验证通过
      },
    },
    {
      name: 'NG_APP_SUPABASE_ANON_KEY',
      description: 'Supabase 匿名公钥',
      validate: (value) => {
        if (!value) return '未设置';
        if (value === 'YOUR_SUPABASE_ANON_KEY') return '仍然是占位符值，请设置真实的 Key';
        if (value.length < 100) return 'Key 长度异常，请检查是否完整复制';
        return null;
      },
    },
  ],

  // 可选变量（警告但不阻断）
  optional: [
    {
      name: 'NG_APP_GOJS_LICENSE_KEY',
      description: 'GoJS 许可证密钥（缺少时流程图显示水印）',
      validate: (value) => {
        if (!value) return '未设置，流程图将显示水印';
        return null;
      },
    },
  ],

  // 开发环境专用变量（生产环境应该不存在）
  devOnly: [
    {
      name: 'NG_APP_DEV_AUTO_LOGIN_EMAIL',
      description: '开发环境自动登录邮箱',
    },
    {
      name: 'NG_APP_DEV_AUTO_LOGIN_PASSWORD',
      description: '开发环境自动登录密码',
    },
  ],
};

/**
 * 验证环境变量
 */
function validateEnv() {
  console.log(colors.bold('\n🔍 验证环境变量...\n'));
  
  const errors = [];
  const warnings = [];

  // 验证必需变量
  if (isProduction) {
    console.log(colors.cyan('📦 生产环境模式\n'));

    for (const def of envDefinitions.required) {
      const value = env[def.name];
      const error = def.validate(value);

      if (error) {
        errors.push({
          name: def.name,
          description: def.description,
          error,
        });
        console.log(`  ${colors.red('✗')} ${def.name}`);
        console.log(`    ${colors.red(error)}`);
        console.log(`    ${colors.yellow(def.description)}\n`);
      } else {
        console.log(`  ${colors.green('✓')} ${def.name}`);
      }
    }

    // 检查开发环境变量是否意外泄露到生产环境
    console.log(colors.cyan('\n🔒 安全检查：开发环境变量\n'));
    
    for (const def of envDefinitions.devOnly) {
      const value = env[def.name];
      if (value) {
        warnings.push({
          name: def.name,
          description: def.description,
          warning: '生产环境中不应存在此变量',
        });
        console.log(`  ${colors.yellow('⚠')} ${def.name}`);
        console.log(`    ${colors.yellow('生产环境中检测到开发变量，建议移除')}\n`);
      } else {
        console.log(`  ${colors.green('✓')} ${def.name} (未设置，正确)`);
      }
    }
  } else {
    console.log(colors.cyan('🛠️  开发环境模式（跳过强制验证）\n'));
    
    // 开发环境下仍然检查，但只作为警告
    for (const def of envDefinitions.required) {
      const value = env[def.name];
      const error = def.validate(value);

      if (error) {
        warnings.push({
          name: def.name,
          description: def.description,
          warning: error,
        });
        console.log(`  ${colors.yellow('⚠')} ${def.name}`);
        console.log(`    ${colors.yellow(error)} (开发环境允许离线模式)\n`);
      } else {
        console.log(`  ${colors.green('✓')} ${def.name}`);
      }
    }
  }

  // 验证可选变量
  console.log(colors.cyan('\n📋 可选变量\n'));
  
  for (const def of envDefinitions.optional) {
    const value = env[def.name];
    const warning = def.validate(value);

    if (warning) {
      warnings.push({
        name: def.name,
        description: def.description,
        warning,
      });
      console.log(`  ${colors.yellow('⚠')} ${def.name}`);
      console.log(`    ${colors.yellow(warning)}\n`);
    } else {
      console.log(`  ${colors.green('✓')} ${def.name}`);
    }
  }

  // 输出摘要
  console.log(colors.bold('\n📊 验证摘要\n'));
  
  if (errors.length > 0) {
    console.log(colors.red(`  错误: ${errors.length} 个必需变量验证失败`));
    
    if (!isDryRun && isProduction) {
      console.log(colors.red(colors.bold('\n❌ 构建已阻断\n')));
      console.log('请设置以下环境变量后重试：\n');
      
      for (const err of errors) {
        console.log(`  ${err.name}:`);
        console.log(`    描述: ${err.description}`);
        console.log(`    问题: ${err.error}\n`);
      }
      
      console.log('设置方式：');
      console.log('  1. 在 .env.local 文件中添加（开发环境）');
      console.log('  2. 在 CI/CD 环境变量中设置（生产环境）');
      console.log('  3. 在 Vercel/Netlify 等平台的环境变量设置中添加\n');
      
      process.exit(1);
    }
  }

  if (warnings.length > 0) {
    console.log(colors.yellow(`  警告: ${warnings.length} 个`));
  }

  const total = envDefinitions.required.length + envDefinitions.optional.length;
  const passed = total - errors.length - warnings.length;
  console.log(colors.green(`  通过: ${passed} 个`));

  if (errors.length === 0) {
    console.log(colors.green(colors.bold('\n✅ 环境变量验证通过\n')));
    
    if (isProduction && !isStrict && warnings.length > 0) {
      console.log(colors.yellow('注意：存在警告项，建议在生产部署前处理\n'));
    }
  }

  // 严格模式：警告也算失败
  if (isStrict && warnings.length > 0) {
    console.log(colors.yellow(colors.bold('\n⚠️ 严格模式：存在警告，构建已阻断\n')));
    process.exit(1);
  }

  return { errors, warnings };
}

// 运行验证
validateEnv();
