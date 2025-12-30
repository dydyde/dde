import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { ToastService } from '../../../services/toast.service';

/**
 * 密码重置组件
 * 处理 Supabase 发送的密码重置邮件回调
 * 路由: /reset-password?access_token=xxx&refresh_token=xxx&type=recovery
 */
@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div class="max-w-md w-full space-y-8">
        <!-- Logo -->
        <div class="text-center">
          <h1 class="text-3xl font-bold text-primary">NanoFlow</h1>
          <h2 class="mt-6 text-xl font-semibold text-gray-900 dark:text-white">
            {{ isLoading() ? '验证中...' : (isValid() ? '设置新密码' : '链接无效') }}
          </h2>
        </div>

        <!-- 加载状态 -->
        @if (isLoading()) {
          <div class="flex justify-center">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        }

        <!-- 链接无效 -->
        @if (!isLoading() && !isValid()) {
          <div class="rounded-md bg-red-50 dark:bg-red-900/20 p-4">
            <div class="flex">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
                </svg>
              </div>
              <div class="ml-3">
                <h3 class="text-sm font-medium text-red-800 dark:text-red-200">
                  密码重置链接无效或已过期
                </h3>
                <div class="mt-2 text-sm text-red-700 dark:text-red-300">
                  <p>请重新请求密码重置邮件。</p>
                </div>
              </div>
            </div>
          </div>
          <div class="text-center">
            <button 
              (click)="goToLogin()"
              class="text-primary hover:text-primary-dark font-medium"
            >
              返回登录页
            </button>
          </div>
        }

        <!-- 重置成功 -->
        @if (isSuccess()) {
          <div class="rounded-md bg-green-50 dark:bg-green-900/20 p-4">
            <div class="flex">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                </svg>
              </div>
              <div class="ml-3">
                <h3 class="text-sm font-medium text-green-800 dark:text-green-200">
                  密码重置成功！
                </h3>
                <div class="mt-2 text-sm text-green-700 dark:text-green-300">
                  <p>正在跳转到登录页...</p>
                </div>
              </div>
            </div>
          </div>
        }

        <!-- 重置表单 -->
        @if (!isLoading() && isValid() && !isSuccess()) {
          <form class="mt-8 space-y-6" (ngSubmit)="handleSubmit($event)">
            @if (error()) {
              <div class="rounded-md bg-red-50 dark:bg-red-900/20 p-4">
                <p class="text-sm text-red-700 dark:text-red-300">{{ error() }}</p>
              </div>
            }

            <div class="space-y-4">
              <div>
                <label for="password" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  新密码
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minlength="8"
                  [(ngModel)]="newPassword"
                  class="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary focus:border-primary dark:bg-gray-800 dark:text-white"
                  placeholder="至少 8 个字符"
                />
              </div>

              <div>
                <label for="confirmPassword" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  确认新密码
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  [(ngModel)]="confirmPassword"
                  class="mt-1 block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary focus:border-primary dark:bg-gray-800 dark:text-white"
                  placeholder="再次输入新密码"
                />
              </div>
            </div>

            <div>
              <button
                type="submit"
                [disabled]="isSubmitting()"
                class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                @if (isSubmitting()) {
                  <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  处理中...
                } @else {
                  重置密码
                }
              </button>
            </div>
          </form>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
  `]
})
export class ResetPasswordComponent implements OnInit {
  private supabase = inject(SupabaseClientService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private toast = inject(ToastService);

  isLoading = signal(true);
  isValid = signal(false);
  isSuccess = signal(false);
  isSubmitting = signal(false);
  error = signal<string | null>(null);

  newPassword = '';
  confirmPassword = '';

  async ngOnInit() {
    await this.verifyResetToken();
  }

  /**
   * 验证重置令牌
   * Supabase 会在 URL hash 中传递 access_token 和 refresh_token
   */
  private async verifyResetToken() {
    if (!this.supabase.isConfigured) {
      this.isLoading.set(false);
      this.isValid.set(false);
      this.error.set('Supabase 未配置');
      return;
    }

    try {
      // 检查 URL hash 中是否有 token（Supabase 默认行为）
      const hash = window.location.hash;
      
      if (hash && hash.includes('access_token')) {
        // 解析 hash 参数
        const params = new URLSearchParams(hash.substring(1));
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        const type = params.get('type');

        if (type === 'recovery' && accessToken && refreshToken) {
          // 设置会话
          const { error } = await this.supabase.client().auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken
          });

          if (error) {
            throw error;
          }

          this.isValid.set(true);
          
          // 清除 URL hash
          window.history.replaceState(null, '', window.location.pathname);
        } else {
          this.isValid.set(false);
        }
      } else {
        // 检查是否已有有效会话（可能是页面刷新）
        const { data: { session } } = await this.supabase.client().auth.getSession();
        
        if (session) {
          this.isValid.set(true);
        } else {
          this.isValid.set(false);
        }
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.error('Token verification failed:', e);
      this.isValid.set(false);
      this.error.set(err?.message ?? '验证失败');
    } finally {
      this.isLoading.set(false);
    }
  }

  async handleSubmit(event: Event) {
    event.preventDefault();
    this.error.set(null);

    // 验证密码（统一使用8位最小长度）
    if (this.newPassword.length < 8) {
      this.error.set('密码长度至少 8 个字符');
      return;
    }

    if (this.newPassword !== this.confirmPassword) {
      this.error.set('两次输入的密码不一致');
      return;
    }

    this.isSubmitting.set(true);

    try {
      const { error } = await this.supabase.client().auth.updateUser({
        password: this.newPassword
      });

      if (error) {
        throw error;
      }

      this.isSuccess.set(true);
      this.toast.success('密码重置成功', '请使用新密码登录');

      // 登出并跳转到登录页
      await this.supabase.client().auth.signOut();
      
      setTimeout(() => {
        void this.router.navigate(['/projects']);
      }, 2000);
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.error('Password reset failed:', e);
      this.error.set(err?.message ?? '密码重置失败，请重试');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  goToLogin() {
    void this.router.navigate(['/projects']);
  }
}
