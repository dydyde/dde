// 这是环境变量模板文件
// 复制此文件为 environment.ts 和 environment.development.ts
// 或运行 npm run config 自动从 .env.local 生成

export const environment = {
  production: false,
  supabaseUrl: 'YOUR_SUPABASE_URL',
  supabaseAnonKey: 'YOUR_SUPABASE_ANON_KEY',
  // GoJS License Key - 生产环境需要配置以移除水印
  // 在 .env.local 中设置 NG_APP_GOJS_LICENSE_KEY
  gojsLicenseKey: '',
  
  // ========== 开发环境自动登录配置 ==========
  // 仅在开发环境使用，生产环境应始终为 null
  // 目的：保留 Guard 的存在，避免"把 Guard 关掉"的懒惰做法
  // 实现：在 AuthService 启动时自动使用这些凭据登录
  // 
  // 在 .env.local 中设置：
  // NG_APP_DEV_AUTO_LOGIN_EMAIL=dev@example.com
  // NG_APP_DEV_AUTO_LOGIN_PASSWORD=your-dev-password
  devAutoLogin: null as { email: string; password: string } | null
};
