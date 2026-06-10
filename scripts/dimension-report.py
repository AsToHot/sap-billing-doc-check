#!/usr/bin/env python3
"""
发货多维统计报表 — 快速版
直接通过 ADT SQL JOIN 查询 SAP 数据，秒级生成多维度汇总 Excel

用法：
  python3 scripts/dimension-report.py
  python3 scripts/dimension-report.py --from 20251001 --to 20251231
  python3 scripts/dimension-report.py --from 20251001 --to 20251231 --output /path/to/report.xlsx
  python3 scripts/dimension-report.py --all (扫描全部销售组织)

参数：
  --from <YYYYMMDD>    起始日期 (默认: 3个月前)
  --to <YYYYMMDD>      截止日期 (默认: 今天)
  --output <path>      Excel 输出路径 (默认: workspace/日期范围_发货统计多维度.xlsx)
  --exclude <types>    排除的交货类型，逗号分隔 (默认: ZNL1,ZNL2,ZNL3,ZNL4)
  --rows <N>           ADT 查询行数 (默认: 2000)
"""
import sys, json, subprocess, re, time, os
from collections import defaultdict
from datetime import datetime, timedelta

ADT_URL = "http://127.0.0.1:9876/sap/bc/adt/datapreview/freestyle"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.environ.get('SAP_BILLING_WORKSPACE', os.path.expanduser('~/.openclaw/workspace'))

def adt_query(sql, rows=500, timeout=30):
    """执行 ADT SQL 查询"""
    r = subprocess.run(['curl', '-s', '-X', 'POST',
        ADT_URL + '?rowNumber=' + str(rows),
        '-H', 'Accept: application/vnd.sap.adt.datapreview.table.v1+xml',
        '-H', 'Content-Type: text/plain; charset=utf-8', '-d', sql],
        capture_output=True, text=True, timeout=timeout)
    xml = r.stdout
    if '<exc:exception' in xml:
        msg = re.search(r'<message[^>]*>([^<]*)</message>', xml)
        raise Exception(f"ADT error: {msg.group(1) if msg else 'Unknown'}")
    result = {}
    for section in xml.split('</dataPreview:columns>'):
        if '<dataPreview:metadata' not in section:
            continue
        name_m = re.search(r'name="([^"]+)"', section)
        if not name_m:
            continue
        values = re.findall(r'<dataPreview:data>([^<]*)</dataPreview:data>', section)
        result[name_m.group(1)] = values
    return result

def months_ago(n):
    d = datetime.now()
    m = d.month - n
    y = d.year
    while m <= 0:
        m += 12
        y -= 1
    return f"{y}{m:02d}01"

def today_str():
    return datetime.now().strftime('%Y%m%d')

def sanitize_date(s):
    """确保日期为8位数字"""
    s = re.sub(r'[^0-9]', '', str(s))
    if len(s) < 8:
        s = s + '01'
    return s[:8]

def parse_args():
    args = {
        'date_from': None,
        'date_to': None,
        'output': None,
        'exclude': ['ZNL1','ZNL2','ZNL3','ZNL4'],
        'rows': 2000,
    }
    i = 1
    while i < len(sys.argv):
        if sys.argv[i] == '--from' and i + 1 < len(sys.argv):
            args['date_from'] = sanitize_date(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == '--to' and i + 1 < len(sys.argv):
            args['date_to'] = sanitize_date(sys.argv[i + 1])
            i += 2
        elif sys.argv[i] == '--output' and i + 1 < len(sys.argv):
            args['output'] = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == '--exclude' and i + 1 < len(sys.argv):
            args['exclude'] = [t.strip().upper() for t in sys.argv[i + 1].split(',')]
            i += 2
        elif sys.argv[i] == '--rows' and i + 1 < len(sys.argv):
            args['rows'] = int(sys.argv[i + 1])
            i += 2
        else:
            i += 1
    # 默认日期
    if not args['date_from']:
        args['date_from'] = months_ago(3)
    if not args['date_to']:
        args['date_to'] = today_str()
    return args

def main():
    t0 = time.time()
    args = parse_args()
    
    date_from = args['date_from']
    date_to = args['date_to']
    exclude_types = args['exclude']
    max_rows = args['rows']
    output_path = args['output']
    
    # 构建排除条件
    exclude_cond = ''
    if exclude_types:
        like_conds = ' AND '.join(f"b~LFART NOT LIKE '{t[:4]}_'" for t in exclude_types)
        # Remove leading AND if needed
        if like_conds.startswith('AND '):
            like_conds = like_conds[4:]
        exclude_cond = f"  AND {like_conds}" if like_conds else ''
    
    print(f"[MODE] 日期范围: {date_from} ~ {date_to}")
    if exclude_types:
        print(f"       排除类型: {','.join(exclude_types)}")
    
    # Step 1: 主查询
    print("[1/3] 查询发货数据...")
    
    sql = f"""
SELECT 
  a~VBELN, a~POSNR, a~LFIMG, a~VRKME, a~MATNR, a~FKSTA,
  b~VKORG, b~KUNNR, b~KUNAG, b~LFART, b~WADAT_IST, b~WAERK, b~VBTYP,
  c~MATKL,
  d~MAKTX,
  e~NAME1 AS KUNNR_NAME
FROM LIPS AS a
  INNER JOIN LIKP AS b ON a~VBELN = b~VBELN
  LEFT JOIN MARA AS c ON a~MATNR = c~MATNR
  LEFT JOIN MAKT AS d ON a~MATNR = d~MATNR AND d~SPRAS = '1'
  LEFT JOIN KNA1 AS e ON b~KUNNR = e~KUNNR
WHERE b~WADAT_IST >= '{date_from}'
  AND b~WADAT_IST <= '{date_to}'
  AND b~WBSTK = 'C'{exclude_cond}
"""
    data = adt_query(sql, max_rows)
    
    if not data.get('VBELN'):
        # 如果没有WBSTK字段，重试去掉该条件
        print("  重试：不带WBSTK过滤...")
        sql2 = f"""
SELECT 
  a~VBELN, a~POSNR, a~LFIMG, a~VRKME, a~MATNR, a~FKSTA,
  b~VKORG, b~KUNNR, b~KUNAG, b~LFART, b~WADAT_IST, b~WAERK, b~VBTYP,
  c~MATKL,
  d~MAKTX,
  e~NAME1 AS KUNNR_NAME
FROM LIPS AS a
  INNER JOIN LIKP AS b ON a~VBELN = b~VBELN
  LEFT JOIN MARA AS c ON a~MATNR = c~MATNR
  LEFT JOIN MAKT AS d ON a~MATNR = d~MATNR AND d~SPRAS = '1'
  LEFT JOIN KNA1 AS e ON b~KUNNR = e~KUNNR
WHERE b~WADAT_IST >= '{date_from}'
  AND b~WADAT_IST <= '{date_to}'{exclude_cond}
"""
        data = adt_query(sql2, max_rows)
    
    total_rows = len(data.get('VBELN', []))
    print(f"  -> {total_rows} 行")
    
    if total_rows == 0:
        print("[WARN] 无数据")
        return
    
    # Step 2: 查询 VBRP 实际开票数量
    print("[2/4] 查询 VBRP 已开票数据...")
    all_vbeln = sorted(set(data['VBELN']))
    
    def query_chunked(sql_template, col1, chunk_name="data"):
        """分批查询，自动处理ADT的IN-list长度限制"""
        result = {}
        batch_size = 180  # SAP ADT IN 列表安全上限
        total = len(col1)
        for i in range(0, total, batch_size):
            batch = col1[i:i+batch_size]
            inlist = ',\n'.join(["'" + v + "'" for v in batch])
            sql = sql_template.replace('{inlist}', inlist)
            try:
                chunk_data = adt_query(sql, 500)
                for k, v in chunk_data.items():
                    if k not in result:
                        result[k] = []
                    result[k].extend(v)
            except Exception as e:
                print(f"  WARN: 批次 {i//batch_size+1} 失败: {e}")
        return result
    
    # 查询 VBRP: fkimg 是已开票数量
    vbrp_data = query_chunked(
        "SELECT vbeln, vgbel, vgpos, fkimg FROM vbrp WHERE vgbel IN ({inlist})",
        all_vbeln, "VBRP")
    
    # Step 3: 查询 VBRK 冲销状态
    print("[3/4] 查询 VBRK 冲销状态...")
    all_billing_docs = sorted(set(vbrp_data.get('VBELN', [])))
    
    vbrk_data = {}
    if all_billing_docs:
        vbrk_raw = query_chunked(
            "SELECT vbeln, sfakn, fksto, fkart FROM vbrk WHERE vbeln IN ({inlist})",
            all_billing_docs, "VBRK")
        # 排除已冲销的凭证：SFAKN不为空（冲销凭证） 或 FKSTO不为空（被冲销凭证）
        excluded_docs = set()
        for i in range(len(vbrk_raw.get('VBELN', []))):
            vbeln = vbrk_raw['VBELN'][i]
            sfakn = vbrk_raw.get('SFAKN', [''])[i] if i < len(vbrk_raw.get('SFAKN',[])) else ''
            fksto = vbrk_raw.get('FKSTO', [''])[i] if i < len(vbrk_raw.get('FKSTO',[])) else ''
            # SFAKN不为空 = 这是冲销凭证本身 → 排除
            # FKSTO不为空 = 这是被冲销的原始凭证 → 排除
            if (sfakn and sfakn.strip()) or (fksto and fksto.strip()):
                excluded_docs.add(vbeln)
        vbrk_data['excluded'] = excluded_docs
    
    print(f"  VBRP: {len(vbrp_data.get('VBELN',[]))} 行")
    print(f"  VBRK: {len(all_billing_docs)} 张凭证, {len(vbrk_data.get('excluded',set()))} 张已冲销")
    # 计算每个交货单行项目的实际已开票数量
    vbrp_billed = defaultdict(float)  # (vgbel, vgpos) -> billed_qty
    excluded_set = vbrk_data.get('excluded', set())
    for i in range(len(vbrp_data.get('VBELN', []))):
        billing_doc = vbrp_data['VBELN'][i]
        vgbel = vbrp_data.get('VGBEL', [''])[i] if i < len(vbrp_data.get('VGBEL',[])) else ''
        vgpos = vbrp_data.get('VGPOS', [''])[i] if i < len(vbrp_data.get('VGPOS',[])) else ''
        fkimg = float(vbrp_data.get('FKIMG', ['0'])[i] if i < len(vbrp_data.get('FKIMG',[])) else '0')
        # 排除已冲销（SFAKN+FKSTO）的凭证
        if billing_doc not in excluded_set:
            vbrp_billed[(vgbel, vgpos)] += fkimg
    
    # Step 4: 物料组名称
    print("[4/5] 查询物料组名称...")
    matkls = sorted(set(data.get('MATKL', [])))
    matkl_name_map = {}
    if matkls:
        try:
            inlist = ','.join(["'" + m + "'" for m in matkls])
            t023_data = adt_query(
                f"SELECT matkl, wgbez FROM t023t WHERE matkl IN ({inlist}) AND spras = '1'", 50)
            matkl_name_map = dict(zip(t023_data.get('MATKL', []), t023_data.get('WGBEZ', [])))
        except:
            pass
    
    # Step 5: 生成报表数据
    print(f"[5/5] 生成报表 ({total_rows} 行)...")
    
    # 构建行数据，计算实际已开票/未开票
    seen = set()
    items = []
    fksta_a_count = 0  # FKSTA='A' (完全未开票)
    fksta_b_count = 0  # FKSTA='B' (部分开票，需VBRP计算)
    fksta_c_count = 0  # FKSTA='C' (已开票)
    partial_adjusted = 0  # 部分开票修正次数
    
    for i in range(total_rows):
        vbeln = data['VBELN'][i]
        posnr = data['POSNR'][i]
        matkl = data.get('MATKL', [''])[i] if i < len(data.get('MATKL',[])) else ''
        fksta = data.get('FKSTA', [''])[i] if i < len(data.get('FKSTA',[])) else ''
        
        # 计算已开票数量
        delivered = float(data.get('LFIMG',['0'])[i] if i < len(data.get('LFIMG',[])) else '0')
        billed_from_vbrp = vbrp_billed.get((vbeln, posnr), 0.0)
        
        if fksta == 'A':
            # 完全未开票
            billed = 0.0
            unbilled = delivered
            fksta_a_count += 1
        elif fksta == 'B':
            # 部分开票：已开票 = VBRP实际开票数 - 冲销；未开票 = 发货 - 实际已开票
            billed = billed_from_vbrp
            unbilled = max(0, delivered - billed)
            fksta_b_count += 1
            if abs(billed - billed_from_vbrp) > 0.001:
                partial_adjusted += 1
        elif fksta == 'C':
            # 已开票
            billed = delivered if billed_from_vbrp <= 0.001 else billed_from_vbrp
            unbilled = 0.0
            fksta_c_count += 1
        else:
            # 其他状态
            billed = billed_from_vbrp
            unbilled = max(0, delivered - billed)
        
        item = {
            'VBELN': vbeln,
            'POSNR': posnr,
            'MATNR': data.get('MATNR',[''])[i] if i < len(data.get('MATNR',[])) else '',
            'MAKTX': data.get('MAKTX',[''])[i] if i < len(data.get('MAKTX',[])) else '',
            'MATKL': matkl,
            'MATKL_NAME': matkl_name_map.get(matkl, ''),
            'VKORG': data.get('VKORG',[''])[i] if i < len(data.get('VKORG',[])) else '',
            'KUNNR': data.get('KUNNR',[''])[i] if i < len(data.get('KUNNR',[])) else '',
            'KUNAG': data.get('KUNAG',[''])[i] if i < len(data.get('KUNAG',[])) else '',
            'KUNNR_NAME': data.get('KUNNR_NAME',[''])[i] if i < len(data.get('KUNNR_NAME',[])) else '',
            'LFIMG': delivered,
            'BILLED': billed,
            'UNBILLED': unbilled,
            'VRKME': data.get('VRKME',[''])[i] if i < len(data.get('VRKME',[])) else '',
            'LFART': data.get('LFART',[''])[i] if i < len(data.get('LFART',[])) else '',
            'WADAT_IST': data.get('WADAT_IST',[''])[i] if i < len(data.get('WADAT_IST',[])) else '',
            'FKSTA': fksta,
        }
        key = (vbeln, posnr)
        if key not in seen:
            seen.add(key)
            items.append(item)
    
    print(f"  有效行: {len(items)} | FKSTA-A={fksta_a_count} B={fksta_b_count} C={fksta_c_count}")
    if partial_adjusted > 0:
        print(f"  部分开票修正: {partial_adjusted} 行（VBRP 实际开票量修正）")
    
    # 统计函数（区分已开票/未开票）
    def pivot(dims):
        agg_total = defaultdict(float)
        agg_billed = defaultdict(float)
        agg_unbilled = defaultdict(float)
        for it in items:
            key = tuple(it.get(d, '') for d in dims)
            agg_total[key] += it['LFIMG']
            agg_billed[key] += it['BILLED']
            agg_unbilled[key] += it['UNBILLED']
        result = []
        for key in agg_total:
            result.append((key, agg_total[key], agg_billed[key], agg_unbilled[key]))
        return sorted(result, key=lambda x: -x[1])
    
    # 统计交货单/客户基础信息
    vbelns = set(it['VBELN'] for it in items)
    customers = set(it['KUNNR'] for it in items if it['KUNNR'])
    vkorgs = set(it['VKORG'] for it in items if it['VKORG'])
    
    # 生成 Excel
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    
    wb = openpyxl.Workbook()
    hf = Font(bold=True, color='FFFFFF', size=11)
    hfill = PatternFill('solid', fgColor='1F4E79')
    bdr = Border(left=Side('thin'), right=Side('thin'), top=Side('thin'), bottom=Side('thin'))
    
    def ws_write(ws, title, headers, rows, widths=None, note=None):
        ws.title = title
        for c, h in enumerate(headers, 1):
            cell = ws.cell(1, c, h)
            cell.font = hf
            cell.fill = hfill
            cell.border = bdr
            cell.alignment = Alignment(horizontal='center')
        for r, row in enumerate(rows, 2):
            for c, v in enumerate(row, 1):
                cell = ws.cell(r, c, v)
                cell.font = Font(size=10)
                cell.border = bdr
                if isinstance(v, float):
                    cell.alignment = Alignment(horizontal='right')
                    cell.number_format = '#,##0.00'
                else:
                    cell.alignment = Alignment(horizontal='left')
        ws.freeze_panes = 'A2'
        if widths:
            for i, w in enumerate(widths, 1):
                ws.column_dimensions[get_column_letter(i)].width = w
        if note:
            ws.cell(len(rows)+3, 1, note).font = Font(size=9, color='666666')
    
    # Sheet 1: 客户+销售组织+物料
    ws1 = wb.active
    p1 = pivot(['KUNNR_NAME','KUNNR','VKORG','MATNR','MAKTX'])
    r1 = [list(key) + [round(b,3), round(u,3), round(t,3)] for key, t, b, u in p1]
    ws_write(ws1, '客户+销售组织+物料',
        ['客户名称','客户编号','销售组织','物料编号','物料描述','已开票数量','未开票数量','发货数量合计'],
        r1, [30,14,10,22,30,14,14,14])
    
    # Sheet 2: 客户+销售组织
    ws2 = wb.create_sheet()
    p2 = pivot(['KUNNR_NAME','KUNNR','VKORG'])
    r2 = [list(key) + [round(b,3), round(u,3), round(t,3)] for key, t, b, u in p2]
    ws_write(ws2, '客户+销售组织',
        ['客户名称','客户编号','销售组织','已开票数量','未开票数量','发货数量合计'],
        r2, [30,14,10,14,14,14])
    
    # Sheet 3: 客户维度
    ws3 = wb.create_sheet()
    p3 = pivot(['KUNNR_NAME','KUNNR'])
    r3 = [list(key) + [round(b,3), round(u,3), round(t,3)] for key, t, b, u in p3]
    ws_write(ws3, '客户维度',
        ['客户名称','客户编号','已开票数量','未开票数量','发货数量合计'],
        r3, [30,14,14,14,14])
    
    # Sheet 4: 销售组织+客户
    ws4 = wb.create_sheet()
    p4 = pivot(['VKORG','KUNNR_NAME','KUNNR'])
    r4 = [list(key) + [round(b,3), round(u,3), round(t,3)] for key, t, b, u in p4]
    ws_write(ws4, '销售组织+客户',
        ['销售组织','客户名称','客户编号','已开票数量','未开票数量','发货数量合计'],
        r4, [10,30,14,14,14,14])
    
    # Sheet 5: 客户+销售组织+物料组
    ws5 = wb.create_sheet()
    p5 = pivot(['KUNNR_NAME','KUNNR','VKORG','MATKL','MATKL_NAME'])
    r5 = [list(key) + [round(b,3), round(u,3), round(t,3)] for key, t, b, u in p5]
    ws_write(ws5, '客户+销售组织+物料组',
        ['客户名称','客户编号','销售组织','物料组','物料组名称','已开票数量','未开票数量','发货数量合计'],
        r5, [30,14,10,10,20,14,14,14])
    
    # 默认输出路径
    if not output_path:
        os.makedirs(WORKSPACE, exist_ok=True)
        output_path = os.path.join(WORKSPACE, f'{date_from}_{date_to}_发货统计多维度.xlsx')
    
    wb.save(output_path)
    
    elapsed = round(time.time() - t0, 1)
    print(f'\n✅ 完成！用时 {elapsed}s')
    print(f'EXCEL_OK:{output_path}')
    print(f'数据: {len(items)}行 / {len(vbelns)}交货单 / {len(customers)}客户 / {len(vkorgs)}销售组织')

if __name__ == '__main__':
    main()
