-- 为 connections 表添加 title 列
-- 用于存储关联块的标题（外显内容）

-- 添加 title 列（如果不存在）
ALTER TABLE connections
ADD COLUMN IF NOT EXISTS title TEXT DEFAULT NULL;

-- 添加注释
COMMENT ON COLUMN connections.title IS '关联块标题，用于流程图上的外显内容（类似维基百科链接预览的标题）';
