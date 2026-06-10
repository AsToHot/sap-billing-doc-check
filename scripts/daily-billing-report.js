#!/usr/bin/env node
/**
 * 每日开票明细推送 - 读取开票日志，汇总上一个开票日的数据
 * 用于 9:00 AM cron 推送
 *
 * 输出：JSON 格式
 * { report: "...", totals: { docs, items, clients } }
 */
const fs = require('node:fs');
const path = require('node:path');

const logPath = process.env.BILLING_LOG_PATH || path.resolve(process.env.HOME || '/tmp', '.openclaw', 'billing-log.jsonl');

if (!fs.existsSync(logPath)) {
  console.log(JSON.stringify({ report: '暂无开票记录', totals: { docs: 0, items: 0, clients: 0 } }));
  process.exit(0);
}

// 读取日志
const lines = fs.readFileSync(logPath, 'utf-8').split(/\r?\n/).filter(Boolean);
const records = lines.map(l => {
  try { return JSON.parse(l); } catch(e) { return null; }
}).filter(Boolean);

// 获取昨天的 "billingDate"
// billingDate 格式 "YYYY.MM.DD"，用该字段判断"上一个日期"
const today = new Date();
const billDates = [...new Set(records.map(r => r.billingDate).filter(Boolean))].sort().reverse();

// 取最近的 billingDate（非当天的）
const todayBillStr = `${today.getFullYear()}.${String(today.getMonth()+1).padStart(2,'0')}.${String(today.getDate()).padStart(2,'0')}`;
const yesterdayBillStr = billDates.find(d => d !== todayBillStr) || billDates[0];

if (!yesterdayBillStr) {
  console.log(JSON.stringify({ report: '暂无开票记录', totals: { docs: 0, items: 0, clients: 0 } }));
  process.exit(0);
}

// 筛选该开票日的数据
const dayRecords = records.filter(r => r.billingDate === yesterdayBillStr && r.success);

if (dayRecords.length === 0) {
  console.log(JSON.stringify({ report: `开票日 ${yesterdayBillStr} 无有效开票记录`, totals: { docs: 0, items: 0, clients: 0 } }));
  process.exit(0);
}

// 按开票凭证分组
const docGroups = {};
const clientNames = {};
const invoiceClientMap = {};

for (const r of dayRecords) {
  const doc = r.billingDoc;
  if (!docGroups[doc]) docGroups[doc] = [];
  docGroups[doc].push(r);

  // 尝试查找客户名称
  const c = r.client || '';
  // 如果 client 为空但有 vbeln，从交货单号推断客户
  const vbelnInferMap = {
    '8000001202': '葡萄牙博格华PDS',
    '8000001203': '葡萄牙博格华PDS',
    '8000001205': '葡萄牙博格华PDS',
    '8000001206': '葡萄牙博格华PDS',
    '8000001354': '通力电梯',
    '8000001448': '（客户925）',
    '8000001449': '（客户925）',
    '8500000247': '（客户925）',
  };
  const inferredName = vbelnInferMap[r.vbeln] || null;

  const displayClient = c || inferredName || '未知';
  if (displayClient && !clientNames['_last_' + displayClient]) {
    const nameMap = {
      '0000600954': '通力电梯',
      '0000700045': '葡萄牙博格华PDS',
      '0000600405': '北京星动纪元',
      '0000600925': '（客户925）',
      '0000603199': '（客户3199）',
    };
    clientNames['_last_' + displayClient] = true;
    if (!clientNames[c]) clientNames[c] = nameMap[c] || displayClient;
  }
  // 记录该凭证对应的显示客户名
  if (!invoiceClientMap[doc]) {
    invoiceClientMap[doc] = displayClient;
  }
}

const docKeys = Object.keys(docGroups).sort();
let report = `⚜️ 开票日报 | ${yesterdayBillStr}\n\n`;

let totalQty = 0;
let totalAmount = 0;
let totalGross = 0;

for (const doc of docKeys) {
  const items = docGroups[doc];
  const cname = invoiceClientMap[doc] || '未知';

  report += `📄 ${doc} | ${cname}\n`;

  // 按交货单/行项目排序
  const sorted = items.sort((a, b) => {
    if (a.vbeln !== b.vbeln) return a.vbeln.localeCompare(b.vbeln);
    return (a.posnr || '').localeCompare(b.posnr || '');
  });

  let docQty = 0;
  let docAmount = 0;
  let docGross = 0;
  let docWaerk = '';
  for (const it of sorted) {
    const mat = (it.maktx || '') ? it.maktx.substring(0, 28) : (it.vbeln || '').substring(0, 10);
    const qty = it.qty || 0;
    const unit = it.unit || '';
    const vbeln = it.vbeln || '';
    const net = it.netwr || it.amount || 0;
    const gross = it.gross || net;
    const curr = it.waerk || '';
    if (curr) docWaerk = curr;
    if (net) docAmount += net;
    if (gross) docGross += gross;
    report += `   ${vbeln} ${mat} ${qty} ${unit}\n`;
    docQty += qty;
  }
  totalQty += docQty;
  if (docAmount) totalAmount += docAmount;
  if (docGross) totalGross += docGross;
  const amountStr = docAmount ? ` | 💰 净额=${docAmount.toFixed(2)} 含税=${docGross.toFixed(2)} ${docWaerk}` : '';
  report += `   小计: ${items.length} 行, ${docQty} ${items[0].unit || ''}${amountStr}\n\n`;
}

const uniqueClients = [...new Set(dayRecords.map(r => r.client).filter(Boolean))];

report += `━━━━━━━━━━━━━━━━━━\n`;
const totalAmtStr = totalAmount ? ` | 💰 净额合计=${totalAmount.toFixed(2)} 含税合计=${totalGross.toFixed(2)} ${dayRecords[0]?.waerk || ''}` : '';
report += `合计: ${docKeys.length} 张凭证, ${dayRecords.length} 行, ${uniqueClients.length} 个客户${totalAmtStr}`;

const result = {
  report,
  totals: {
    docs: docKeys.length,
    items: dayRecords.length,
    clients: uniqueClients.length,
    date: yesterdayBillStr,
    lines: dayRecords
  }
};

console.log(JSON.stringify(result));
