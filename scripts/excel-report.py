#!/usr/bin/env python3
"""
Excel 报表生成器（独立模块）
被 fetch-delivery-data.js --excel 调用

用法: python3 excel-report.py <json_data_file> <excel_output_path>
"""
import json, sys, os
from collections import defaultdict
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ── 样式常量 ──────────────────────────────────────────────────────────────────
HDR_FONT = Font(bold=True, color='FFFFFF', size=11)
HDR_FILL = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')
HDR_ALIGN = Alignment(horizontal='center', vertical='center', wrap_text=True)
CELL_ALIGN = Alignment(vertical='center')
BORDER = Border(
    left=Side(style='thin'), right=Side(style='thin'),
    top=Side(style='thin'), bottom=Side(style='thin')
)
NUM_ALL = '#,##0'
NUM_DEC = '#,##0.000'

def write_header(ws, cols):
    """写入表头行"""
    for c, n in enumerate(cols, 1):
        cl = ws.cell(row=1, column=c, value=n)
        cl.font = HDR_FONT; cl.fill = HDR_FILL
        cl.alignment = HDR_ALIGN; cl.border = BORDER

def style_cell(cell, num_fmt=None):
    """应用基础样式"""
    cell.alignment = CELL_ALIGN; cell.border = BORDER
    if num_fmt: cell.number_format = num_fmt

def auto_width(ws, max_w=45, min_w=8):
    """自适应列宽"""
    for col_cells in ws.columns:
        header = col_cells[0]
        ln = max(min_w, min(max_w, max(
            (len(str(c.value or '')) + 2) for c in col_cells if c.value
        )))
        ws.column_dimensions[get_column_letter(header.column)].width = ln

def generate(data_path, out_path):
    with open(data_path) as f:
        data = json.load(f)
    items = data.get('items', [])
    meta = data.get('meta', {})

    wb = Workbook()

    # ── Sheet 1: 发货汇总 ──────────────────────────────────────────────
    ws1 = wb.active; ws1.title = '发货汇总'
    write_header(ws1, ['#','交货单','类型','销售组织','行数','总数量','单位','过账日期','开票状态'])
    
    grps = defaultdict(list)
    for it in items:
        grps[it.get('VBELN_JS') or it.get('VBELN')].append(it)
    
    for i, vb in enumerate(sorted(grps), 1):
        g = grps[vb]; r = g[0]
        n = len(g)
        q = sum(x.get('LFIMG', 0) for x in g)
        # 总体开票状态取 LIKP.FKSTK（表头级）
        fkstk = r.get('FKSTK', '')
        fkstk_label = {'': '❌ 未开票', 'A': '❌ 未开票', 'B': '⚠️ 部分开票', 'C': '✅ 已开票'}
        st = fkstk_label.get(fkstk, '❌ 未开票')
        if meta.get('unbilled') == len(items): st = '❌ 未开票'
        # 与开票无关的类型
        lfarts = set(it.get('LFART','') for it in items)
        if lfarts & {'ZLR7'} and fkstk == '':
            st = '➖ 不适用'
        row = [i, vb, r.get('LFART',''), r.get('VKORG',''),
               n, q, g[0].get('VRKME',''), r.get('WADAT_IST',''), st]
        for c, v in enumerate(row, 1):
            cl = ws1.cell(row=i+1, column=c, value=v)
            style_cell(cl, NUM_ALL if c == 6 else None)
    auto_width(ws1)

    # ── Sheet 2: 发货明细 ──────────────────────────────────────────────
    ws2 = wb.create_sheet('发货明细')
    write_header(ws2, ['#','交货单','行项目','类型','物料号','物料描述',
                       '发货数量','单位','已开票数量','可开票数量','过账日期','行状态(FKSTA)','总体状态(FKSTK)'])
    for i, it in enumerate(items, 1):
        fk = it.get('FKSTA','')
        fkstk = it.get('FKSTK','')
        # 与开票无关的交货类型（库存转储等）
        lfart = it.get('LFART','')
        non_billing_types = {'ZLR7'}
        if lfart in non_billing_types and not fk:
            st_item = '➖ 不适用'
            st_hdr = '➖ 不适用'
        else:
            st_item = '❌ 未开票' if fk=='A' else ('⚠️ 部分开票' if fk=='B' else ('✅ 已开票' if fk=='C' else '➖ 未确定'))
            st_hdr = {'': '❌ 未开票', 'A': '❌ 未开票', 'B': '⚠️ 部分开票', 'C': '✅ 已开票'}.get(fkstk, '➖ '+fkstk)
        row = [i,
               it.get('VBELN_JS') or it.get('VBELN'),
               it.get('POSNR_JS') or it.get('POSNR'),
               it.get('LFART',''),
               it.get('MATNR',''),
               it.get('MAKTX','') or it.get('ARKTX',''),
               it.get('LFIMG',0),
               it.get('VRKME',''),
               it.get('FKIMG_JS',0),
               it.get('ZKYSL',0),
               it.get('WADAT_IST',''),
               st_item,
               st_hdr]
        for c, v in enumerate(row, 1):
            cl = ws2.cell(row=i+1, column=c, value=v)
            style_cell(cl, NUM_ALL if c in (7,9,10) else None)
    auto_width(ws2)

    # ── Sheet 3: 未开票明细 ────────────────────────────────────────────
    ws3 = wb.create_sheet('未开票明细')
    write_header(ws3, ['#','交货单','行项目','类型','物料号','物料描述',
                       '发货数量','单位','已开票数量','可开票数量','过账日期'])
    ub = [it for it in items if it.get('FKSTA') == 'A' and it.get('LFART','') not in ('ZLR7',)]
    for i, it in enumerate(ub, 1):
        row = [i,
               it.get('VBELN_JS') or it.get('VBELN'),
               it.get('POSNR_JS') or it.get('POSNR'),
               it.get('LFART',''),
               it.get('MATNR',''),
               it.get('MAKTX','') or it.get('ARKTX',''),
               it.get('LFIMG',0),
               it.get('VRKME',''),
               it.get('FKIMG_JS',0),
               it.get('ZKYSL',0),
               it.get('WADAT_IST','')]
        for c, v in enumerate(row, 1):
            cl = ws3.cell(row=i+1, column=c, value=v)
            style_cell(cl, NUM_ALL if c in (7,9,10) else None)
    if not ub:
        ws3.cell(row=2, column=1, value='全部已开票，无未开票记录').font = Font(bold=True)
    auto_width(ws3)

    # ── Sheet 4: 按客户汇总 ────────────────────────────────────────────
    ws4 = wb.create_sheet('按客户汇总')
    write_header(ws4, ['客户编码','客户名称','未开票单数','未开票行数',
                       '合计数量','单位','主要币种'])
    # 从数据推断客户：需要客户名映射，暂时展示客户编码
    cust_data = defaultdict(lambda: {'docs': set(), 'items': 0, 'qty': 0, 'unit': '', 'curr': ''})
    for it in items:
        knr = it.get('KUNNR','')
        cust_data[knr]['docs'].add(it.get('VBELN_JS') or it.get('VBELN'))
        cust_data[knr]['items'] += 1
        cust_data[knr]['qty'] += it.get('LFIMG', 0)
        if not cust_data[knr]['unit']: cust_data[knr]['unit'] = it.get('VRKME','')
        if not cust_data[knr]['curr']: cust_data[knr]['curr'] = it.get('WAERK','')
    for i, (knr, cd) in enumerate(sorted(cust_data.items()), 1):
        row = [knr, '', len(cd['docs']), cd['items'],
               cd['qty'], cd['unit'], cd['curr']]
        for c, v in enumerate(row, 1):
            cl = ws4.cell(row=i+1, column=c, value=v)
            style_cell(cl, NUM_ALL if c == 5 else None)
    auto_width(ws4)

    # ── Sheet 5: 按物料统计 ────────────────────────────────────────────
    ws5 = wb.create_sheet('按物料统计')
    bm = defaultdict(lambda: {'desc':'','total':0,'unit':'','cnt':0,'months':defaultdict(float)})
    for it in items:
        m = it.get('MATNR','')
        mm = (it.get('WADAT_IST') or '')[:7]
        bm[m]['desc'] = it.get('MAKTX','') or it.get('ARKTX','')
        bm[m]['total'] += it.get('LFIMG',0)
        bm[m]['unit'] = it.get('VRKME','')
        bm[m]['cnt'] += 1
        bm[m]['months'][mm] += it.get('LFIMG',0)
    
    mons = sorted(set(mm for x in bm.values() for mm in x['months']))
    h5 = ['#','物料号','物料描述','单位','交货次数'] + mons + ['总计']
    write_header(ws5, h5)
    sm = sorted(bm.items(), key=lambda x: -x[1]['total'])
    for i, (m, info) in enumerate(sm, 1):
        row = [i, m, info['desc'], info['unit'], info['cnt']]
        for mm in mons:
            v = info['months'].get(mm, '')
            row.append(v)
        row.append(info['total'])
        for c, v in enumerate(row, 1):
            cl = ws5.cell(row=i+1, column=c, value=v)
            # 数量列设为数字格式
            fmt = NUM_ALL if (c >= 5 and isinstance(v, (int, float))) else None
            style_cell(cl, fmt)
    auto_width(ws5)

    # ── Sheet 6: 月度汇总 ──────────────────────────────────────────────
    ws6 = wb.create_sheet('月度汇总')
    write_header(ws6, ['月份','总数量','物料种类','交货单数'])
    bm2 = defaultdict(lambda: {'q':0, 'm':set(), 'd':set()})
    for it in items:
        mm = (it.get('WADAT_IST') or '')[:7]
        bm2[mm]['q'] += it.get('LFIMG',0)
        bm2[mm]['m'].add(it.get('MATNR',''))
        bm2[mm]['d'].add(it.get('VBELN_JS') or it.get('VBELN'))
    for i, mm in enumerate(sorted(bm2), 1):
        info = bm2[mm]
        row = [mm, round(info['q'], 3), len(info['m']), len(info['d'])]
        for c, v in enumerate(row, 1):
            cl = ws6.cell(row=i+1, column=c, value=v)
            style_cell(cl, NUM_DEC if c == 2 else None)
    auto_width(ws6)

    # ── 保存 ──────────────────────────────────────────────────────────
    wb.save(out_path)
    return out_path

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: python3 excel-report.py <data.json> <output.xlsx>', file=sys.stderr)
        sys.exit(1)
    out = generate(sys.argv[1], sys.argv[2])
    print(f'EXCEL_OK:{out}')
