-- NanoFlow 附件存储配置
-- 
-- 此脚本在 Supabase SQL 编辑器中运行，配置 Storage 桶及其权限策略
-- 
-- 注意：Supabase Storage 桶需要先通过 Dashboard 或 API 创建
-- 以下是存储策略配置

-- ============================================
-- 1. 创建存储桶（需要在 Dashboard 中执行或使用 API）
-- ============================================
-- 
-- 在 Supabase Dashboard > Storage > New bucket 创建：
-- - Name: attachments
-- - Public: false (私有桶，通过签名 URL 访问)
-- - File size limit: 10MB (10485760 bytes)
-- - Allowed MIME types: image/*, application/pdf, text/*, application/msword, 
--   application/vnd.openxmlformats-officedocument.wordprocessingml.document

-- ============================================
-- 2. Storage 策略 (RLS)
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "Users can upload own attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can view own attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own attachments" ON storage.objects;
DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;

-- 用户可以上传自己的附件
-- 路径格式: {bucket_id}/{user_id}/{project_id}/{task_id}/{filename}
CREATE POLICY "Users can upload own attachments"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- 用户可以查看自己的附件
CREATE POLICY "Users can view own attachments"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- 用户可以删除自己的附件
CREATE POLICY "Users can delete own attachments"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'attachments'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- 项目成员可以查看附件（支持协作场景）
CREATE POLICY "Project members can view attachments"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'attachments'
  AND EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.user_id = auth.uid()
    AND pm.project_id::text = (storage.foldername(name))[2]
  )
);

-- ============================================
-- 3. 验证策略
-- ============================================

-- 查看存储桶
-- SELECT * FROM storage.buckets;

-- 查看策略
-- SELECT * FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage';

-- ============================================
-- 完成！
-- ============================================
-- 配置完成后，用户可以：
-- 1. 上传附件到自己项目的任务中
-- 2. 查看和下载自己的附件
-- 3. 删除自己的附件
-- 4. 项目成员可以查看共享项目中的附件
