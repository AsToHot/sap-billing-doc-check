#!/usr/bin/env bash
# ⚡ RFC 代理自动启动脚本
# 用法: bash auto-proxy.sh         # 正常启动
#       bash auto-proxy.sh --force # 强制重启（先杀旧进程）
#       bash auto-proxy.sh --check # 仅检查状态

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_PORT="${RFC_PROXY_PORT:-9876}"
PROXY_SCRIPT="${SCRIPT_DIR}/rfc-proxy-server.js"
LOG_FILE="${RFC_PROXY_LOG:-/tmp/rfc-proxy.log}"
PID_FILE="${RFC_PROXY_PID:-/tmp/rfc-proxy.pid}"

# 颜色
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

check_status() {
  local pid=""
  local running=false

  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      running=true
    fi
  fi

  if ! $running && ss -tlnp 2>/dev/null | grep -q ":${PROXY_PORT} "; then
    # PID 文件不存在但端口被占用
    pid=$(ss -tlnp 2>/dev/null | grep ":${PROXY_PORT} " | grep -oP 'pid=\K[0-9]+' || echo "")
    running=true
  fi

  echo "$pid" "$running"
}

is_alive() {
  check_status | awk '{print $2}'
}

status_msg() {
  local pid running
  read pid running < <(check_status)

  if [ "$running" = "true" ]; then
    echo -e "${GREEN}✅ RFC Proxy 运行中 (PID: $pid, 端口: $PROXY_PORT)${NC}"
    echo "   进程: $(ps -p "$pid" -o cmd= 2>/dev/null | head -c 100)"
    echo "   日志: $LOG_FILE"
    ss -tlnp 2>/dev/null | grep ":${PROXY_PORT} " && echo ""
    return 0
  else
    echo -e "${RED}❌ RFC Proxy 未运行${NC}"
    echo "   端口 $PROXY_PORT 未监听"
    return 1
  fi
}

start_proxy() {
  echo -e "${YELLOW}[*] 启动 RFC Proxy...${NC}"

  # 确保 NW-RFC-SDK 存在
  if [ ! -f "${SCRIPT_DIR}/NW-RFC-SDK/nwrfcsdk/lib/libsapnwrfc.so" ]; then
    echo -e "${RED}[ERROR] NW-RFC-SDK 未找到: ${SCRIPT_DIR}/NW-RFC-SDK/nwrfcsdk/lib/libsapnwrfc.so${NC}"
    exit 1
  fi

  # 确保 node_modules 存在
  if [ ! -f "${SCRIPT_DIR}/node_modules/node-rfc/package.json" ]; then
    echo -e "${RED}[ERROR] node-rfc 未安装，请先 npm install${NC}"
    exit 1
  fi

  # 确保 .env 存在
  if [ ! -f "${SCRIPT_DIR}/.env" ]; then
    echo -e "${RED}[ERROR] .env 未找到: ${SCRIPT_DIR}/.env${NC}"
    exit 1
  fi

  # 设置环境变量并启动
  export LD_LIBRARY_PATH="${SCRIPT_DIR}/NW-RFC-SDK/nwrfcsdk/lib:${LD_LIBRARY_PATH:-}"
  export PATH="${SCRIPT_DIR}/NW-RFC-SDK/nwrfcsdk/lib:${PATH}"

  cd "$SCRIPT_DIR"
  setsid node rfc-proxy-server.js > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # 等待就绪
  echo -n "${YELLOW}[*] 等待代理就绪"
  local max_wait=30
  for i in $(seq 1 $max_wait); do
    sleep 1
    if ss -tlnp 2>/dev/null | grep -q ":${PROXY_PORT} "; then
      echo ""
      echo -e "${GREEN}✅ RFC Proxy 已启动 (PID: $pid, 端口: $PROXY_PORT)${NC}"
      tail -3 "$LOG_FILE"
      return 0
    fi
    echo -n "."
  done

  echo -e "${RED}\n[ERROR] 代理启动超时（${max_wait}秒）${NC}"
  tail -10 "$LOG_FILE"
  return 1
}

stop_proxy() {
  echo -e "${YELLOW}[*] 停止 RFC Proxy...${NC}"
  local pid running
  read pid running < <(check_status)

  if [ "$running" = "true" ]; then
    kill "$pid" 2>/dev/null || true
    for i in 1 2 3 4 5; do
      sleep 1
      read _ running < <(check_status)
      if [ "$running" != "true" ]; then
        echo -e "${GREEN}✅ RFC Proxy 已停止${NC}"
        rm -f "$PID_FILE"
        return 0
      fi
    done
    kill -9 "$pid" 2>/dev/null || true
    echo -e "${YELLOW}⚠️  强制终止${NC}"
    rm -f "$PID_FILE"
  else
    echo -e "${YELLOW}⚠️  RFC Proxy 未在运行${NC}"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
case "${1:-}" in
  --check)
    status_msg
    ;;
  --force)
    stop_proxy
    sleep 1
    start_proxy
    ;;
  --stop)
    stop_proxy
    ;;
  "")
    # 正常启动：如果已运行则不动，否则启动
    lst=($(check_status))
    if [ "${lst[1]}" = "true" ]; then
      echo -e "${GREEN}✅ RFC Proxy 已在运行 (PID: ${lst[0]})${NC}"
    else
      start_proxy
    fi
    ;;
  *)
    echo "用法: bash auto-proxy.sh [--check|--force|--stop]"
    exit 1
    ;;
esac
