import { Injectable, signal } from '@angular/core';
import { createClient, type AuthResponse, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment'; // 引入环境文件

/**
 * 敏感密钥检测模式
 * 用于防止 SERVICE_ROLE_KEY 意外泄露到前端
 */
const SENSITIVE_KEY_PATTERNS = [
  'service_role',
  'secret',
  'private',
  'admin'
];

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private supabase: SupabaseClient | null = null;
  
  // 配置状态信号，UI 可以响应式订阅
  readonly configurationError = signal<string | null>(null);
  readonly isOfflineMode = signal(false);

  constructor() {
    const supabaseUrl = environment.supabaseUrl;
    const supabaseAnonKey = environment.supabaseAnonKey;

    // 检查是否为模板占位符
    const isPlaceholder = (val: string) => 
      !val || val === 'YOUR_SUPABASE_URL' || val === 'YOUR_SUPABASE_ANON_KEY';

    if (isPlaceholder(supabaseUrl) || isPlaceholder(supabaseAnonKey)) {
      const errorMsg = 'Supabase 环境变量未配置。请运行 npm run config 或手动配置 .env.local 文件。';
      
      if (environment.production) {
        // 生产环境：记录严重错误
        console.error('🚨 [CRITICAL]', errorMsg);
        this.configurationError.set(errorMsg);
      } else {
        // 开发环境：警告并进入离线模式
        console.warn('⚠️', errorMsg, '应用将以离线模式运行。');
        this.isOfflineMode.set(true);
      }
      return;
    }
    
    // 🔒 安全检查：确保不会意外使用 SERVICE_ROLE_KEY
    if (this.isSensitiveKey(supabaseAnonKey)) {
      const securityError = '🚨 [SECURITY] 检测到敏感密钥！前端不应使用 SERVICE_ROLE_KEY，请使用 ANON_KEY。';
      console.error(securityError);
      this.configurationError.set('安全配置错误：请使用公开的 ANON_KEY 而非 SERVICE_ROLE_KEY');
      // 阻止创建客户端，强制进入离线模式
      this.isOfflineMode.set(true);
      return;
    }

    try {
      this.supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          // 使用 localStorage 存储 session（更稳定，减少锁竞争）
          storage: typeof window !== 'undefined' ? window.localStorage : undefined,
          // 自动刷新 token
          autoRefreshToken: true,
          // 持久化 session
          persistSession: true,
          // 检测会话过期
          detectSessionInUrl: true,
          // 流式会话（减少并发问题）
          flowType: 'pkce'
        }
      });
    } catch (e) {
      console.error('Failed to initialize Supabase client:', e);
      this.configurationError.set('Supabase 客户端初始化失败');
      this.supabase = null;
    }
  }
  
  /**
   * 检测是否为敏感密钥
   * 通过 JWT payload 分析或密钥命名模式检测
   */
  private isSensitiveKey(key: string): boolean {
    if (!key) return false;
    
    try {
      // JWT 格式：header.payload.signature
      const parts = key.split('.');
      if (parts.length === 3) {
        // 解码 payload（不需要验证签名，只检查内容）
        const payload = JSON.parse(atob(parts[1]));
        
        // 检查 role 字段
        if (payload.role && payload.role !== 'anon') {
          // 检测到非匿名角色密钥，直接返回 true 阻止使用
          console.error('🚨 检测到非匿名角色密钥:', payload.role, '- 已阻止使用');
          return true;
        }
      }
    } catch (e) {
      // 解析失败，不是有效的 JWT，检查字符串模式
    }
    
    // 字符串模式检测（备用）
    const lowerKey = key.toLowerCase();
    return SENSITIVE_KEY_PATTERNS.some(pattern => lowerKey.includes(pattern));
  }

  get isConfigured() {
    return this.supabase !== null;
  }

  client(): SupabaseClient {
    if (!this.supabase) {
      throw new Error('Supabase 未配置，请提供 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY');
    }
    return this.supabase;
  }

  reset() {
    this.supabase = null;
  }

  async getSession() {
    if (!this.supabase) {
      return { data: { session: null as Session | null }, error: null };
    }
    return this.supabase.auth.getSession();
  }

  async signInWithPassword(email: string, password: string): Promise<AuthResponse> {
    if (!this.supabase) {
      throw new Error('Supabase 未配置，无法登录');
    }
    return this.supabase.auth.signInWithPassword({ email, password });
  }

  async signOut() {
    if (!this.supabase) return;
    await this.supabase.auth.signOut();
  }
}
