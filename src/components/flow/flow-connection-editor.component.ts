import { Component, input, output, ElementRef, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Task } from '../../models';

export interface ConnectionEditorData {
  sourceId: string;
  targetId: string;
  description: string;
  x: number;
  y: number;
}

export interface ConnectionTasks {
  source: Task | null;
  target: Task | null;
}

/**
 * 联系块编辑器组件
 * 浮动在连接线附近，可拖动，用于编辑连接描述
 */
@Component({
  selector: 'app-flow-connection-editor',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (data(); as connData) {
      <div class="absolute z-30 animate-scale-in"
           [style.left.px]="position().x"
           [style.top.px]="position().y">
        <div class="bg-white rounded-xl shadow-xl border border-violet-200 overflow-hidden w-52"
             (click)="$event.stopPropagation()">
          <!-- 可拖动标题栏 -->
          <div class="px-3 py-2 bg-gradient-to-r from-violet-50 to-indigo-50 border-b border-violet-100 flex items-center justify-between cursor-move select-none"
               (mousedown)="onDragStart($event)"
               (touchstart)="onDragStart($event)">
            <div class="flex items-center gap-1.5">
              <span class="text-sm">🔗</span>
              <span class="text-xs font-medium text-violet-700">编辑关联</span>
              <span class="text-[8px] text-violet-400 ml-1">☰ 拖动</span>
            </div>
            <button (click)="close.emit(); $event.stopPropagation()" class="text-stone-400 hover:text-stone-600 p-0.5">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          
          <!-- 连接的两个任务 - 紧凑显示 -->
          <div class="px-3 py-2 bg-stone-50/50 border-b border-stone-100">
            <div class="flex items-center gap-1 text-[10px]">
              @if (connectionTasks().source; as source) {
                <span class="font-bold text-violet-500 truncate max-w-[70px]">{{ compressDisplayId(source.displayId) }}</span>
              }
              <svg class="w-3 h-3 text-violet-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
              @if (connectionTasks().target; as target) {
                <span class="font-bold text-indigo-500 truncate max-w-[70px]">{{ compressDisplayId(target.displayId) }}</span>
              }
            </div>
          </div>
          
          <!-- 描述输入 - 自动调整高度 -->
          <div class="px-3 py-2">
            <textarea 
              #descInput
              (keydown.escape)="close.emit()"
              (input)="autoResizeTextarea($event)"
              class="w-full text-xs text-stone-700 border border-stone-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-violet-300 focus:border-violet-400 bg-white resize-none"
              placeholder="输入关联描述..."
              [style.min-height.px]="28"
              [style.max-height.px]="120"
              autofocus>{{ connData.description }}</textarea>
          </div>
          
          <!-- 操作按钮 - 紧凑 -->
          <div class="flex border-t border-stone-100">
            <button 
              (click)="close.emit()"
              class="flex-1 px-2 py-1.5 text-[10px] font-medium text-stone-500 hover:bg-stone-50 transition-colors">
              取消
            </button>
            <button 
              (click)="save.emit(descInput.value)"
              class="flex-1 px-2 py-1.5 text-[10px] font-medium text-white bg-violet-500 hover:bg-violet-600 transition-colors">
              保存
            </button>
          </div>
        </div>
      </div>
    }
  `
})
export class FlowConnectionEditorComponent {
  @ViewChild('descInput') descInput!: ElementRef<HTMLTextAreaElement>;

  readonly data = input<ConnectionEditorData | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly connectionTasks = input<ConnectionTasks>({ source: null, target: null });
  
  readonly close = output<void>();
  readonly save = output<string>();
  readonly positionChange = output<{ x: number; y: number }>();
  readonly dragStart = output<MouseEvent | TouchEvent>();

  // 压缩显示ID（简化版，具体逻辑由父组件处理）
  compressDisplayId(displayId: string | undefined): string {
    if (!displayId) return '';
    // 简单的压缩逻辑：如果超过8字符，显示前6个字符...
    if (displayId.length > 8) {
      return displayId.substring(0, 6) + '..';
    }
    return displayId;
  }

  onDragStart(event: MouseEvent | TouchEvent) {
    event.preventDefault();
    this.dragStart.emit(event);
  }

  autoResizeTextarea(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(120, Math.max(28, textarea.scrollHeight)) + 'px';
  }
}
