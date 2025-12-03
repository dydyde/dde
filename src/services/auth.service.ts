import { Injectable, inject, signal } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { 
  Result, OperationError, ErrorCodes, success, failure 
} from '../utils/result';
import { environment } from '../environments/environment';

export interface AuthState {
  isCheckingSession: boolean;
  isLoading: boolean;
  userId: string | null;
  email: string | null;
  error: string | null;
}

/**
 * 认证结果类型
 */
export interface AuthResult {
  userId?: string;
  email?: string;
  needsConfirmation?: boolean;
}

/**
 * 认证服务
 * 负责用户登录、注册、登出
 * 
 * 开发环境自动登录：
 * - 设置 environment.devAutoLogin 后，应用启动时会自动登录
 * - Guard 仍然存在且生效，只是登录过程被自动化
 * - 这避免了"关掉 Guard"的懒惰做法，保持代码路径与生产环境一致
 * 
 * 所有公共方法返回 Result<T> 类型以保持一致性
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private supabase = inject(SupabaseClientService);
  
  /** 是否已尝试过开发环境自动登录 */
  private devAutoLoginAttempted = false;
  
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
   * 
   * 开发环境：如果没有现有会话且配置了 devAutoLogin，会自动登录
   */
  async checkSession(): Promise<{ userId: string | null; email: string | null }> {
    console.log('[Auth] checkSession 开始');
    
    if (!this.supabase.isConfigured) {
      console.log('[Auth] Supabase 未配置，跳过会话检查');
      this.authState.update(s => ({ ...s, isCheckingSession: false }));
      return { userId: null, email: null };
    }
    
    this.authState.update(s => ({ ...s, isCheckingSession: true }));
    
    // 超时保护：10秒后自动放弃
    const SESSION_TIMEOUT = 10000;
    
    try {
      console.log('[Auth] 正在获取 Supabase 会话...');
      
      // 使用 AbortController 实现超时（如果支持）
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = setTimeout(() => {
        console.warn('[Auth] 会话检查超时');
        if (controller) controller.abort();
      }, SESSION_TIMEOUT);
      
      let sessionResult: { data: { session: any } | null; error: any };
      
      try {
        // 创建一个带超时的 Promise
        const sessionPromise = this.supabase.getSession();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('会话检查超时')), SESSION_TIMEOUT);
        });
        
        sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }
      
      const { data, error } = sessionResult;
      
      if (error) {
        console.error('[Auth] 获取会话出错:', error);
        throw error;
      }
      
      const session = data?.session;
      console.log('[Auth] 会话数据:', session ? '存在' : '不存在');
      
      if (session?.user) {
        const userId = session.user.id;
        const email = session.user.email ?? null;
        console.log('[Auth] 用户已登录:', { userId, email });
        
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
      
      // 没有现有会话，尝试开发环境自动登录
      const autoLoginResult = await this.tryDevAutoLogin();
      if (autoLoginResult) {
        return autoLoginResult;
      }
      
      return { userId: null, email: null };
    } catch (e: any) {
      console.error('[Auth] checkSession 异常:', e?.message ?? e);
      
      // 超时不是致命错误，只是记录并继续
      const isTimeout = e?.message?.includes('超时');
      if (!isTimeout) {
        this.authState.update(s => ({
          ...s,
          error: e?.message ?? String(e)
        }));
      }
      return { userId: null, email: null };
    } finally {
      console.log('[Auth] checkSession 完成，设置 isCheckingSession = false');
      this.authState.update(s => ({ ...s, isCheckingSession: false }));
    }
  }

  /**
   * 尝试开发环境自动登录
   * 
   * 设计理念：
   * - 保留 Guard 的存在，确保代码路径与生产环境一致
   * - 只是自动化登录过程，不是跳过登录
   * - 便于开发调试，同时不污染生产代码
   * 
   * @returns 登录成功返回用户信息，否则返回 null
   */
  private async tryDevAutoLogin(): Promise<{ userId: string | null; email: string | null } | null> {
    // 防止重复尝试
    if (this.devAutoLoginAttempted) {
      return null;
    }
    this.devAutoLoginAttempted = true;
    
    // 检查是否配置了开发环境自动登录
    const devAutoLogin = (environment as any).devAutoLogin;
    if (!devAutoLogin || !devAutoLogin.email || !devAutoLogin.password) {
      return null;
    }
    
    // 仅在非生产环境启用
    if ((environment as any).production) {
      console.warn('⚠️ devAutoLogin 不应在生产环境使用，已忽略');
      return null;
    }
    
    // 开发环境日志：不泄露凭据
    console.log('🔐 开发环境自动登录中...');
    
    try {
      const result = await this.signIn(devAutoLogin.email, devAutoLogin.password);
      
      if (result.ok && result.value.userId) {
        // 安全：只记录登录成功，不记录具体邮箱
        console.log('✅ 开发环境自动登录成功');
        return { 
          userId: result.value.userId, 
          email: result.value.email ?? null 
        };
      } else {
        // 开发环境凭据问题：使用 info 而非 warn，避免在控制台产生混淆
        // 这是预期的静默降级，不是真正的错误
        console.info('ℹ️ 开发环境自动登录未成功，将以未登录状态运行');
        return null;
      }
    } catch (e) {
      // 网络异常等：静默降级为未登录状态
      console.info('ℹ️ 开发环境自动登录异常，静默降级:', e);
      return null;
    }
  }

  /**
   * 登录
   * @returns Result 类型，成功时包含用户信息
   */
  async signIn(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      );
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      const { data, error } = await this.supabase.signInWithPassword(email, password);
      
      if (error || !data.session?.user) {
        const errorMsg = error?.message || '登录失败';
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.SYNC_AUTH_EXPIRED, errorMsg);
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
      
      return success({ userId, email: userEmail ?? undefined });
    } catch (e: any) {
      const errorMsg = e?.message ?? String(e);
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return failure(ErrorCodes.UNKNOWN, errorMsg);
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * 注册
   * @returns Result 类型，成功时可能包含 needsConfirmation 标志
   */
  async signUp(email: string, password: string): Promise<Result<AuthResult, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(
        ErrorCodes.SYNC_AUTH_EXPIRED,
        'Supabase 未配置。请设置 NG_APP_SUPABASE_URL 和 NG_APP_SUPABASE_ANON_KEY。'
      );
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      const { data, error } = await this.supabase.client().auth.signUp({
        email,
        password
      });
      
      if (error) {
        const errorMsg = error.message;
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.UNKNOWN, errorMsg);
      }
      
      // 检查是否需要邮箱确认
      if (data.user && !data.session) {
        return success({ needsConfirmation: true });
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
        
        return success({ userId, email: userEmail ?? undefined });
      }
      
      return success({});
    } catch (e: any) {
      const errorMsg = e?.message ?? String(e);
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return failure(ErrorCodes.UNKNOWN, errorMsg);
    } finally {
      this.authState.update(s => ({ ...s, isLoading: false }));
    }
  }

  /**
   * 重置密码（发送重置邮件）
   * @returns Result 类型
   */
  async resetPassword(email: string): Promise<Result<void, OperationError>> {
    if (!this.supabase.isConfigured) {
      return failure(ErrorCodes.SYNC_AUTH_EXPIRED, 'Supabase 未配置');
    }
    
    this.authState.update(s => ({ ...s, isLoading: true, error: null }));
    
    try {
      const { error } = await this.supabase.client().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`
      });
      
      if (error) {
        const errorMsg = error.message;
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.UNKNOWN, errorMsg);
      }
      
      return success(undefined);
    } catch (e: any) {
      const errorMsg = e?.message ?? String(e);
      this.authState.update(s => ({ ...s, error: errorMsg }));
      return failure(ErrorCodes.UNKNOWN, errorMsg);
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
  
  // ========== 显式状态重置（用于测试和 HMR）==========
  
  /**
   * 显式重置服务状态
   * 用于测试环境的 afterEach 或 HMR 重载
   */
  reset(): void {
    this.currentUserId.set(null);
    this.sessionEmail.set(null);
    this.authState.set({
      isCheckingSession: false,
      isLoading: false,
      userId: null,
      email: null,
      error: null
    });
  }
  
  // ========== 向后兼容的属性访问器 ==========
  // 这些属性用于旧代码的向后兼容，新代码应使用 Result 类型
  
  /**
   * @deprecated 使用 signIn() 返回的 Result 替代
   */
  get success(): boolean {
    return this.authState().userId !== null;
  }
  
  /**
   * @deprecated 使用 signIn() 返回的 Result 替代
   */
  get error(): string | null {
    return this.authState().error;
  }
}
