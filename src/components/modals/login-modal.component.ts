import { Component, signal, computed, Output, EventEmitter, input, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-login-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div data-testid="login-modal" class="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6 animate-scale-in" (click)="$event.stopPropagation()">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
            <svg class="w-5 h-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </div>
          <div>
            <h3 class="text-lg font-semibold text-stone-800">
              @if (isResetPasswordMode()) { 重置密码 }
              @else if (isSignupMode()) { 注册账号 }
              @else { 登录 }
            </h3>
            <p class="text-xs text-stone-500">
              @if (isResetPasswordMode()) { 输入邮箱接收重置链接 }
              @else if (isSignupMode()) { 创建新账号开始使用 }
              @else { 登录后可同步云端数据 }
            </p>
          </div>
        </div>
        
        <!-- 密码重置表单 -->
        @if (isResetPasswordMode()) {
          @if (isResetPasswordSent()) {
            <div class="text-center py-4">
              <div class="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                <svg class="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                </svg>
              </div>
              <p class="text-stone-700 text-sm mb-1">重置邮件已发送</p>
              <p class="text-stone-500 text-xs">请查收邮件并点击链接重置密码</p>
              <button type="button" (click)="switchToLogin()" class="mt-4 px-4 py-2 text-indigo-600 hover:bg-indigo-50 rounded-lg text-sm">返回登录</button>
            </div>
          } @else {
            <form (submit)="handleResetPassword($event)" class="space-y-4">
              <input type="email" placeholder="邮箱" 
                     [ngModel]="email()" (ngModelChange)="email.set($event)" 
                     [ngModelOptions]="{standalone: true}" name="resetEmail" 
                     class="w-full border border-stone-200 rounded-lg px-4 py-3 text-sm text-stone-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all" 
                     autocomplete="email" required>
              
              @if (currentError) {
                <div data-testid="auth-error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{{ currentError }}</div>
              }
              
              <div class="flex gap-2 pt-2">
                <button type="button" (click)="switchToLogin()" class="flex-1 px-4 py-2.5 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors text-sm font-medium">返回登录</button>
                <button type="submit" class="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-semibold disabled:opacity-60" [disabled]="isLoading()">
                  @if (isLoading()) { 发送中... } @else { 发送重置邮件 }
                </button>
              </div>
            </form>
          }
        }
        <!-- 注册表单 -->
        @else if (isSignupMode()) {
          <form (submit)="handleSignup($event)" class="space-y-4">
            <div class="space-y-3">
              <input type="email" placeholder="邮箱" 
                     [ngModel]="email()" (ngModelChange)="email.set($event)" 
                     [ngModelOptions]="{standalone: true}" name="signupEmail" 
                     class="w-full border border-stone-200 rounded-lg px-4 py-3 text-sm text-stone-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all" 
                     autocomplete="email" required>
              <input type="password" placeholder="密码（至少8位）" 
                     [ngModel]="password()" (ngModelChange)="password.set($event)" 
                     [ngModelOptions]="{standalone: true}" name="signupPassword" 
                     class="w-full border border-stone-200 rounded-lg px-4 py-3 text-sm text-stone-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all" 
                     autocomplete="new-password" required minlength="8">
              <input type="password" placeholder="确认密码" 
                     [ngModel]="confirmPassword()" (ngModelChange)="confirmPassword.set($event)" 
                     [ngModelOptions]="{standalone: true}" name="signupConfirmPassword" 
                     class="w-full border border-stone-200 rounded-lg px-4 py-3 text-sm text-stone-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all" 
                     autocomplete="new-password" required>
            </div>
            
            @if (currentError) {
              <div class="text-xs bg-amber-50 border border-amber-100 rounded-lg px-3 py-2"
                   [class.text-red-500]="!currentError?.includes('成功')"
                   [class.text-green-600]="currentError?.includes('成功')">{{ currentError }}</div>
            }
            
            <div class="flex gap-2 pt-2">
              <button type="button" (click)="switchToLogin()" class="flex-1 px-4 py-2.5 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors text-sm font-medium">返回登录</button>
              <button type="submit" class="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-semibold disabled:opacity-60" [disabled]="isLoading()">
                @if (isLoading()) { 注册中... } @else { 注册 }
              </button>
            </div>
          </form>
        }
        <!-- 登录表单 -->
        @else {
          <form (submit)="handleLogin($event)" class="space-y-4">
            <div class="space-y-3">
              <input data-testid="email-input" type="email" placeholder="邮箱" 
                     [ngModel]="email()" (ngModelChange)="email.set($event)" 
                     [ngModelOptions]="{standalone: true}" name="authEmailModal" 
                     class="w-full border border-stone-200 rounded-lg px-4 py-3 text-sm text-stone-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all" 
                     autocomplete="email" required>
              <input data-testid="password-input" type="password" placeholder="密码" 
                     [ngModel]="password()" (ngModelChange)="password.set($event)" 
                     [ngModelOptions]="{standalone: true}" name="authPasswordModal" 
                     class="w-full border border-stone-200 rounded-lg px-4 py-3 text-sm text-stone-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-all" 
                     autocomplete="current-password" required>
            </div>
            
            @if (currentError) {
              <div data-testid="auth-error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{{ currentError }}</div>
            }
            
            <div class="flex flex-col gap-2 pt-2">
              <div class="flex gap-2">
                <button type="button" (click)="close.emit()" class="flex-1 px-4 py-2.5 text-stone-600 hover:bg-stone-100 rounded-lg transition-colors text-sm font-medium">取消</button>
                <button data-testid="submit-login" type="submit" class="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-semibold disabled:opacity-60" [disabled]="isLoading()">
                  @if (isLoading()) { 登录中... } @else { 登录 }
                </button>
              </div>
              <div class="flex justify-center gap-4 text-xs">
                <button type="button" (click)="switchToSignup()" class="text-indigo-600 hover:text-indigo-800">没有账号？注册</button>
                <button type="button" (click)="switchToResetPassword()" class="text-stone-500 hover:text-stone-700">忘记密码？</button>
              </div>
              
              <!-- 本地模式分隔线和按钮 -->
              <div class="relative my-3">
                <div class="absolute inset-0 flex items-center">
                  <div class="w-full border-t border-stone-200"></div>
                </div>
                <div class="relative flex justify-center text-xs">
                  <span class="bg-white px-2 text-stone-400">或</span>
                </div>
              </div>
              
              <button 
                type="button" 
                (click)="handleLocalMode()" 
                data-testid="local-mode-btn"
                class="w-full px-4 py-2.5 text-stone-600 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-lg transition-colors text-sm font-medium flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                </svg>
                本地模式（不同步云端）
              </button>
              <p class="text-xs text-stone-400 text-center">数据仅保存在本地，不会同步到云端</p>
            </div>
          </form>
        }
      </div>
    </div>
  `
})
export class LoginModalComponent implements OnDestroy {
  @Output() close = new EventEmitter<void>();
  @Output() login = new EventEmitter<{ email: string; password: string }>();
  @Output() signup = new EventEmitter<{ email: string; password: string; confirmPassword: string }>();
  @Output() resetPassword = new EventEmitter<string>();
  @Output() localMode = new EventEmitter<void>();
  
  /** 认证错误信息 */
  authError = input<string | null>(null);
  /** 是否正在加载 */
  isLoading = input(false);
  /** 重置密码邮件是否已发送（由父组件控制） */
  resetPasswordSentInput = input<boolean>(false, { alias: 'resetPasswordSent' });
  
  // 内部状态：用于模态框内部清除错误
  private _internalError = signal<string | null>(null);
  
  // 内部状态
  email = signal('');
  password = signal('');
  confirmPassword = signal('');
  isSignupMode = signal(false);
  isResetPasswordMode = signal(false);
  
  /** 统一的重置密码发送状态（合并外部和内部状态） */
  readonly isResetPasswordSent = computed(() => this.resetPasswordSentInput());
  
  /**
   * 计算密码强度 (0-4)
   * 0: 太短
   * 1: 弱（仅满足长度）
   * 2: 中（满足2个条件）
   * 3: 强（满足3个条件）
   * 4: 很强（满足所有条件）
   */
  passwordStrength = computed(() => {
    const pwd = this.password();
    if (pwd.length < 8) return 0;
    
    let score = 1; // 长度满足
    if (/[a-z]/.test(pwd)) score++; // 小写字母
    if (/[A-Z]/.test(pwd)) score++; // 大写字母
    if (/\d/.test(pwd)) score++; // 数字
    if (/[^a-zA-Z0-9]/.test(pwd)) score++; // 特殊字符
    
    return Math.min(4, score);
  });
  
  passwordStrengthText = computed(() => {
    const strength = this.passwordStrength();
    switch (strength) {
      case 0: return '密码太短';
      case 1: return '弱';
      case 2: return '中';
      case 3: return '强';
      case 4: return '很强';
      default: return '';
    }
  });
  
  passwordHint = computed(() => {
    const pwd = this.password();
    if (pwd.length < 8) return '需要至少8位';
    const missing: string[] = [];
    if (!/[a-z]/.test(pwd)) missing.push('小写');
    if (!/[A-Z]/.test(pwd)) missing.push('大写');
    if (!/\d/.test(pwd)) missing.push('数字');
    if (missing.length > 0) return `建议添加: ${missing.join('、')}`;
    return '✓';
  });
  
  switchToSignup() {
    this.isSignupMode.set(true);
    this.isResetPasswordMode.set(false);
    this._internalError.set(null);
    this.password.set('');
    this.confirmPassword.set('');
  }
  
  switchToLogin() {
    this.isSignupMode.set(false);
    this.isResetPasswordMode.set(false);
    this._internalError.set(null);
  }
  
  switchToResetPassword() {
    this.isResetPasswordMode.set(true);
    this.isSignupMode.set(false);
    this._internalError.set(null);
  }
  
  /** 获取当前显示的错误（外部传入优先，其次是内部错误） */
  get currentError(): string | null {
    return this.authError() ?? this._internalError();
  }
  
  handleLogin(event: Event) {
    event.preventDefault();
    this.login.emit({ email: this.email(), password: this.password() });
  }
  
  handleSignup(event: Event) {
    event.preventDefault();
    this.signup.emit({ 
      email: this.email(), 
      password: this.password(), 
      confirmPassword: this.confirmPassword() 
    });
  }
  
  handleResetPassword(event: Event) {
    event.preventDefault();
    this.resetPassword.emit(this.email());
  }
  
  handleLocalMode() {
    this.localMode.emit();
  }
  
  // 设置重置密码已发送状态（保留接口兼容性，现在由父组件控制）
  setResetPasswordSent(sent: boolean) {
    // 状态现在由父组件通过 input 控制
    // 此方法保留用于向后兼容
  }
  
  /**
   * 重置所有表单状态
   * 应在模态框关闭时调用，防止敏感信息残留
   */
  resetFormState() {
    this.email.set('');
    this.password.set('');
    this.confirmPassword.set('');
    this._internalError.set(null);
    this.isSignupMode.set(false);
    this.isResetPasswordMode.set(false);
  }

  /**
   * 组件销毁时自动清理敏感数据
   * 确保密码等敏感信息不会残留在内存中
   */
  ngOnDestroy() {
    this.resetFormState();
  }
}
