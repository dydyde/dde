# 小地图拖拽卡顿修复进度

> **创建日期**: 2024-12-25
> **问题描述**: 将小地图中的视口窗拖拽到最下面时，整个小地图会突然卡死

## 问题诊断

### 复现场景
1. 将小地图中的视口窗拖拽到小地图的最下面
2. 整个小地图突然卡死
3. 视口窗依然可以移动，但流程图不同步
4. 视口窗向边缘拖拽时会被"墙"卡住

### 根因分析

| 问题 | 严重程度 | 原因 |
|------|----------|------|
| **拖拽时的事件风暴** | ⭐⭐⭐⭐⭐ | `ViewportBoundsChanged` 触发频率过高，每次都执行复杂计算 |
| **超时保护不足** | ⭐⭐⭐⭐ | 500ms 超时后 `isOverviewInteracting` 被重置，导致卡顿 |
| **硬墙 clamp** | ⭐⭐⭐⭐ | `limitDisplayBounds` 中的 clamp 导致世界坐标饱和 |
| **scroll 上限** | ⭐⭐⭐ | `scrollMargin: 5000` 限制了无限画布能力 |

### 核心数学问题

当你把 indicator 拖到边缘：
```
indicator 位置 → 用当前 scale 换算 worldCenter
    ↓
worldCenter 变远 → viewportBounds 扩大 union → extendedBounds 变大
    ↓
extendedBounds 变大 → scaleRatio 变小
    ↓
scaleRatio 变小 → 同样的 worldCenter 映射回小地图位置会"被压回去"
    ↓
如果有 clamp，就会出现"撞墙/卡死"
```

---

## 修复计划

### 阶段 1: 核心修复

| 任务 | 状态 | 文件 |
|------|------|------|
| 1. 修复交互状态超时保护 | ✅ 已完成 | `flow-diagram.service.ts` |
| 2. 消除硬墙 clamp | ✅ 已完成 | `flow-diagram.service.ts` |
| 3. 分离逻辑/显示位置 | ✅ 已完成 | `flow-diagram.service.ts` |
| 4. 动态 maxOverflow | ✅ 已完成 | `flow-diagram.service.ts` |
| 5. 优化事件节流 | ✅ 已完成 | `flow-diagram.service.ts` |

### 阶段 2: Further Considerations

| 任务 | 状态 | 文件 |
|------|------|------|
| 6. 开启 InfiniteScroll | ✅ 已完成 | `flow-diagram.service.ts` |
| 7. 简化 Overview 模板 | ✅ 已完成 | `flow-template.service.ts` |
| 8. 添加性能监控 | ✅ 已完成 | `flow-diagram.service.ts` |

---

## 修改日志

### 2024-12-25

#### ✅ 任务 1: 修复交互状态超时保护

**问题**: 500ms 超时后 `isOverviewInteracting` 被自动重置，导致后续拖拽事件触发大量 `ViewportBoundsChanged` 处理

**解决方案**: 
- 使用 `setPointerCapture()` 确保拖拽出界后仍能收到事件
- 移除 500ms 超时自动重置逻辑
- 使用 `lostpointercapture` 替代 `pointerleave` 检测拖拽结束

**修改文件**: `src/services/flow-diagram.service.ts` (attachOverviewPointerListeners 方法)

```typescript
// 存储当前捕获的 pointerId，用于 releasePointerCapture
let capturedPointerId: number | null = null;

const onPointerDown = (ev: PointerEvent) => {
  this.isOverviewInteracting = true;
  
  // 使用 PointerCapture 确保拖拽出界后仍能收到事件
  try {
    container.setPointerCapture(ev.pointerId);
    capturedPointerId = ev.pointerId;
  } catch (e) {
    // 某些触摸设备可能不支持
  }
};
```

---

#### ✅ 任务 2-4: 消除硬墙 clamp + 分离逻辑/显示位置 + 动态 maxOverflow

**问题**: `limitDisplayBounds()` 中的 `clampedViewport` 计算和 `maxOverflow = 1200` 硬编码导致：
- 视口位置被限制在 `limited` 边界内
- 无法实现无限画布效果
- 拖拽到边缘时被 clamp 拉回

**解决方案**: 重写为 `calculateExtendedBounds()` 函数

**修改文件**: `src/services/flow-diagram.service.ts`

```typescript
/**
 * 动态扩展边界 - 无限画布核心
 */
const calculateExtendedBounds = (baseBounds: go.Rect, viewportBounds: go.Rect): go.Rect => {
  // 动态 maxOverflow：不再硬编码 1200，允许无限扩展
  const overflowLeft = Math.max(0, baseBounds.x - viewportBounds.x);
  const overflowRight = Math.max(0, viewportBounds.right - baseBounds.right);
  const overflowTop = Math.max(0, baseBounds.y - viewportBounds.y);
  const overflowBottom = Math.max(0, viewportBounds.bottom - baseBounds.bottom);

  // 不再限制 overflow，允许无限扩展
  const extended = new go.Rect(
    baseBounds.x - overflowLeft,
    baseBounds.y - overflowTop,
    baseBounds.width + overflowLeft + overflowRight,
    baseBounds.height + overflowTop + overflowBottom
  );

  // 关键：不再 clamp viewportBounds，直接合并
  return extended.unionRect(viewportBounds);
};
```

---

#### ✅ 任务 5: 优化事件节流

**问题**: 交互期间仍在处理 `ViewportBoundsChanged` 事件

**解决方案**: 当 `isOverviewInteracting === true` 时完全跳过 viewport 更新（已有代码，保持不变）

---

#### ✅ 任务 6: 开启 InfiniteScroll

**问题**: `scrollMargin: 5000` 限制了滚动范围

**解决方案**: 配置 `scrollMode: go.Diagram.InfiniteScroll` + `scrollMargin: Infinity`

**修改文件**: `src/services/flow-diagram.service.ts` (initialize 方法)

```typescript
this.diagram = $(go.Diagram, container, {
  // 无限画布：使用 InfiniteScroll 模式，允许视口自由移动到任何位置
  "scrollMode": go.Diagram.InfiniteScroll,
  "scrollMargin": new go.Margin(Infinity, Infinity, Infinity, Infinity),
  // ...
});
```

---

#### ✅ 任务 7: 简化 Overview 模板

**问题**: Overview 使用主图的复杂模板，渲染开销大

**解决方案**: 为 Overview 定义简化模板

**修改文件**: `src/services/flow-template.service.ts`

```typescript
// 简化的节点模板 - 只有一个矩形，无文字、无边框
overview.nodeTemplate = $(go.Node, "Auto", /*...*/);
overview.updateDelay = 100;  // 降低更新频率

// 简化的连接线模板 - 直线 + 固定颜色
overview.linkTemplate = $(go.Link, {
  routing: go.Link.Normal,
  curve: go.Link.None  // 直线，不用 Bezier
}, /*...*/);
```

---

#### ✅ 任务 8: 添加性能监控

**问题**: 缺乏 Overview 更新耗时监控

**解决方案**: 使用 Performance API + Sentry 监控掉帧情况

**修改文件**: `src/services/flow-diagram.service.ts` (runViewportUpdate 方法)

```typescript
const runViewportUpdate = (source: 'viewport' | 'document') => {
  // 性能监控：记录开始时间
  const perfStart = performance.now();
  
  // ... 执行更新逻辑 ...
  
  // finally 块中检查耗时
  const duration = performance.now() - perfStart;
  if (duration > 16) {  // 掉帧阈值
    Sentry.captureMessage('Overview Lag Detected', {
      level: 'warning',
      extra: { duration, nodeCount, source, isMobile }
    });
  }
};
```

---

## 架构决策记录

### ADR-001: 继续使用 GoJS Overview (方案 A)

**背景**: 项目中已有 `ReactiveMinimapService` 作为替代方案但尚未集成

**决策**: 继续修复 GoJS Overview

**理由**:
1. 符合"不要造轮子"的核心哲学
2. GoJS Overview 是高度优化的 Canvas 渲染器
3. 自定义实现增加维护成本和潜在 Bug
4. 两者并存增加复杂度和打包体积

### ADR-002: 使用 PointerCapture 替代超时保护

**背景**: 500ms 超时保护在快速拖拽时不可靠

**决策**: 使用 `setPointerCapture()` 确保事件可靠性

**理由**:
1. 浏览器原生 API，可靠性高
2. 拖拽出界后仍能收到事件
3. 移除超时逻辑简化代码

---

## 测试验证

### 测试场景

1. [ ] 将视口窗拖拽到小地图最下方，观察是否卡死
2. [ ] 持续向边缘拖拽，观察视口窗是否逐渐变小
3. [ ] 快速拖拽测试事件节流效果
4. [ ] 移动端测试触摸拖拽
5. [ ] 大量节点（100+）时的性能表现

### 性能指标

| 指标 | 修复前 | 修复后 | 目标 |
|------|--------|--------|------|
| Overview 更新耗时 | >100ms | - | <16ms |
| 事件触发频率 | 高频风暴 | - | RAF 节流 |
| 内存占用 | - | - | 稳定 |

---

## 参考资料

- [GoJS InfiniteScroll 文档](https://gojs.net/latest/intro/viewport.html)
- [Pointer Capture API](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture)
- [Performance API](https://developer.mozilla.org/en-US/docs/Web/API/Performance)

---

## 架构可视化

### 核心数据流

```
用户操作 → 写入 IndexedDB (立即) → 更新 UI (立即)
                ↓
        后台进程 → 写入 Supabase (防抖 3s)
                ↓
        失败 → RetryQueue (持久化) → 网络恢复 → 自动重播
```

### 小地图拖拽流程（修复后）

```
用户开始拖拽 (pointerdown)
        ↓
setPointerCapture() ← 确保出界后仍收到事件
        ↓
isOverviewInteracting = true ← 完全跳过 viewport 更新
        ↓
用户持续拖拽 (pointermove)
        ↓
GoJS 内部更新主 Diagram viewportBounds
        ↓
calculateExtendedBounds() ← 动态扩展，无硬墙
        ↓
scaleRatio 变小 → indicator 变小 ← "无限画布"效果
        ↓
用户结束拖拽 (pointerup / lostpointercapture)
        ↓
releasePointerCapture()
        ↓
强制补一次同步：overview.requestUpdate()
```

---

## 高级顾问建议实施记录

### ✅ 已实施

1. **开启 InfiniteScroll 模式** - 替代硬编码 scrollMargin
2. **简化 Overview 模板** - 去掉文字、阴影，降低 updateDelay
3. **Performance API + Sentry 监控** - 掉帧自动上报

### ⚠️ 后续注意事项

1. **GoJS 内存泄漏风险**：确保 `ngOnDestroy` 中彻底清理 `Diagram` 实例及其 Model
2. **Sentry 配额**：生产环境建议调低 `replaysSessionSampleRate`
3. **LWW 同步风险**：上传队列非空时，暂停拉取合并（防止时钟不同步导致数据覆盖）
- [Performance API](https://developer.mozilla.org/en-US/docs/Web/API/Performance)
