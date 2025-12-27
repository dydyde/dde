# 修复 Angular 组件元数据读取错误

## 问题描述

**错误信息**: `TypeError: Cannot read properties of undefined (reading 'ɵcmp')`

**发生场景**:
1. 应用启动时，`activeProjectId` 为 null，主视图被条件渲染隐藏
2. `ProjectShellComponent` 静态导入 `TextViewComponent` 和 `FlowViewComponent`
3. 当 Supabase 数据加载完成后，`activeProjectId` 被设置为有效值
4. Angular 尝试实例化条件渲染的组件时，无法读取组件元数据 (`ɵcmp`)

## 根本原因

静态导入组件但通过 `@if` 条件渲染，会导致 Angular 在状态转换时无法正确解析组件元数据。这种情况在以下场景下特别容易出现：
- 组件在初始状态下被隐藏（条件为 false）
- 数据异步加载后，条件变为 true
- Angular 需要实例化之前未加载的组件

## 解决方案

使用 Angular 19 的 `@defer` 块实现真正的懒加载，避免静态导入导致的元数据解析问题。

### 修改内容

#### 1. 移除静态导入

**修改前**:
```typescript
import { TextViewComponent } from '../app/features/text';
import { FlowViewComponent } from '../app/features/flow';

@Component({
  imports: [CommonModule, TextViewComponent, FlowViewComponent, ErrorBoundaryComponent],
})
```

**修改后**:
```typescript
// 移除 TextViewComponent 和 FlowViewComponent 的导入

@Component({
  imports: [CommonModule, ErrorBoundaryComponent],
})
```

#### 2. 使用 @defer 包裹组件

**修改前**:
```html
<app-text-view class="flex-1 min-h-0 overflow-hidden"></app-text-view>
```

**修改后**:
```html
@defer (on immediate) {
  <app-text-view class="flex-1 min-h-0 overflow-hidden"></app-text-view>
} @placeholder {
  <div class="flex-1 flex items-center justify-center text-stone-400">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
  </div>
}
```

对 `FlowViewComponent` 做同样的处理。

## 优势

1. **解决元数据错误**: 组件在真正需要时才加载，避免元数据解析问题
2. **减少首屏加载**: 组件代码被拆分为独立的 chunk，按需加载
3. **更好的用户体验**: 显示加载状态，用户知道内容正在加载
4. **符合架构原则**: 遵循项目的"移动端 GoJS 懒加载"策略

## 构建结果

修复后，项目成功构建，`project-shell-component` 被正确打包为懒加载 chunk：

```
chunk-73Z36ITW.js | project-shell-component | 21.24 kB | 5.46 kB
```

## 相关文档

- Angular @defer 文档: https://angular.dev/guide/defer
- 项目架构指南: `/workspaces/dde/.github/copilot-instructions.md`
- AGENTS.md: 移动端 GoJS 优化策略

## 测试状态

✅ 所有单元测试通过 (327 passed | 8 skipped)
✅ 构建成功，无编译错误
✅ 组件正确地被拆分为懒加载 chunk

## 注意事项

- `ViewChild('flowView')` 会在 `@defer` 块加载完成后自动绑定
- 在组件加载前访问 `flowView` 会返回 `undefined`，需要进行空值检查
- `@defer (on immediate)` 表示立即开始加载，但不会阻塞初始渲染
