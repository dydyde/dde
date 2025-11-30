import { Routes } from '@angular/router';
import { authGuard, projectExistsGuard } from './services/guards';

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
 * - authGuard: 认证检查（支持离线模式）
 * - projectExistsGuard: 项目存在性检查
 */
export const routes: Routes = [
  // 默认重定向到项目列表
  { path: '', redirectTo: '/projects', pathMatch: 'full' },
  
  // 项目列表/主视图 - AppComponent 作为布局容器
  { 
    path: 'projects', 
    canActivate: [authGuard],
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
        children: [
          // 默认重定向到 text 视图
          { path: '', redirectTo: 'text', pathMatch: 'full' },
          // 文本视图模式
          { 
            path: 'text', 
            loadComponent: () => import('./components/project-shell.component').then(m => m.ProjectShellComponent)
          },
          // 流程图模式
          { 
            path: 'flow', 
            loadComponent: () => import('./components/project-shell.component').then(m => m.ProjectShellComponent)
          },
          // 定位到特定任务（深度链接）
          { 
            path: 'task/:taskId', 
            loadComponent: () => import('./components/project-shell.component').then(m => m.ProjectShellComponent)
          }
        ]
      }
    ]
  },
  
  // 密码重置回调页面 - 使用专门的组件处理 token
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
