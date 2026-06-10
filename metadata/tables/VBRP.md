# VBRP — 开票凭证行项目（Billing Document Item）
> ✅ 字段定义从 SAP DD03L 实时读取验证（2026-05-29）

## 基础信息
- **表名**: VBRP（SD 模块）
- **用途**: 存储开票凭证的行项目数据
- **关联**: N:1 ← VBRK（抬头），通过 VBELN

## 核心字段（按位置排序）

| 位置 | 字段 | 类型/长度 | 主键 | 说明 |
|:----:|------|:---------:|:----:|------|
| 0001 | MANDT | CLNT(3) | X | 集团 |
| 0002 | VBELN | CHAR(10) | X | **开票凭证号** |
| 0003 | POSNR | NUMC(6) | X | **行项目号** |
| 0005 | FKIMG | QUAN(13/3) | | **开票数量** |
| 0006 | VRKME | UNIT(3) | | **销售单位** |
| 0022 | NETWR | CURR(15/2) | | **净额（行项目级）** |
| 0025 | VGBEL | CHAR(10) | | **参考凭证（交货单号）** |
| 0026 | VGPOS | NUMC(6) | | **参考行项目** |
| 0028 | AUBEL | CHAR(10) | | **销售订单号** |
| 0029 | AUPOS | NUMC(6) | | 销售订单行项目 |
| 0031 | MATNR | CHAR(40) | | **物料号** |
| 0032 | ARKTX | CHAR(40) | | 物料描述 |
| 0043 | WERKS | CHAR(4) | | **工厂** |
| 0136 | MWSBP | CURR(13/2) | | **税额（行项目级）** |

## 关键用途

| 用途 | 方式 |
|------|------|
| **金额验证** | 开票后查 NETWR + MWSBP 确认金额 |
| **未开票推算** | 对比 VGBEL+VGPOS 与 LIPS，VBRP 无记录 = 未开票 |
| **冲销排除** | 关联 VBRK.SFAKN = '' 且 VBRK.FKSTO = '' 为本期有效凭证 |

## 关键查询
```sql
-- 按交货单查开票行项目
SELECT VGBEL, VGPOS, VBELN, POSNR, NETWR, MWSBP, FKIMG, VRKME
FROM VBRP
WHERE VGBEL = '8000001354';
```
```sql
-- 按凭证查金额明细
SELECT VBELN, POSNR, MATNR, ARKTX, NETWR, MWSBP, FKIMG, VRKME
FROM VBRP
WHERE VBELN = '9000000689';
```

## 注意事项
- **NETWR 在 0022，MWSBP 在 0136**（中间间隔大量字段）
- **FKIMG 是 QUAN(13/3)**，不是整数
- **MATNR 长度 40**（非 18）
