/**
 * Core Module - 核心基础设施
 * 
 * 包含应用核心基础设施服务：
 * - SupabaseClientService: Supabase 客户端
 * - AuthService: 认证服务
 * - LocalDbService: IndexedDB 本地存储
 * - SimpleSyncService: 简化的同步服务 (LWW)
 * 
 * @see .github/agents.md 极简架构原则
 */

// 核心服务
export { SupabaseClientService } from '../../services/supabase-client.service';
export { AuthService } from '../../services/auth.service';
export { LoggerService } from '../../services/logger.service';

// 存储适配器
export { 
  StorageAdapter, 
  StorageState,
  LocalStorageAdapter,
  IndexedDBAdapter,
  StorageAdapterService,
  STORAGE_ADAPTER
} from '../../services/storage-adapter.service';

// 简化同步服务
export { SimpleSyncService } from './services/simple-sync.service';

// 状态管理
export { TaskStore, ProjectStore, ConnectionStore, StorePersistenceService } from './state';
