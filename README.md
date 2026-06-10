# SAP 对账开票助手

[![OpenClaw Skill](https://img.shields.io/badge/openclaw-skill-blue)](https://openclaw.ai)

基于 **RFC-ADT** 的 SAP SD 模块开票自动化工具集。通过 `node-rfc` + `SADT_REST_RFC_ENDPOINT` 桥接，实现从查询发货记录到执行 VF01/VF11 开票的完整闭环。

---

## 功能概览

| 功能 | 脚本 | 说明 |
|------|------|------|
| 📦 **发货查询** | `fetch-delivery-data.js` | LIKP+LIPS+VBRP 多表联查，支持按客户/销售组织/单号/日期筛选 |
| 📊 **多维报表** | `dimension-report.py` | 客户/物料/销售组织多维度 Excel 统计 |
| 📝 **开票(VF01)** | `create-billing.js` | BAPI_BILLINGDOC_CREATEMULTIPLE，自动 COMMIT + VBRP 验证 |
| ❌ **冲销(VF11)** | `create-billing.js --cancel` | BAPI_BILLINGDOC_CANCEL1，交互式确认 |
| 📁 **Excel 解析** | `parse-excel.py` | 上传 Excel → 开票数据批量导入 |
| 🖼️ **图片 OCR** | `parse-image.py` | 图片 → 单据号识别 |
| 📈 **日报推送** | `daily-billing-report.js` | 读取开票日志，生成昨日开票汇总 |

---

## 架构

```
fetch-delivery-data.js / create-billing.js
  → HTTP POST → 127.0.0.1:9876 (RFC Proxy)
    → node-rfc → SADT_REST_RFC_ENDPOINT
      → SAP (configured via .env)
```

**RFC Proxy** (`rfc-proxy-server.js`) 将 ADT REST 请求通过 `node-rfc` 转发到 SAP，解决 ADT 不支持 RFC/SAP Router 的问题。

---

## 快速开始

### 1. 前置条件

- **Node.js** ≥ 18
- **Python** ≥ 3.10（Excel 报表生成）
- **NW-RFC-SDK** — 从 [SAP Support Portal](https://support.sap.com/en/nwrfcsdk.html) 下载，放置到 `NW-RFC-SDK/nwrfcsdk/`

### 2. 安装

```bash
git clone https://github.com/AsToHot/sap-billing-doc-check.git
cd sap-billing-doc-check
npm install
```

### 3. 配置

复制 `.env` 模板并填写实际的 SAP 连接参数：

```bash
# SAP target system URL
SAP_URL=http://your-sap-host:3300

# SAP Client & System Number
SAP_CLIENT=XXX
SAP_SYSNR=XX

# Authentication
SAP_USERNAME=YOUR_USER
SAP_PASSWORD=YOUR_PASS

# Connection type
SAP_CONNECTION_TYPE=rfc
```

### 4. 启动 RFC 代理

```bash
bash auto-proxy.sh
```

### 5. 常用命令

```bash
# 查交货单（最近3月）
node scripts/fetch-delivery-data.js --client <KUNNR>

# 按销售组织查
node scripts/fetch-delivery-data.js --vkorg <VKORG>

# 单号直查
node scripts/fetch-delivery-data.js --vbeln <VBELN>

# 带 Excel 报表
node scripts/fetch-delivery-data.js --client <KUNNR> --excel

# 仅未开票
node scripts/fetch-delivery-data.js --client <KUNNR> --unbilled true

# 全销售组织
node scripts/fetch-delivery-data.js --all

# 多维统计
python3 scripts/dimension-report.py --from 20251001 --to 20251231

# 开票（先 testrun）
node scripts/create-billing.js --testrun '[{"VBELN_JS":"80000001","POSNR_JS":"000010","ZKYSL":100,"VRKME":"EA"}]'

# 正式开票
node scripts/create-billing.js '[{"VBELN_JS":"80000001","POSNR_JS":"000010","ZKYSL":100,"VRKME":"EA"}]'

# 冲销
node scripts/create-billing.js --cancel <BillingDoc>

# 查看开票日志
node scripts/create-billing.js --show-log
```

---

## ⚠️ 核心警告：BAPI 成功 ≠ 凭证已持久化

**这是开票操作中最危险的陷阱。**

```
BAPI 返回成功                  ✅  但不代表写入了数据库
VBRK 查不到记录                ❌  幽灵凭证
根因：BAPI_TRANSACTION_COMMIT 未调用  →  数据只活在 SAP 内存中
```

- `create-billing.js` **已自动执行 COMMIT + 查 VBRP 验证**
- **开票后必须人工验证：** 查 VBRK 或重跑 `fetch-delivery-data` 确认 FKSTA 变更为已开票

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BILLING_LOG_PATH` | 开票日志路径 | `~/.openclaw/billing-log.jsonl` |
| `SAP_BILLING_WORKSPACE` | Excel 输出目录 | `~/.openclaw/workspace` |
| `RFC_PROXY_PORT` | 代理端口 | `9876` |
| `RFC_PROXY_LOG` | 代理日志路径 | `/tmp/rfc-proxy.log` |

---

## 表结构文档

`metadata/tables/` 下包含以下 SAP 表的字段定义：

- `LIKP` — 交货单抬头
- `LIPS` — 交货单行项目
- `VBRK` / `VBRP` — 开票凭证抬头/行项目
- `KNA1` — 客户主数据
- `MARA` / `MAKT` — 物料主数据/物料描述

---

## 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `ECONNREFUSED 127.0.0.1:9876` | RFC 代理未启动 | `bash auto-proxy.sh` |
| HTTP 502 | SAP 后端未就绪 | 等 10 秒重试；kill 旧代理重启 |
| `ERR_DLOPEN_FAILED` | 找不到 `libsapnwrfc.so` | 检查 `LD_LIBRARY_PATH` 含 SDK lib |
| ADT 缓存不一致 | 偶发 | 脚本已内置 FKSTA 双向验证 |

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)

> **注意**：NW-RFC-SDK 是 SAP 专有软件，需从 SAP 官方渠道获取，不包含在本仓库中。
