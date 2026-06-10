---
name: sap-billing-doc-check
description: "SAP 对账开票助手：RFC-ADT → 查发货记录/未开票/开票(VF01/VF11)。触发：对账开票、VF01、未开票、发票、发货记录、交货单、Excel/图片上传"
---

# SAP 对账开票助手

## 触发词
对账开票 | 开票 | VF01 | VF11 | 未开票 | billing doc | 发票 | 发货记录 | 交货单 | 出货

## 连接架构

```
fetch-delivery-data.js / create-billing.js
  → HTTP POST → 127.0.0.1:9876 (RFC Proxy)
    → node-rfc → SADT_REST_RFC_ENDPOINT
      → SAP (configured via .env)
```

**关键路径说明：**
- **RFC Proxy** (`rfc-proxy-server.js`)：本地 HTTP → RFC 桥接，将 ADT REST 请求通过 node-rfc 转发到 SAP
- **SAP 目标**：.env 中配置 `SAP_URL`（仅用于提取 ashost），实际连接走 RFC 协议
- **ADT SQL 查询**：脚本发 HTTP POST 到 9876 → 代理转 RFC 调用 `SADT_REST_RFC_ENDPOINT` → SAP 执行 SQL → 返回 XML

### 502 / 连接失败常见原因

| 现象 | 原因 | 解决 |
|------|------|------|
| `ECONNREFUSED 127.0.0.1:9876` | RFC 代理未启动 | 启动代理 |
| HTTP 502 | SAP 后端未就绪/断连 | 等 10 秒重试；或 kill 旧代理重启 |
| `ERR_DLOPEN_FAILED` | 找不到 `libsapnwrfc.so` | 检查 `LD_LIBRARY_PATH` 含 SDK lib |
| 代理跑了但 SAP 不通 | SAP 系统本身未启动 | 检查 SAP 服务状态 |

> **重试通常能解决临时性 502**。如果连续失败，检查代理日志看 RFC 连接错误详情。

## 快速上手

### 1. 安装依赖

```bash
# NW-RFC-SDK 需要手动下载并放置到 NW-RFC-SDK/nwrfcsdk/ 目录
npm install
```

### 2. 配置

复制 `.env` 模板并填写实际的 SAP 连接参数。

### 3. 启动 RFC 代理

```bash
bash auto-proxy.sh
# 或手动：
export LD_LIBRARY_PATH="$(pwd)/NW-RFC-SDK/nwrfcsdk/lib:$LD_LIBRARY_PATH"
node rfc-proxy-server.js
```

### 4. 常用命令
| 场景 | 命令 |
|------|------|
| 查交货单（最近3月） | `node scripts/fetch-delivery-data.js --client <KUNNR>` |
| 按销售组织查 | `node scripts/fetch-delivery-data.js --vkorg <VKORG>` |
| 单号直查（最快） | `node scripts/fetch-delivery-data.js --vbeln <VBELN>` |
| 带 Excel 报表 | `...--excel` |
| 仅未开票 | `...--unbilled true` |
| 排除公司间 | `...--exclude-lfart ZNL1,ZNL2,ZNL3,ZNL4` |
| 全销售组织 | `...--all` |
| 多维统计 | `python3 scripts/dimension-report.py [--from YYYYMMDD] [--to YYYYMMDD]` |
| 开票（VF01） | `node scripts/create-billing.js '<JSON>'` |
| 先测试 | 加 `--testrun` |
| 开票日志 | `node scripts/create-billing.js --show-log` |

### ⚠️ 开票参数注意

**数量字段用 `ZKYSL`，不是 `FKIMG`。**
```json
// ✅ 正确
{"VBELN_JS":"8000000341","POSNR_JS":"000001","ZKYSL":324,"VRKME":"PC"}
// ❌ 错误（REQ_QTY 取不到值 → 退化为 0 → SAP 自动开全额）
{"VBELN_JS":"8000000341","POSNR_JS":"000001","FKIMG":324}
```
当 `ZKYSL` 为 0 时，BAPI 自动按该行全额开票，不会报错。

## 🚨 核心警告：BAPI 成功 ≠ 凭证已持久化

**这是开票操作中最危险的陷阱。**

```
BAPI 返回成功                  ✅  但不代表写入了数据库
VBRK 查不到记录                ❌  幽灵凭证
根因：BAPI_TRANSACTION_COMMIT 未调用  →  数据只活在 SAP 内存中
```

`create-billing.js` 已自动执行 COMMIT + 查 VBRP 验证。
**开票后必须人工验证：** 查 VBRK 或重跑 fetch-delivery-data 确认 FKSTA 变更为已开票。

## ⚡ 冲销操作（VF11）

已集成到 `create-billing.js`，通过 `--cancel` 参数调用 BAPI_BILLINGDOC_CANCEL1。

```bash
# 测试冲销（不会实际执行）
node scripts/create-billing.js --cancel <BillingDoc> --testrun

# 正式冲销（会交互式确认）
node scripts/create-billing.js --cancel <BillingDoc>

# 带原因冲销
node scripts/create-billing.js --cancel <BillingDoc> --reason "开票数据有误"
```

**功能特性：**
- 冲销前自动查 VBRK 验证凭证状态（防止重复冲销、冲销已冲销的凭证）
- 显示凭证详情（金额、客户、行项目）供确认
- 正式冲销前交互式确认 `y/N`
- 自动 `BAPI_TRANSACTION_COMMIT` + 日志记录
- 冲销后交货单 FKSTA 自动回退为 'A'

## FKSTK / FKSTA 开票状态

### 表头总体状态（LIKP.FKSTK）
| 值 | 含义 |
|:--:|------|
| 空/A | ❌ 未开票 — 所有行均无开票 |
| B | ⚠️ 部分开票 — 部分行已开，部分未开 |
| C | ✅ 已开票 — 全部行已开 |

FKSTA/FKSTK 为空时：`❌ 未开票`（普通发货）或 `➖ 不适用`（非开票类型）

## 脚本一览

| 脚本 | 路径 | 作用 |
|------|------|------|
| **发货数据** | `scripts/fetch-delivery-data.js` | LIKP+LIPS+VBRP→JSON/Excel |
| **维度统计** | `scripts/dimension-report.py` | 客户/物料/销售组织多维度Excel |
| **开票(VF01)** | `scripts/create-billing.js` | BAPI_BILLINGDOC_CREATEMULTIPLE |
| **冲销(VF11)** | `scripts/create-billing.js --cancel <凭证号>` | BAPI_BILLINGDOC_CANCEL1 |
| **日志** | `scripts/create-billing.js --show-log` | 开票操作日志 |
| **Excel 解析** | `scripts/parse-excel.py` | 上传Excel → 开票数据 |
| **图片 OCR** | `scripts/parse-image.py` | 图片 → 单据号 |

## ⚡ fetch-delivery-data.js 内部流程

LIKP查询（含FKSTK）→ 并发查LIPS+VBRP → 本地JOIN计算未开票 → FKSTA双向验证 → 物料/客户补全

## 开票须知

- ⚠️ **先 `--testrun`，确认无误再去掉正式执行**
- 🚨 **BAPI 成功后必须 COMMIT**：脚本已自动处理，但开票后务必查 VBRK 确认凭证存在
- 同批开票的客户应一致，不一致时拆批
- 开票日期 ≥ 过账日期（WADAT_IST）
- 冲销后交货单 FKSTA 自动回退为 'A'
- ⚡ **VKORG 自动补全**：`create-billing.js` 在 BAPI 报"无法确定开票类型"时会自动查 LIKP 补全 VKORG/VBTYP 并重试
- 🤖 **AI Agent 工作流**：用户在测试后修改数量（如"第1行改为100"），AI Agent 必须在最终执行前再次确认

## 已知问题

| 问题 | 解决 |
|------|------|
| ADT 不支持 JOIN | 分步查询，本地 JOIN |
| ADT IN 列表限制 | 用 `,\n` 换行分隔 |
| ADT 偶发缓存不一致 | FKSTA 双向验证（fetch-delivery-data.js） |
| ECC 无 FKSTA/WBSTK | 不用 `--s4`，靠 VBRP 反推 |
| BAPI ITM_NUMBER 重复 | `(idx+1)*10` 自动生成 |
| 冲销不计入已开票 | VBRK 查 SFAKN+FKSTO 排除 |
| **BAPI 返回成功但未持久化** | **脚本已加 COMMIT + VBRP 验证；人工仍需复查 VBRK** |
