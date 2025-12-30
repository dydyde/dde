import { Component, input, output, signal, ElementRef, ViewChild, computed, OnInit, OnDestroy, HostListener, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Task } from '../../../../models';
import { renderMarkdown } from '../../../../utils/markdown';

export interface ConnectionEditorData {
  sourceId: string;
  targetId: string;
  /** 联系块标题（外显内容） */
  title: string;
  /** 联系块详细描述 */
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
 * 浮动在连接线附近，可拖动，用于编辑连接标题和描述
 * 
 * 设计思路（类似维基百科悬浮预览）：
 * - 默认预览模式，显示标题和描述
 * - 点击进入编辑模式
 * - 标题用于外显（流程图上显示）
 * - 描述用于详细说明（悬停/点击时显示）
 */
@Component({
  selector: 'app-flow-connection-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (data(); as connData) {
      <div class="fixed z-[100] animate-scale-in"
           #editorContainer
           [style.left.px]="clampedPosition().x"
           [style.top.px]="clampedPosition().y">
        <div class="bg-white rounded-lg shadow-xl border border-violet-200 overflow-hidden w-52 max-w-[calc(100vw-1.5rem)]"
             (click)="$event.stopPropagation()">
          <!-- 可拖动标题栏 - 整个标题栏都可拖动 -->
          <div class="px-2 py-1.5 bg-gradient-to-r from-violet-50 to-indigo-50 border-b border-violet-100 flex items-center gap-1.5 cursor-move select-none"
               (mousedown)="onDragStart($event)"
               (touchstart)="onDragStart($event)">
            <span class="text-[10px]">🔗</span>
            <span class="text-[10px] font-medium text-violet-700 flex-1">关联</span>
            <!-- 删除按钮 -->
            <button 
              (click)="onDeleteClick($event)"
              (touchend)="onDeleteClick($event)"
              class="text-stone-400 hover:text-red-500 p-0.5 transition-colors"
              title="删除关联">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            <span class="text-[8px] text-violet-300 ml-0.5">☰</span>
          </div>
          
          <!-- 连接的两个任务 + 模式切换 - 超紧凑显示 -->
          <div class="px-2 py-1 bg-stone-50/50 border-b border-stone-100">
            <div class="flex items-center gap-1 text-[9px]">
              @if (connectionTasks().source; as source) {
                <span class="font-bold text-violet-500 truncate max-w-[55px]">{{ compressDisplayId(source.displayId) }}</span>
              }
              <svg class="w-2.5 h-2.5 text-violet-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
              @if (connectionTasks().target; as target) {
                <span class="font-bold text-indigo-500 truncate max-w-[55px]">{{ compressDisplayId(target.displayId) }}</span>
              }
              <!-- 预览/编辑模式切换按钮 -->
              <button 
                (click)="toggleEditMode(); $event.stopPropagation()"
                class="ml-auto text-[8px] px-1 py-0.5 rounded transition-colors"
                [class.bg-indigo-100]="isEditMode()"
                [class.text-indigo-600]="isEditMode()"
                [class.bg-stone-100]="!isEditMode()"
                [class.text-stone-500]="!isEditMode()"
                [class.hover:bg-indigo-50]="!isEditMode()">
                {{ isEditMode() ? '预览' : '编辑' }}
              </button>
            </div>
          </div>
          
          <!-- 标题和描述区域 -->
          <div class="px-2 py-1.5 space-y-2">
            @if (isEditMode()) {
              <!-- 编辑模式 -->
              <!-- 标题输入 -->
              <div>
                <label class="text-[9px] text-stone-400 font-medium block mb-0.5">标题（外显）</label>
                <input 
                  #titleInput
                  type="text"
                  [(ngModel)]="editingTitle"
                  (ngModelChange)="onTitleChange($event)"
                  (keydown.escape)="exitEditMode()"
                  spellcheck="false"
                  class="w-full text-[11px] text-stone-700 border border-violet-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400 bg-white"
                  placeholder="输入关联标题..."
                  maxlength="20">
              </div>
              <!-- 描述输入 -->
              <div>
                <label class="text-[9px] text-stone-400 font-medium block mb-0.5">描述（悬停显示）</label>
                <textarea 
                  #descInput
                  [(ngModel)]="editingDescription"
                  (ngModelChange)="onDescriptionChange($event)"
                  (keydown.escape)="exitEditMode()"
                  (blur)="onTextareaBlur($event)"
                  (mousedown)="isSelecting = true"
                  (mouseup)="isSelecting = false"
                  spellcheck="false"
                  class="w-full text-[11px] text-stone-700 border border-violet-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400 bg-white resize-none font-mono"
                  placeholder="输入详细描述（支持 Markdown）..."
                  [style.min-height.px]="48"
                  [style.max-height.px]="100"></textarea>
              </div>
            } @else {
              <!-- 预览模式 -->
              <div 
                class="text-[11px] text-stone-600 min-h-[48px] px-1.5 py-1 rounded border border-transparent hover:border-stone-200 cursor-pointer transition-colors max-h-28 overflow-y-auto"
                (click)="enterEditMode(); $event.stopPropagation()">
                <!-- 标题 -->
                @if (currentTitle()) {
                  <div class="font-medium text-violet-700 mb-1 flex items-center gap-1">
                    <span class="text-[10px]">📌</span>
                    <span>{{ currentTitle() }}</span>
                  </div>
                }
                <!-- 描述 -->
                @if (currentDescription()) {
                  <div class="markdown-preview leading-relaxed text-stone-600" [innerHTML]="renderMarkdownContent(currentDescription())"></div>
                } @else if (!currentTitle()) {
                  <span class="text-stone-400 italic">点击添加标题和描述...</span>
                } @else {
                  <span class="text-stone-400 italic text-[10px]">无描述</span>
                }
              </div>
            }
          </div>
        </div>
      </div>
    }
  `
})
export class FlowConnectionEditorComponent implements OnInit, OnDestroy {
  @ViewChild('descInput') descInput!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('titleInput') titleInput!: ElementRef<HTMLInputElement>;
  @ViewChild('editorContainer') editorContainer!: ElementRef<HTMLDivElement>;

  readonly data = input<ConnectionEditorData | null>(null);
  readonly position = input<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly connectionTasks = input<ConnectionTasks>({ source: null, target: null });
  
  readonly close = output<void>();
  /** 保存事件：发送 { title, description } */
  readonly save = output<{ title: string; description: string }>();
  readonly delete = output<void>();
  readonly positionChange = output<{ x: number; y: number }>();
  readonly dragStart = output<MouseEvent | TouchEvent>();
  
  // 编辑模式状态（默认预览模式）
  readonly isEditMode = signal(false);
  
  // 当前编辑的标题和描述
  editingTitle = '';
  editingDescription = '';
  
  // 防抖保存定时器
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // 防止"打开编辑器的同一次点击"触发 document:click 立即关闭
  private ignoreOutsideUntil = 0;
  
  // 标记是否正在进行文本选择
  private isSelecting = false;

  // 当 data 变化时：刷新保护窗口，并在非编辑态同步内容
  private readonly dataSyncEffect = effect(() => {
    const data = this.data();
    console.log('[ConnectionEditor] dataSyncEffect 触发', { data });
    if (!data) return;

    this.ignoreOutsideUntil = Date.now() + 200;

    // 如果用户正在编辑，不要覆盖输入
    if (!this.isEditMode()) {
      this.editingTitle = data.title || '';
      this.editingDescription = data.description || '';
    }
  });
  
  // 计算当前标题（优先显示编辑中的内容）
  readonly currentTitle = computed(() => {
    const data = this.data();
    return this.editingTitle || data?.title || '';
  });
  
  // 计算当前描述（优先显示编辑中的内容）
  readonly currentDescription = computed(() => {
    const data = this.data();
    return this.editingDescription || data?.description || '';
  });
  
  // 计算限制在视口内的位置（已由服务端处理，这里做兜底）
  readonly clampedPosition = computed(() => {
    const pos = this.position();
    const editorWidth = 208; // w-52 = 13rem = 208px
    const editorHeight = 180; // 估算高度（更高，因为增加了标题）
    const padding = 12;
    
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1000;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    
    return {
      x: Math.max(padding, Math.min(pos.x, viewportWidth - editorWidth - padding)),
      y: Math.max(padding, Math.min(pos.y, viewportHeight - editorHeight - padding))
    };
  });

  ngOnInit(): void {
    // 初始化逻辑已由 dataSyncEffect 统一处理
  }

  ngOnDestroy(): void {
    // 清理定时器
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * 监听全局点击事件
   * - 编辑模式下，点击空白区域或外部时，退出编辑模式并保存
   * - 非编辑模式下，点击外部时关闭编辑器
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.editorContainer) return;
    if (Date.now() < this.ignoreOutsideUntil) return;
    
    // 如果正在进行文本选择，不处理
    if (this.isSelecting) return;
    
    // 检查是否有文本被选中
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    
    const target = event.target as HTMLElement;
    const editorEl = this.editorContainer.nativeElement;
    const clickedInside = editorEl && editorEl.contains(target);
    
    if (this.isEditMode()) {
      // 编辑模式下的处理
      // 检查是否点击了可交互元素（输入框、按钮等）
      const isInteractiveElement = target.tagName === 'TEXTAREA' ||
                                    target.tagName === 'BUTTON' ||
                                    target.tagName === 'svg' ||
                                    target.tagName === 'path' ||
                                    target.closest('textarea, button, svg') !== null;
      
      if (isInteractiveElement) {
        console.log('[ConnectionEditor] 点击可交互元素，保持编辑模式');
        return;
      }
      
      if (clickedInside) {
        // 点击在编辑器内部但不是可交互元素（如标题栏、空白区域），退出编辑模式
        console.log('[ConnectionEditor] 点击编辑器空白区域，退出编辑模式');
        this.exitEditMode();
      } else {
        // 点击在编辑器外部，退出编辑模式并关闭编辑器
        console.log('[ConnectionEditor] 点击编辑器外部，退出编辑模式并关闭');
        this.exitEditMode();
        this.saveAndClose();
      }
    } else {
      // 预览模式下，点击外部关闭编辑器
      if (!clickedInside) {
        this.saveAndClose();
      }
    }
  }

  /**
   * 监听全局触摸事件（移动端）
   * - 编辑模式下，触摸空白区域或外部时，退出编辑模式并保存
   * - 非编辑模式下，触摸外部时关闭编辑器
   */
  @HostListener('document:touchstart', ['$event'])
  onDocumentTouchStart(event: TouchEvent): void {
    if (!this.editorContainer) return;
    if (Date.now() < this.ignoreOutsideUntil) return;
    
    // 如果正在进行文本选择，不处理
    if (this.isSelecting) return;
    
    // 检查是否有文本被选中
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      return;
    }
    
    // 检查是否有输入框正在使用
    const activeElement = document.activeElement;
    if (activeElement && activeElement.tagName === 'TEXTAREA') {
      console.log('[ConnectionEditor] 文本框正在使用，保持编辑模式');
      return;
    }
    
    const target = event.target as HTMLElement;
    const editorEl = this.editorContainer.nativeElement;
    const clickedInside = editorEl && editorEl.contains(target);
    
    if (this.isEditMode()) {
      // 编辑模式下的处理
      const isInteractiveElement = target.tagName === 'TEXTAREA' ||
                                    target.tagName === 'BUTTON' ||
                                    target.tagName === 'svg' ||
                                    target.tagName === 'path' ||
                                    target.closest('textarea, button, svg') !== null;
      
      if (isInteractiveElement) {
        console.log('[ConnectionEditor] 触摸可交互元素，保持编辑模式');
        return;
      }
      
      if (clickedInside) {
        // 触摸在编辑器内部但不是可交互元素，退出编辑模式
        console.log('[ConnectionEditor] 触摸编辑器空白区域，退出编辑模式');
        this.exitEditMode();
      } else {
        // 触摸在编辑器外部，退出编辑模式并关闭编辑器
        console.log('[ConnectionEditor] 触摸编辑器外部，退出编辑模式并关闭');
        this.exitEditMode();
        this.saveAndClose();
      }
    } else {
      // 预览模式下，触摸外部关闭编辑器
      if (!clickedInside) {
        this.saveAndClose();
      }
    }
  }

  /**
   * 切换编辑模式
   */
  toggleEditMode(): void {
    const newMode = !this.isEditMode();
    console.log('[ConnectionEditor] toggleEditMode: 当前模式 =', this.isEditMode(), '→ 新模式 =', newMode);
    if (newMode) {
      this.enterEditMode();
    } else {
      this.exitEditMode();
    }
  }
  
  /**
   * 进入编辑模式
   */
  enterEditMode(): void {
    this.isEditMode.set(true);
    // 延迟聚焦，确保 textarea 已渲染
    setTimeout(() => {
      if (this.descInput) {
        this.descInput.nativeElement.focus();
        // 自动调整高度
        this.autoResizeTextarea(this.descInput.nativeElement);
      }
    }, 50);
  }

  /**
   * 退出编辑模式
   */
  exitEditMode(): void {
    this.isEditMode.set(false);
    // 保存内容
    this.saveContent();
  }

  /**
   * textarea 失焦处理
   * 只有当焦点移到编辑器外部时才退出编辑模式
   */
  onTextareaBlur(event: FocusEvent): void {
    // 获取新的焦点元素
    const relatedTarget = event.relatedTarget as HTMLElement;
    
    // 延迟检查，给浏览器时间处理焦点转移
    setTimeout(() => {
      if (!this.isEditMode()) return;
      if (!this.editorContainer) return;
      
      const editorEl = this.editorContainer.nativeElement;
      const activeElement = document.activeElement;
      
      // 如果焦点仍在编辑器内部（包括 textarea/input 重新获得焦点的情况），不退出编辑模式
      if (editorEl && (editorEl.contains(activeElement) || editorEl.contains(relatedTarget))) {
        return;
      }
      
      // 焦点移到编辑器外部，退出编辑模式
      this.exitEditMode();
    }, 150);
  }

  /**
   * 标题内容变化时实时保存
   */
  onTitleChange(value: string): void {
    this.editingTitle = value;
    
    // 防抖保存
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveContent();
    }, 500);
  }

  /**
   * 描述内容变化时实时保存
   */
  onDescriptionChange(value: string): void {
    this.editingDescription = value;
    
    // 自动调整高度
    if (this.descInput) {
      this.autoResizeTextarea(this.descInput.nativeElement);
    }
    
    // 防抖保存
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveContent();
    }, 500);
  }

  /**
   * 保存内容（标题和描述）
   */
  private saveContent(): void {
    const data = this.data();
    if (data && (this.editingTitle !== data.title || this.editingDescription !== data.description)) {
      this.save.emit({ title: this.editingTitle, description: this.editingDescription });
    }
  }

  /**
   * 保存并关闭
   */
  private saveAndClose(): void {
    // 先保存
    this.saveContent();
    // 再关闭
    this.close.emit();
  }

  /**
   * 压缩显示ID
   */
  compressDisplayId(displayId: string | undefined): string {
    if (!displayId) return '';
    if (displayId.length > 6) {
      return displayId.substring(0, 5) + '..';
    }
    return displayId;
  }

  /**
   * 删除按钮点击处理
   */
  onDeleteClick(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    console.log('[ConnectionEditor] 删除按钮被点击');
    // 设置忽略外部点击的保护窗口，防止 document:click 立即关闭编辑器
    this.ignoreOutsideUntil = Date.now() + 300;
    this.delete.emit();
  }

  onDragStart(event: MouseEvent | TouchEvent): void {
    event.preventDefault();
    this.dragStart.emit(event);
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(100, Math.max(48, textarea.scrollHeight)) + 'px';
  }
  
  /**
   * 渲染 Markdown 内容为安全的 HTML
   */
  renderMarkdownContent(content: string): string {
    return renderMarkdown(content);
  }
}
