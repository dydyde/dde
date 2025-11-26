import { Injectable } from '@angular/core';
import { createClient, type AuthResponse, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment'; // 引入环境文件

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private supabase: SupabaseClient;

  constructor() {
    const supabaseUrl = environment.supabaseUrl;
    const supabaseAnonKey = environment.supabaseAnonKey;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error('Supabase keys missing. Check src/environments/environment.ts');
      // 防止报错崩溃，给个空值，但功能会失效
      this.supabase = createClient('https://placeholder.supabase.co', 'placeholder');
      return;
    }

    this.supabase = createClient(supabaseUrl, supabaseAnonKey);
  }

  get isConfigured() {
    return Boolean(environment.supabaseUrl && environment.supabaseAnonKey);
  }

  client(): SupabaseClient {
    if (!this.isConfigured) {
      throw new Error('Supabase 未配置，请提供 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY');
    }
    return this.supabase;
  }

  reset() {
    this.supabase = null;
  }

  async getSession() {
    if (!this.isConfigured) {
      return { data: { session: null as Session | null }, error: null };
    }
    return this.supabase.auth.getSession();
  }

  async signInWithPassword(email: string, password: string): Promise<AuthResponse> {
    if (!this.isConfigured) {
      throw new Error('Supabase 未配置，无法登录');
    }
    return this.supabase.auth.signInWithPassword({ email, password });
  }

  async signOut() {
    if (!this.isConfigured) return;
    await this.supabase.auth.signOut();
  }
}
