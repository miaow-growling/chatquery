# 智询 (ChatQuery) 阿里云 OSS 自动化发布与配置指南

本项目已实现桌面端安装包**构建后自动上传到阿里云 OSS**的能力，兼顾**本地终端一键打包上传**与 **CI/CD 云端流水线自动构建上传**。

---

## 一、阿里云 OSS 准备工作

### 1. 创建 Bucket
1. 登录 [阿里云 OSS 控制台](https://oss.console.aliyun.com/)。
2. 新建一个 Bucket（例如 `chatquery-releases`）：
   - **地域 (Region)**：选择离目标用户最近的地域（例如 `oss-cn-hangzhou`、`oss-cn-shanghai` 等）。
   - **读写权限 (ACL)**：选择 **公共读 (Public Read)**，以便用户可以通过 HTTP(S) 直接下载安装包。
   - 存储类型推荐：**标准存储**。

### 2. 创建专用 RAM 用户（推荐最小权限）
为了账号安全，请勿使用主账号 AccessKey。建议在 [RAM 访问控制台](https://ram.console.aliyun.com/) 创建专门用于发布的 RAM 用户：
1. 创建 RAM 用户并勾选 **OpenAPI 调用访问**，记录生成的 `AccessKey ID` 与 `AccessKey Secret`。
2. 为该 RAM 用户添加自定义权限策略（仅允许向发布目录上传文件）：
```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:ListObjects"
      ],
      "Resource": [
        "acs:oss:*:*:your-bucket-name",
        "acs:oss:*:*:your-bucket-name/chatquery/releases/*"
      ]
    }
  ]
}
```
*（请将 `your-bucket-name` 替换为你实际的 Bucket 名称）*

---

## 二、本地一键打包与自动上传

### 1. 配置本地密钥（一次性配置）
在项目根目录下，复制模板文件并填写实际配置：
```bash
cp .env.oss.example .env.oss
```
编辑 `.env.oss`（该文件已加入 `.gitignore`，不会被提交）：
```env
OSS_ACCESS_KEY_ID=LTAI5txxxxxxxxxxxxxxxx
OSS_ACCESS_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OSS_BUCKET=chatquery-releases
OSS_REGION=oss-cn-hangzhou
OSS_PREFIX=chatquery/releases
# 可选：如果你给 Bucket 绑定了自定义 CDN 域名（如 https://download.example.com），在此填入
OSS_PUBLIC_DOMAIN=

# 自动更新签名私钥（用于生成防篡改签名文件 .sig，由 tauri signer 生成）
TAURI_SIGNING_PRIVATE_KEY="dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5C..."
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

### 2. 常用操作命令
在项目根目录下操作：

- **打包并一键自动上传至 OSS（含签名与应用内热更支持）**：
  ```bash
  npm run release:oss
  ```
- **仅上传已有构建产物（不重新编译）**：
  ```bash
  npm run upload:oss
  ```
- **测试预览（Dry-Run 模式，不实际连接与上传）**：
  ```bash
  npm run upload:oss -- --dry-run
  ```

---

## 三、CI/CD 云端自动化发布

### 1. GitHub Actions 自动上传
当你在 GitHub 推送版本标签（如 `git push origin v0.1.0`）时，`.github/workflows/build-windows.yml` 会自动在 Windows 环境编译并上传至 OSS。

**需要在 GitHub 仓库中配置的 Secrets**：
进入 GitHub 仓库 -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**：
- `OSS_ACCESS_KEY_ID`：RAM 用户的 AccessKey ID
- `OSS_ACCESS_KEY_SECRET`：RAM 用户的 AccessKey Secret
- `OSS_BUCKET`：Bucket 名称（如 `chatquery-releases`）
- `OSS_REGION`：（可选，默认 `oss-cn-hangzhou`）
- `OSS_PREFIX`：（可选，默认 `chatquery/releases`）
- `OSS_PUBLIC_DOMAIN`：（可选，自定义 CDN 域名）
- `TAURI_SIGNING_PRIVATE_KEY`：Tauri 签名私钥（用于 Windows 增量更新包签名）
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码（无密码则为空）

*注：若未配置上述 Secrets，CI 会自动发出 Warning 并跳过上传，不会导致流水线报错。*

### 2. Azure Pipelines 多平台自动打包与上传 (Windows / macOS / Linux)
在 Azure DevOps 的 `Library -> aliyun-oss-chatquery` 变量组中配置好变量后：
- 推送版本标签（如 `git push azure v0.1.1`）或在 Azure 网页点击「Run pipeline」；
- 流水线将依次启动：
  1. **Windows 构建 (windows-latest)**：生成 NSIS 安装包 `.exe` 与免安装绿色版；
  2. **macOS 构建 (macos-14 Apple Silicon)**：生成 `.dmg` 安装包与 `.app.tar.gz` 热更新包；
  3. **Linux 构建 (ubuntu-latest)**：安装 WebKitGTK 依赖并生成 `.AppImage` 与 `.deb`；
- 各平台独立完成签名，并通过智能增量合并自动将全平台产物与哈希汇总上传到同一个 OSS `latest.json` 中。

---

## 四、Tauri 应用内无感自动更新 (In-App Auto-Updater) 机制

本项目已完整集成 Tauri v2 官方 Updater：
1. **客户端自动检测**：应用启动时异步请求 OSS 上的 `latest.json`。
2. **应用内一键下载**：点击更新后，直接在应用内弹窗显示平滑进度条，从 OSS 下载签名增量包。
3. **数字签名校验**：自动校验 Ed25519 签名，防篡改劫持。
4. **一键重启生效**：下载完毕点击「立即重启软件」即可完成替换，全流程无需打开浏览器或运行安装向导。

---

## 五、对象存储目录规范与下载地址

上传成功后，OSS 中的目录结构如下：
```text
chatquery/releases/
├── v0.1.0/
│   ├── 智询_0.1.0_x64-setup.exe       # Windows 安装包 (NSIS)
│   ├── 智询_免安装绿色版.exe           # Windows 免安装便携版
│   ├── 智询_0.1.0_aarch64.dmg         # macOS 安装包
│   ├── 智询.app.tar.gz                # macOS 应用内热更新增量包
│   ├── 智询.app.tar.gz.sig            # 增量包数字签名
│   └── SHA256SUMS.txt                 # 本版本所有产物的哈希校验清单
└── latest.json                        # 符合 Tauri v2 规范的最新版本清单与签名
```

### 1. 固定最新版本清单地址
```text
https://<bucket>.<region>.aliyuncs.com/chatquery/releases/latest.json
```
`latest.json` 会在每次发布时自动更新，并禁用了浏览器与 CDN 强缓存（`no-cache`），内容包含：
- 最新版本号 (`version`)；
- 发布时间戳 (`release_date`)；
- 各平台完整下载直链 (`url`)；
- 对应的文件大小与 SHA256 校验值。

### 2. 官网或用户下载对接建议
- **官网下载按钮**：前端可通过 `fetch('/chatquery/releases/latest.json')` 动态获取当前最新版本的真实下载链接，无需每次发版都重新修改官网代码。
- **不可变安装包缓存**：版本化路径下的 `.exe` 与 `.dmg` 文件已自动设置长达一年的不可变缓存头（`immutable`），下载速度极快且节省 CDN 回源流量。
