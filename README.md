# NanoFlow Project Tracker

一个高效的项目追踪应用，具有双视图（文本/流程图）、Markdown 支持、离线优先、云端同步。

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Angular | 19.x | 前端框架（Signals + 独立组件） |
| Supabase | ^2.84.0 | BaaS（认证 + 数据库 + 存储） |
| GoJS | ^3.1.1 | 流程图渲染 |
| Sentry | ^10.32.1 | 错误监控 |
| Vitest / Playwright | - | 单元测试 / E2E 测试 |

## 本地运行

**前置条件:** Node.js 18+

1. 安装依赖:
   ```bash
   npm install
   ```

2. 配置环境变量 (可选):
   
   创建 `.env.local` 文件并添加以下内容（如不配置将以离线模式运行）:
   ```
   # Supabase 配置（云端同步功能）
   NG_APP_SUPABASE_URL=your_supabase_url
   NG_APP_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

3. 运行应用:
   ```bash
   npm start
   ```

## 开发命令

```bash
npm start              # 开发服务器
npm run test           # Vitest watch 模式
npm run test:run       # 单次运行测试
npm run test:e2e       # Playwright E2E
npm run lint:fix       # ESLint 自动修复
npm run build          # 生产构建
```

## 功能特性

- 📝 **双视图模式**: 文本视图与流程图视图无缝切换
- 🔄 **云端同步**: 通过 Supabase 实现多设备数据同步（LWW 冲突解决）
- 📱 **离线优先**: 本地 IndexedDB 存储，断网可用，联网自动同步
- 🎨 **主题系统**: 5 种精心设计的主题风格
- 📦 **PWA 支持**: 可安装，响应式设计
- 📝 **Markdown 支持**: 任务内容支持 Markdown 格式渲染
- 🔒 **附件支持**: 支持文件附件上传与管理

---

## 数据保护

### 数据存储位置

NanoFlow 采用**多层数据保护架构**，确保用户数据安全：

| 层级 | 存储位置 | 说明 |
|------|----------|------|
| **A 层 - 本地缓存** | 浏览器 IndexedDB | 离线可用，实时响应，浏览器数据隔离 |
| **B 层 - 本地备份** | 下载 JSON 文件 | 手动导出，可在任何地方恢复 |
| **C 层 - 坚果云/同步盘** | 本地目录 → 云同步 | 自动定时备份，配合坚果云/Dropbox/OneDrive 同步 |
| **D 层 - 回收站** | 软删除 + 30 天保留 | 误删可恢复，到期自动清理 |
| **E 层 - 云端同步** | Supabase PostgreSQL | 服务器级备份，多设备同步 |

### 数据备份方法

#### 1. 手动导出（推荐定期操作）

在**设置 → 数据管理 → 导出数据**中，将所有项目导出为 JSON 文件。

- 导出文件包含：项目信息、所有任务、连接关系、附件元数据
- 建议：每周手动导出一次，保存到云盘或移动硬盘

#### 2. 本地自动备份（桌面 Chrome 推荐）

在**设置 → 本地自动备份**中配置：

1. 点击"选择备份目录"，选择坚果云/Dropbox/OneDrive 的同步文件夹
2. 开启"自动定时备份"（默认每 30 分钟）
3. 备份文件会自动同步到云端，形成版本历史

**注意：**
- 仅支持桌面 Chrome 浏览器（使用 File System Access API）
- 浏览器重启后需重新授权目录访问
- 备份保留最近 30 个版本，旧文件自动清理

#### 3. 云端同步

登录 Supabase 账号后，数据自动同步到云端：

- 实时增量同步（防抖 3 秒）
- LWW（最后写入优先）冲突解决
- 服务器端数据库级备份

### 数据恢复方法

| 场景 | 恢复方法 |
|------|----------|
| **误删任务** | 设置 → 系统仪表盘 → 回收站，选择恢复 |
| **浏览器数据丢失** | 设置 → 数据管理 → 导入数据，选择之前导出的 JSON |
| **本地备份恢复** | 打开坚果云同步目录，选择任意 `nanoflow-backup-*.json` 导入 |
| **多设备同步** | 登录同一账号，数据自动同步 |
| **回滚到历史版本** | 使用坚果云/Dropbox 的版本历史功能 |

---

### 手机端与电脑端备份关系

NanoFlow 支持手机和电脑双平台使用，但由于浏览器 API 限制，备份能力有所不同：

| 功能 | 📱 手机端 (Android Chrome) | 💻 电脑端 (Chrome) |
|------|---------------------------|-------------------|
| **本地缓存 (A层)** | ✅ IndexedDB 自动存储 | ✅ IndexedDB 自动存储 |
| **手动导出 (B层)** | ✅ 设置 → 导出数据 → 下载 JSON | ✅ 设置 → 导出数据 → 下载 JSON |
| **自动备份 (C层)** | ❌ 不支持（无 File System Access API） | ✅ 设置 → 本地自动备份 |
| **回收站 (D层)** | ✅ 30 天软删除保护 | ✅ 30 天软删除保护 |
| **云端同步 (E层)** | ✅ 登录后自动同步 | ✅ 登录后自动同步 |

#### 数据流向说明

```
┌─────────────────────────────────────────────────────────────────┐
│                        Supabase 云端 (E层)                       │
│                    PostgreSQL 数据库 + 服务器备份                 │
└─────────────────────────────────────────────────────────────────┘
                    ↑ 实时同步 ↓              ↑ 实时同步 ↓
┌───────────────────────────┐     ┌───────────────────────────────┐
│      📱 手机端 (Android)  │     │       💻 电脑端 (Chrome)      │
├───────────────────────────┤     ├───────────────────────────────┤
│  IndexedDB (A层)          │     │  IndexedDB (A层)              |
│    ↓ 手动导出              │     │    ↓ 手动导出  ↓ 自动备份      │
│  下载 JSON (B层)           │     │  下载 JSON    本地目录 (C层)   │
│    ↓ 保存到                │     │    ↓ 保存到     ↓ 自动同步     │
│  手机存储/云盘 App         │     │  任意位置     坚果云/Dropbox    │
└───────────────────────────┘     └───────────────────────────────┘
```

#### 手机端备份策略

由于手机浏览器不支持 File System Access API，无法实现自动备份到本地目录。建议：

1. **优先使用云端同步**：登录账号后，数据自动同步到服务器，这是手机端最可靠的备份方式
2. **定期手动导出**：每周在手机上执行一次「设置 → 导出数据」
3. **导出文件保存**：
   - 保存到手机本地存储（下载目录）
   - 通过分享功能发送到坚果云 App / 微信文件传输助手 / 邮箱
   - 直接上传到任意云盘 App

#### 电脑端备份策略

电脑端拥有完整的备份能力：

1. **自动备份到坚果云**：设置好本地备份目录后，每 30 分钟自动保存，坚果云客户端自动同步到云端
2. **版本历史**：坚果云/Dropbox 会保留文件历史版本，可回滚到任意时间点
3. **手动导出**：重大变更前手动导出一份，保存到不同位置

---

### 数据恢复操作指南

根据你的设备和数据丢失场景，选择合适的恢复方式：

#### 场景 1：手机数据丢失，需要恢复

| 恢复源 | 操作步骤 |
|--------|----------|
| **从云端恢复**（推荐） | 1. 打开 NanoFlow<br>2. 登录同一账号<br>3. 数据自动同步恢复 |
| **从手机导出文件恢复** | 1. 找到之前下载的 `nanoflow-export-*.json`<br>2. 打开 NanoFlow → 设置 → 导入数据<br>3. 选择该文件导入 |
| **从电脑备份恢复** | 1. 电脑坚果云目录找到 `nanoflow-backup-*.json`<br>2. 通过微信/邮件发送到手机<br>3. 手机打开 NanoFlow → 设置 → 导入数据 |

#### 场景 2：电脑数据丢失，需要恢复

| 恢复源 | 操作步骤 |
|--------|----------|
| **从云端恢复**（推荐） | 1. 打开 NanoFlow<br>2. 登录同一账号<br>3. 数据自动同步恢复 |
| **从坚果云备份恢复** | 1. 打开坚果云同步目录（如 `~/Nutstore/NanoFlow`）<br>2. 找到 `nanoflow-backup-*.json`（按日期选择）<br>3. 打开 NanoFlow → 设置 → 导入数据<br>4. 选择该文件导入 |
| **从手动导出恢复** | 1. 找到之前下载的 `nanoflow-export-*.json`<br>2. 打开 NanoFlow → 设置 → 导入数据<br>3. 选择该文件导入 |
| **从坚果云历史版本恢复** | 1. 右键点击备份文件 → 查看历史版本<br>2. 选择需要的版本下载<br>3. 导入该版本文件 |

#### 场景 3：误删除任务，需要恢复

| 操作步骤 |
|----------|
| 1. 打开 NanoFlow → 设置 → 系统仪表盘 |
| 2. 进入回收站 |
| 3. 找到误删的任务，点击恢复 |
| ⚠️ 注意：回收站仅保留 30 天，过期自动清理 |

#### 场景 4：需要回滚到历史版本

| 恢复源 | 操作步骤 |
|--------|----------|
| **坚果云版本历史** | 1. 打开坚果云同步目录<br>2. 右键 `nanoflow-backup-*.json` → 历史版本<br>3. 下载指定日期的版本<br>4. 导入该版本 |
| **多个备份文件** | 1. 备份文件名包含时间戳（如 `nanoflow-backup-2026-01-02_14-30-00.json`）<br>2. 选择需要的时间点文件导入 |

---

### 备份文件说明

| 文件类型 | 文件名格式 | 来源 | 内容 |
|----------|------------|------|------|
| **手动导出** | `nanoflow-export-2026-01-02.json` | 设置 → 导出数据 | 所有项目完整数据 |
| **自动备份** | `nanoflow-backup-2026-01-02_14-30-00.json` | 电脑端本地自动备份 | 所有项目完整数据 |

两种文件格式完全兼容，都可以通过「设置 → 导入数据」恢复。

### 数据保护建议

1. **启用云端同步**：登录 Supabase 账号，实现多设备同步和服务器备份
2. **配置本地自动备份**：选择坚果云同步目录，开启定时备份
3. **定期手动导出**：每周导出一次，保存到不同的存储介质
4. **保留多个版本**：不要覆盖旧备份，利用云盘版本历史

## 核心架构

```
src/
├── app/
│   ├── core/           # 核心单例（状态、同步）
│   ├── features/       # 业务模块（flow、text）
│   └── shared/         # 共享组件与模态框
├── services/           # 主服务层（50+ 服务）
├── config/             # 配置常量
├── models/             # 数据模型
└── utils/              # 工具函数
```

---

## Supabase 部署配置

> 💡 **给新手的说明**：Supabase 是一个云端数据库服务。如果你不需要云端同步功能，可以跳过此部分，应用会以离线模式运行。

### 第一步：创建 Supabase 账号和项目

1. 打开 [supabase.com](https://supabase.com)，用 GitHub 或邮箱注册
2. 点击「New Project」创建新项目
3. 输入项目名称（如 `nanoflow`），选择一个靠近你的服务器区域
4. 设置一个数据库密码（记住它，但本应用用不到）
5. 等待几分钟，项目创建完成

### 第二步：创建附件存储桶

1. 在 Supabase 控制台左侧，点击「Storage」
2. 点击「New bucket」
3. 名称输入 `attachments`
4. 取消勾选「Public bucket」（保持私有）
5. 点击「Create bucket」

### 第三步：执行数据库初始化脚本

1. 在左侧菜单点击「SQL Editor」
2. 打开本项目的 `scripts/init-supabase.sql` 文件，全选复制内容
3. 粘贴到 SQL 编辑器中
4. 点击右下角的「Run」按钮
5. 等待执行完成，看到绿色提示「Success」即可

> 这个脚本会自动创建所有需要的表、函数、安全策略等，你不需要理解里面的内容。

### 第四步：获取连接信息

1. 在左侧点击「Project Settings」（齿轮图标）
2. 点击「API」
3. 复制以下两个值：
   - **Project URL**（类似 `https://xxx.supabase.co`）
   - **anon public key**（一长串字符）

### 第五步：配置应用环境变量

在项目根目录创建 `.env.local` 文件，填入：

```
NG_APP_SUPABASE_URL=上面复制的 Project URL
NG_APP_SUPABASE_ANON_KEY=上面复制的 anon public key
```

> ⚠️ **安全提示**：不要使用 `service_role` 密钥，那是管理员密钥，泄露会很危险。

### 第六步：（可选）启用定时清理

如果你想让系统自动清理 30 天前删除的任务：

1. 在控制台左侧点击「Database」→「Extensions」
2. 搜索 `pg_cron`，点击启用
3. 回到「SQL Editor」，执行以下命令：

```sql
SELECT cron.schedule('cleanup-deleted-tasks', '0 3 * * *', $$SELECT cleanup_old_deleted_tasks()$$);
SELECT cron.schedule('cleanup-deleted-connections', '0 3 * * *', $$SELECT cleanup_old_deleted_connections()$$);
SELECT cron.schedule('cleanup-old-logs', '0 4 * * 0', $$SELECT cleanup_old_logs()$$);
SELECT cron.schedule('cleanup-expired-scan-records', '0 5 * * 0', $$SELECT cleanup_expired_scan_records()$$);
```

### 配置完成！

重新启动应用 (`npm start`)，现在你可以：
- 注册/登录账号
- 数据自动同步到云端
- 多设备之间数据保持一致

---

### 附录：数据库对象速查

<details>
<summary>点击展开详细说明（给开发者）</summary>

**核心表（5 个）**
- `projects` - 项目
- `project_members` - 项目成员（协作预留）
- `tasks` - 任务
- `connections` - 任务连接
- `user_preferences` - 用户偏好

**辅助表（8 个）**
- `task_tombstones` / `connection_tombstones` - 永久删除记录
- `cleanup_logs` - 清理日志
- `circuit_breaker_logs` - 安全删除审计
- `app_config` - 应用配置
- `purge_rate_limits` - 速率限制
- `attachment_scans` / `quarantined_files` - 病毒扫描相关

**视图（2 个）**
- `active_tasks` - 过滤已删除任务
- `active_connections` - 过滤已删除连接

**常用 RPC 函数**
- `get_dashboard_stats()` - 获取仪表盘统计
- `batch_upsert_tasks(tasks, project_id)` - 批量更新任务
- `purge_tasks_v3(project_id, task_ids)` - 永久删除任务
- `safe_delete_tasks(task_ids, project_id)` - 安全软删除

完整函数和触发器清单请参考 `scripts/README.md`。

</details>

---

## 关键配置

| 配置 | 值 | 说明 |
|------|-----|------|
| `SYNC_CONFIG.DEBOUNCE_DELAY` | 3000ms | 同步防抖 |
| `REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT` | 4 | 最大并发请求 |
| `TIMEOUT_CONFIG.STANDARD` | 10000ms | API 超时 |
| `AUTH_CONFIG.LOCAL_MODE_USER_ID` | 'local-user' | 离线模式 |

## License

MIT
