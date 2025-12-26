import { Component, inject, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../../../services/store.service';
import { UnfinishedItem } from './text-view.types';

/**
 * 待办事项区组件
 * 显示所有未完成的待办项，支持完成和跳转操作
 */
@Component({
  selector: 'app-text-unfinished',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section 
      class="flex-none mt-2 px-2 pb-1 rounded-xl bg-retro-rust/10 border border-retro-rust/30 transition-all"
      [ngClass]="{'mx-4 mt-4': !isMobile, 'mx-2': isMobile}">
      
      <header 
        (click)="store.isTextUnfinishedOpen.set(!store.isTextUnfinishedOpen())" 
        class="py-2 cursor-pointer flex justify-between items-center group select-none">
        <span class="font-bold text-retro-dark flex items-center gap-2 tracking-tight"
              [ngClass]="{'text-sm': !isMobile, 'text-xs': isMobile}">
          <span class="w-1.5 h-1.5 rounded-full bg-retro-rust shadow-[0_0_6px_rgba(193,91,62,0.4)]"></span>
          待办事项
        </span>
        <span class="text-stone-300 text-xs group-hover:text-stone-500 transition-transform" 
              [class.rotate-180]="!store.isTextUnfinishedOpen()">▼</span>
      </header>
      
      @if (store.isTextUnfinishedOpen()) {
        <div class="pb-2 overflow-y-auto grid grid-cols-1 animate-collapse-open"
             [ngClass]="{'max-h-48 gap-2': !isMobile, 'max-h-36 gap-1': isMobile}">
          @for (item of store.unfinishedItems(); track trackItem(item)) {
            <div class="p-2 bg-panel/50 backdrop-blur-sm rounded-lg border border-retro-muted/20 hover:border-retro-rust hover:shadow-sm cursor-pointer group flex items-start gap-2 active:scale-[0.98] transition-all">
              <button 
                (click)="onComplete(item.taskId, item.text, $event)"
                class="mt-0.5 w-4 h-4 rounded-full border-2 border-retro-muted bg-canvas hover:border-green-500 hover:bg-green-50 active:scale-90 transition-all"
                title="点击完成"></button>
              <div class="flex-1 min-w-0" (click)="jumpToTask.emit(item.taskId)">
                <div class="text-[9px] font-bold text-retro-muted mb-0.5 tracking-wider group-hover:text-retro-rust transition-colors">
                  {{store.compressDisplayId(item.taskDisplayId)}}
                </div>
                <div class="text-xs text-stone-600 line-clamp-2 group-hover:text-stone-900 transition-colors leading-relaxed">
                  {{item.text}}
                </div>
              </div>
            </div>
          } @empty {
            <div class="text-xs text-stone-400 italic py-1 font-light">暂无待办</div>
          }
        </div>
      }
    </section>
  `,
  styles: [`
    .animate-collapse-open { 
      animation: collapseOpen 0.15s ease-out; 
    }
    @keyframes collapseOpen { 
      from { opacity: 0; transform: translateY(-4px); } 
      to { opacity: 1; transform: translateY(0); } 
    }
  `]
})
export class TextUnfinishedComponent {
  readonly store = inject(StoreService);
  
  @Input() isMobile = false;
  @Output() jumpToTask = new EventEmitter<string>();
  
  trackItem = (item: UnfinishedItem) => `${item.taskId}-${item.text}`;
  
  onComplete(taskId: string, text: string, event: Event) {
    event.stopPropagation();
    this.store.completeUnfinishedItem(taskId, text);
  }
}
