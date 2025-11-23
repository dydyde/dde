import { Component, inject, signal, WritableSignal, HostListener, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from './services/store.service';
import { TextViewComponent } from './components/text-view.component';
import { FlowViewComponent } from './components/flow-view.component';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, TextViewComponent, FlowViewComponent, FormsModule],
  templateUrl: './app.component.html',
})
export class AppComponent {
  store = inject(StoreService);
  
  isSidebarOpen = signal(true);
  isFilterOpen = signal(false); // Add this line
  
  currentFilterLabel = computed(() => {
    const filterId = this.store.filterMode();
    if (filterId === 'all') return '全部任务';
    const task = this.store.rootTasks().find(t => t.id === filterId);
    return task ? task.title : '全部任务';
  });

  showSettings = signal(false);
  showNewProjectModal = signal(false);
  showGenAIModal = signal(false);
  showImageEditModal = signal(false);

  genAiImage: WritableSignal<string | null> = signal(null);
  editingImage: WritableSignal<string | null> = signal(null);
  isGenerating = signal(false);

  // Resizing State
  isResizingSidebar = false;
  isResizingContent = false;
  private startX = 0;
  private startWidth = 0;
  private startRatio = 0;
  private mainContentWidth = 0;

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  // --- Resizing Logic ---

  startSidebarResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingSidebar = true;
      this.startX = e.clientX;
      this.startWidth = this.store.sidebarWidth();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  startContentResize(e: MouseEvent) {
      e.preventDefault();
      this.isResizingContent = true;
      this.startX = e.clientX;
      this.startRatio = this.store.textColumnRatio();
      
      // Get current main content width
      const mainEl = document.querySelector('main');
      this.mainContentWidth = mainEl ? mainEl.clientWidth : 1000;
      
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(e: MouseEvent) {
      if (this.isResizingSidebar) {
          const delta = e.clientX - this.startX;
          const newWidth = Math.max(200, Math.min(600, this.startWidth + delta));
          this.store.sidebarWidth.set(newWidth);
      } else if (this.isResizingContent) {
          const delta = e.clientX - this.startX;
          // Convert delta pixels to percentage
          const deltaPercent = (delta / this.mainContentWidth) * 100;
          const newRatio = Math.max(20, Math.min(80, this.startRatio + deltaPercent));
          this.store.textColumnRatio.set(newRatio);
      }
  }

  @HostListener('document:mouseup')
  onMouseUp() {
      if (this.isResizingSidebar || this.isResizingContent) {
          this.isResizingSidebar = false;
          this.isResizingContent = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
      }
  }

  selectProject(id: string) {
    this.store.activeProjectId.set(id);
  }

  createNewProject() {
    this.showNewProjectModal.set(true);
  }
  
  confirmCreateProject(name: string, desc: string) {
      if (!name) return;
      this.store.addProject({
          id: crypto.randomUUID(),
          name,
          description: desc,
          createdDate: new Date().toISOString(),
          tasks: [],
          connections: []
      });
      this.showNewProjectModal.set(false);
  }

  openSettings() {
    this.showSettings.set(true);
  }

  closeSettings() {
    this.showSettings.set(false);
  }

  updateLayoutDirection(e: Event) {
    const val = (e.target as HTMLSelectElement).value as 'ltr' | 'rtl';
    this.store.layoutDirection.set(val);
  }
  
  updateFloatPref(e: Event) {
      const val = (e.target as HTMLSelectElement).value as 'auto' | 'fixed';
      this.store.floatingWindowPref.set(val);
  }

  updateFilter(e: Event) {
      this.store.filterMode.set((e.target as HTMLSelectElement).value);
  }
  
  generateImage() {
      this.closeSettings();
      this.showGenAIModal.set(true);
  }
  
  openImageEditor() {
      this.closeSettings();
      this.showImageEditModal.set(true);
  }
  
  async runImageGen(prompt: string) {
      if (!prompt) return;
      this.isGenerating.set(true);
      const img = await this.store.generateImage(prompt);
      this.genAiImage.set(img);
      this.isGenerating.set(false);
  }

  async runImageEdit(prompt: string) {
      if (!prompt || !this.editingImage()) return;
      this.isGenerating.set(true);
      const result = await this.store.editImageWithPrompt(this.editingImage()!, prompt);
      if (result) {
          this.editingImage.set(result); // Update view with new image
      }
      this.isGenerating.set(false);
  }

  onFileSelected(event: Event) {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = (e) => {
              this.editingImage.set(e.target?.result as string);
          };
          reader.readAsDataURL(file);
      }
  }
}
