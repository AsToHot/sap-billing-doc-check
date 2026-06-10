#!/usr/bin/env bash
# 每日发货开票数据推送 - shell 直接调用脚本，不经过模型
# 用于 cron job 每日 10:00 自动执行
# 输出格式：纯文本，供飞书消息推送
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${BILLING_LOG_PATH:-$HOME/.openclaw/billing-log.jsonl}"

# ── 日期计算 ────────────────────────────────────────────────────────────────
TODAY=$(date +%Y%m%d)
YESTERDAY=$(date -d "yesterday" +%Y%m%d)
MONTH_AGO=$(date -d "30 days ago" +%Y%m%d)

# ── 1. 检查 RFC 代理 ────────────────────────────────────────────────────────
PROXY_PID=""
if ! ss -tlnp 2>/dev/null | grep -q ':9876'; then
  echo "⚠️ RFC 代理未运行，正在启动..."
  bash "$SKILL_DIR/auto-proxy.sh" 2>&1 | tail -5
  sleep 10
  if ! ss -tlnp 2>/dev/null | grep -q ':9876'; then
    echo "❌ RFC 代理启动失败，请手动检查"
    exit 1
  fi
  echo "✅ RFC 代理已启动"
fi

# ── 2. 查询昨日发货数据（全销售组织） ────────────────────────────────────────
echo ""
echo "━━━ 📦 昨日发货数据 ━━━"
echo "日期范围: ${YESTERDAY} ~ ${YESTERDAY}"
echo ""

FETCH_OUTPUT=$(node "$SCRIPT_DIR/fetch-delivery-data.js" \
  --all \
  --wadat-from "$YESTERDAY" \
  --wadat-to "$YESTERDAY" \
  --mode summary \
  --exclude-lfart ZNL1,ZNL2,ZNL3,ZNL4 2>&1)

echo "$FETCH_OUTPUT"

# ── 3. 统计 ──────────────────────────────────────────────────────────────────
# 从输出中提取统计信息
TOTAL_DN=$(echo "$FETCH_OUTPUT" | grep -c "^VBELN\|^[0-9]" || true)
BILLED=$(echo "$FETCH_OUTPUT" | grep "✅\|FKSTA.*C\|已开票" | wc -l || true)
UNBILLED=$(echo "$FETCH_OUTPUT" | grep "❌\|未开票" | wc -l || true)

echo ""
echo "━━━ 📊 统计汇总 ━━━"
echo "查询日期: ${YESTERDAY}"
echo ""

# ── 4. 开票日报 ──────────────────────────────────────────────────────────────
if [ -f "$LOG_FILE" ]; then
  INVOICE_REPORT=$(node "$SCRIPT_DIR/daily-billing-report.js" 2>/dev/null | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get('report', '暂无开票数据'))
except:
    print('开票日报生成失败')
" 2>/dev/null || echo "暂无开票记录")
else
  INVOICE_REPORT="暂无开票记录"
fi

echo "$INVOICE_REPORT"

echo ""
echo "━━━ ✅ 推送完成 ━━━"
