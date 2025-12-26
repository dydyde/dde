import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FlowConnectionEditorComponent, ConnectionEditorData, ConnectionTasks } from './flow-connection-editor.component';
import { signal } from '@angular/core';

describe('FlowConnectionEditorComponent - Markdown 支持', () => {
  let component: FlowConnectionEditorComponent;
  let fixture: ComponentFixture<FlowConnectionEditorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FlowConnectionEditorComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(FlowConnectionEditorComponent);
    component = fixture.componentInstance;
  });

  it('应该创建组件', () => {
    expect(component).toBeTruthy();
  });

  it('默认应该是预览模式', () => {
    expect(component.isEditMode()).toBe(false);
  });

  it('应该能切换到编辑模式', () => {
    component.toggleEditMode();
    expect(component.isEditMode()).toBe(true);
  });

  it('应该能从编辑模式切换回预览模式', () => {
    component.toggleEditMode(); // 进入编辑模式
    expect(component.isEditMode()).toBe(true);
    
    component.toggleEditMode(); // 退出编辑模式
    expect(component.isEditMode()).toBe(false);
  });

  it('应该能渲染 Markdown 内容', () => {
    const markdownText = '**粗体** 和 *斜体*';
    const rendered = component.renderMarkdownContent(markdownText);
    
    expect(rendered).toContain('<strong>');
    expect(rendered).toContain('<em>');
  });

  it('应该能处理空描述', () => {
    const rendered = component.renderMarkdownContent('');
    expect(rendered).toBe('');
  });

  it('Markdown 应该能渲染列表', () => {
    const markdownText = '- 项目1\n- 项目2';
    const rendered = component.renderMarkdownContent(markdownText);
    
    expect(rendered).toContain('<ul class="list-disc');
    expect(rendered).toContain('<li');
    expect(rendered).toContain('项目1');
    expect(rendered).toContain('项目2');
  });

  it('Markdown 应该能渲染待办事项', () => {
    const markdownText = '- [ ] 待办任务\n- [x] 已完成任务';
    const rendered = component.renderMarkdownContent(markdownText);
    
    expect(rendered).toContain('待办任务');
    expect(rendered).toContain('已完成任务');
    // 检查 Unicode 方框字符（实际渲染结果）
    expect(rendered).toContain('☐');
    expect(rendered).toContain('☑');
  });
});
