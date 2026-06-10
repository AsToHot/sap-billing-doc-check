#!/usr/bin/env node
/**
 * 发货数据查询脚本（优化版 v2.0）
 * 通过 ADT Data Preview freestyle SQL 分批查询单表，本地 JOIN
 *
 * 优化内容：
 *   - ⚡ 空 VBELN 列表守卫：LIKP 无结果时立即返回，避免全表扫描
 *   - ⚡ 并发查询：LIPS 与 VBRP 并行执行
 *   - ⚡ 物料描述批量查询：自动获取所有唯一物料的 MAKTX
 *   - ⚡ 智能日期默认值：未指定日期时默认近 3 个月
 *   - ⚡ IN 列表自动换行：避免 ADT 行长度限制（~255 字符）
 *   - ⚡ VIEW/SUMMARY 模式：支持"全部发货记录"和"未开票"两种输出
 *   - ⚡ 状态字段感应：自动检测 S4 HANA 并启用 WBSTK/FKSTA 过滤
 *   - ⚡ JSON 模式：静默输出，仅打印 JSON 到 stdout
 *
 * 用法: node scripts/fetch-delivery-data.js [options]
 *   --client      <kunnr>           客户编号（可选，与 --vkorg 二选一）
 *   --vkorg       <vkorg>           销售组织编号（可选，与 --client 二选一）
 *   --vbeln       <vbeln>           按交货单号直查（最快，单条查询）
 *   --mode        <summary|detail>  输出模式：summary=汇总(默认) detail=明细
 *   --unbilled    <true|false>      仅显示未开票 (默认 false)
 *   --wadat-from  <YYYYMMDD>        过账日期起 (默认 3 个月前)
 *   --wadat-to    <YYYYMMDD>        过账日期止 (默认今天)
 *   --s4                             启用 S4 HANA 状态字段过滤
 *   --rows        <N>               明细输出最大行数 (默认 500)
 *   --json                          仅输出 JSON 到 stdout（静默模式）
 *   --exclude-lfart <types>         排除的交货类型，逗号分隔 (如 ZNL1,ZNL2,ZNL3,ZNL4)
 *   --excel                         输出 Excel 文件（需 Python + openpyxl）
 *   --all                           扫描全部销售组织（覆盖所有 VKORG）
 */

const http = require('node:http');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 9876;
const MAX_IN_LIST = 180; // SAP ADT IN 列表安全上限

// ── 工具函数 ────────────────────────────────────────────────────────────────

function sanitizeSapValue(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^A-Za-z0-9_\-\.]/g, '').slice(0, maxLen || 40);
}

function escapeSapString(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/'/g, "''").slice(0, maxLen || 40);
}

function padLeft(str, len, ch) {
  return String(str || '').padStart(len, ch || '0');
}

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + m + day;
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + m + day;
}

// ── ADT 查询 ────────────────────────────────────────────────────────────────

function adtQuery(sql, rowNumber) {
  return new Promise((resolve, reject) => {
    const postData = sql;
    const req = http.request({
      hostname: PROXY_HOST, port: PROXY_PORT,
      path: '/sap/bc/adt/datapreview/freestyle?rowNumber=' + (rowNumber || 500),
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.sap.adt.datapreview.table.v1+xml',
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const msg = data.match(/<localizedMessage[^>]*>([^<]*)<\/localizedMessage>/)
            || data.match(/<message[^>]*>([^<]*)<\/message>/);
          reject(new Error(msg ? msg[1] : ('HTTP ' + res.statusCode)));
          return;
        }
        resolve(parseAdtXml(data));
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function parseAdtXml(xml) {
  const columns = [];
  const colRegex = /<dataPreview:columns>(.*?)<\/dataPreview:columns>/gs;
  const nameRegex = /dataPreview:name="([^"]*)"/;
  // 支持 <dataPreview:data/>（NULL值，自闭合标签）和 <dataPreview:data>value</dataPreview:data>
  const dataRegex = /<dataPreview:data\s*\/>|<dataPreview:data>(.*?)<\/dataPreview:data>/gs;

  let colMatch;
  while ((colMatch = colRegex.exec(xml)) !== null) {
    const block = colMatch[1];
    const name = (nameRegex.exec(block) || [])[1] || '';
    const values = [];
    let dm;
    while ((dm = dataRegex.exec(block)) !== null) {
      // 自闭合标签 → NULL/空值
      values.push(dm[0].indexOf('/>') >= 0 ? '' : (dm[1] || ''));
    }
    columns.push({ name: name, values: values });
    dataRegex.lastIndex = 0;
  }

  const rows = [];
  const n = columns.length > 0 ? columns[0].values.length : 0;
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const col of columns) row[col.name] = col.values[i] || '';
    rows.push(row);
  }
  return rows;
}

// ── VBELN 分块 ──────────────────────────────────────────────────────────────

function chunkVbelns(vbelns, chunkSize) {
  chunkSize = chunkSize || MAX_IN_LIST;
  const chunks = [];
  for (let i = 0; i < vbelns.length; i += chunkSize) {
    chunks.push(vbelns.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * 批量查询物料描述
 * 多行 IN 格式避免 ADT 行长度限制
 */
async function batchQueryMaterials(matnrs, allRows, maxRetries) {
  maxRetries = maxRetries || 1;
  if (matnrs.length === 0) return;
  const unique = [...new Set(matnrs.map(function(m) {
    return m.replace(/^0+/, '').padStart(18, '0');
  }))];
  const chunks = chunkVbelns(unique, MAX_IN_LIST);
  for (const chunk of chunks) {
    const inLines = chunk.map(function(v) {
      return "  '" + escapeSapString(v, 18) + "'";
    }).join(',\n');
    const sql = "SELECT MATNR, MAKTX FROM MAKT\nWHERE MATNR IN (\n" + inLines + "\n) AND SPRAS = '1'";
    var maktRows = [];
    for (var retry = 0; retry < maxRetries; retry++) {
      try {
        maktRows = await adtQuery(sql, chunk.length + 10);
        break; // 成功则跳出重试循环
      } catch (e) {
        if (retry < maxRetries - 1) {
          await new Promise(function(r) { setTimeout(r, 1000 * (retry + 1)); });
        } else {
          throw e; // 最后一次重试仍失败，向上抛
        }
      }
    }
    for (const r of maktRows) {
      const fullMatnr = r.MATNR.replace(/^0+/, '').padStart(18, '0');
      allRows.push({ MATNR: fullMatnr, MAKTX: r.MAKTX });
    }
  }
}

// ── FKSTA 状态标签 ──────────────────────────────────────────────────────────

/**
 * 开票状态判定（信任 FKSTA 为主）
 * FKSTA 由 SAP 开票流程维护，是开票状态的权威依据
 * ZKYSL 作辅助参考，不覆盖 FKSTA
 */
function realStatus(item) {
  if (item.FKSTA) return item.FKSTA;
  // FKSTA 为空时，用 ZKYSL 推断
  if (item.FKIMG_JS > 0.001) return 'C';
  if (item.ZKYSL > 0.001) return 'A';
  return '';
}

// 与开票无关的交货类型（如库存转储 ZLR7）
var NON_BILLING_LFART = new Set(['ZLR7']);

function fkstaLabel(code, lfart) {
  if (NON_BILLING_LFART.has(lfart) && !code) return '➖ 不适用';
  var map = { '': '➖ 未确定', 'A': '❌ 未开票', 'B': '⚠️ 部分开票', 'C': '✅ 已开票' };
  return map[code] || ('➖ ' + code);
}

function billingStatusLabel(fksta, lfart) {
  if (NON_BILLING_LFART.has(lfart) && !fksta) return '➖ 不适用';
  var map = { '': '➖ 未确定', 'A': '❌ 未开票', 'B': '⚠️ 部分开票', 'C': '✅ 已开票' };
  return map[fksta] || ('➖ ' + fksta);
}



/**
 * 构建 VBELN WHERE 子句（多行格式）
 * ADT freestyle SQL 行长度约 255 字符限制，必须用换行分隔
 */
function buildVbelnWhere(col, list, extraConds) {
  extraConds = extraConds || [];
  if (list.length === 0) {
    return extraConds.length > 0 ? '\nWHERE\n  ' + extraConds.join('\n  AND ') : '';
  }
  // 使用分块 IN 列表（即使超大量也用 IN，避免范围截断引发数据遗漏）
  // 分块可确保只查需要的交货单，不会被无关数据撑爆 5000 行限制
  var inLines = list.map(function(v) {
    return "  '" + escapeSapString(v, 10) + "'";
  }).join(',\n');
  var whereClauses = [col + " IN (\n" + inLines + "\n)"];
  whereClauses = whereClauses.concat(extraConds);
  return "\nWHERE\n  " + whereClauses.join("\n  AND ");
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

async function main() {
  var args = process.argv.slice(2);
  var filters = {
    client: '', vkorg: '', vbeln: '', mode: 'summary',
    'wadat-from': '', 'wadat-to': '',
    rows: '500', unbilled: 'false',
  };
  var isS4 = false;
  var jsonMode = false;
  var excelMode = false;
  var scanAll = false;
  var excludeLfart = [];

  for (var i = 0; i < args.length; i++) {
    var key = args[i].replace(/^--/, '');
    if (key === 's4') { isS4 = true; continue; }
    if (key === 'json') { jsonMode = true; continue; }
    if (key === 'excel') { excelMode = true; continue; }
    if (key === 'all') { scanAll = true; continue; }
    if (key === 'exclude-lfart') { excludeLfart = args[i + 1].split(',').map(function(s) { return s.trim().toUpperCase(); }); continue; }
    if (args[i + 1] !== undefined) filters[key] = args[i + 1];
  }

  var maxRows = parseInt(filters.rows, 10) || 500;
  var onlyUnbilled = filters.unbilled === 'true' || filters.unbilled === 'yes' || filters.unbilled === '1';
  // scanAll 已在参数解析时通过 --all 标志设置

  if (!scanAll && !filters.client && !filters.vkorg && !filters.vbeln) {
    console.log('[ERROR] 必须指定 --client、--vkorg、--vbeln 或 --all');
    process.exit(1);
  }

  // JSON 模式下静默（不输出调试信息）
  var log = jsonMode ? function(){} : console.log;

  // 智能日期默认值
  if (!filters['wadat-from']) filters['wadat-from'] = monthsAgo(3);
  if (!filters['wadat-to']) filters['wadat-to'] = today();

  var wadatFrom = sanitizeSapValue(filters['wadat-from'], 8);
  var wadatTo = sanitizeSapValue(filters['wadat-to'], 8);
  var clientCode = padLeft(sanitizeSapValue(filters.client), 10);
  // 只有实际传了 --client 才当作客户编号，否则为空字符串
  var hasClient = filters.client && filters.client.replace(/^0+/, '') !== '';
  var vkorgCode = sanitizeSapValue(filters.vkorg, 4);

  var totalStart = Date.now();

  if (isS4) log('[MODE] S4 HANA: 已启用状态字段过滤');
  var vbelnCode = sanitizeSapValue(filters.vbeln, 10);
  var modeDesc = hasClient ? '客户: ' + clientCode : (vkorgCode ? '销售组织: ' + vkorgCode : (scanAll ? '全部销售组织' : '交货单: ' + vbelnCode));
  log('[MODE] ' + modeDesc + ' | 日期范围: ' + wadatFrom + ' ~ ' + wadatTo + ' | 模式: ' + (onlyUnbilled ? '仅未开票' : '全部发货'));

  // ⚡ --vbeln 快捷模式：单条直查，跳过全套流水线
  if (vbelnCode) {
    log('\n[⚡快速模式] 按交货单号直查...');
    var t0 = Date.now();
    var headers = await adtQuery("SELECT vbeln, lfart, vkorg, kunnr, wadat_ist, waerk, vbtyp, fkstk FROM likp WHERE vbeln = '" + vbelnCode + "'", 5);
    if (headers.length === 0) {
      log('\n\u26a0\ufe0f 交货单 ' + vbelnCode + ' 不存在');
      process.exit(0);
    }
    var items = await adtQuery("SELECT vbeln, posnr, matnr, arktx, lfimg, vrkme, fksta FROM lips WHERE vbeln = '" + vbelnCode + "'", 50);
    var vbrp = await adtQuery("SELECT vbeln, vgbel, vgpos, fkimg FROM vbrp WHERE vgbel = '" + vbelnCode + "'", 50);
    log('      -> ' + items.length + ' 行 (' + (Date.now() - t0) + 'ms)');

    // 查 VBRK 排除已冲销开票
    var revokedDocsFast = new Set();
    var billingDocsFast = [...new Set(vbrp.map(function(r) { return r.VBELN; }).filter(Boolean))];
    if (billingDocsFast.length > 0) {
      try {
        var inList = billingDocsFast.map(function(v) { return "'" + v + "'"; }).join(',');
        var vbrkF = await adtQuery("SELECT vbeln, sfakn, fkart FROM vbrk WHERE vbeln IN (" + inList + ")", 50);
        var sfaknMapF = new Map();
        for (var kfi = 0; kfi < vbrkF.length; kfi++) {
          var kf = vbrkF[kfi];
          if (kf.SFAKN && kf.SFAKN.trim() !== '') {
            revokedDocsFast.add(kf.VBELN);
            revokedDocsFast.add(kf.SFAKN);
          }
        }
      } catch (e) {}
    }

    // 本地 JOIN（同主流程逻辑）
    var billedMap = new Map();
    for (var ri = 0; ri < vbrp.length; ri++) {
      var r = vbrp[ri];
      var key = r.VGBEL + '-' + r.VGPOS;
      if (revokedDocsFast.has(r.VBELN)) continue;
      billedMap.set(key, (billedMap.get(key) || 0) + parseFloat(r.FKIMG || 0));
    }
    var headerMap = new Map();
    for (var hi = 0; hi < headers.length; hi++) {
      headerMap.set(headers[hi].VBELN, headers[hi]);
    }
    var results = [];
    for (var ii = 0; ii < items.length; ii++) {
      var item = items[ii];
      var header = headerMap.get(item.VBELN);
      if (!header) continue;
      var billedQty = billedMap.get(item.VBELN + '-' + item.POSNR) || 0;
      var deliverQty = parseFloat(item.LFIMG || 0);
      var unbilledQty = deliverQty - billedQty;
      var effectiveUnbilled = unbilledQty > 0.001 ? unbilledQty : 0;
      results.push({
        VBELN_JS: item.VBELN, POSNR_JS: item.POSNR,
        LFART: header.LFART, VKORG: header.VKORG, VBTYP: header.VBTYP, KUNNR: header.KUNNR,
        MATNR: item.MATNR, MAKTX: item.ARKTX || '',
        LFIMG: deliverQty, VRKME: item.VRKME,
        FKIMG_JS: billedQty, ZKYSL: effectiveUnbilled,
        WAERK: header.WAERK, WADAT_IST: header.WADAT_IST,
        FKSTA: item.FKSTA || '',
        FKSTK: header.FKSTK || '',  // 表头级总体开票状态
      });
    }

    // FKSTA 二次验证
    var suspicious = results.filter(function(r) { return r.FKSTA === 'A' && r.FKIMG_JS >= r.LFIMG && r.LFIMG > 0; });
    if (suspicious.length > 0) {
      for (var vi = 0; vi < suspicious.length; vi++) {
        var s = suspicious[vi];
        try {
          var vr = await adtQuery("SELECT fksta FROM lips WHERE vbeln = '" + s.VBELN_JS + "' AND posnr = '" + s.POSNR_JS + "'", 5);
          if (vr.length > 0 && vr[0].FKSTA && vr[0].FKSTA !== s.FKSTA) {
            log('      -> \u26a1 ' + s.VBELN_JS + ' FKSTA=' + s.FKSTA + ' \u2192 ' + vr[0].FKSTA);
            s.FKSTA = vr[0].FKSTA;
          }
        } catch (e) {}
      }
    }

    // 物料描述
    var matnrs = results.map(function(r) { return r.MATNR; }).filter(function(m) { return m && !m.startsWith('0') || (m && !m.replace(/^0+/, '')); });
    // 去重
    var seen = {};
    matnrs = matnrs.filter(function(m) { return seen[m] ? false : (seen[m] = true); });
    if (matnrs.length > 0) {
      var maktResult = [];
      await batchQueryMaterials(matnrs, maktResult);
      var maktMap = new Map();
      for (var mi = 0; mi < maktResult.length; mi++) maktMap.set(maktResult[mi].MATNR, maktResult[mi].MAKTX);
      for (var ri = 0; ri < results.length; ri++) {
        if (maktMap.has(results[ri].MATNR)) results[ri].MAKTX = maktMap.get(results[ri].MATNR);
      }
    }
    log('      -> 物料描述补全 (' + (Date.now() - t0) + 'ms)');

    // 输出
    var totalTime = Date.now() - t0;
    log('[MODE] 客户: ' + (results[0] ? results[0].KUNNR : '') + ' | 总耗时: ' + totalTime + 'ms');

    if (jsonMode) {
      console.log(JSON.stringify({meta:{totalDeliveries:1,totalItems:results.length,durationMs:totalTime},items:results}, null, 2));
    } else {
      console.log('\n\u269c\ufe0f 交货单 ' + vbelnCode + ' 数据');
      console.log('='.repeat(60));
      console.log('# | 交货单          | 行项目 | 类型 | 销组 | 开票类 | 物料描述                   | 数量     | 单位 | 已开票   | 可开票   | 过账日期  | 开票状态');
      console.log('-'.repeat(135));
      for (var di = 0; di < results.length; di++) {
        var r = results[di];
        var st = billingStatusLabel(r.FKSTA, r.LFART);
        console.log((di+1) + ' | ' + r.VBELN_JS + ' | ' + r.POSNR_JS + ' | ' + r.LFART + ' | ' + (r.VKORG || '').slice(0, 4) + ' | ' + (r.VBTYP || '') + ' | ' + (r.MAKTX || '').slice(0, 24) + ' | ' + r.LFIMG + ' | ' + r.VRKME + ' | ' + r.FKIMG_JS + ' | ' + r.ZKYSL + ' | ' + r.WADAT_IST + ' | ' + st);
      }
      console.log('-'.repeat(120));
      console.log('\n\u26a1 查询耗时: ' + totalTime + 'ms');
    }
    process.exit(0);
  }

  // ── Step 1: LIKP 表头 ──────────────────────────────────────────────────
  log('\n[1/5] 查询 LIKP 表头...');
  var t1 = Date.now();
  var likpConds = [
    "WADAT_IST >= '" + wadatFrom + "'",
    "WADAT_IST <= '" + wadatTo + "'"
  ];
  if (scanAll) {
    log('      -> 全销售组织扫描模式');
  } else {
    if (hasClient) likpConds.unshift("KUNNR = '" + clientCode + "'");
    if (vkorgCode) likpConds.unshift("VKORG = '" + vkorgCode + "'");
  }
  if (isS4) likpConds.push("WBSTK = 'C'");
  var likpSql = "SELECT VBELN, VBTYP, LFART, VKORG, KUNNR, KUNAG, WADAT_IST, WAERK, FKSTK FROM LIKP\nWHERE\n  " + likpConds.join("\n  AND ");
  var headers = await adtQuery(likpSql, 2000);
  log('      -> ' + headers.length + ' 行 (' + (Date.now() - t1) + 'ms)');

  // ⚡ 排除指定交货类型（如公司间 ZNL1~ZNL4）
  if (excludeLfart.length > 0) {
    var excludeSet = new Set(excludeLfart);
    var beforeCount = headers.length;
    headers = headers.filter(function(h) { return !excludeSet.has(h.LFART); });
    if (!jsonMode) log('      -> 排除类型 ' + excludeLfart.join(',') + ': ' + (beforeCount - headers.length) + ' 个交货单被过滤');
  }

  // ⚡ [守卫] LIKP 无数据 → 提前返回
  if (headers.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({
        meta: { client: hasClient ? clientCode : '', vkorg: vkorgCode, dateFrom: wadatFrom, dateTo: wadatTo, totalDeliveries: 0, totalItems: 0, durationMs: Date.now() - totalStart },
        items: []
      }, null, 2));
    } else {
      log('\n\u26a0\ufe0f 指定条件下无交货单数据。可能原因：');
      log('   \u2022 ' + (vkorgCode ? '该销售组织' : '该客户') + '在所查期间内无交货单');
      log('   \u2022 日期范围不匹配（试试更大范围）');
      log('   \u2022 编号不正确');
    }
    return;
  }

  // 收集 VBELN 列表
  var vbelns = headers.map(function(r) { return r.VBELN; }).filter(Boolean);
  log('      -> VBELN 列表: ' + vbelns.length + ' 个');

  // ── Step 2 & 3: 并发查询 LIPS 和 VBRP ─────────────────────────────────
  log('[2/5] 查询 LIPS 行项目...');
  var lipsExtra = isS4 ? ["FKSTA IN ('A','B')"] : [];
  var lipsWhere = buildVbelnWhere('VBELN', vbelns, lipsExtra);
  var lipsSql = "SELECT VBELN, POSNR, MATNR, ARKTX, LFIMG, VRKME, FKSTA FROM LIPS" + lipsWhere;

  log('[3/5] 查询 VBRP 已开票数据...');
  var vbrpWhere = buildVbelnWhere('VGBEL', vbelns);
  var vbrpSql = "SELECT VBELN, VGBEL, VGPOS, FKIMG FROM VBRP" + vbrpWhere;

  // ⚡ 对大 IN 列表进行分块查询（ADT freestyle SQL 的 IN 列表有限制）
  var t2 = Date.now();
  var items = [], vbrp = [];
  if (vbelns.length > MAX_IN_LIST) {
    var chunks = chunkVbelns(vbelns, MAX_IN_LIST);
    log('      -> 分 ' + chunks.length + ' 批查询 LIPS/VBRP...');
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci];
      var lw = buildVbelnWhere('VBELN', chunk, lipsExtra);
      var vw = buildVbelnWhere('VGBEL', chunk);
      var chunkLipsSql = "SELECT VBELN, POSNR, MATNR, ARKTX, LFIMG, VRKME, FKSTA FROM LIPS" + lw;
      var chunkVbrpSql = "SELECT VBELN, VGBEL, VGPOS, FKIMG FROM VBRP" + vw;
      try {
        var chunkBoth = await Promise.all([
          adtQuery(chunkLipsSql, 5000),
          adtQuery(chunkVbrpSql, 5000),
        ]);
        items = items.concat(chunkBoth[0]);
        vbrp = vbrp.concat(chunkBoth[1]);
      } catch (e) {
        log('      -> [警告] 第 ' + (ci+1) + '/' + chunks.length + ' 批查询失败 (' + e.message + ')，跳过');
      }
    }
  } else {
    var both = await Promise.all([
      adtQuery(lipsSql, 5000),
      adtQuery(vbrpSql, 5000),
    ]);
    items = both[0];
    vbrp = both[1];
  }
  log('      -> LIPS: ' + items.length + ' 行, VBRP: ' + vbrp.length + ' 行 (' + (Date.now() - t2) + 'ms)');

  // ── 查 VBRK 排除已冲销的开票 ──────────────────────────────────────────
  // 已冲销的开票（SFAKN != ''）和冲销凭证本身都不应计入已开票数量
  var revokedDocs = new Set();
  if (vbrp.length > 0) {
    var billingDocs = [...new Set(vbrp.map(function(r) { return r.VBELN; }).filter(Boolean))];
    if (billingDocs.length > 0) {
      var inList = billingDocs.map(function(v) { return "'" + v + "'"; }).join(',\n  ');
      try {
        var vbrkResult = await adtQuery("SELECT VBELN, SFAKN, FKART, FKDAT FROM VBRK\nWHERE VBELN IN (\n  " + inList + "\n)", 500);
        var sfaknMap = new Map();
        for (var ki = 0; ki < vbrkResult.length; ki++) {
          var k = vbrkResult[ki];
          sfaknMap.set(k.VBELN, k);
          if (k.SFAKN && k.SFAKN.trim() !== '') {
            // 被冲销的开票：SFAKN 指向冲销凭证
            revokedDocs.add(k.VBELN);
          }
        }
        // 冲销凭证本身：有其 VBELN 出现在其他凭证的 SFAKN 中
        for (var ki = 0; ki < vbrkResult.length; ki++) {
          var k = vbrkResult[ki];
          if (k.SFAKN && k.SFAKN.trim() !== '') {
            // k.SFAKN 是冲销此凭证的凭证号
            revokedDocs.add(k.SFAKN);
          }
        }
        log('      -> VBRK: ' + vbrkResult.length + ' 条 (' + (revokedDocs.size > 0 ? '排除 ' + revokedDocs.size + ' 张已冲销凭证' : '全部有效') + ')');
      } catch (e) {
        log('      -> VBRK 查询失败（不影响流程，使用原始 FKIMG）: ' + e.message);
      }
    }
  }

  // ── Step 4: 本地 JOIN ──────────────────────────────────────────────────
  log('[4/5] 本地 JOIN 计算未开票...');
  var t3 = Date.now();

  var billedMap = new Map();
  for (var ri = 0; ri < vbrp.length; ri++) {
    var r = vbrp[ri];
    var key = r.VGBEL + '-' + r.VGPOS;
    // 跳过已冲销或冲销凭证本身的开票数量
    if (revokedDocs.has(r.VBELN)) continue;
    billedMap.set(key, (billedMap.get(key) || 0) + parseFloat(r.FKIMG || 0));
  }

  var headerMap = new Map();
  for (var hi = 0; hi < headers.length; hi++) {
    headerMap.set(headers[hi].VBELN, headers[hi]);
  }

  var results = [];
  for (var ii = 0; ii < items.length; ii++) {
    var item = items[ii];
    var header = headerMap.get(item.VBELN);
    if (!header) continue;

    var billedQty = billedMap.get(item.VBELN + '-' + item.POSNR) || 0;
    var deliverQty = parseFloat(item.LFIMG || 0);
    var unbilledQty = deliverQty - billedQty;
    var isPosted = header.WADAT_IST && header.WADAT_IST !== '00000000';

    if (!isPosted) continue;

    // 可开票数量不低于 0（已开票超过发货量时取 0）
    var effectiveUnbilled = unbilledQty > 0.001 ? unbilledQty : 0;

    results.push({
      VBELN_JS: item.VBELN,
      POSNR_JS: item.POSNR,
      VBTYP: header.VBTYP,
      LFART: header.LFART,
      VKORG: header.VKORG,
      KUNNR: header.KUNNR,
      MATNR: item.MATNR,
      MAKTX: item.ARKTX || '',
      LFIMG: deliverQty,
      VRKME: item.VRKME,
      FKIMG_JS: billedQty,
      ZKYSL: effectiveUnbilled,
      WAERK: header.WAERK,
      WADAT_IST: header.WADAT_IST,
      FKSTA: item.FKSTA || '',
      FKSTK: header.FKSTK || '',
    });
  }

  // 按 FKSTA 排序：未开票(A) > 部分(B) > 已开票(C)
  results.sort(function(a, b) {
    var order = { 'A': 0, 'B': 1, 'C': 2, '': 3 };
    return (order[a.FKSTA] || 3) - (order[b.FKSTA] || 3);
  });

  log('      -> ' + results.length + ' 行 (' + (Date.now() - t3) + 'ms)');

  // ── Step 4.5: FKSTA 二次验证 ───────────────────────────────────────────
  // ADT 批量 IN 列表查询偶发缓存问题，对 FKSTA='A' 但 VBRP 已开满的发货单做单条验证
  var suspiciousItems = results.filter(function(r) { return r.FKSTA === 'A' && r.FKIMG_JS >= r.LFIMG && r.LFIMG > 0; });
  if (suspiciousItems.length > 0) {
    var verifyStart = Date.now();
    log('      -> FKSTA 二次验证: ' + suspiciousItems.length + ' 条待确认');
    for (var vi = 0; vi < suspiciousItems.length; vi++) {
      var sus = suspiciousItems[vi];
      try {
        var verifySql = "SELECT vbeln, posnr, fksta FROM lips WHERE vbeln = '" + sus.VBELN_JS + "' AND posnr = '" + sus.POSNR_JS + "'";
        var verifyResult = await adtQuery(verifySql, 5);
        if (verifyResult.length > 0 && verifyResult[0].FKSTA && verifyResult[0].FKSTA !== sus.FKSTA) {
          log('      -> ⚡ ' + sus.VBELN_JS + ' FKSTA=' + sus.FKSTA + ' → ' + verifyResult[0].FKSTA + '（ADT 单条查询修正）');
          sus.FKSTA = verifyResult[0].FKSTA;
        }
      } catch (e) {
        // 验证失败就保留原值
      }
    }
    log('      -> FKSTA 验证完成 (' + (Date.now() - verifyStart) + 'ms)');
  }

  // ⚡ 反向 FKSTA 验证：FKSTA='C' 但 VBRP 无开票 → 回退为 'A'
  var reverseSus = results.filter(function(r) {
    return r.FKSTA === 'C' && r.FKIMG_JS < r.LFIMG && r.LFIMG > 0;
  });
  if (reverseSus.length > 0) {
    var revStart = Date.now();
    log('      -> FKSTA 反向验证: ' + reverseSus.length + ' 条待确认');
    for (var rvi = 0; rvi < reverseSus.length; rvi++) {
      var revSus = reverseSus[rvi];
      try {
        var revSql = "SELECT vbeln, posnr, fksta FROM lips WHERE vbeln = '" + revSus.VBELN_JS + "' AND posnr = '" + revSus.POSNR_JS + "'";
        var revResult = await adtQuery(revSql, 5);
        if (revResult.length > 0 && revResult[0].FKSTA && revResult[0].FKSTA === 'A') {
          log('      -> ⚡ ' + revSus.VBELN_JS + ' FKSTA=C → A（反向修正，VBRP 无开票）');
          revSus.FKSTA = 'A';
        }
      } catch (e) {
        // 验证失败保留原值
      }
    }
    log('      -> FKSTA 反向验证完成 (' + (Date.now() - revStart) + 'ms)');
  }

  // ── FKSTK 验证：批次查询的 FKSTK 偶发 ADT 缓存问题 ────────────────────
  // 根据行项目 FKSTA 推断期望表头 FKSTK，不一致时单条 ADT 确认
  var fkstkGroups = {};
  for (var fgi = 0; fgi < results.length; fgi++) {
    var fri = results[fgi];
    if (!fkstkGroups[fri.VBELN_JS]) fkstkGroups[fri.VBELN_JS] = [];
    fkstkGroups[fri.VBELN_JS].push(fri);
  }
  for (var fvb in fkstkGroups) {
    var fitems = fkstkGroups[fvb];
    var hasBilled = false, hasUnbilled = false;
    for (var fsi = 0; fsi < fitems.length; fsi++) {
      if (fitems[fsi].FKSTA === 'C') hasBilled = true;
      if (fitems[fsi].FKSTA === 'A' || fitems[fsi].FKSTA === 'B' || fitems[fsi].FKSTA === '') hasUnbilled = true;
    }
    var expectedFkstk = '';
    if (hasBilled && hasUnbilled) expectedFkstk = 'B';  // 部分开票
    else if (hasBilled) expectedFkstk = 'C';             // 完全开票
    var batchFkstk = fitems[0].FKSTK || '';
    if (expectedFkstk && expectedFkstk !== batchFkstk) {
      try {
        var fkstkSql = "SELECT fkstk FROM likp WHERE vbeln = '" + fvb + "'";
        var fkstkVerify = await adtQuery(fkstkSql, 5);
        if (fkstkVerify.length > 0 && fkstkVerify[0].FKSTK) {
          var realFkstk = fkstkVerify[0].FKSTK;
          if (realFkstk !== batchFkstk) {
            for (var ffi = 0; ffi < fitems.length; ffi++) {
              fitems[ffi].FKSTK = realFkstk;
            }
          }
        }
      } catch(e) {}
    }
  }

  // ── Step 5: 物料描述补全 ───────────────────────────────────────────────
  log('[5/5] 批量查询物料描述...');
  var t4 = Date.now();
  var allMatnrs = [];
  for (var mi = 0; mi < results.length; mi++) {
    if (results[mi].MATNR) allMatnrs.push(results[mi].MATNR);
  }
  // 去重
  var seen = {};
  allMatnrs = allMatnrs.filter(function(m) {
    return seen[m] ? false : (seen[m] = true);
  });

  var maktCache = new Map();
  if (allMatnrs.length > 0) {
    try {
      var maktResults = [];
      await batchQueryMaterials(allMatnrs, maktResults, 3); // 最多重试 3 次
      for (var mri = 0; mri < maktResults.length; mri++) {
        maktCache.set(maktResults[mri].MATNR, maktResults[mri].MAKTX);
      }
    } catch (e) {
      log('      -> [警告] 物料描述查询失败 (' + e.message + ')，跳过描述补全');
    }
  }

  // 如果 ARKTX 为空，用 MAKTX 填充
  for (var ri2 = 0; ri2 < results.length; ri2++) {
    if (!results[ri2].MAKTX) {
      var fullMatnr = results[ri2].MATNR.replace(/^0+/, '').padStart(18, '0');
      results[ri2].MAKTX = maktCache.get(fullMatnr) || '';
    }
  }
  log('      -> 补充 ' + maktCache.size + ' 个物料描述 (' + (Date.now() - t4) + 'ms)');

  // ── 统计（基于真实状态） ──────────────────────────────────────────────
  var totalTime = Date.now() - totalStart;
  var unbilledCount = 0, partialCount = 0, billedCount = 0, totalQty = 0;
  for (var si = 0; si < results.length; si++) {
    var r = results[si];
    totalQty += r.LFIMG;
    var st = realStatus(r);
    if (st === 'A') unbilledCount++;
    else if (st === 'B') partialCount++;
    else if (st === 'C') billedCount++;
  }

  // ⚡ JSON 模式输出
  if (jsonMode) {
    var output = onlyUnbilled ? results.filter(function(r) { return r.FKSTA === 'A'; }) : results;
    console.log(JSON.stringify({
      meta: {
        client: hasClient ? clientCode : '', vkorg: vkorgCode, dateFrom: wadatFrom, dateTo: wadatTo,
        totalDeliveries: vbelns.length, totalItems: results.length,
        unbilled: unbilledCount, partial: partialCount, billed: billedCount,
        durationMs: totalTime,
      },
      items: output,
    }, null, 2));
    return;
  }

  // ⚡ Excel 模式：输出 JSON 到临时文件，调用 Python 生成 Excel
  if (excelMode) {
    var fs = require('fs');
    var output = onlyUnbilled ? results.filter(function(r) { return r.FKSTA === 'A'; }) : results;
    var jsonPayload = JSON.stringify({
      meta: {
        client: hasClient ? clientCode : '', vkorg: vkorgCode, dateFrom: wadatFrom, dateTo: wadatTo,
        totalDeliveries: vbelns.length, totalItems: results.length,
        unbilled: unbilledCount, partial: partialCount, billed: billedCount,
        durationMs: totalTime,
      },
      items: output,
    });

    var tmpFile = '/tmp/sap_excel_data.json';
    fs.writeFileSync(tmpFile, jsonPayload);

    // 调用 Python 生成 Excel（使用独立脚本，更稳定）
    var clientName = scanAll ? '全组织' : (vkorgCode ? '销售组织_' + vkorgCode : '客户_' + clientCode);
    var excelDir = process.env.SAP_BILLING_WORKSPACE || (process.env.HOME || '/tmp') + '/.openclaw/workspace';
    var excelFile = excelDir + '/' + clientName + '_' + wadatFrom + '_' + wadatTo + '_发货数据统计.xlsx';
    var pythonScript = __dirname + '/excel-report.py';

    var execSync = require('child_process').execSync;
    try {
      var result = execSync('python3 ' + pythonScript + ' ' + tmpFile + ' ' + excelFile, { timeout: 30000, encoding: 'utf-8' });
      console.log(result.trim());
    } catch (e) {
      // Fallback: 尝试舊版内联脚本
      try {
        var inlinePy = genInlinePython(excelFile, tmpFile);
        var inlineScript = '/tmp/gen_excel_inline.py';
        fs.writeFileSync(inlineScript, inlinePy);
        var result2 = execSync('python3 ' + inlineScript, { timeout: 30000, encoding: 'utf-8' });
        console.log(result2.trim());
      } catch (e2) {
        console.log('[ERROR] Excel generation failed (external & fallback): ' + (e2.stderr || e2.message));
      }
    }
    return;
  }

  // ── 格式化输出 ─────────────────────────────────────────────────────────
  console.log('');
  console.log(repeat('=', 100));
  console.log('\u269c\ufe0f ' + (vkorgCode ? '销售组织 ' + vkorgCode : '客户 ' + clientCode) + ' 发货数据查询结果');
  console.log('   期间: ' + wadatFrom + ' ~ ' + wadatTo);
  console.log(repeat('=', 100));

  if (onlyUnbilled) {
    var unbilled = results.filter(function(r) { return r.FKSTA === 'A'; });
    if (unbilled.length === 0) {
      console.log('\n\u2705 所有交货单均已开票，无未开票项目。');
      return;
    }
    console.log('\n\u26a0\ufe0f 未开票项目 (' + unbilled.length + ' 行):');
    for (var ui = 0; ui < Math.min(unbilled.length, maxRows); ui++) {
      var r = unbilled[ui];
      console.log('  \U0001f4e6 ' + r.VBELN_JS + ' | ' + (r.VKORG||'') + ' | 行 ' + r.POSNR_JS + ' | ' + r.MATNR + ' | ' + (r.MAKTX || '(无描述)') + ' | ' + r.LFIMG + ' ' + r.VRKME + ' | 可开票:' + r.ZKYSL + ' ' + r.VRKME + ' | ' + r.WADAT_IST);
    }
  } else {
    // 汇总输出（按交货单分组）
    var deliveryGroups = new Map();
    for (var gi = 0; gi < results.length; gi++) {
      var r = results[gi];
      if (!deliveryGroups.has(r.VBELN_JS)) {
        deliveryGroups.set(r.VBELN_JS, { items: [] });
      }
      deliveryGroups.get(r.VBELN_JS).items.push(r);
    }

    console.log('\n总交货单 ' + vbelns.length + ' 张 | 总行项目 ' + results.length + ' 行');
    console.log('已开票 ' + billedCount + ' | 部分开票 ' + partialCount + ' | 未开票 ' + unbilledCount);
    console.log('查询耗时 ' + totalTime + 'ms\n');

    console.log('#  | 交货单          | 销组 | 类型   | 行数 | 数量            | 日期       | 开票状态');
    console.log('---+-' + repeat('\u2500', 16) + '-+-' + repeat('\u2500', 4) + '-+-' + repeat('\u2500', 6) + '-+-' + repeat('\u2500', 4) + '-+-' + repeat('\u2500', 14) + '-+-' + repeat('\u2500', 10) + '-+-' + repeat('\u2500', 10));
    var idx = 0;
    var sortedKeys = [...deliveryGroups.keys()].sort();
    for (var k = 0; k < sortedKeys.length; k++) {
      var vbeln = sortedKeys[k];
      var grp = deliveryGroups.get(vbeln);
      idx++;
      var nItems = grp.items.length;
      var dTotal = 0;
      for (var qi = 0; qi < grp.items.length; qi++) dTotal += grp.items[qi].LFIMG;
      // 总体开票状态取 LIKP.FKSTK（表头级）
      var hdrFkstk = grp.items[0].FKSTK || '';
      var status = '';
      if (NON_BILLING_LFART.has(grp.items[0].LFART) && hdrFkstk === '' && grp.items[0].FKSTA === '') status = '➖ 不适用';
      else if (hdrFkstk === '' || hdrFkstk === 'A') status = '❌ 未开票';
      else if (hdrFkstk === 'B') status = '⚠️ 部分开票';
      else if (hdrFkstk === 'C') status = '✅ 已开票';
      else status = '➖ ' + hdrFkstk;
      var wadat = grp.items[0].WADAT_IST || '(未过账)';
      var lfart = grp.items[0].LFART || '?';
      console.log(String(idx).padStart(2) + ' | ' + vbeln.padEnd(16) + ' | ' + (grp.items[0].VKORG||'').padEnd(4) + ' | ' + lfart.padEnd(6) + ' | ' + String(nItems).padEnd(4) + ' | ' + String(dTotal).padEnd(14) + ' | ' + wadat.padEnd(10) + ' | ' + status);
    }

    // 明细输出
    if (filters.mode === 'detail') {
      console.log('\n--- 明细 (前 ' + Math.min(maxRows, results.length) + ' 行) ---');
      console.log('#  | 交货单          | 行      | 销组 | 物料               | 描述                          | 数量    | 单位 | 已开票  | 可开票  | 日期       | 开票状态');
      console.log('---+-' + repeat('\u2500', 16) + '-+-' + repeat('\u2500', 7) + '-+-' + repeat('\u2500', 4) + '-+-' + repeat('\u2500', 18) + '-+-' + repeat('\u2500', 28) + '-+-' + repeat('\u2500', 8) + '-+-' + repeat('\u2500', 4) + '-+-' + repeat('\u2500', 8) + '-+-' + repeat('\u2500', 8) + '-+-' + repeat('\u2500', 10) + '-+-' + repeat('\u2500', 10));
      for (var di = 0; di < Math.min(results.length, maxRows); di++) {
        var r = results[di];
        var st = fkstaLabel(realStatus(r), r.LFART);
        console.log(String(di+1).padStart(2) + ' | ' + r.VBELN_JS.padEnd(16) + ' | ' + r.POSNR_JS.padEnd(7) + ' | ' + (r.VKORG||'').padEnd(4) + ' | ' + r.MATNR.padEnd(18) + ' | ' + (r.MAKTX || '').padEnd(28) + ' | ' + String(r.LFIMG).padEnd(8) + ' | ' + (r.VRKME||'').padEnd(4) + ' | ' + String(r.FKIMG_JS).padEnd(8) + ' | ' + String(r.ZKYSL).padEnd(8) + ' | ' + r.WADAT_IST.padEnd(10) + ' | ' + st);
      }
      if (results.length > maxRows) {
        console.log('\n... 还有 ' + (results.length - maxRows) + ' 行 (使用 --rows N 查看全部)');
      }
    }
  }

  console.log('\n' + repeat('=', 100));
  console.log('\u26a1 查询完成 | 耗时 ' + totalTime + 'ms');
}

function repeat(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}

main().catch(function(e) {
  console.error('[ERROR]', e.message);
  process.exit(1);
});
