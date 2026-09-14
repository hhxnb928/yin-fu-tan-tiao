#!/bin/bash
# 音符弹跳 · 一键启动本地音乐服务并打开游戏
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then
  echo "未找到 python3，请先安装 Python 3"
  exit 1
fi
PORT=${1:-8000}
URL="http://localhost:$PORT"
( sleep 1; (command -v xdg-open >/dev/null && xdg-open "$URL") || \
  (command -v gio >/dev/null && gio open "$URL") || \
  (command -v termux-open >/dev/null && termux-open "$URL") ) >/dev/null 2>&1 &
exec "$PY" server.py "$PORT"
