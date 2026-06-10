# NW-RFC-SDK 占位说明

本目录用于放置 **SAP NetWeaver RFC SDK**。

## 当前环境信息

| 项目 | 值 |
|------|-----|
| 版本 | **7.50** |
| 平台 | Linux x86_64 |
| 核心文件 | `libsapnwrfc.so`, `libsapucum.so` |

## 获取方式

### 1. SAP 官方（推荐）
- [SAP Support Portal - NW-RFC-SDK](https://support.sap.com/en/nwrfcsdk.html)
- 需要 SAP S-User 账号
- 下载对应平台的 SDK 压缩包

### 2. GitHub 社区镜像（搜索）
- GitHub 搜索 `nwrfcsdk` 或 `SAP NW-RFC-SDK`
- 注意：社区镜像可能版本较旧，仅供测试

## 安装步骤

```bash
# 1. 下载 SDK 后解压
# 2. 将 nwrfcsdk/ 目录放置到本位置：
#    NW-RFC-SDK/nwrfcsdk/
#    包含：bin/ demo/ doc/ include/ lib/

# 3. 验证 lib 目录存在
ls NW-RFC-SDK/nwrfcsdk/lib/libsapnwrfc.so

# 4. 启动代理时自动加载
bash auto-proxy.sh
```

## 各平台文件名对照

| 平台 | 核心库文件 |
|------|-----------|
| Linux x86_64 | `libsapnwrfc.so` |
| Windows x64 | `sapnwrfc.dll` |
| macOS (Intel) | `libsapnwrfc.dylib` |
| macOS (Apple Silicon) | `libsapnwrfc.dylib` (需 Rosetta 或 ARM 版本) |

## 许可证声明

> SAP NetWeaver RFC SDK 是 SAP SE 的专有软件。
> 使用需遵守 SAP Software License Terms。
> 本仓库仅提供集成脚本，不包含 SDK 本身。
