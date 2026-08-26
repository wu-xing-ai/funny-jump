@echo off
chcp 65001 >nul
cd /d %~dp0

echo ================================================
echo  趣味游戏 - 一键发布 (GitHub push + Cloudflare)
echo ================================================

echo.
echo [1/3] 提交代码到本地仓库...
git add -A
set /p MSG="请输入本次更新说明 (直接回车 = 常规更新): "
if "%MSG%"=="" set MSG=update: 游戏更新
git commit -m "%MSG%"
if errorlevel 1 echo   (没有新改动，跳过提交)

echo.
echo [2/3] 推送到 GitHub...
git push origin main
if errorlevel 1 goto :err

echo.
echo [3/3] 部署到 Cloudflare Workers（游戏页面 + 排行榜接口一体）...
call wrangler deploy
if errorlevel 1 goto :err

echo.
echo ================================================
echo  完成！线上地址: https://jump.wuxinw.dpdns.org
echo ================================================
pause
goto :eof

:err
echo.
echo 出错了，请检查上面的提示信息。
pause
