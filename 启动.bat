@echo off
chcp 65001 >nul
title 合同识别系统
if exist "%~dp0ContractOCR.exe" (
  start "" "%~dp0ContractOCR.exe"
) else (
  echo 当前是浏览器备用版。如需后台并行与语义匹配，请到GitHub Releases下载Windows原生包。
  start "" "%~dp0index.html"
)
