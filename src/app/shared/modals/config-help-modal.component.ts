import { Component, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-config-help-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in p-4" (click)="close.emit()">
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden" (click)="$event.stopPropagation()">
        <div class="px-6 py-5 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-amber-200">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
              <svg class="w-5 h-5 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
            </div>
            <div>
              <h3 class="text-lg font-bold text-stone-800">Supabase 配置指南</h3>
              <p class="text-xs text-amber-700">启用云同步需要配置 Supabase 环境变量</p>
            </div>
          </div>
        </div>
        
        <div class="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
          <div class="text-sm text-stone-600">
            <p class="mb-3">您当前处于<span class="font-semibold text-amber-600">离线模式</span>，数据只保存在本地浏览器中。要启用云端同步，请按以下步骤配置：</p>
          </div>
          
          <div class="space-y-3">
            <div class="p-3 bg-stone-50 rounded-lg">
              <div class="flex items-center gap-2 mb-2">
                <span class="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-xs font-bold flex items-center justify-center">1</span>
                <span class="font-medium text-stone-700 text-sm">创建 Supabase 项目</span>
              </div>
              <p class="text-xs text-stone-500 ml-7">
                访问 <a href="https://supabase.com" target="_blank" class="text-indigo-600 hover:underline">supabase.com</a> 创建免费账号和项目
              </p>
            </div>
            
            <div class="p-3 bg-stone-50 rounded-lg">
              <div class="flex items-center gap-2 mb-2">
                <span class="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-xs font-bold flex items-center justify-center">2</span>
                <span class="font-medium text-stone-700 text-sm">获取 API 密钥</span>
              </div>
              <p class="text-xs text-stone-500 ml-7">
                在项目设置 &gt; API 中找到 Project URL 和 anon public key
              </p>
            </div>
            
            <div class="p-3 bg-stone-50 rounded-lg">
              <div class="flex items-center gap-2 mb-2">
                <span class="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-xs font-bold flex items-center justify-center">3</span>
                <span class="font-medium text-stone-700 text-sm">配置环境变量</span>
              </div>
              <p class="text-xs text-stone-500 ml-7 mb-2">
                在项目根目录创建 <code class="px-1.5 py-0.5 bg-stone-200 rounded text-[11px] font-mono">.env.local</code> 文件：
              </p>
              <div class="ml-7 p-2 bg-stone-800 rounded text-[11px] font-mono text-stone-100 overflow-x-auto">
                <div>NG_APP_SUPABASE_URL=your-project-url</div>
                <div>NG_APP_SUPABASE_ANON_KEY=your-anon-key</div>
              </div>
            </div>
            
            <div class="p-3 bg-stone-50 rounded-lg">
              <div class="flex items-center gap-2 mb-2">
                <span class="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 text-xs font-bold flex items-center justify-center">4</span>
                <span class="font-medium text-stone-700 text-sm">运行配置脚本</span>
              </div>
              <p class="text-xs text-stone-500 ml-7 mb-2">
                执行以下命令生成环境配置：
              </p>
              <div class="ml-7 p-2 bg-stone-800 rounded text-[11px] font-mono text-stone-100">
                npm run config && npm start
              </div>
            </div>
          </div>
          
          <div class="p-3 bg-emerald-50 rounded-lg border border-emerald-200">
            <div class="flex items-start gap-2">
              <svg class="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <p class="text-xs text-emerald-700">
                <span class="font-semibold">离线模式也能正常使用</span> - 您的数据会保存在浏览器本地存储中，但无法跨设备同步。
              </p>
            </div>
          </div>
        </div>
        
        <div class="px-6 py-4 bg-stone-50 border-t border-stone-200 flex justify-end gap-3">
          <a href="https://github.com/your-repo/nanoflow#readme" target="_blank" class="px-4 py-2 text-stone-600 hover:text-stone-800 text-sm font-medium transition-colors">
            查看文档
          </a>
          <button (click)="close.emit()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium">
            我知道了
          </button>
        </div>
      </div>
    </div>
  `
})
export class ConfigHelpModalComponent {
  @Output() close = new EventEmitter<void>();
}
