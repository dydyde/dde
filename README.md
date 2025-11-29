# NanoFlow Project Tracker

一个复杂的项目追踪应用，具有双视图（文本/流程图）、Markdown 支持、任务云端同步和 Gemini AI 集成。

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
   
   # Gemini API 配置（AI 功能，可选）
   GEMINI_API_KEY=your_gemini_api_key
   ```

3. 运行应用:
   ```bash
   npm start
   ```

## 功能特性

- 📝 **双视图模式**: 文本视图与流程图视图无缝切换
- 🔄 **云端同步**: 通过 Supabase 实现多设备数据同步
- 🎨 **主题系统**: 5 种精心设计的主题风格
- 📱 **响应式设计**: 完美适配桌面端和移动端
- 🤖 **AI 集成**: 集成 Gemini AI 功能（可选）
- 📦 **离线支持**: 无需后端配置也能使用基础功能
