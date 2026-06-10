#!/usr/bin/env node
/**
 * 对账开票 - Excel 导出脚本
 * 从 fetch-unbilled-adt.js 的 --json 输出生成 Excel 文件
 *
 * 用法:
 *   node scripts/fetch-unbilled-adt.js --json [...] | node scripts/export-excel.js [output.xlsx]
 *   node scripts/export-excel.js < input.json [output.xlsx]
 */

const fs = require('node:fs');
const XLSX = require('xlsx');

const outputPath = process.argv[2] || 'unbilled_items.xlsx';

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let rows;
  try {
    rows = JSON.parse(raw.trim());
    if (!Array.isArray(rows)) rows = [rows];
  } catch (e) {
    console.error('[ERROR] Invalid JSON input:', e.message);
    console.error('Usage: node scripts/fetch-unbilled-adt.js --json [...] | node scripts/export-excel.js [output.xlsx]');
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log('[INFO] No data to export.');
    return;
  }

  // Sanitize values to prevent Excel formula injection
  function sanitizeExcelValue(val) {
    if (typeof val !== 'string') return val;
    if (/^[=+\-@\t\r]/.test(val)) {
      return "'" + val;
    }
    return val;
  }

  // Add SEL column for user to mark selections
  const sheetData = rows.map((r, idx) => ({
    '选择 (X)': '',
    '序号': idx + 1,
    '单据号': sanitizeExcelValue(r.VBELN_JS || ''),
    '行项目': sanitizeExcelValue(r.POSNR_JS || ''),
    '单据类别': sanitizeExcelValue(r.VBTYP || ''),
    '销售组织': sanitizeExcelValue(r.VKORG || ''),
    '客户': sanitizeExcelValue(r.KUNNR || ''),
    '物料': sanitizeExcelValue(r.MATNR || ''),
    '物料描述': sanitizeExcelValue(r.MAKTX || ''),
    '交货数量': r.LFIMG || 0,
    '单位': sanitizeExcelValue(r.VRKME || ''),
    '已开票数量': r.FKIMG_JS || 0,
    '可开票数量': r.ZKYSL || 0,
    '本次开票数量': r.ZKYSL || 0,
    '货币': sanitizeExcelValue(r.WAERK || ''),
    '过账日期': sanitizeExcelValue(r.WADAT_IST || ''),
  }));

  const ws = XLSX.utils.json_to_sheet(sheetData);

  // Set column widths
  const colWidths = [
    { wch: 10 }, // SEL
    { wch: 6 },  // 序号
    { wch: 12 }, // 单据号
    { wch: 8 },  // 行项目
    { wch: 10 }, // 单据类别
    { wch: 10 }, // 销售组织
    { wch: 12 }, // 客户
    { wch: 12 }, // 物料
    { wch: 20 }, // 物料描述
    { wch: 12 }, // 交货数量
    { wch: 6 },  // 单位
    { wch: 12 }, // 已开票数量
    { wch: 12 }, // 可开票数量
    { wch: 14 }, // 本次开票数量
    { wch: 6 },  // 货币
    { wch: 12 }, // 过账日期
  ];
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '未开票数据');
  XLSX.writeFile(wb, outputPath);

  console.log(`[OK] Excel exported: ${outputPath} (${rows.length} rows)`);
});
