import { Routes } from '@angular/router';
import { requireAuthGuard, projectExistsGuard } from './services/guards';

/**
 * 应用路由配置
 * 支持项目深度链接和视图状态保持
 * 
 * 路由结构：
 * - /projects - 项目列表（AppComponent）
 * - /projects/:projectId - 项目视图外壳（ProjectShellComponent）
 * - /projects/:projectId/text - 文本视图模式
 * - /projects/:projectId/flow - 流程图模式
 * - /projects/:projectId/task/:taskId - 定位到特定任务
 * 
 * 路由守卫：
 * - requireAuthGuard: 强制登录验证（数据归属权保障）
 * - projectExistsGuard: 项目存在性检查
 * 
 * 认证策略说明：
 * 采用「强制登录」模式，所有数据操作都需要明确的 user_id：
 * 1. 简化 Supabase RLS 策略 - 所有操作都有明确的数据归属
 * 2. 避免「幽灵数据」问题 - 无需处理匿名数据到正式账户的迁移
 * 3. 保障数据安全 - 防止未授权访问和垃圾数据注入
 */
export const routes: Routes = [
  // 默认重定向到项目列表
  { path: '', redirectTo: '/projects', pathMatch: 'full' },
  
  // 项目列表/主视图 - AppComponent 作为布局容器
  { 
    path: 'projects', 
    canActivate: [requireAuthGuard],
    children: [
      // 项目列表首页（无选中项目）
      { 
        path: '', 
        pathMatch: 'full',
        loadComponent: () => import('./components/project-shell.component').then(m => m.ProjectShellComponent)
      },
      // 特定项目视图 - ProjectShellComponent 管理 text/flow 视图切换
      { 
        path: ':projectId', 
        canActivate: [projectExistsGuard],
        loadComponent: () => import('./components/project-shell.component').then(m => m.ProjectShellComponent),
        children: [
          // 默认重定向到 text 视图
          { path: '', redirectTo: 'text', pathMatch: 'full' },
          // 文本视图模式
          { path: 'text', component: undefined },
          // 流程图模式
          { path: 'flow', component: undefined },
          // 定位到特定任务（深度链接）
          { path: 'task/:taskId', component: undefined }
        ]
      }
    ]
  },
  
  // 密码重置回调页面 - 使用专门的组件处理 token
  // 注意：此路由故意不添加 authGuard，因为：
  // 1. 用户是通过邮箱链接跳转到此页面的，此时尚未登录
  // 2. Supabase 的密码重置 token 会通过 URL fragment 传递
  // 3. 该页面不涉及敏感数据，只用于设置新密码
  { 
    path: 'reset-password', 
    loadComponent: () => import('./components/reset-password.component').then(m => m.ResetPasswordComponent)
  },
  
  // 致命错误页面
  { 
    path: 'error', 
    loadComponent: () => import('./components/error-page.component').then(m => m.ErrorPageComponent)
  },
  
  // 404 页面
  { 
    path: 'not-found', 
    loadComponent: () => import('./components/not-found.component').then(m => m.NotFoundComponent)
  },
  
  // 兜底路由 - 重定向到 404
  { path: '**', redirectTo: '/not-found' }
];
