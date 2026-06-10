#!/bin/bash
# 每日开票日报 - 直接输出报告，供 cron announce 推送
# 输出格式：纯文本
set -e

LOG_FILE="${BILLING_LOG_PATH:-$HOME/.openclaw/billing-log.jsonl}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${SCRIPT_DIR}/daily-billing-report.js"

if [ ! -f "$LOG_FILE" ]; then
  echo "暂无开票记录"
  exit 0
fi

# 直接输出脚本结果（report 字段）
RESULT=$(BILLING_LOG_PATH="$LOG_FILE" node "$SCRIPT" 2>/dev/null)
echo "$RESULT" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get('report', '暂无开票数据'))
except:
    print('开票日报生成失败')
"