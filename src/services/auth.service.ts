import { Injectable, inject, signal } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';

export interface AuthState {
  isCheckingSession: boolean;
  isLoading: boolean;
  userId: string | null;
  email: string | null;
  error: string | null;
}

/**
 * 认证服务
 * 负责用户登录、注册、登出
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private supabase = inject(SupabaseClientService);
  
  /** Supabase 是否已配置 */
  get isConfigured(): boolean {
    return this.supabase.isConfigured;
  }
  
  /** 认证状态 */
  readonly authState = signal<AuthState>({
    isCheckingSession: true,
    isLoading: false,
    userId: null,
    email: null,
    error: null
  });

  /** 当前用户 ID */
  readonly currentUserId = signal<string | null>(null);
  
  /** 当前用户邮箱 */
  readonly sessionEmail = signal<string | null>(null);

  /**
   * 检查并恢复会话
   * 添加超时保护，防止网络异常时无限阻塞
   */
  async checkSession(): Promise<{ userId: string | null; email: string | null }> {
    if (!this.supabase.isConfigured) {
      this.authState.update(s => ({ ...s, isCheckingSession: false }));
      return { userId: null, email: null };
    }
    
    this.authState.update(s => ({ ...s, isCheckingSession: true }));
    
    // 超时保护：10秒后自动放弃
    const SESSION_TIMEOUT = 10000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('会话检查超时')), SESSION_TIMEOUT);
    });
    
    try {
      const sessionPromise = this.supabase.getSession();
      const { data, error } = await Promise.race([sessionPromise, timeoutPromise]);
      if (error) throw error;
      
      const session = data?.session;
      if (session?.user) {
        const userId = session.user.id;
        const email = session.user.email ?? null;
        
        this.currentUserId.set(userId);
        this.sessionEmail.set(email);
        this.authState.update(s => ({
          ...s,
          userId,
          email,
          error: null
        }));
        
        return { userId, email };
      }
      
      return { userId: null, email: null };
    } catch (e: any) {
      this.authState.update(s => ({
        ...s,
        error: e?.message ?? String(e)
      }));
      return { userId: null, email: null };
    } finally {
      this.authState.update(s => ({ ...s, isCheckingSession: false }));
    }
  }

  /**
   * 登录
   */
  async signIn(email: string, password: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) {
      return {
        success: false,
        error: 'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      };
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      const { data, error } = await this.supabase.signInWithPassword(email, password);
      
      if (error || !data.session?.user) {
        throw new Error(error?.message || '登录失败');
      }
      
      const userId = data.session.user.id;
      const userEmail = data.session.user.email ?? null;
      
      this.currentUserId.set(userId);
      this.sessionEmail.set(userEmail);
      this.authState.update(s => ({
        ...s,
        userId,
        email: userEmail,
        error: null
      }));
      
      return { success: true };
    } catch (e: any) {
      const errorMsg = e?.message ?? String(e);
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return { success: false, error: errorMsg };
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * 注册
   */
  async signUp(email: string, password: string): Promise<{ success: boolean; error?: string; needsConfirmation?: boolean }> {
    if (!this.supabase.isConfigured) {
      return {
        success: false,
        error: 'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      };
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      const { data, error } = await this.supabase.client().auth.signUp({
        email,
        password
      });
      
      if (error) {
        throw new Error(error.message);
      }
      
      // 检查是否需要邮箱确认
      if (data.user && !data.session) {
        return { success: true, needsConfirmation: true };
      }
      
      // 如果直接获得 session（禁用了邮箱确认的情况）
      if (data.session?.user) {
        const userId = data.session.user.id;
        const userEmail = data.session.user.email ?? null;
        
        this.currentUserId.set(userId);
        this.sessionEmail.set(userEmail);
        this.authState.update(s => ({
          ...s,
          userId,
          email: userEmail,
          error: null
        }));
      }
      
      return { success: true };
    } catch (e: any) {
      const errorMsg = e?.message ?? String(e);
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return { success: false, error: errorMsg };
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * 重置密码（发送重置邮件）
   */
  async resetPassword(email: string): Promise<{ success: boolean; error?: string }> {
    if (!this.supabase.isConfigured) {
      return { success: false, error: 'Supabase 未配置' };
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      const { error } = await this.supabase.client().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`
      });
      
      if (error) throw new Error(error.message);
      
      return { success: true };
    } catch (e: any) {
      const errorMsg = e?.message ?? String(e);
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return { success: false, error: errorMsg };
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * 登出
   * 注意：先清理本地状态，再调用 Supabase 登出
   * 这样可以确保即使 Supabase 调用失败，本地状态也已被清理
   */
  async signOut(): Promise<void> {
    // 先清理本地状态
    this.currentUserId.set(null);
    this.sessionEmail.set(null);
    this.authState.update(s => ({
      ...s,
      userId: null,
      email: null,
      error: null
    }));
    
    // 再调用 Supabase 登出
    if (this.supabase.isConfigured) {
      try {
        await this.supabase.signOut();
      } catch (e) {
        // 即使 Supabase 登出失败，本地状态已清理
        console.warn('Supabase signOut failed:', e);
      }
    }
  }

  /**
   * 清除错误
   */
  clearError() {
    this.authState.update(s => ({ ...s, error: null }));
  }
}
