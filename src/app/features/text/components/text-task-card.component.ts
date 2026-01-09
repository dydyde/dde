import { Component, inject, Input, Output, EventEmitter, ChangeDetectionStrategy, OnChanges, SimpleChanges, ViewChild, ElementRef } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import { ProjectStateService } from '../../../../services/project-state.service';
import { Task, Connection } from '../../../../models';
import { renderMarkdownSafe } from '../../../../utils/markdown';
import { TextTaskEditorComponent } from './text-task-editor.component';

/**
 * 任务卡片组件
 * 显示单个任务，支持收起/展开两种状态
 */
@Component({
  selector: 'app-text-task-card',
  standalone: true,
  imports: [CommonModule, DatePipe, TextTaskEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div 
      [attr.data-task-id]="task.id"
      (click)="onCardClick($event)"
      [attr.draggable]="!isSelected"
      (dragstart)="onDragStart($event)"
      (dragend)="onDragEnd()"
      (dragover)="onDragOver($event)"
      (touchstart)="onTouchStart($event)"
      (touchmove)="onTouchMove($event)"
      (touchend)="onTouchEnd($event)"
      (touchcancel)="onTouchCancel($event)"
      class="relative bg-canvas/80 dark:bg-stone-800/80 backdrop-blur-sm border rounded-lg cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all group stack-card overflow-hidden"
      [ngClass]="cardClasses">
      
      <!-- 头部信息 -->
      <div class="flex justify-between items-start"
           [ngClass]="{'mb-1': !isMobile, 'mb-0.5': isMobile}">
        <span class="font-mono font-medium text-retro-muted"
              [ngClass]="{'text-[10px]': !isMobile, 'text-[9px]': isMobile}">
          {{projectState.compressDisplayId(task.displayId)}}
        </span>
        <span class="text-retro-muted/60 dark:text-stone-500 font-light"
              [ngClass]="{'text-[10px]': !isMobile, 'text-[9px]': isMobile}">
          {{task.createdDate | date:'yyyy/MM/dd HH:mm'}}
        </span>
      </div>
      
      @if (!isSelected) {
        <!-- 收起状态 -->
        <div class="font-medium text-retro-dark dark:text-stone-200 leading-snug line-clamp-2 cursor-pointer"
             [ngClass]="{'text-sm mb-1': !isMobile, 'text-xs mb-0.5': isMobile}">
          {{task.title || '未命名任务'}}
        </div>
        @if (task.content) {
          <div class="text-stone-500 dark:text-stone-400 font-light leading-relaxed line-clamp-1 cursor-pointer min-h-[1em] markdown-preview-compact"
               [ngClass]="{'text-xs': !isMobile, 'text-[10px]': isMobile}"
               [innerHTML]="renderMarkdown(task.content)">
          </div>
        } @else {
          <div class="text-stone-400 dark:text-stone-500 italic font-light leading-relaxed line-clamp-1 cursor-pointer min-h-[1em]"
               [ngClass]="{'text-xs': !isMobile, 'text-[10px]': isMobile}">
            暂无描述
          </div>
        }
      } @else {
        <!-- 展开编辑状态 -->
        <app-text-task-editor
          #taskEditor
          [task]="task"
          [isMobile]="isMobile"
          [userId]="userId"
          [projectId]="projectId"
          [connections]="connections"
          (addSibling)="addSibling.emit()"
          (addChild)="addChild.emit()"
          (deleteTask)="deleteTask.emit()"
          (attachmentError)="attachmentError.emit($event)"
          (openLinkedTask)="openLinkedTask.emit($event)">
        </app-text-task-editor>
      }
    </div>
  `
})
export class TextTaskCardComponent implements OnChanges {
  readonly projectState = inject(ProjectStateService);
  private readonly sanitizer = inject(DomSanitizer);
  
  @ViewChild('taskEditor') taskEditor?: TextTaskEditorComponent;
  @ViewChild('taskEditor', { read: ElementRef }) taskEditorElement?: ElementRef<HTMLElement>;
  
  @Input({ required: true }) task!: Task;
  @Input() isMobile = false;
  @Input() isSelected = false;
  @Input() isDragging = false;
  @Input() userId: string | null = null;
  @Input() projectId: string | null = null;
  @Input() connections: Connection[] | null = null;
  @Input() stageNumber = 0;
  
  ngOnChanges(changes: SimpleChanges) {
    if (changes['task']) {
      const prev = changes['task'].previousValue as Task | undefined;
      const curr = changes['task'].currentValue as Task;
      
      // 检测 displayId 从有效值变成 "?" 的情况
      if (prev?.displayId && prev.displayId !== '?' && curr?.displayId === '?') {
        console.warn('[TextTaskCard] displayId changed from valid to "?":', {
          taskId: curr.id.slice(-4),
          prevDisplayId: prev.displayId,
          currDisplayId: curr.displayId,
          title: curr.title || 'untitled',
          stage: curr.stage,
          parentId: curr.parentId?.slice(-4) || null,
          isFirstChange: changes['task'].isFirstChange()
        });
        console.trace('[TextTaskCard] Stack trace');
      }
    }
  }
  
  @Output() select = new EventEmitter<Task>();
  @Output() addSibling = new EventEmitter<void>();
  @Output() addChild = new EventEmitter<void>();
  @Output() deleteTask = new EventEmitter<void>();
  @Output() attachmentError = new EventEmitter<string>();
  @Output() openLinkedTask = new EventEmitter<{ task: Task; event: Event }>();
  
  // 拖拽事件
  @Output() dragStart = new EventEmitter<{ event: DragEvent; task: Task }>();
  @Output() dragEnd = new EventEmitter<void>();
  @Output() dragOver = new EventEmitter<{ event: DragEvent; task: Task; stageNumber: number }>();
  @Output() touchStart = new EventEmitter<{ event: TouchEvent; task: Task }>();
  @Output() touchMove = new EventEmitter<TouchEvent>();
  @Output() touchEnd = new EventEmitter<TouchEvent>();
  @Output() touchCancel = new EventEmitter<TouchEvent>();
  
  get cardClasses() {
    return {
      'p-3': !this.isMobile,
      'p-2': this.isMobile,
      'shadow-sm border-retro-muted/20': !this.isSelected && !this.isDragging,
      'ring-1 ring-retro-gold shadow-md': this.isSelected,
      // 拖拽时的视觉效果：半透明、缩小、虚线边框
      // 注意：不使用 pointer-events-none，因为会阻止 touchend 事件
      'opacity-40 scale-98 border-2 border-retro-teal border-dashed bg-retro-teal/5': this.isDragging
    };
  }
  
  /**
   * 渲染 Markdown 内容
   */
  renderMarkdown(content: string) {
    return renderMarkdownSafe(content, this.sanitizer);
  }
  
  /**
   * 处理卡片点击
   * - 如果任务未选中：选中任务（展开）
   * - 如果任务已选中且点击卡片头部：切换到预览模式
   */
  onCardClick(event: Event) {
    const targetElement = event.target instanceof HTMLElement ? event.target : null;
    
    // 如果点击的是输入框、文本框或按钮，或者点击目标在这些元素内部，直接阻止冒泡并返回
    if (targetElement && (
        targetElement.tagName === 'INPUT' || 
        targetElement.tagName === 'TEXTAREA' || 
        targetElement.tagName === 'BUTTON' ||
        targetElement.closest('input, textarea, button'))
    ) {
      event.stopPropagation();
      return;
    }
    
    if (this.isSelected) {
      // 任务已展开，检查是否点击在编辑器区域内
      const clickedInEditor = this.isClickInsideEditor(event.target);
      
      // 只有点击在编辑器区域外部（如卡片头部）时才切换到预览模式
      if (!clickedInEditor) {
        this.taskEditor?.setPreviewMode();
      }
      // 无论如何都阻止事件冒泡，避免触发父组件的收缩逻辑
      event.stopPropagation();
    } else {
      // 任务未展开，触发选中事件
      this.select.emit(this.task);
    }
  }

  private isClickInsideEditor(target: EventTarget | null): boolean {
    if (!target) return false;
    const editorElement = this.taskEditorElement?.nativeElement;
    if (!editorElement) return false;
    
    if (target instanceof Node && editorElement.contains(target)) {
      return true;
    }
    
    if (target instanceof Element) {
      return !!target.closest('app-text-task-editor');
    }
    
    return false;
  }
  
  onDragStart(event: DragEvent) {
    // 只在未选中状态下允许鼠标拖拽
    if (!this.isSelected) {
      this.dragStart.emit({ event, task: this.task });
    } else {
      event.preventDefault();
    }
  }
  
  onDragEnd() {
    if (!this.isSelected) {
      this.dragEnd.emit();
    }
  }
  
  onDragOver(event: DragEvent) {
    this.dragOver.emit({ event, task: this.task, stageNumber: this.stageNumber });
  }
  
  onTouchStart(event: TouchEvent) {
    // 只在未选中状态下允许触摸拖拽（与待分配区域一致）
    // 不在这里 preventDefault，让浏览器正常处理触摸开始
    if (!this.isSelected) {
      this.touchStart.emit({ event, task: this.task });
    }
  }
  
  onTouchMove(event: TouchEvent) {
    if (!this.isSelected) {
      // 发射事件让父组件处理
      this.touchMove.emit(event);
      // 🔧 修复：在拖拽状态下或有待处理的触摸拖拽时都要阻止默认行为
      // 这样可以防止浏览器触发页面滚动，确保拖拽体验流畅
      // 注意：isDragging 属性由父组件传入，在拖拽激活后会变为 true
      if (this.isDragging) {
        event.preventDefault();
      }
      // 注意：在拖拽激活前的 touchmove 不阻止默认行为，
      // 这是为了让用户可以正常滚动页面（垂直方向的移动）
    }
  }
  
  onTouchEnd(event: TouchEvent) {
    // console.log('[TaskCard] touchend received', {
    //   taskId: this.task.id.slice(-4),
    //   isSelected: this.isSelected,
    //   isDragging: this.isDragging
    // });
    if (!this.isSelected) {
      // 不在这里 preventDefault，让事件正常冒泡到 document
      this.touchEnd.emit(event);
    }
  }
  
  onTouchCancel(event: TouchEvent) {
    if (!this.isSelected) {
      this.touchCancel.emit(event);
    }
  }
}
