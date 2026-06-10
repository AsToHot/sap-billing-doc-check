# SAP 智能开票 · OpenClaw Skill

> **OpenClaw 技能包** — 为 AI Agent 设计的 SAP SD 模块对账开票自动化能力。
>
> 本仓库是 **OpenClaw AgentSkill** 的完整实现案例，需配合 OpenClaw 智能体框架使用，不能脱离 Agent 独立运行。

---

## 这是什么

一个 **OpenClaw AgentSkill**，让 AI Agent 能够通过自然语言指令完成 SAP 开票全流程：

- 用户说"查一下昨天发货"→ Agent 自动执行 `fetch-delivery-data.js`
- 用户说"把这些开票"→ Agent 解析 Excel/图片，自动调用 `create-billing.js` 执行 VF01
- 用户说"冲销 9000000675"→ Agent 调用 `--cancel` 执行 VF11

**触发词**：`对账开票` | `开票` | `VF01` | `VF11` | `未开票` | `发货记录` | `交货单`

---

## 技能架构

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────┐
│   OpenClaw      │────→│  Skill 脚本   │────→│  RFC Proxy   │────→│ SAP │
│   AI Agent      │     │  (Node.js)   │     │  (node-rfc)  │     │     │
│                 │     │              │     │              │     │     │
│ 用户: "查发货"   │     │ fetch-*.js   │     │ 9876 端口     │     │ ADT │
│ 用户: "开票"     │     │ create-*.js  │     │ SADT_REST_   │────→│ SQL │
│ 用户: "冲销"     │     │ parse-*.py   │     │ RFC_ENDPOINT │     │ BAPI│
└─────────────────┘     └──────────────┘     └──────────────┘     └─────┘
```

**RFC Proxy** (`rfc-proxy-server.js`) 是关键桥接层：ADT REST 不支持 RFC/SAP Router，代理将其转为 `node-rfc` 调用。

---

## 技能组件

| 组件 | 文件 | 作用 |
|------|------|------|
| **SKILL.md** | `SKILL.md` | 技能定义文件（触发词、命令速查、故障排查） |
| **发货查询** | `scripts/fetch-delivery-data.js` | LIKP+LIPS+VBRP 多表联查，JSON/Excel 输出 |
| **开票(VF01)** | `scripts/create-billing.js` | BAPI_BILLINGDOC_CREATEMULTIPLE，自动 COMMIT + VBRP 验证 |
| **冲销(VF11)** | `scripts/create-billing.js --cancel` | BAPI_BILLINGDOC_CANCEL1，交互式确认 |
| **Excel 解析** | `scripts/parse-excel.py` | 用户上传 Excel → 开票数据批量导入 |
| **图片 OCR** | `scripts/parse-image.py` | 用户上传图片 → 单据号识别 |
| **多维报表** | `scripts/dimension-report.py` | 客户/物料/销售组织多维度 Excel 统计 |
| **日报** | `scripts/daily-billing-report.js` | 读取开票日志，生成昨日汇总 |
| **RFC 代理** | `rfc-proxy-server.js` | HTTP → RFC 桥接，解决 ADT 协议限制 |
| **表结构** | `metadata/tables/*.md` | LIKP/LIPS/VBRK/VBRP/KNA1/MARA/MAKT 字段文档 |
| **SQL 参考** | `references/*.sql` | 未开票查询、贷项查询、排除已开票等 SQL 模板 |

---

## 安装（OpenClaw 环境）

```bash
# 1. 克隆到 OpenClaw skills 目录
cd ~/.openclaw/workspace/skills
git clone https://github.com/AsToHot/sap-billing-doc-check.git

# 2. 安装依赖
cd sap-billing-doc-check
npm install

# 3. 配置 SAP 连接
cp .env .env.local  # 编辑 .env.local 填入实际参数

# 4. 下载 NW-RFC-SDK（SAP 专有，需自行获取）
# 放置到 NW-RFC-SDK/nwrfcsdk/ 目录

# 5. 启动 RFC 代理
bash auto-proxy.sh
```

---

## 配置说明

`.env` 模板：

```bash
# SAP target system URL（仅用于提取 ashost）
SAP_URL=http://your-sap-host:3300

# SAP Client & System Number
SAP_CLIENT=XXX
SAP_SYSNR=XX

# Authentication
SAP_USERNAME=YOUR_USER
SAP_PASSWORD=YOUR_PASS

# Connection type: rfc（支持 SAP Router）或 http
SAP_CONNECTION_TYPE=rfc

# SAP Router（如有）
# SAP_ROUTER=/H/router-host
```

---

## Agent 调用示例

```bash
# Agent 查交货单（最近3月）
node scripts/fetch-delivery-data.js --client <KUNNR>

# Agent 按销售组织查
node scripts/fetch-delivery-data.js --vkorg <VKORG>

# Agent 单号直查
node scripts/fetch-delivery-data.js --vbeln <VBELN>

# Agent 开票（先 testrun 确认）
node scripts/create-billing.js --testrun '<JSON>'

# Agent 正式开票
node scripts/create-billing.js '<JSON>'

# Agent 冲销
node scripts/create-billing.js --cancel <BillingDoc>

# Agent 查看日志
node scripts/create-billing.js --show-log
```

---

## ⚠️ 核心警告：幽灵凭证

**BAPI 返回成功 ≠ 数据已持久化。**

```
BAPI 返回成功                  ✅  但不代表写入了数据库
VBRK 查不到记录                ❌  幽灵凭证
根因：BAPI_TRANSACTION_COMMIT 未调用  →  数据只活在 SAP 内存中
```

- `create-billing.js` **已自动执行 COMMIT + 查 VBRP 验证**
- **Agent 开票后必须二次验证：** 查 VBRK 或重跑 `fetch-delivery-data` 确认 FKSTA 变更

---

## 故障排查（Agent 视角）

| 现象 | 原因 | Agent 解决 |
|------|------|-----------|
| `ECONNREFUSED 127.0.0.1:9876` | RFC 代理未启动 | 自动执行 `bash auto-proxy.sh` |
| HTTP 502 | SAP 后端未就绪 | 等 10 秒重试；kill 旧代理重启 |
| `ERR_DLOPEN_FAILED` | 找不到 `libsapnwrfc.so` | 检查 `LD_LIBRARY_PATH` 含 SDK lib |
| ADT 缓存不一致 | 偶发 | 脚本已内置 FKSTA 双向验证 |
| "无法确定开票类型" | VKORG 缺失 | 脚本自动查 LIKP 补全并重试 |

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BILLING_LOG_PATH` | 开票日志路径 | `~/.openclaw/billing-log.jsonl` |
| `SAP_BILLING_WORKSPACE` | Excel 输出目录 | `~/.openclaw/workspace` |
| `RFC_PROXY_PORT` | 代理端口 | `9876` |
| `RFC_PROXY_LOG` | 代理日志路径 | `/tmp/rfc-proxy.log` |

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)

> **注意**：NW-RFC-SDK 是 SAP 专有软件，需从 SAP 官方渠道获取，不包含在本仓库中。
