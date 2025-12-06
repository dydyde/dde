#!/bin/bash

# 快速启动开发服务器并打开浏览器

echo "=========================================="
echo "  启动流程图调试模式"
echo "=========================================="
echo ""
echo "完成后请："
echo "1. 在浏览器中打开 http://localhost:4200"
echo "2. 按 F12 打开开发者工具"
echo "3. 在控制台运行: flowDebug.test()"
echo ""
echo "=========================================="
echo ""

cd /workspaces/dde
npm run dev
