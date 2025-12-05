import { Component, inject, Input, Output, EventEmitter, ChangeDetectionStrategy, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { Task } from '../../models';
import { extractPlainText } from '../../utils/markdown';
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
      (dragend)="dragEnd.emit()"
      (dragover)="onDragOver($event)"
      (touchstart)="onTouchStart($event)"
      (touchmove)="touchMove.emit($event)"
      (touchend)="touchEnd.emit($event)"
      class="relative bg-canvas/80 backdrop-blur-sm border rounded-lg cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all group stack-card overflow-hidden"
      [ngClass]="cardClasses">
      
      <!-- 头部信息 -->
      <div class="flex justify-between items-start"
           [ngClass]="{'mb-1': !isMobile, 'mb-0.5': isMobile}">
        <span class="font-mono font-medium text-retro-muted"
              [ngClass]="{'text-[10px]': !isMobile, 'text-[9px]': isMobile}">
          {{store.compressDisplayId(task.displayId)}}
        </span>
        <span class="text-retro-muted/60 font-light"
              [ngClass]="{'text-[10px]': !isMobile, 'text-[9px]': isMobile}">
          {{task.createdDate | date:'yyyy/MM/dd HH:mm'}}
        </span>
      </div>
      
      @if (!isSelected) {
        <!-- 收起状态 -->
        <div class="font-medium text-retro-dark leading-snug line-clamp-2 cursor-pointer"
             [ngClass]="{'text-sm mb-1': !isMobile, 'text-xs mb-0.5': isMobile}">
          {{task.title || '未命名任务'}}
        </div>
        <div class="text-stone-500 font-light leading-relaxed line-clamp-1 cursor-pointer min-h-[1em]"
             [ngClass]="{'text-xs': !isMobile, 'text-[10px]': isMobile}">
          {{getContentPreview(task.content) || '暂无描述'}}
        </div>
      } @else {
        <!-- 展开编辑状态 -->
        <app-text-task-editor
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
  readonly store = inject(StoreService);
  
  @Input({ required: true }) task!: Task;
  @Input() isMobile = false;
  @Input() isSelected = false;
  @Input() isDragging = false;
  @Input() userId: string | null = null;
  @Input() projectId: string | null = null;
  @Input() connections: any = null;
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
  
  get cardClasses() {
    return {
      'p-3': !this.isMobile,
      'p-2': this.isMobile,
      'shadow-sm border-retro-muted/20': !this.isSelected,
      'ring-1 ring-retro-gold shadow-md': this.isSelected,
      'opacity-50 touch-none': this.isDragging
    };
  }
  
  getContentPreview(content: string): string {
    return extractPlainText(content, 80);
  }
  
  onCardClick(event: Event) {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('input, textarea, button')) {
      return;
    }
    this.select.emit(this.task);
  }
  
  onDragStart(event: DragEvent) {
    if (!this.isSelected) {
      this.dragStart.emit({ event, task: this.task });
    }
  }
  
  onDragOver(event: DragEvent) {
    this.dragOver.emit({ event, task: this.task, stageNumber: this.stageNumber });
  }
  
  onTouchStart(event: TouchEvent) {
    if (!this.isSelected) {
      this.touchStart.emit({ event, task: this.task });
    }
  }
}
