# 启动本机 Xiaomi-OCR-0 推理服务（Ollama 后端）
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\start-ollama-ocr.ps1
#
# 关键点（踩过的坑）：
#   1. Ollama 桌面版（ollama app.exe）不读 OLLAMA_MODELS，模型放在非默认目录时它会报
#      「models path not accessible」并起不来 —— 必须用 ollama serve 手动启动。
#   2. 模型目录默认写进 C:\Users\<user>\.ollama\models，这里显式指向 D 盘。
#   3. 浏览器直连 127.0.0.1 属跨域请求，必须给 OLLAMA_ORIGINS，否则前端被 CORS 拦掉。
#
# 只想让服务常驻：用 D:\DevTools\ollama\start-ollama-ocr.vbs（静默、无窗口），
# 它已通过启动文件夹快捷方式做成开机自启，日常无需手动执行本脚本。

$ErrorActionPreference = 'Stop'

$modelDir = 'D:\DevTools\ollama-models'
$env:OLLAMA_MODELS = $modelDir
$env:OLLAMA_ORIGINS = '*'
$env:OLLAMA_HOST = '127.0.0.1:11434'

New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

# 服务已在跑就不重复启动
try {
  $null = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 -UseBasicParsing
  Write-Host '本机已有 Ollama 服务在运行（127.0.0.1:11434），无需重复启动。'
  & ollama list
  exit 0
} catch {
  # 未运行，继续
}

Write-Host "模型目录：$modelDir"
Write-Host '启动 ollama serve …（保持本窗口开启）'
ollama serve
