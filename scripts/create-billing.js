#!/usr/bin/env node
/**
 * 对账开票/冲销 - BAPI 脚本
 * 通过 node-rfc 调用 BAPI_BILLINGDOC_CREATEMULTIPLE 执行 VF01 开票
 * 或 BAPI_BILLINGDOC_CANCEL1 执行 VF11 冲销
 *
 * ⚡ 每次成功开票自动记录到日志（含开票凭证号、物料、数量、日期）
 *    日志位置: 可通过环境变量 BILLING_LOG_PATH 指定，默认 ~/.openclaw/billing-log.jsonl
 *
 * 用法:
 *   开票: node scripts/create-billing.js [options] <json_array>
 *   冲销: node scripts/create-billing.js --cancel <billing_doc> [--testrun] [--reason <text>]
 *
 *   开票选项:
 *     --testrun                 测试运行模式（不真正创建凭证）
 *     --billing-date <YYYY.MM.DD>  开票日期（默认今天）
 *     --show-log                显示开票日志
 *
 *   冲销选项:
 *     --cancel <billing_doc>    冲销指定开票凭证（VF11）
 *     --reason <text>           冲销原因（可选）
 *
 * JSON 格式（开票，从 stdin 或最后一个参数传入）：
 * [
 *   { "VBELN_JS": "80000001", "POSNR_JS": "000010", "ZKYSL": 100, "VRKME": "EA", "WAERK": "CNY" }
 * ]
 */

const fs = require('node:fs');
const path = require('node:path');

// ── Ensure NW-RFC-SDK is discoverable ───────────────────────────────────────
const sdkHome = path.resolve(__dirname, '..', 'NW-RFC-SDK', 'nwrfcsdk');
process.env.SAPNWRFC_HOME = sdkHome;
const sdkLib = path.join(sdkHome, 'lib');
if (!(process.env.PATH || '').includes(sdkLib)) {
  process.env.PATH = sdkLib + path.delimiter + (process.env.PATH || '');
}

const noderfc = require('node-rfc');

// ── Load .env ───────────────────────────────────────────────────────────────
const envPath = path.resolve(__dirname, '..', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} else {
  console.error('[FATAL] .env not found at', envPath);
  process.exit(1);
}

// ── Build RFC connection params ─────────────────────────────────────────────
const url = env.SAP_URL || '';
const urlMatch = url.match(/^(?:https?:\/\/)?([^:\/]+)(?::(\d+))?/);
const ashost = urlMatch ? urlMatch[1] : '';
const port = urlMatch ? parseInt(urlMatch[2] || '8000', 10) : 8000;

let sysnr = env.SAP_SYSNR;
if (!sysnr) {
  sysnr = String(port).slice(-2);
  console.warn(`[WARN] SAP_SYSNR not set, fallback to port derivation: ${sysnr}`);
}

const rfcParams = {
  ashost,
  sysnr,
  client: env.SAP_CLIENT || '200',
  user: env.SAP_USERNAME || env.SAP_USER || '',
  passwd: env.SAP_PASSWORD || env.SAP_PASS || '',
  lang: env.SAP_LANGUAGE || 'ZH',
};
if (env.SAP_ROUTER) rfcParams.saprouter = env.SAP_ROUTER;

// ── Billing Log ─────────────────────────────────────────────────────────────
const BILLING_LOG = process.env.BILLING_LOG_PATH || path.resolve(process.env.HOME || '/tmp', '.openclaw', 'billing-log.jsonl');

function ensureLogDir() {
  const dir = path.dirname(BILLING_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendBillingLog(entry) {
  try {
    ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(BILLING_LOG, line, 'utf-8');
  } catch (e) {
    console.warn('[WARN] Failed to write billing log:', e.message);
  }
}

function showBillingLog() {
  try {
    if (!fs.existsSync(BILLING_LOG)) {
      console.log('[LOG] 暂无开票记录。');
      return;
    }
    const data = fs.readFileSync(BILLING_LOG, 'utf-8').trim();
    if (!data) {
      console.log('[LOG] 暂无开票记录。');
      return;
    }
    const lines = data.split('\n').filter(Boolean).map(l => JSON.parse(l));
    // 最新在前
    lines.reverse();
    console.log('\n' + '='.repeat(100));
    console.log('⚜️ 开票历史记录');
    console.log('='.repeat(100));
    console.log('#  | 开票日期    | 开票凭证     | 交货单           | 物料编号             | 物料描述                          | 数量     | 单位 | 净额         | 税额     | 含税         | 币别 | 客户             | 状态');
    console.log('-'.repeat(175));
    for (let i = 0; i < lines.length; i++) {
      const r = lines[i];
      const date = r.billingDate || r.timestamp?.slice(0, 10) || '?';
      const doc = r.billingDoc || '-';
      const vbeln = r.vbeln || '-';
      const matnr = r.matnr || '-';
      const maktx = (r.maktx || '').slice(0, 30);
      const qty = r.qty || 0;
      const unit = r.unit || '';
      const netwr = r.netwr || r.amount || 0;
      const tax = r.tax || 0;
      const gross = r.gross || netwr;
      const curr = r.waerk || '';
      const client = r.client || '-';
      const status = r.success ? '✅' : '❌';
      console.log(`${String(i+1).padStart(2)} | ${date.padEnd(12)} | ${String(doc).padEnd(14)} | ${String(vbeln).padEnd(16)} | ${String(matnr).padEnd(22)} | ${maktx.padEnd(30)} | ${String(qty).padEnd(7)} | ${(unit||'').padEnd(4)} | ${String(netwr).padEnd(10)} | ${String(tax).padEnd(8)} | ${String(gross).padEnd(10)} | ${curr.padEnd(4)} | ${client.padEnd(16)} | ${status}`);
    }
    console.log('-'.repeat(175));
    console.log(`共 ${lines.length} 条记录`);
  } catch (e) {
    console.error('[ERROR] Reading billing log:', e.message);
  }
}

// ── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let testrun = false;
let showLog = false;
let cancelMode = false;
let cancelDoc = '';
let cancelReason = '';
let billingDate = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
let jsonInput = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--testrun') { testrun = true; continue; }
  if (arg === '--show-log') { showLog = true; continue; }
  if (arg === '--billing-date') { billingDate = args[++i]; continue; }
  if (arg === '--cancel') { cancelMode = true; cancelDoc = args[++i] || ''; continue; }
  if (arg === '--reason') { cancelReason = args[++i] || ''; continue; }
  if (arg.startsWith('{') || arg.startsWith('[')) jsonInput = arg;
}

// ── Handle --show-log ───────────────────────────────────────────────────────
if (showLog) {
  showBillingLog();
  process.exit(0);
}

// ── Handle --cancel (VF11) ──────────────────────────────────────────────────
if (cancelMode) {
  if (!cancelDoc) {
    console.error('[ERROR] 请指定要冲销的开票凭证号: --cancel <billing_doc>');
    process.exit(1);
  }
  runCancel(cancelDoc, testrun, cancelReason).catch(e => {
    const msg = (e && typeof e.message === 'string') ? e.message : String(e);
    console.error('[ERROR]', msg);
    process.exit(1);
  });
} else {
  if (jsonInput) {
    main().catch(e => {
      const msg = (e && typeof e.message === 'string') ? e.message : String(e);
      console.error('[ERROR]', msg);
      process.exit(1);
    });
  } else {
    let stdinData = '';
    let stdinTimer = null;
    const startMain = () => {
      if (stdinTimer) clearTimeout(stdinTimer);
      if (!jsonInput) jsonInput = stdinData.trim();
      main().catch(e => {
        const msg = (e && typeof e.message === 'string') ? e.message : String(e);
        console.error('[ERROR]', msg);
        process.exit(1);
      });
    };
    process.stdin.on('data', chunk => { stdinData += chunk; });
    process.stdin.on('end', startMain);
    // If stdin is a TTY or empty pipe, fall back after a short delay
    stdinTimer = setTimeout(() => {
      if (!jsonInput) startMain();
    }, 100);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!jsonInput) {
    console.error('[ERROR] No billing data provided. Pass JSON array as last argument or via stdin.');
    process.exit(1);
  }

  let lines;
  try {
    lines = JSON.parse(jsonInput);
    if (!Array.isArray(lines)) lines = [lines];
  } catch (e) {
    console.error('[ERROR] Invalid JSON:', e.message);
    process.exit(1);
  }

  if (lines.length === 0) {
    console.error('[ERROR] Empty billing data array');
    process.exit(1);
  }

  console.log(`[BAPI] Connecting to ${ashost} client=${rfcParams.client}...`);
  const client = new noderfc.Client(rfcParams);
  await client.open();
  console.log('[BAPI] Connected\n');

  try {
    // Build BAPI parameters
    const billingDataIn = lines.map((line, idx) => ({
      REF_DOC: line.VBELN_JS || '',
      REF_ITEM: line.POSNR_JS || '',
      REQ_QTY: parseFloat(line.ZKYSL || line.ZBCSL || 0),
      SALES_UNIT: line.VRKME || '',
      BILL_DATE: billingDate,
      REF_DOC_CA: line.VBTYP || '',
      SALESORG: line.VKORG || '',
      DISTR_CHAN: line.VTWEG || '',
      DIVISION: line.SPART || '',
      // Map line number for tracking
      ITM_NUMBER: String((idx + 1) * 10).padStart(6, '0'),
    }));

    const bapiParams = {
      TESTRUN: testrun ? 'X' : '',
      BILLINGDATAIN: billingDataIn,
    };

    console.log(`[BAPI] Calling BAPI_BILLINGDOC_CREATEMULTIPLE`);
    console.log(`       Lines: ${billingDataIn.length}`);
    console.log(`       Test run: ${testrun ? 'YES' : 'NO'}`);
    console.log(`       Billing date: ${billingDate}`);
    console.log('');

    for (const line of billingDataIn) {
      console.log(`  -> ${line.REF_DOC}-${line.REF_ITEM} | Qty: ${line.REQ_QTY} ${line.SALES_UNIT}`);
    }
    console.log('');

    const result = await client.call('BAPI_BILLINGDOC_CREATEMULTIPLE', bapiParams);

    // Parse return messages
    const returns = result.RETURN || [];
    const messages = Array.isArray(returns) ? returns : [returns];

    console.log('─'.repeat(60));
    console.log('BAPI RETURN MESSAGES');
    console.log('─'.repeat(60));

    const errors = [];
    const warnings = [];
    const successes = [];

    for (const msg of messages) {
      const type = msg.TYPE || '';
      const text = msg.MESSAGE || '';
      const id = msg.ID || '';
      const number = msg.NUMBER || '';
      const line = `[${type}] ${id}-${number}: ${text}`;
      console.log(line);

      if (type === 'E' || type === 'A') errors.push(msg);
      else if (type === 'W') warnings.push(msg);
      else if (type === 'S') successes.push(msg);
    }

    // Check for created billing docs
    const successData = result.SUCCESS || [];
    if (successData.length > 0) {
      console.log('\n' + '─'.repeat(60));
      console.log('CREATED BILLING DOCUMENTS');
      console.log('─'.repeat(60));
      for (const s of successData) {
        console.log(`  Billing Doc: ${s.BILL_DOC} / Item: ${s.BILL_DOC_ITEM}`);
      }
    }

    console.log('\n' + '─'.repeat(60));
    console.log(`Result: ${errors.length} errors, ${warnings.length} warnings, ${successes.length} successes`);
    console.log('─'.repeat(60));

    if (errors.length > 0) {
      // ⚡ 自动补全 VKORG/VTWEG/SPART：当 BAPI 报"无法确定开票类型"时，查 LIKP 补 VKORG/VBTYP，查 VBAK 补 VTWEG/SPART
      const needAutoComplete = errors.some(m => (m.MESSAGE || '').includes('无法确定开票类型'));

      if (needAutoComplete) {
        const missingSalesOrg = billingDataIn.some(b => !b.SALESORG);
        const needSalesRange = !missingSalesOrg && errors.some(m => (m.MESSAGE || '').includes('销售范围'));
        
        if (missingSalesOrg || needSalesRange || !billingDataIn[0].DISTR_CHAN) {
          console.log('\n[⚡自动补全] 检查开票参数...');
          
          for (let bi = 0; bi < billingDataIn.length; bi++) {
            const b = billingDataIn[bi];
            const refDoc = b.REF_DOC;
            
            let vkorg = b.SALESORG;
            let vbtyp = b.REF_DOC_CA;
            
            // 1. 查 LIKP 获取 VKORG/VBTYP
            if (!vkorg || !vbtyp) {
              try {
                const likpResult = await client.call('RFC_READ_TABLE', {
                  QUERY_TABLE: 'LIKP',
                  DELIMITER: '|',
                  FIELDS: [{FIELDNAME: 'VKORG'}, {FIELDNAME: 'VBTYP'}],
                  OPTIONS: [{TEXT: "VBELN = '" + refDoc + "'"}],
                  ROWSKIPS: 0, ROWCOUNT: 2,
                });
                const rows = likpResult.DATA || [];
                if (rows.length > 0) {
                  const parts = (rows[0].WA || '').split('|');
                  if (!vkorg) vkorg = parts[0] || '';
                  if (!vbtyp) vbtyp = (parts[1] || '').trim();
                }
              } catch (e) {
                console.log(`      [WARN] 查LIKP ${refDoc} 失败: ${e.message}`);
              }
            }
            
            b.SALESORG = vkorg;
            if (vbtyp) b.REF_DOC_CA = vbtyp;
            
            // 2. 查 LIPS -> VBAK 获取 VTWEG/SPART（通过关联订单）
            if (!b.DISTR_CHAN || !b.DIVISION) {
              try {
                // 先查 LIPS 获取关联订单
                const lipsResult = await client.call('RFC_READ_TABLE', {
                  QUERY_TABLE: 'LIPS',
                  DELIMITER: '|',
                  FIELDS: [{FIELDNAME: 'VGBEL'}],
                  OPTIONS: [{TEXT: "VBELN = '" + refDoc + "'"}],
                  ROWSKIPS: 0, ROWCOUNT: 2,
                });
                const lipsRows = lipsResult.DATA || [];
                if (lipsRows.length > 0) {
                  const orderNo = (lipsRows[0].WA || '').split('|')[0].trim();
                  if (orderNo) {
                    const vbResult = await client.call('RFC_READ_TABLE', {
                      QUERY_TABLE: 'VBAK',
                      DELIMITER: '|',
                      FIELDS: [{FIELDNAME: 'VTWEG'}, {FIELDNAME: 'SPART'}],
                      OPTIONS: [{TEXT: "VBELN = '" + orderNo + "'"}],
                      ROWSKIPS: 0, ROWCOUNT: 2,
                    });
                    const vbRows = vbResult.DATA || [];
                    if (vbRows.length > 0) {
                      const rangeParts = (vbRows[0].WA || '').split('|');
                      if (!b.DISTR_CHAN) b.DISTR_CHAN = rangeParts[0] || '';
                      if (!b.DIVISION) b.DIVISION = rangeParts[1] || '';
                    }
                  }
                }
              } catch (e) {
                console.log(`      [WARN] 查VBAK ${refDoc} 失败: ${e.message}`);
              }
            }
            
            console.log(`      ${refDoc} → VKORG=${b.SALESORG} VBTYP=${b.REF_DOC_CA} VTWEG=${b.DISTR_CHAN} SPART=${b.DIVISION}`);
          }

          // 更新原始 lines
          for (let li = 0; li < lines.length; li++) {
            if (!lines[li].VKORG) lines[li].VKORG = billingDataIn[li].SALESORG;
            if (!lines[li].VBTYP) lines[li].VBTYP = billingDataIn[li].REF_DOC_CA;
            if (!lines[li].VTWEG) lines[li].VTWEG = billingDataIn[li].DISTR_CHAN;
            if (!lines[li].SPART) lines[li].SPART = billingDataIn[li].DIVISION;
          }
        }

        console.log('[⚡自动补全] 重试 BAPI_BILLINGDOC_CREATEMULTIPLE...\n');
        for (const b of billingDataIn) {
          console.log(`  -> ${b.REF_DOC}-${b.REF_ITEM} | Qty: ${b.REQ_QTY} ${b.SALES_UNIT}`);
        }
        console.log('');

        const retryResult = await client.call('BAPI_BILLINGDOC_CREATEMULTIPLE', {
          TESTRUN: testrun ? 'X' : '',
          BILLINGDATAIN: billingDataIn,
        });

        const retryReturns = retryResult.RETURN || [];
        const retryMessages = Array.isArray(retryReturns) ? retryReturns : [retryReturns];
        const retryErrors = retryMessages.filter(m => m.TYPE === 'E' || m.TYPE === 'A');
        const retryWarnings = retryMessages.filter(m => m.TYPE === 'W');
        const retrySuccess = retryResult.SUCCESS || [];

        console.log('─'.repeat(60));
        console.log('BAPI RETURN MESSAGES');
        console.log('─'.repeat(60));
        for (const m of retryMessages) {
          const type = m.TYPE || '';
          const text = m.MESSAGE || '';
          const id = m.ID || '';
          const number = m.NUMBER || '';
          console.log(`[${type}] ${id}-${number}: ${text}`);
        }

        if (retrySuccess.length > 0) {
          console.log('\n' + '─'.repeat(60));
          console.log('CREATED BILLING DOCUMENTS');
          console.log('─'.repeat(60));
          for (const s of retrySuccess) {
            console.log(`  Billing Doc: ${s.BILL_DOC} / Item: ${s.BILL_DOC_ITEM}`);
          }
        }

        console.log('\n' + '─'.repeat(60));
        console.log(`Result: ${retryErrors.length} errors, ${retryWarnings.length} warnings, ${retrySuccess.length} successes`);

        if (retryErrors.length > 0) {
          console.error('\n[ERROR] 自动补全后 BAPI 仍有错误。');
          process.exit(1);
        }

        // 覆盖原始 result 变量，让后续 COMMIT/日志流程使用重试结果
        result.RETURN = retryReturns;
        result.SUCCESS = retrySuccess;
        // 跳到 COMMIT/结果处理
      } else {
        console.error('\n[ERROR] BAPI returned errors. No billing document created.');
        process.exit(1);
      }
    }

    if (testrun) {
      console.log('\n[Test run completed successfully. No document was created.]');
    } else {
      // ⚠️ 必须调用 BAPI_TRANSACTION_COMMIT 才能实际写入数据库
      //    BAPI 调用只停留在 SAP 内存中，不 COMMIT 则连接断开后回滚
      console.log('\n[BAPI] Committing transaction...');
      try {
        const commitResult = await client.call('BAPI_TRANSACTION_COMMIT', { WAIT: 'X' });
        const commitReturn = (Array.isArray(commitResult.RETURN) ? commitResult.RETURN : [commitResult.RETURN]).filter(Boolean);
        if (commitReturn.length > 0) {
          const hasError = commitReturn.some(m => m.TYPE === 'E' || m.TYPE === 'A');
          if (hasError) {
            console.log('[WARN] COMMIT returned errors - document may not persist');
            for (const m of commitReturn) {
              console.log(`  [${m.TYPE}] ${m.MESSAGE || ''}`);
            }
          }
        }
        console.log('[BAPI] Transaction committed successfully.');
      } catch (commitError) {
        console.error('[ERROR] COMMIT failed:', commitError.message);
        process.exit(1);
      }

      // ⚡ 重新获取 successData（自动补全后可能已更新 result.SUCCESS）
      const finalSuccessData = result.SUCCESS || [];
      if (finalSuccessData.length === 0) {
        console.error('[ERROR] No success data after BAPI call.');
        process.exit(1);
      }

      // ⚡ 开票成功后，查 VBRP 获取各行项金额、税额和币别
      const amountMap = new Map(); // "doc-item" -> { netwr, mwsbp, waerk }
      let globalWaerk = '';
      const uniqueDocs = [...new Set(finalSuccessData.map(s => s.BILL_DOC).filter(Boolean))];
      console.log(`\n[BAPI] 查 VBRP 获取开票金额 (${uniqueDocs.length} 张凭证)...`);
      for (const doc of uniqueDocs) {
        try {
          // 先查 VBRK 拿总额、税额、币别
          const vbrkResult = await client.call('RFC_READ_TABLE', {
            QUERY_TABLE: 'VBRK',
            DELIMITER: '|',
            FIELDS: [{FIELDNAME: 'VBELN'}, {FIELDNAME: 'NETWR'}, {FIELDNAME: 'MWSBK'}, {FIELDNAME: 'WAERK'}],
            OPTIONS: [{TEXT: "VBELN = '" + doc + "'"}],
            ROWSKIPS: 0,
            ROWCOUNT: 2,
          });
          const vbrkRows = vbrkResult.DATA || [];
          let headerNet = 0, headerTax = 0;
          if (vbrkRows.length > 0) {
            const parts = (vbrkRows[0].WA || '').split('|');
            headerNet = parseFloat(parts[1] || 0);
            headerTax = parseFloat(parts[2] || 0);
            globalWaerk = (parts[3] || '').trim();
            console.log(`      ${doc}: 合计净额=${headerNet} 税额=${headerTax} 含税=${headerNet+headerTax} ${globalWaerk}`);
          }
          // 查 VBRP 拿各行 NETWR + MWSBP
          const vbrpResult = await client.call('RFC_READ_TABLE', {
            QUERY_TABLE: 'VBRP',
            DELIMITER: '|',
            FIELDS: [{FIELDNAME: 'VBELN'}, {FIELDNAME: 'POSNR'}, {FIELDNAME: 'NETWR'}, {FIELDNAME: 'MWSBP'}, {FIELDNAME: 'FKIMG'}],
            OPTIONS: [{TEXT: "VBELN = '" + doc + "'"}],
            ROWSKIPS: 0,
            ROWCOUNT: 100,
          });
          const vbrpRows = vbrpResult.DATA || [];
          console.log(`      ${doc}: ${vbrpRows.length} lines`);
          for (const row of vbrpRows) {
            const parts = (row.WA || '').split('|');
            const item = parts[1]?.trim() || '';
            const netwr = parseFloat(parts[2] || 0);
            const mwsbp = parseFloat(parts[3] || 0);
            const qty = parseFloat(parts[4] || 0);
            const gross = netwr + mwsbp;
            amountMap.set(doc + '-' + item, { netwr, mwsbp, waerk: globalWaerk, qty, gross });
            console.log(`        ${item} → 净额=${netwr} 税额=${mwsbp} 含税=${gross} ${globalWaerk} (${qty})`);
          }
        } catch (e) {
          console.log(`      [WARN] 查询 ${doc} 金额失败: ${e.message}`);
        }
      }

      // ⚡ 记录开票日志
      for (let li = 0; li < finalSuccessData.length; li++) {
        const s = finalSuccessData[li];
        const line = lines[li] || {};
        const itemKey = (s.BILL_DOC || '') + '-' + (s.BILL_DOC_ITEM || '').trim();
        const amt = amountMap.get(itemKey) || {};
        const netwr = amt.netwr || 0;
        const mwsbp = amt.mwsbp || 0;
        appendBillingLog({
          timestamp: new Date().toISOString(),
          billingDate: billingDate,
          billingDoc: s.BILL_DOC || '',
          billingItem: s.BILL_DOC_ITEM || '',
          vbeln: line.VBELN_JS || '',
          posnr: line.POSNR_JS || '',
          matnr: line.MATNR || line.MATNR_JS || '',
          maktx: line.MAKTX || '',
          qty: parseFloat(line.ZKYSL || line.ZBCSL || 0),
          unit: line.VRKME || '',
          netwr: netwr,
          tax: mwsbp,
          gross: netwr + mwsbp,
          waerk: amt.waerk || '',
          client: line.KUNNR || '',
          vkorg: line.VKORG || '',
          success: true,
        });
      }
      console.log('\n[Billing completed successfully.]');
      console.log('[LOG] 开票记录已保存到: ' + BILLING_LOG);
    }

  } finally {
    await client.close();
  }
}

// ── Cancel (VF11) ───────────────────────────────────────────────────────────
async function runCancel(billingDoc, isTestrun, reason) {
  console.log(`[VF11] 冲销开票凭证: ${billingDoc}`);
  console.log(`       Test run: ${isTestrun ? 'YES' : 'NO'}`);
  console.log(`       Reason: ${reason || '(默认)'}`);

  // 先查 VBRK 获取凭证信息
  const infoClient = new noderfc.Client(rfcParams);
  await infoClient.open();

  let vbrkInfo = null;
  let hasItemSplit = false;
  try {
    const vbrkResult = await infoClient.call('RFC_READ_TABLE', {
      QUERY_TABLE: 'VBRK',
      DELIMITER: '|',
      FIELDS: [
        {FIELDNAME: 'VBELN'},
        {FIELDNAME: 'FKART'},
        {FIELDNAME: 'FKDAT'},
        {FIELDNAME: 'NETWR'},
        {FIELDNAME: 'MWSBK'},
        {FIELDNAME: 'WAERK'},
        {FIELDNAME: 'KUNRG'},
        {FIELDNAME: 'FKSTO'},
        {FIELDNAME: 'SFAKN'},
      ],
      OPTIONS: [{TEXT: "VBELN = '" + billingDoc + "'"}],
      ROWSKIPS: 0,
      ROWCOUNT: 2,
    });
    const rows = vbrkResult.DATA || [];
    if (rows.length > 0) {
      const p = (rows[0].WA || '').split('|');
      vbrkInfo = {
        VBELN: p[0]?.trim() || billingDoc,
        FKART: (p[1] || '').trim(),
        FKDAT: (p[2] || '').trim(),
        NETWR: parseFloat(p[3] || 0),
        MWSBK: parseFloat(p[4] || 0),
        WAERK: (p[5] || '').trim(),
        KUNRG: (p[6] || '').trim(),
        FKSTO: (p[7] || '').trim(),
        SFAKN: (p[8] || '').trim(),
      };
      console.log(`       开票类型: ${vbrkInfo.FKART}`);
      console.log(`       开票日期: ${vbrkInfo.FKDAT}`);
      console.log(`       金额: ${vbrkInfo.NETWR} ${vbrkInfo.WAERK}`);
      console.log(`       客户: ${vbrkInfo.KUNRG}`);

      if (vbrkInfo.FKSTO === 'X') {
        console.error(`[ERROR] 凭证 ${billingDoc} 已经是冲销凭证，不可再次冲销。`);
        await infoClient.close();
        process.exit(1);
      }
      if (vbrkInfo.SFAKN) {
        console.error(`[ERROR] 凭证 ${billingDoc} 已被冲销（冲销凭证: ${vbrkInfo.SFAKN}），不可重复冲销。`);
        await infoClient.close();
        process.exit(1);
      }

      // 查 VBRP 看是否有多个行项目（用于信息展示）
      const vbrpResult = await infoClient.call('RFC_READ_TABLE', {
        QUERY_TABLE: 'VBRP',
        DELIMITER: '|',
        FIELDS: [{FIELDNAME: 'POSNR'}, {FIELDNAME: 'NETWR'}],
        OPTIONS: [{TEXT: "VBELN = '" + billingDoc + "'"}],
        ROWSKIPS: 0,
        ROWCOUNT: 100,
      });
      const vbrpRows = vbrpResult.DATA || [];
      if (vbrpRows.length > 1) {
        hasItemSplit = true;
        console.log(`       行项目数: ${vbrpRows.length}`);
        for (const row of vbrpRows) {
          const pp = (row.WA || '').split('|');
          console.log(`         - ${pp[0]?.trim()}: 净额 ${parseFloat(pp[1] || 0)}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[WARN] 查 VBRK 失败（不影响冲销）: ${e.message}`);
  }
  await infoClient.close();

  // ⚠️ 确认提示
  if (!isTestrun) {
    const netAmt = vbrkInfo ? `${vbrkInfo.NETWR} ${vbrkInfo.WAERK}` : '? ?';
    console.log('');
    console.log(`⚠️  即将正式冲销凭证 ${billingDoc}（金额: ${netAmt}）`);
    console.log(`   是否继续？(y/N): `);

    // Read YN from stdin
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question('', (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });
    if (answer !== 'y' && answer !== 'yes') {
      console.log('[VF11] 用户取消操作。');
      process.exit(0);
    }
  }

  // 执行冲销
  const client = new noderfc.Client(rfcParams);
  await client.open();

  try {
    console.log(`\n[BAPI] Calling BAPI_BILLINGDOC_CANCEL1...`);

    const cancelParams = {
      BILLINGDOCUMENT: billingDoc,
      TESTRUN: isTestrun ? 'X' : '',
    };

    // 可选原因字段（如果用 REASON_REV）
    if (reason) {
      cancelParams.REASON_REV = reason;
    }

    const result = await client.call('BAPI_BILLINGDOC_CANCEL1', cancelParams);

    // Parse return messages
    const returns = result.RETURN || [];
    const messages = Array.isArray(returns) ? returns : [returns];

    console.log('─'.repeat(60));
    console.log('BAPI RETURN MESSAGES (VF11)');
    console.log('─'.repeat(60));

    const errors = [];
    const warnings = [];
    const successes = [];

    for (const msg of messages) {
      const type = msg.TYPE || '';
      const text = msg.MESSAGE || '';
      const id = msg.ID || '';
      const number = msg.NUMBER || '';
      console.log(`[${type}] ${id}-${number}: ${text}`);

      if (type === 'E' || type === 'A') errors.push(msg);
      else if (type === 'W') warnings.push(msg);
      else if (type === 'S') successes.push(msg);
    }

    // 冲销产生的新凭证
    const cancelDocOut = result.CANCELLATION_DOC || '';
    if (cancelDocOut) {
      console.log(`\n  冲销产生的新凭证: ${cancelDocOut}`);
    }

    console.log('');
    console.log(`Result: ${errors.length} errors, ${warnings.length} warnings, ${successes.length} successes`);

    if (errors.length > 0) {
      console.error('\n[ERROR] BAPI_CANCEL1 返回错误。');
      process.exit(1);
    }

    if (isTestrun) {
      console.log('\n[VF11 Test run completed. No actual cancellation was performed.]');
    } else {
      // ⚠️ COMMIT
      console.log('\n[BAPI] Committing cancellation transaction...');
      try {
        const commitResult = await client.call('BAPI_TRANSACTION_COMMIT', { WAIT: 'X' });
        const commitReturn = (Array.isArray(commitResult.RETURN) ? commitResult.RETURN : [commitResult.RETURN]).filter(Boolean);
        if (commitReturn.length > 0) {
          const hasError = commitReturn.some(m => m.TYPE === 'E' || m.TYPE === 'A');
          if (hasError) {
            console.log('[WARN] COMMIT returned errors - cancellation may not persist');
            for (const m of commitReturn) {
              console.log(`  [${m.TYPE}] ${m.MESSAGE || ''}`);
            }
          }
        }
        console.log('[BAPI] Cancellation committed successfully.');
      } catch (commitError) {
        console.error('[ERROR] COMMIT failed:', commitError.message);
        process.exit(1);
      }

      // 记录冲销日志
      appendBillingLog({
        timestamp: new Date().toISOString(),
        billingDate: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
        billingDoc: billingDoc,
        cancelDoc: cancelDocOut || '',
        vbeln: '',
        posnr: '',
        matnr: '',
        maktx: '',
        qty: 0,
        unit: '',
        netwr: vbrkInfo ? vbrkInfo.NETWR : 0,
        tax: vbrkInfo ? vbrkInfo.MWSBK : 0,
        gross: vbrkInfo ? (vbrkInfo.NETWR + vbrkInfo.MWSBK) : 0,
        waerk: vbrkInfo ? vbrkInfo.WAERK : '',
        client: vbrkInfo ? vbrkInfo.KUNRG : '',
        vkorg: '',
        success: true,
        action: 'CANCEL',
        reason: reason || '',
      });

      console.log('');
      console.log('[VF11] 冲销完成 ✅');
      if (cancelDocOut) {
        console.log(`  原凭证 ${billingDoc} → 已冲销，生成冲销凭证 ${cancelDocOut}`);
      }
      console.log(`  记录已保存到: ${BILLING_LOG}`);
    }
  } finally {
    await client.close();
  }
}
