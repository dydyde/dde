const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// 优先读取 .env.local，其次读取进程环境（方便 Vercel/Supabase 等 CI 环境）
const localEnv = dotenv.config({ path: path.resolve(__dirname, '../.env.local') }).parsed || {};
const supabaseUrl = process.env.NG_APP_SUPABASE_URL || localEnv.NG_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.NG_APP_SUPABASE_ANON_KEY || localEnv.NG_APP_SUPABASE_ANON_KEY;
const gojsLicenseKey = process.env.NG_APP_GOJS_LICENSE_KEY || localEnv.NG_APP_GOJS_LICENSE_KEY || '';

// 开发环境自动登录配置
// 设置后，应用启动时会自动登录，无需手动输入凭据
// Guard 仍然存在且生效，只是登录过程被自动化
const devAutoLoginEmail = process.env.NG_APP_DEV_AUTO_LOGIN_EMAIL || localEnv.NG_APP_DEV_AUTO_LOGIN_EMAIL;
const devAutoLoginPassword = process.env.NG_APP_DEV_AUTO_LOGIN_PASSWORD || localEnv.NG_APP_DEV_AUTO_LOGIN_PASSWORD;
const hasDevAutoLogin = devAutoLoginEmail && devAutoLoginPassword;

// 如果没有配置 Supabase 环境变量，使用占位符（应用将以离线模式运行）
const useOfflineMode = !supabaseUrl || !supabaseAnonKey;
if (useOfflineMode) {
  console.warn('⚠️ 未找到 Supabase 环境变量，将生成离线模式配置文件。');
  console.warn('   如需云端同步功能，请在 .env.local 中设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY');
}

if (!gojsLicenseKey) {
  console.warn('⚠️ 未找到 GoJS License Key，流程图将显示水印。');
  console.warn('   如需移除水印，请在 .env.local 中设置 NG_APP_GOJS_LICENSE_KEY');
}

if (hasDevAutoLogin) {
  console.log('🔐 开发环境自动登录已配置，应用启动时将自动使用配置的凭据登录');
}

const targetPath = path.resolve(__dirname, '../src/environments/environment.development.ts');
const targetPathProd = path.resolve(__dirname, '../src/environments/environment.ts');

// 离线模式使用占位符
const finalUrl = supabaseUrl || 'YOUR_SUPABASE_URL';
const finalKey = supabaseAnonKey || 'YOUR_SUPABASE_ANON_KEY';

// 开发环境自动登录配置（仅开发环境）
const devAutoLoginConfig = hasDevAutoLogin 
  ? `{ email: '${devAutoLoginEmail}', password: '${devAutoLoginPassword}' }`
  : 'null';

const devEnvContent = `// 此文件由 scripts/set-env.cjs 自动生成，请勿手动编辑
// 已添加到 .gitignore，不会被提交到代码仓库

export const environment = {
  production: false,
  supabaseUrl: '${finalUrl}',
  supabaseAnonKey: '${finalKey}',
  // GoJS License Key - 生产环境需要配置以移除水印
  gojsLicenseKey: '${gojsLicenseKey}',
  // 开发环境自动登录（仅开发环境生效）
  // 设置方式：在 .env.local 中配置 NG_APP_DEV_AUTO_LOGIN_EMAIL 和 NG_APP_DEV_AUTO_LOGIN_PASSWORD
  devAutoLogin: ${devAutoLoginConfig} as { email: string; password: string } | null
};
`;

const prodEnvContent = `// 此文件由 scripts/set-env.cjs 自动生成，请勿手动编辑
// 已添加到 .gitignore，不会被提交到代码仓库

export const environment = {
  production: true,
  supabaseUrl: '${finalUrl}',
  supabaseAnonKey: '${finalKey}',
  // GoJS License Key - 生产环境需要配置以移除水印
  gojsLicenseKey: '${gojsLicenseKey}',
  // 生产环境始终禁用自动登录
  devAutoLogin: null as { email: string; password: string } | null
};
`;

fs.writeFileSync(targetPath, devEnvContent);
fs.writeFileSync(targetPathProd, prodEnvContent);

console.log(`✅ 环境变量已写入:`);
console.log(`   - ${targetPath} (development)`);
console.log(`   - ${targetPathProd} (production)`);

