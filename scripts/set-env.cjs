const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// 读取 .env.local
const envConfig = dotenv.config({ path: path.resolve(__dirname, '../.env.local') }).parsed;

if (!envConfig) {
  console.error('❌ 未找到 .env.local 文件或文件为空');
  process.exit(1);
}

const targetPath = path.resolve(__dirname, '../src/environments/environment.development.ts');
const targetPathProd = path.resolve(__dirname, '../src/environments/environment.ts');

const envFileContent = `
export const environment = {
  production: false,
  supabaseUrl: '${envConfig.NG_APP_SUPABASE_URL}',
  supabaseAnonKey: '${envConfig.NG_APP_SUPABASE_ANON_KEY}'
};
`;

fs.writeFileSync(targetPath, envFileContent);
fs.writeFileSync(targetPathProd, envFileContent); // 开发环境同时也写入 prod 文件防止报错

console.log(`✅ 环境变量已写入 ${targetPath}`);