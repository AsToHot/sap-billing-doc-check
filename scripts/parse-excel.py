#!/usr/bin/env python3
"""
解析用户上传的开票 Excel 文件
用法: python parse-excel.py <excel文件路径>

Excel 格式要求：
- 必须包含列: VBELN(单据号), POSNR(行项目)
- 可选列: SEL(选择标记X), ZBCSL(本次开票数量)
- 如果 ZBCSL 为空，默认使用全部可开数量
"""

import sys
import json
import pandas as pd
from pathlib import Path


def parse_billing_excel(filepath: str) -> list[dict]:
    """解析开票 Excel，返回选中的行列表"""

    df = pd.read_excel(filepath, dtype=str)

    # 标准化列名（去除空格，转大写）
    df.columns = [c.strip().upper() for c in df.columns]

    # 检查必填列
    required = {'VBELN', 'POSNR'}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Excel 缺少必填列: {missing}")

    # 筛选选中的行
    if 'SEL' in df.columns:
        selected = df[df['SEL'].str.strip().str.upper() == 'X']
    else:
        # 如果没有 SEL 列，默认全部选中
        selected = df

    # 组装结果
    result = []
    for _, row in selected.iterrows():
        item = {
            'vbeln': str(row['VBELN']).strip(),
            'posnr': str(row['POSNR']).strip().zfill(6),
            'zbcsl': float(row['ZBCSL']) if 'ZBCSL' in row and pd.notna(row['ZBCSL']) else None,
        }
        # 可选字段
        for col in ['MATNR', 'LFIMG', 'ZPRICE_J', 'WAERK', 'WADAT_IST']:
            if col in row and pd.notna(row[col]):
                item[col.lower()] = str(row[col]).strip()

        result.append(item)

    return result


def main():
    if len(sys.argv) < 2:
        print("用法: python parse-excel.py <excel文件路径>")
        sys.exit(1)

    filepath = sys.argv[1]
    if not Path(filepath).exists():
        print(f"错误: 文件不存在: {filepath}")
        sys.exit(1)

    try:
        result = parse_billing_excel(filepath)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"解析失败: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
