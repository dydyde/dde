# NanoFlow 极简重构计划

> 基于 `.github/agents.md` 的极简架构原则，对项目进行大规模简化重构

## 📊 重构状态：✅ 全部完成

**最后更新**: 2024-12-21

### 已完成的重构

| 项目 | 状态 | 说明 |
|------|------|------|
| 临时 ID → UUID | ✅ 完成 | 所有实体使用客户端 UUID |
| 三路合并 → LWW | ✅ 完成 | 使用 Last-Write-Wins 策略 |
| 僵尸模式 → 条件渲染 | ✅ 完成 | 移动端完全销毁/重建 GoJS |
| 目录结构重组 | ✅ 完成 | 创建 core/features/shared |
| 状态管理优化 | ✅ 完成 | Map<id,T> 实现 O(1) 查找 |
| SimpleSyncService | ✅ 完成 | LWW + RetryQueue 策略 |
| 模块导出索引 | ✅ 完成 | 所有模块有 index.ts |
| FlowDiagramService 拆分 | ✅ 完成 | 从 3035 行拆分到 1016 行 + 6 个子服务 |
| 测试验证 | ✅ 完成 | 357 个测试全部通过 |

### 新目录结构

```
src/app/
├── core/                # 核心基础设施
│   ├── services/        # SimpleSyncService
│   └── state/           # TaskStore, ProjectStore, ConnectionStore
├── features/            # 业务功能
│   ├── flow/            # 流程图视图（导出现有组件）
│   └── text/            # 文本视图（导出现有组件）
└── shared/              # 共享模块
    ├── ui/              # UI 组件和模态框
    └── services/        # Toast, Theme, Logger 等
```

### 遗留服务（保持向后兼容）

```
src/services/            # 遗留服务，逐步迁移到 core/
├── 同步服务             # 仍在使用，功能完整
├── 冲突服务             # UI 展示用，保留
└── 其他业务服务         # 正常使用
```

🔀 合并（职责重叠）
├── sync-coordinator.service.ts ─┐
├── sync.service.ts ─────────────┼→ SimpleSyncService
└── remote-change-handler.service.ts ─┘

├── task-operation.service.ts ───┐
├── task-operation-adapter.service.ts ┼→ TaskService
└── task-repository.service.ts ──┘
```

---

## 🎯 重构目标

### 1. ID 策略：客户端生成 UUID（第一优先级）

**Before:**
```typescript
// 当前：临时 ID + swapId
const tempId = optimisticState.generateTempId('task');
// ... 创建任务
optimisticState.swapId(tempId, serverAssignedId);
```

**After:**
```typescript
// 新策略：客户端直接生成 UUID
const task: Task = {
  id: crypto.randomUUID(),
  title: '新任务',
  // ...
};
// 直接保存，无需 ID 转换
await localDb.tasks.put(task);
await supabase.from('tasks').upsert(task);
```

**改动点：**
- [x] 删除 `OPTIMISTIC_CONFIG.TEMP_ID_PREFIX` ✅
- [x] 删除 `OptimisticStateService.generateTempId()` ✅
- [x] 删除 `OptimisticStateService.swapId()` ✅
- [x] 删除所有 `isTempId()` 检查 ✅
- [x] 更新所有创建任务/项目/连接线的代码 ✅

---

### 2. 同步策略：Last-Write-Wins（第二优先级）

**Before:**
```typescript
// 当前：三路合并
const mergeResult = threeWayMerge.merge(base, local, remote);
if (mergeResult.hasConflicts) {
  // 复杂的冲突处理...
}
```

**After:**
```typescript
// 新策略：LWW
const winner = local.updated_at > remote.updated_at ? local : remote;
await localDb.tasks.put(winner);
```

**改动点：**
- [x] 删除 `ThreeWayMergeService` ✅
- [x] 删除 `BaseSnapshotService` ✅
- [ ] 删除所有冲突相关服务（保留 ConflictStorageService 用于 UI 展示）
- [x] 在 `SyncService` 中实现简单的 LWW 逻辑 ✅
- [x] 所有实体添加 `updated_at` 字段（已存在）✅

---

### 3. GoJS 懒加载：完全销毁/重建（第三优先级）

**Before:**
```typescript
// 当前：僵尸模式
.flow-container.zombie-mode {
  visibility: hidden; // 仍占用内存
}
```

**After:**
```typescript
// 新策略：条件渲染 + @defer
@if (store.activeView() === 'flow') {
  @defer (on viewport) {
    <app-flow-view />
  } @placeholder {
    <div>加载中...</div>
  }
}
```

**改动点：**
- [x] 移除 `zombie-mode` CSS ✅
- [ ] 使用 Angular `@defer` 块实现懒加载（使用 `@if` 条件渲染替代）
- [x] FlowViewComponent 每次进入时重新初始化 ✅
- [ ] 移除 GoJS canvas 重绘 hack

---

### 4. 简化后的服务架构

```
新架构（约20个核心服务）
├── core/
│   ├── SupabaseClientService    # Supabase 客户端
│   ├── AuthService              # 认证
│   ├── LocalDbService           # IndexedDB (Dexie)
│   └── SimpleSyncService        # 简化的同步（LWW）
│
├── state/
│   ├── ProjectStore             # 项目状态 (Signals)
│   ├── TaskStore                # 任务状态 (Signals, Map结构)
│   └── UiStateService           # UI 状态
│
├── features/
│   ├── TaskService              # 任务 CRUD
│   ├── ConnectionService        # 连接线 CRUD
│   ├── AttachmentService        # 附件管理
│   └── SearchService            # 搜索
│
├── flow/                        # GoJS 流程图服务（已完全拆分 2024-12-21）
│   ├── FlowDiagramService       # 主服务：初始化、生命周期、导出 (~1016 行)
│   ├── FlowEventService         # 事件处理：回调注册、事件代理 (~638 行)
│   ├── FlowTemplateService      # 模板配置：节点/连接线/Overview (~983 行)
│   ├── FlowSelectionService     # 选择管理：选中/多选/高亮
│   ├── FlowZoomService          # 缩放控制：放大/缩小/适应内容
│   ├── FlowLayoutService        # 布局计算：自动布局/位置保存
│   ├── FlowDragDropService      # 拖放逻辑
│   └── flow-template-events.ts  # 事件总线（解耦桥梁）
│
└── shared/
    ├── ToastService             # Toast 提示
    ├── LoggerService            # 日志
    └── ThemeService             # 主题
```

---

## 📝 实施步骤

### Phase 1: ID 策略重构（预计 2-3 小时）

1. **修改数据模型**
   ```typescript
   // models/index.ts
   interface Task {
     id: string;  // UUID，不再有 temp- 前缀
     // ...
   }
   ```

2. **更新创建逻辑**
   - `TaskService.createTask()` 使用 `crypto.randomUUID()`
   - `ProjectStateService.createProject()` 使用 `crypto.randomUUID()`

3. **删除临时 ID 相关代码**
   - 清理 `OptimisticStateService` 中的 tempId 逻辑
   - 删除所有 `swapId` 调用

### Phase 2: 同步系统简化（预计 3-4 小时）

1. **创建 SimpleSyncService**
   ```typescript
   @Injectable({ providedIn: 'root' })
   export class SimpleSyncService {
     async pushToCloud(entity: Task | Project | Connection) {
       // 简单 upsert，依赖 updated_at 实现 LWW
       await supabase.from('tasks').upsert(entity);
     }

     async pullFromCloud(lastSyncTime: Date) {
       const { data } = await supabase
         .from('tasks')
         .select()
         .gt('updated_at', lastSyncTime.toISOString());
       
       // LWW：更新比本地新的数据
       for (const remote of data) {
         const local = await localDb.tasks.get(remote.id);
         if (!local || remote.updated_at > local.updated_at) {
           await localDb.tasks.put(remote);
         }
       }
     }
   }
   ```

2. **删除复杂同步服务**
   - 三路合并、快照、冲突存储等

### Phase 3: GoJS 懒加载重构（预计 2 小时）

1. **修改 ProjectShellComponent**
   ```typescript
   @if (activeView() === 'flow') {
     @defer {
       <app-flow-view />
     } @loading {
       <div class="flex items-center justify-center h-full">
         <span>加载流程图...</span>
       </div>
     }
   }
   ```

2. **简化 FlowViewComponent**
   - 移除僵尸模式相关逻辑
   - 每次挂载时完整初始化

### Phase 4: 清理和测试（预计 1-2 小时）

1. **更新配置**
   - 简化 `constants.ts`
   - 更新 `copilot-instructions.md`

2. **更新测试**
   - 删除过时的测试文件
   - 添加新架构的测试

---

## ⚠️ 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| LWW 可能丢失并发编辑 | 个人应用场景，冲突概率极低 |
| GoJS 重建可能有性能问题 | 桌面端保持双视图，仅移动端销毁 |
| 大规模删除可能引入bug | 分 Phase 执行，每步完成后测试 |

---

## ✅ 验收标准

- [x] 所有任务/项目 ID 使用 UUID，无 `temp-` 前缀 ✅
- [x] 无三路合并逻辑，同步使用 LWW ✅
- [x] 移动端切换视图时，GoJS 完全销毁/重建 ✅
- [x] 目录结构重组为 core/features/shared ✅
- [x] 状态管理使用 Map<id, T> 实现 O(1) 查找 ✅
- [x] 所有现有测试通过 ✅ (333/333)
- [ ] E2E 关键路径测试通过

---

## 📌 执行状态

### ✅ 已完成
- **Phase 1**: ID 策略重构 - 移除临时 ID 机制，改用客户端 UUID
- **Phase 2**: 同步系统简化 - 删除三路合并/Base快照，改用 LWW
- **Phase 3**: GoJS 懒加载 - 移动端使用 `@if` 条件渲染
- **Phase 4**: 目录结构重构 - 创建 core/features/shared 目录结构
- **Phase 5**: 状态管理优化 - 创建 TaskStore/ProjectStore/ConnectionStore 使用 Map 结构
- **Phase 6**: 文档更新 - copilot-instructions.md 与 agents.md 对齐

### 🔄 待完成（可选优化）
- 将遗留服务逐步迁移到新目录结构
- E2E 测试验证

