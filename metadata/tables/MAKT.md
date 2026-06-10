# MAKT — 物料描述（Material Text）
> ✅ 字段定义从 SAP DD03L 实时读取验证（2026-05-29）

## 基础信息
- **表名**: MAKT（MM 模块）
- **用途**: 存储物料的多语言描述文本
- **主键**: MANDT + MATNR + SPRAS

## 核心字段

| 位置 | 字段 | 类型/长度 | 主键 | 说明 |
|:----:|------|:---------:|:----:|------|
| 0001 | MANDT | CLNT(3) | X | 集团 |
| 0002 | MATNR | CHAR(40) | X | **物料号**（与 MARA 一致，长度 40） |
| 0003 | SPRAS | LANG(1) | X | **语言代码**（1=中文, E=英语） |
| 0004 | MAKTX | CHAR(40) | | **物料描述（短文本）** |
| 0005 | MAKTG | CHAR(40) | | 物料描述（大写） |

## 关键查询
```sql
-- 批量查物料描述
SELECT MATNR, SPRAS, MAKTX
FROM MAKT
WHERE MATNR IN ('000000000010010104018')
  AND SPRAS = '1';
```

## 在开票查询中的用途
- `fetch-delivery-data.js` 自动收集所有唯一 MATNR 批量查 MAKTX
- 用于显示列表中的物料名称
