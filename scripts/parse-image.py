#!/usr/bin/env python3
"""
解析用户上传的开票图片（OCR）
用法: python parse-image.py <图片路径>

支持格式: JPG, PNG, BMP, TIFF
"""

import sys
import re
import json
from pathlib import Path

try:
    from PIL import Image
    import pytesseract
except ImportError:
    print("错误: 缺少依赖。请先安装: pip install pillow pytesseract")
    print("注意: Windows 还需安装 Tesseract-OCR 引擎并配置环境变量")
    sys.exit(1)


def extract_billing_info(image_path: str) -> list[dict]:
    """从图片 OCR 结果中提取开票关键信息"""

    # OCR 识别
    image = Image.open(image_path)
    text = pytesseract.image_to_string(image, lang='chi_sim+eng')

    # 提取单据号（常见格式: 800xxxxx, 900xxxxx）
    vbeln_pattern = re.compile(r'\b(\d{8,10})\b')
    vbelns = vbeln_pattern.findall(text)

    # 提取数量（常见格式: 数字 + 单位）
    qty_pattern = re.compile(r'(\d+(?:\.\d+)?)\s*(EA|PC|KG|件|个|箱)')
    qtys = qty_pattern.findall(text)

    # 提取物料号（常见格式: MATxxxxx 或纯数字）
    matnr_pattern = re.compile(r'(MAT[A-Z0-9]+|\b\d{6,8}\b)')
    matnrs = matnr_pattern.findall(text)

    result = []
    for i, vbeln in enumerate(vbelns):
        item = {
            'vbeln': vbeln,
            'posnr': '10',  # 默认行项目，OCR 难以精确识别
            'raw_text': text[:500]  # 保留原始文本供人工核对
        }
        if i < len(qtys):
            item['zbcsl'] = float(qtys[i][0])
            item['unit'] = qtys[i][1]
        if i < len(matnrs):
            item['matnr'] = matnrs[i]

        result.append(item)

    return result


def main():
    if len(sys.argv) < 2:
        print("用法: python parse-image.py <图片路径>")
        sys.exit(1)

    filepath = sys.argv[1]
    if not Path(filepath).exists():
        print(f"错误: 文件不存在: {filepath}")
        sys.exit(1)

    try:
        result = extract_billing_info(filepath)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"OCR 解析失败: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
