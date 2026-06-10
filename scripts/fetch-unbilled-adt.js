#!/usr/bin/env node
/**
 * 对账开票 - 未开票数据读取脚本 (ADT 版)
 * 通过 ADT Data Preview freestyle SQL 分批查询单表，本地 JOIN
 *
 * 用法: node scripts/fetch-unbilled-adt.js [options]
 *   --doctype     <delivery|order>  单据类型：交货单/贷项借项订单 (默认 delivery)
 *   --client      <kunnr>           按客户筛选
 *   --vkorg       <vkorg>           按销售组织筛选
 *   --type        <lfart|auart>     按交货类型/订单类型筛选
 *   --vbtyp       <vbtyp>           按单据类别筛选
 *   --wadat-from  <YYYYMMDD>        过账日期起
 *   --wadat-to    <YYYYMMDD>        过账日期止
 *   --vbeln-from  <vbeln>           单号起
 *   --vbeln-to    <vbeln>           单号止
 *   --s4                              S4 HANA 模式：启用状态字段过滤
 *   --rows        <N>               最大返回行数 (默认 100)
 */

const http = require('node:http');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 9876;

// ── ADT freestyle SQL query ─────────────────────────────────────────────────
function adtQuery(sql, rowNumber = 100) {
  return new Promise((resolve, reject) => {
    const postData = sql;
    const req = http.request({
      hostname: PROXY_HOST, port: PROXY_PORT,
      path: `/sap/bc/adt/datapreview/freestyle?rowNumber=${rowNumber}`,
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
          const msg = data.match(/<localizedMessage[^>]*>([^<]*)<\/localizedMessage>/)?.[1]
            || data.match(/<message[^>]*>([^<]*)<\/message>/)?.[1]
            || `HTTP ${res.statusCode}`;
          reject(new Error(msg));
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
  const dataRegex = /<dataPreview:data>(.*?)<\/dataPreview:data>/gs;

  let colMatch;
  while ((colMatch = colRegex.exec(xml)) !== null) {
    const block = colMatch[1];
    const name = nameRegex.exec(block)?.[1] || '';
    const values = [];
    let dm;
    while ((dm = dataRegex.exec(block)) !== null) values.push(dm[1]);
    columns.push({ name, values });
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

// ── Input sanitization ──────────────────────────────────────────────────────
function sanitizeSapValue(value, maxLen = 40) {
  if (typeof value !== 'string') return '';
  // Allow alphanumeric and a few safe chars; strip everything else
  const cleaned = value.replace(/[^A-Za-z0-9_\-\.]/g, '').slice(0, maxLen);
  return cleaned;
}

function escapeSapString(value, maxLen = 40) {
  if (typeof value !== 'string') return '';
  // Escape single quotes for SAP SQL by doubling them
  return value.replace(/'/g, "''").slice(0, maxLen);
}

// ── WHERE helpers ───────────────────────────────────────────────────────────
function buildVbelnWhere(col, list) {
  if (list.length === 0) return '';
  const safeList = list.map(v => escapeSapString(String(v), 20));
  if (safeList.length <= 200) {
    return ' WHERE ' + col + ' IN (' + safeList.map(v => `'${v}'`).join(',') + ')';
  }
  const sorted = [...safeList].sort();
  return ` WHERE ${col} >= '${sorted[0]}' AND ${col} <= '${sorted[sorted.length - 1]}'`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const filters = {
    client: '', vkorg: '', type: '', vbtyp: '',
    'wadat-from': '', 'wadat-to': '',
    'vbeln-from': '', 'vbeln-to': '',
    rows: '100', doctype: 'delivery',
  };
  let isS4 = false;
  let jsonMode = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (key === 's4') { isS4 = true; continue; }
    if (key === 'json') { jsonMode = true; continue; }
    if (args[i + 1] !== undefined) filters[key] = args[i + 1];
  }
  const maxRows = parseInt(filters.rows, 10) || 100;
  const isOrder = filters.doctype === 'order';

  if (isS4) console.log('[MODE] S4 HANA: enabling status field filters');
  console.log(`[MODE] DocType: ${isOrder ? 'credit/debit orders (VBAK+VBAP)' : 'deliveries (LIKP+LIPS)'}`);

  console.log('\n[START] Fetching unbilled data via ADT freestyle SQL\n');
  const t0 = Date.now();

  let headers = [];
  let items = [];
  let vbelnList = [];

  if (isOrder) {
    // ── Orders: VBAK + VBAP ───────────────────────────────────────────────
    // Step 1: Query VBAK
    console.log('[1/4] Query VBAK (sales order headers)...');
    const vbakConds = [`VBTYP IN ('K','L')`];
    if (filters.client) vbakConds.push(`KUNNR = '${sanitizeSapValue(filters.client).padStart(10, '0')}'`);
    if (filters.vkorg) vbakConds.push(`VKORG = '${sanitizeSapValue(filters.vkorg, 4)}'`);
    if (filters.type) vbakConds.push(`AUART = '${sanitizeSapValue(filters.type, 4)}'`);
    if (filters.vbtyp) vbakConds.push(`VBTYP = '${sanitizeSapValue(filters.vbtyp, 1)}'`);
    if (filters['wadat-from']) vbakConds.push(`AUDAT >= '${sanitizeSapValue(filters['wadat-from'], 8)}'`);
    if (filters['wadat-to']) vbakConds.push(`AUDAT <= '${sanitizeSapValue(filters['wadat-to'], 8)}'`);
    if (filters['vbeln-from']) vbakConds.push(`VBELN >= '${sanitizeSapValue(filters['vbeln-from'], 10).padStart(10, '0')}'`);
    if (filters['vbeln-to']) vbakConds.push(`VBELN <= '${sanitizeSapValue(filters['vbeln-to'], 10).padStart(10, '0')}'`);
    const vbakSql = `SELECT VBELN, VBTYP, AUART, VKORG, KUNNR, WAERK FROM VBAK WHERE ${vbakConds.join(' AND ')}`;
    headers = await adtQuery(vbakSql, 0);
    console.log(`      -> ${headers.length} rows in ${Date.now() - t0}ms`);

    // Step 2: Query VBAP
    console.log('[2/4] Query VBAP (sales order items)...');
    const t1 = Date.now();
    vbelnList = headers.map(r => r.VBELN).filter(Boolean);
    const vbapConds = [];
    if (isS4) vbapConds.push(`FKSAA IN ('A','B')`);
    if (vbelnList.length > 0 && vbelnList.length <= 200) {
      vbapConds.push(`VBELN IN (${vbelnList.map(v => `'${v}'`).join(',')})`);
    } else if (vbelnList.length > 200) {
      const sorted = [...vbelnList].sort();
      vbapConds.push(`VBELN >= '${sorted[0]}' AND VBELN <= '${sorted[sorted.length - 1]}'`);
    }
    const vbapWhere = vbapConds.length ? ' WHERE ' + vbapConds.join(' AND ') : '';
    const vbapSql = `SELECT VBELN, POSNR, MATNR, ARKTX, KWMENG, VRKME FROM VBAP${vbapWhere}`;
    items = await adtQuery(vbapSql, 0);
    console.log(`      -> ${items.length} rows in ${Date.now() - t1}ms`);

  } else {
    // ── Deliveries: LIKP + LIPS ───────────────────────────────────────────
    // Step 1: Query LIKP
    console.log('[1/4] Query LIKP (delivery headers)...');
    const likpConds = [];
    if (isS4) likpConds.push(`WBSTK = 'C'`);
    if (filters.client) likpConds.push(`KUNNR = '${sanitizeSapValue(filters.client).padStart(10, '0')}'`);
    if (filters.vkorg) likpConds.push(`VKORG = '${sanitizeSapValue(filters.vkorg, 4)}'`);
    if (filters.type) likpConds.push(`LFART = '${sanitizeSapValue(filters.type, 4)}'`);
    if (filters.vbtyp) likpConds.push(`VBTYP = '${sanitizeSapValue(filters.vbtyp, 1)}'`);
    if (filters['wadat-from']) likpConds.push(`WADAT_IST >= '${sanitizeSapValue(filters['wadat-from'], 8)}'`);
    if (filters['wadat-to']) likpConds.push(`WADAT_IST <= '${sanitizeSapValue(filters['wadat-to'], 8)}'`);
    if (filters['vbeln-from']) likpConds.push(`VBELN >= '${sanitizeSapValue(filters['vbeln-from'], 10).padStart(10, '0')}'`);
    if (filters['vbeln-to']) likpConds.push(`VBELN <= '${sanitizeSapValue(filters['vbeln-to'], 10).padStart(10, '0')}'`);
    const likpWhere = likpConds.length ? ' WHERE ' + likpConds.join(' AND ') : '';
    const likpSql = `SELECT VBELN, VBTYP, LFART, VKORG, KUNNR, KUNAG, WADAT_IST, WAERK FROM LIKP${likpWhere}`;
    headers = await adtQuery(likpSql, 0);
    console.log(`      -> ${headers.length} rows in ${Date.now() - t0}ms`);

    // Step 2: Query LIPS
    console.log('[2/4] Query LIPS (delivery items)...');
    const t1 = Date.now();
    vbelnList = headers.map(r => r.VBELN).filter(Boolean);
    const lipsConds = [];
    if (isS4) lipsConds.push(`FKSTA IN ('A','B')`);
    if (vbelnList.length > 0 && vbelnList.length <= 200) {
      lipsConds.push(`VBELN IN (${vbelnList.map(v => `'${v}'`).join(',')})`);
    } else if (vbelnList.length > 200) {
      const sorted = [...vbelnList].sort();
      lipsConds.push(`VBELN >= '${sorted[0]}' AND VBELN <= '${sorted[sorted.length - 1]}'`);
    }
    const lipsWhere = lipsConds.length ? ' WHERE ' + lipsConds.join(' AND ') : '';
    const lipsSql = `SELECT VBELN, POSNR, MATNR, ARKTX, LFIMG, VRKME FROM LIPS${lipsWhere}`;
    items = await adtQuery(lipsSql, 0);
    console.log(`      -> ${items.length} rows in ${Date.now() - t1}ms`);
  }

  // Step 3: Query VBRP (billed references)
  console.log('[3/4] Query VBRP (billed references)...');
  const t2 = Date.now();
  const vbrpWhere = buildVbelnWhere('VGBEL', vbelnList);
  const vbrp = await adtQuery(`SELECT VGBEL, VGPOS, FKIMG FROM VBRP${vbrpWhere}`, 0);
  console.log(`      -> ${vbrp.length} rows in ${Date.now() - t2}ms`);

  // Step 4: Join and filter
  console.log('[4/4] Joining and filtering...');
  const t3 = Date.now();
  const billedMap = new Map();
  for (const r of vbrp) {
    const key = `${r.VGBEL}-${r.VGPOS}`;
    billedMap.set(key, (billedMap.get(key) || 0) + parseFloat(r.FKIMG || 0));
  }

  const headerMap = new Map();
  for (const r of headers) headerMap.set(r.VBELN, r);

  const results = [];
  const qtyField = isOrder ? 'KWMENG' : 'LFIMG';
  const typeField = isOrder ? 'AUART' : 'LFART';

  for (const item of items) {
    const header = headerMap.get(item.VBELN);
    if (!header) continue;
    const billedQty = billedMap.get(`${item.VBELN}-${item.POSNR}`) || 0;
    const deliverQty = parseFloat(item[qtyField] || 0);
    const unbilledQty = deliverQty - billedQty;
    // 过滤：未过账的交货单不可开票（WADAT_IST 为空或 00000000 表示未过账）
    const postingDate = header.WADAT_IST || header.AUDAT || '';
    const isPosted = postingDate && postingDate !== '00000000';
    // 过滤：仅保留可开票的单据类别（J=交货单, K=贷项凭单, L=借项凭单）
    // 排除 T（移库/转储）等不可开票的类别
    const billableTypes = ['J', 'K', 'L'];
    const isBillable = billableTypes.includes(header.VBTYP);
    if (unbilledQty > 0.001 && isPosted && isBillable) {
      results.push({
        VBELN_JS: item.VBELN, POSNR_JS: item.POSNR,
        VBTYP: header.VBTYP, LFART: header[typeField],
        VKORG: header.VKORG, KUNNR: header.KUNNR,
        MATNR: item.MATNR, MAKTX: item.ARKTX,
        LFIMG: deliverQty, VRKME: item.VRKME,
        FKIMG_JS: billedQty, ZKYSL: unbilledQty,
        WAERK: header.WAERK, WADAT_IST: postingDate,
      });
    }
  }
  console.log(`      -> ${results.length} unbilled lines in ${Date.now() - t3}ms`);
  console.log(`\n[TOTAL] ${Date.now() - t0}ms\n`);

  // Output
  if (results.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify([], null, 2));
    } else {
      console.log('No unbilled items found.');
    }
    return;
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const colMap = {
    'VBELN_JS': { name: '单据号', field: 'VBELN_JS' },
    'POSNR_JS': { name: '行项目', field: 'POSNR_JS' },
    'VBTYP': { name: '类别', field: 'VBTYP' },
    'VKORG': { name: '销售组织', field: 'VKORG' },
    'KUNNR': { name: '客户', field: 'KUNNR' },
    'MATNR': { name: '物料号', field: 'MATNR' },
    'MAKTX': { name: '物料描述', field: 'MAKTX' },
    'LFIMG': { name: '数量', field: 'LFIMG' },
    'FKIMG_JS': { name: '已开票', field: 'FKIMG_JS' },
    'ZKYSL': { name: '可开票', field: 'ZKYSL' },
    'WAERK': { name: '货币', field: 'WAERK' },
    'WADAT_IST': { name: '过账日期', field: 'WADAT_IST' },
  };
  const cols = Object.keys(colMap);
  const widths = {};
  for (const c of cols) {
    const headerLen = colMap[c].name.length;
    const dataLen = Math.max(...results.map(r => String(r[c] || '').length));
    widths[c] = Math.max(headerLen, dataLen);
  }
  console.log(cols.map(c => colMap[c].name.padEnd(widths[c])).join(' | '));
  console.log(cols.map(c => '-'.repeat(widths[c])).join('-+-'));
  for (const r of results.slice(0, maxRows)) {
    console.log(cols.map(c => String(r[c] || '').padEnd(widths[c])).join(' | '));
  }
  if (results.length > maxRows) {
    console.log(`\n... and ${results.length - maxRows} more rows (use --rows N to show more)`);
  }
}

main().catch(e => { console.error('[ERROR]', e.message); process.exit(1); });
