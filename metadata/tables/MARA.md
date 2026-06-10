# MARA — 物料主数据（Material Master General Data）
> ✅ 字段定义从 SAP DD03L 实时读取验证（2026-05-29）

## 基础信息
- **表名**: MARA（MM 模块）
- **用途**: 物料主数据基本视图
- **关联**: 1:N → MAKT（描述，多语言），MARC（工厂视图），MARD（库存视图）

## 核心字段（按位置排序）

| 位置 | 字段 | 类型/长度 | 主键 | 说明 |
|:----:|------|:---------:|:----:|------|
| 0001 | MANDT | CLNT(3) | X | 集团 |
| 0002 | MATNR | CHAR(40) | X | **物料号** |
| 0012 | MTART | CHAR(4) | | 物料类型 |
| 0013 | MBRSH | CHAR(1) | | 行业领域 |
| 0014 | MATKL | CHAR(9) | | **物料组** |
| 0015 | BISMT | CHAR(40) | | 旧物料号 |
| 0016 | MEINS | UNIT(3) | | **基本计量单位** |
| 0032 | BRGEW | QUAN(13/3) | | 毛重 |
| 0033 | NTGEW | QUAN(13/3) | | 净重 |
| 0034 | GEWEI | UNIT(3) | | 重量单位 |
| 0035 | VOLUM | QUAN(13/3) | | 体积 |
| 0036 | VOLEH | UNIT(3) | | 体积单位 |
| 0043 | SPART | CHAR(2) | | 产品组 |
| 0053 | EAN11 | CHAR(18) | | 国际商品编码（EAN） |

## ⚠️ 重要说明
- **MARA 标准表中没有 `CUST_DRAW_NUM`、`OTH_NAME`、`SPEC`、`SALE_TYPE` 字段**
- 这些字段很可能来自 **Z 表（自定义增强）** 或 **MARA 的客户增强 INCLUDE**
- 当前 ADT 查询中使用的 `mara.cust_draw_num` 等字段是 Z 表或视图字段
- 若需远程系统使用标准 MARA，需确认自定义字段是否存在

## 关联表
- **MAKT** → 物料描述（多语言），通过 MATNR 关联
- **MARC** → 工厂级视图（MRP数据）
- **MARD** → 存储地点库存

## 关键查询
```sql
SELECT MATNR, MTART, MATKL, MEINS, BRGEW, NTGEW
FROM MARA
WHERE MATNR = '000000000010010104018';
```
