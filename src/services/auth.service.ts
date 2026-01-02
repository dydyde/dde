import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { SupabaseClientService } from './supabase-client.service';
import { 
  Result, OperationError, ErrorCodes, success, failure, humanizeErrorMessage 
} from '../utils/result';
import { supabaseErrorToError } from '../utils/supabase-error';
import { environment } from '../environments/environment';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';

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
  private toast = inject(ToastService);
  private logger = inject(LoggerService).category('AuthService');
  private destroyRef = inject(DestroyRef);
  
  /** 是否已尝试过开发环境自动登录 */
  private devAutoLoginAttempted = false;
  
  /** 是否为用户主动登出（区分 Token 过期） */
  private isManualSignOut = false;
  
  /** 会话是否已过期 */
  readonly sessionExpired = signal(false);
  
  /** 认证状态变更订阅的取消函数 */
  private authStateSubscription: { unsubscribe: () => void } | null = null;
  
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
  
  constructor() {
    // 初始化认证状态监听
    this.initAuthStateListener();
    
    // 组件销毁时清理订阅
    this.destroyRef.onDestroy(() => {
      this.authStateSubscription?.unsubscribe();
    });
  }

  /**
   * 检查并恢复会话
   * 添加超时保护，防止网络异常时无限阻塞
   * 
   * 开发环境：如果没有现有会话且配置了 devAutoLogin，会自动登录
   */
  async checkSession(): Promise<{ userId: string | null; email: string | null }> {
    console.log('[Auth] ========== checkSession 开始 ==========');
    
    if (!this.supabase.isConfigured) {
      console.log('[Auth] Supabase 未配置，跳过会话检查');
      this.authState.update(s => ({ ...s, isCheckingSession: false }));
      return { userId: null, email: null };
    }
    
    this.authState.update(s => ({ ...s, isCheckingSession: true }));
    
    // 超时保护：10秒后自动放弃
    const SESSION_TIMEOUT = 10000;
    
    try {
      console.log('[Auth] 正在调用 supabase.getSession()...');
      const callStartTime = Date.now();
      
      // 使用 AbortController 实现超时（如果支持）
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = setTimeout(() => {
        console.warn('[Auth] 会话检查超时警告 (10秒)');
        if (controller) controller.abort();
      }, SESSION_TIMEOUT);
      
      let sessionResult: { data: { session: { user?: { id: string; email?: string | null } } | null } | null; error: { message: string; status?: number; name?: string } | null };
      
      try {
        // 创建一个带超时的 Promise
        const sessionPromise = this.supabase.getSession();
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('会话检查超时')), SESSION_TIMEOUT);
        });
        
        sessionResult = await Promise.race([sessionPromise, timeoutPromise]);
        const callElapsed = Date.now() - callStartTime;
        console.log(`[Auth] getSession() 返回 (耗时 ${callElapsed}ms)`);
      } finally {
        clearTimeout(timeoutId);
      }
      
      const { data, error } = sessionResult;
      
      if (error) {
        console.error('[Auth] getSession() 返回错误:', {
          message: error.message,
          status: error.status,
          name: error.name
        });
        // 不抛出异常，而是在 catch 块中统一处理
        throw supabaseErrorToError(error);
      }
      
      const session = data?.session;
      console.log('[Auth] 会话状态:', session ? '✓ 存在' : '✗ 不存在');
      
      if (session?.user) {
        const userId = session.user.id;
        const email = session.user.email ?? null;
        console.log('[Auth] 用户已登录:', { 
          userId: userId.substring(0, 8) + '...', 
          email 
        });
        
        this.currentUserId.set(userId);
        this.sessionEmail.set(email);
        this.authState.update(s => ({
          ...s,
          userId,
          email,
          error: null
        }));
        
        console.log('[Auth] ========== checkSession 成功 ==========');
        return { userId, email };
      }
      
      // 没有现有会话，尝试开发环境自动登录
      console.log('[Auth] 无现有会话，尝试开发环境自动登录...');
      const autoLoginResult = await this.tryDevAutoLogin();
      if (autoLoginResult) {
        console.log('[Auth] ========== 自动登录成功 ==========');
        return autoLoginResult;
      }
      
      console.log('[Auth] ========== 无会话，未登录 ==========');
      return { userId: null, email: null };
    } catch (e: unknown) {
      const err = e as Error | undefined;
      console.error('[Auth] ========== checkSession 异常 ==========');
      console.error('[Auth] 异常详情:', {
        message: err?.message,
        stack: err?.stack?.split('\n').slice(0, 3).join('\n'),
        isTimeout: err?.message?.includes('超时')
      });
      
      // 超时不是致命错误，只是记录并继续
      const isTimeout = err?.message?.includes('超时');
      if (!isTimeout) {
        this.authState.update(s => ({
          ...s,
          error: err?.message ?? String(e)
        }));
      }
      
      // 注意：这里不抛出异常，而是返回 null
      console.log('[Auth] 返回空会话，不阻断应用启动');
      return { userId: null, email: null };
    } finally {
      console.log('[Auth] 设置 isCheckingSession = false');
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
    const envWithDevLogin = environment as { devAutoLogin?: { email: string; password: string }; production?: boolean };
    const devAutoLogin = envWithDevLogin.devAutoLogin;
    if (!devAutoLogin || !devAutoLogin.email || !devAutoLogin.password) {
      return null;
    }
    
    // 仅在非生产环境启用
    if (envWithDevLogin.production) {
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
        const errorMsg = humanizeErrorMessage(error?.message || '登录失败');
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
    } catch (e: unknown) {
      const err = e as Error | undefined;
      const errorMsg = humanizeErrorMessage(err?.message ?? String(e));
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
        const errorMsg = humanizeErrorMessage(error.message);
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
    } catch (e: unknown) {
      const err = e as Error | undefined;
      const errorMsg = humanizeErrorMessage(err?.message ?? String(e));
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
        const errorMsg = humanizeErrorMessage(error.message);
        this.authState.update(s => ({ ...s, error: errorMsg }));
        return failure(ErrorCodes.UNKNOWN, errorMsg);
      }
      
      return success(undefined);
    } catch (e: unknown) {
      const err = e as Error | undefined;
      const errorMsg = humanizeErrorMessage(err?.message ?? String(e));
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
    // 标记为手动登出，避免触发 sessionExpired 提示
    this.isManualSignOut = true;
    
    // 先清理本地状态
    this.currentUserId.set(null);
    this.sessionEmail.set(null);
    this.sessionExpired.set(false);
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
    this.sessionExpired.set(false);
    this.isManualSignOut = false;
    this.authState.set({
      isCheckingSession: false,
      isLoading: false,
      userId: null,
      email: null,
      error: null
    });
  }
  
  // ==================== 私有方法 ====================
  
  /**
   * 初始化认证状态监听
   * 
   * 监听 Supabase 的 onAuthStateChange 事件：
   * - SIGNED_OUT: 用户登出（检测是否为 Token 过期）
   * - TOKEN_REFRESHED: Token 刷新成功
   * - SIGNED_IN: 用户登录
   * - USER_UPDATED: 用户信息更新
   */
  private initAuthStateListener(): void {
    if (!this.supabase.isConfigured) {
      this.logger.debug('Supabase 未配置，跳过认证状态监听');
      return;
    }
    
    const client = this.supabase.client();
    if (!client) return;
    
    const { data } = client.auth.onAuthStateChange((event, session) => {
      this.logger.debug('认证状态变更', { event, hasSession: !!session });
      
      switch (event) {
        case 'SIGNED_OUT':
          this.handleSignedOut();
          break;
          
        case 'TOKEN_REFRESHED':
          this.handleTokenRefreshed(session);
          break;
          
        case 'SIGNED_IN':
          this.handleSignedIn(session);
          break;
          
        case 'USER_UPDATED':
          if (session?.user) {
            this.logger.debug('用户信息已更新', { userId: session.user.id });
          }
          break;
      }
    });
    
    this.authStateSubscription = data.subscription;
  }
  
  /**
   * 处理登出事件
   * 区分用户主动登出和 Token 过期
   */
  private handleSignedOut(): void {
    if (this.isManualSignOut) {
      this.logger.info('用户主动登出');
      // 重置标志
      this.isManualSignOut = false;
    } else {
      // 非主动登出，可能是 Token 过期
      this.logger.warn('检测到非主动登出，可能是 Token 过期');
      this.handleSessionExpired();
    }
  }
  
  /**
   * 处理会话过期
   * 
   * 【Week 8-9 数据保护 - JWT 刷新失败监听】
   */
  private handleSessionExpired(): void {
    this.sessionExpired.set(true);
    
    // 清理认证状态
    this.currentUserId.set(null);
    this.sessionEmail.set(null);
    this.authState.update(s => ({
      ...s,
      userId: null,
      email: null,
      isCheckingSession: false,
    }));
    
    // 显示重新登录提示
    this.toast.warning('登录已过期', '请重新登录以继续同步数据', { duration: 0 });
    
    this.logger.warn('会话已过期，需要重新登录');
  }
  
  /**
   * 处理 Token 刷新成功
   */
  private handleTokenRefreshed(session: { user?: { id: string; email?: string | null } } | null): void {
    this.logger.debug('Token 刷新成功');
    
    // 清除过期标记
    if (this.sessionExpired()) {
      this.sessionExpired.set(false);
    }
    
    // 更新会话信息
    if (session?.user) {
      this.currentUserId.set(session.user.id);
      this.sessionEmail.set(session.user.email ?? null);
    }
  }
  
  /**
   * 处理登录成功
   */
  private handleSignedIn(session: { user?: { id: string; email?: string | null } } | null): void {
    if (session?.user) {
      this.logger.info('用户已登录', { userId: session.user.id });
      this.currentUserId.set(session.user.id);
      this.sessionEmail.set(session.user.email ?? null);
      this.sessionExpired.set(false);
      this.authState.update(s => ({
        ...s,
        userId: session.user!.id,
        email: session.user!.email ?? null,
        isCheckingSession: false,
      }));
    }
  }
}
