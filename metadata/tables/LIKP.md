# LIKP — 交货单抬头（Delivery Header）
> ✅ 字段定义从 SAP DD03L 实时读取验证（2026-05-29）

## 基础信息
- **表名**: LIKP（SD 模块）
- **SAP 描述**: SD凭证:交货抬头数据
- **用途**: 存储交货单抬头信息
- **关联**: 1:N → LIPS（行项目），通过 VBELN

## 核心字段（按位置排序）

| 位置 | 字段 | 类型/长度 | 主键 | 说明 |
|:----:|------|:---------:|:----:|------|
| 0001 | MANDT | CLNT(3) | X | 集团 |
| 0002 | VBELN | CHAR(10) | X | **交货单号** |
| 0003-0007 | ERNAM,ERZET,ERDAT,BZIRK,VSTEL | - | | 创建人/时间/日期/销售办事处/发运点 |
| 0008 | VKORG | CHAR(4) | | **销售组织** |
| 0009 | LFART | CHAR(4) | | **交货类型**（ZLF5标准, ZLR7转储, ZNL1~4公司间） |
| 0012 | WADAT | DATS(8) | | 计划交货日期 |
| 0013 | LDDAT | DATS(8) | | 装货日期 |
| 0014 | TDDAT | DATS(8) | | 运输计划日期 |
| 0018 | INCO1 | CHAR(3) | | 国际贸易条款（FOB/CIF/EXW） |
| 0021 | ROUTE | CHAR(6) | | 运输路线 |
| 0023 | LIFSK | CHAR(2) | | 交货冻结（01=信用冻结） |
| 0024 | VBTYP | CHAR(4) | | **单据类别**（T=交货, J=公司间, M=外贸） |
| 0030 | KUNNR | CHAR(10) | | **售达客户**（收货方） |
| 0031 | KUNAG | CHAR(10) | | **收货客户** |
| 0035 | BTGEW | QUAN(15/3) | | 毛重（POD相关） |
| 0036 | NTGEW | QUAN(15/3) | | 净重 |
| 0053 | WAERK | CUKY(5) | | **币别** |
| 0087 | BLDAT | DATS(8) | | 凭证日期 |
| 0088 | WADAT_IST | DATS(8) | | **实际发货日期**（常用过滤字段） |
| 0097 | NETWR | CURR(15/2) | | 净额 |
| **0196** | **FKSTK** | **CHAR(1)** | | **总体开票状态** |
| 0223 | WBSTK | CHAR(1) | | 总体拣配状态 |

## FKSTK 开票状态

| 值 | 含义 | 行项目对应 |
|:--:|------|-----------|
| 空/A | ❌ 未开票 | 所有行 FKSTA 为空或 'A' |
| B | ⚠️ 部分开票 | 部分行 FKSTA='C' |
| C | ✅ 全部已开票 | 所有行 FKSTA='C' |

> ⚠️ **ADT 偶发缓存不一致**：脚本中通过行级 FKSTA 反向验证 FKSTK

## 关键查询
```sql
-- 按销售组织查询（常用）
SELECT VBELN, VBTYP, LFART, VKORG, KUNNR, KUNAG, WADAT_IST, WAERK, FKSTK
FROM LIKP
WHERE VKORG = '<YOUR_VKORG>'
  AND WADAT_IST >= '20260301';
```
```sql
-- 单号直查
SELECT VBELN, LFART, VKORG, KUNNR, WADAT_IST, WAERK, VBTYP, FKSTK
FROM LIKP
WHERE VBELN = '8000001354';
```
