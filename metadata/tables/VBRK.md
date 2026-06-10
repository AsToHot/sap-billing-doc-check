# VBRK — 开票凭证抬头（Billing Document Header）
> ✅ 字段定义从 SAP DD03L 实时读取验证（2026-05-29）

## 基础信息
- **表名**: VBRK（SD 模块）
- **用途**: 存储开票凭证的抬头信息
- **关联**: 1:N → VBRP（行项目），通过 VBELN

## 核心字段（按位置排序）

| 位置 | 字段 | 类型/长度 | 主键 | 说明 |
|:----:|------|:---------:|:----:|------|
| 0001 | MANDT | CLNT(3) | X | 集团 |
| 0002 | VBELN | CHAR(10) | X | **开票凭证号**（9000000689） |
| 0003 | FKART | CHAR(4) | | **开票类型**（ZF1标准, ZIV1内部） |
| 0006 | WAERK | CUKY(5) | | **币别** |
| 0007 | VKORG | CHAR(4) | | **销售组织** |
| 0008 | VTWEG | CHAR(2) | | 分销渠道 |
| 0012 | FKDAT | DATS(8) | | **开票日期** |
| 0022 | RFBSK | CHAR(1) | | **会计过账状态**（A=未过账, B, C=已过账） |
| 0028 | ZTERM | CHAR(4) | | 付款条件 |
| 0045 | NETWR | CURR(15/2) | | **净额（不含税）** |
| 0047 | ERNAM | CHAR(12) | | 创建者 |
| 0051 | KUNRG | CHAR(10) | | **付款方客户** |
| 0052 | KUNAG | CHAR(10) | | **售达客户** |
| 0057 | SFAKN | CHAR(10) | | **被冲销凭证号**（该凭证是冲销产生的） |
| 0064 | SPART | CHAR(2) | | 产品组 |
| 0083 | MWSBK | CURR(13/2) | | **税额（含税汇总）** |
| 0085 | FKSTO | CHAR(1) | | **冲销标记**（X=该凭证是冲销凭证） |

## 冲销检测

| 条件 | 含义 |
|------|------|
| `FKSTO = 'X'` | 该凭证本身是**冲销凭证**（反向冲销） |
| `SFAKN ≠ ''` | 该凭证**是被冲销的原始凭证**的冲销结果 |
| `FKSTO = '' AND SFAKN = ''` | **正常凭证**（可开票/未冲销） |

## 关键查询
```sql
-- 查凭证确认
SELECT VBELN, FKART, FKDAT, FKSTO, SFAKN, NETWR, MWSBK, WAERK, RFBSK
FROM VBRK
WHERE VBELN = '9000000689';
```
```sql
-- 排除已冲销凭证（用于开票查询）
SELECT VBELN, FKART, FKDAT, NETWR, WAERK
FROM VBRK
WHERE SFAKN = ''    -- 未被冲销
  AND FKSTO = '';   -- 非冲销凭证
```

## 注意事项
- **WAERK 类型 CUKY（5）**（币别字段非 CHAR）
- **NETWR 在 0045, MWSBK 在 0083**（位置较靠后，间隔大）
- ECC 环境无 FKSTA/WBSTK → 开票状态靠 VBRP 反推
