# 幽灵凭证教训

## 现象
BAPI_BILLINGDOC_CREATEMULTIPLE 返回成功，但 VBRK 中查不到对应凭证。

## 根因
未调用 BAPI_TRANSACTION_COMMIT。BAPI 成功只意味着内存中的 Function Module 执行成功，
数据并未写入 SAP 数据库。RFC 连接关闭后数据回滚。

## 检测方式
1. `create-billing.js` 开票后自动查 VBRP 验证金额
2. 人工可通过 `fetch-delivery-data --vbeln` 查看 FKSTA 状态
3. 或直查 VBRK

## 修复
- create-billing.js 加入 BAPI_TRANSACTION_COMMIT
- SKILL.md 新增"核心警告"节
