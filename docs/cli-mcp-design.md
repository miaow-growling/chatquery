# ChatQuery CLI & MCP 架构与功能设计方案 (v2.0)

> **状态**：正式规划  
> **面向对象**：外部 AI 工具（Cursor、Claude Code、ZCode、Windsurf、自主 Agent）及终端自动化脚本  
> **核心定位**：极轻量、高安全、Token 经济、无缝同步 GUI 状态的数据库感知与操作引擎  
> **主命令名**：`chatquery`（拒绝简写冲突，保持品牌与识别度唯一）  

---

## 1. 核心设计原则

1. **统一命令名 `chatquery`**：
   避免使用容易与其他 CLI 冲突的缩写（如 `cq`），全局统一使用 `chatquery`。例如：
   ```bash
   chatquery conn add ...
   chatquery mcp
   ```
2. **纯净无 Chat**：
   剥离多余的命令行对话界面。外部调用者（如 Cursor、Claude Code）本身就是高智能模型，它需要的是底层准确、安全、可预测的数据库基础设施驱动。
3. **与桌面应用（Desktop App）同源同打包**：
   - **一体化二进制**：构建时与 Tauri 桌面端一起编译打包，不拆分为分散零碎的发布物。
   - **自流转架构**：二进制根据入参自动分流——带 CLI/MCP 子命令时作为无头纯终端工具极速执行；无参数时正常启动 Tauri GUI 界面。
   - **启动时自动安装与就绪**：桌面应用在启动或安装时，自动在用户 PATH（如 `~/.local/bin/chatquery` 或 `/usr/local/bin/chatquery`）建立软链接，外部 AI 与终端开箱即用。
4. **共享底层加密数据存储**：
   - CLI / MCP 与桌面端 100% 读写同一份 SQLite 数据库（`~/.config/chatquery/app.db`）。
   - 在 CLI 中添加的环境、分组、连接，桌面端应用刷新后**立刻无缝呈现在左侧导航树**中。
5. **Token 极致节约与安全兜底**：
   - 专设 `prompt-ctx`，只提取大模型写 SQL 所需的关键约束与注释，比完整 DDL 节省 70% Token。
   - 默认只读（Safety by Default）、默认分页上限（LIMIT 50 兜底）、敏感数据自动脱敏（Masking）。

---

## 2. 桌面应用集成与分发架构 (Packaging & Lifecycle)

```
                       ┌────────────────────────────────────────┐
                       │   安装包: ChatQuery.dmg / .app / .deb   │
                       └───────────────────┬────────────────────┘
                                           │ 解压/安装
                                           ▼
            ┌──────────────────────────────────────────────────────────────┐
            │   /Applications/智询.app/Contents/MacOS/chatquery-desktop    │
            └──────────────┬───────────────────────────────┬───────────────┘
                           │                               │
                GUI 启动 (无命令行入参)          CLI / MCP 启动 (带子命令)
                           ▼                               ▼
                 Tauri GUI 窗口渲染                无头 Headless 极速运行
                           │                               │
            ┌──────────────┴──────────────┐                │
            │ App 启动自动探测并建立软链接 │                │
            │  ln -sf ... ~/.local/bin/   │                │
            │            chatquery        │                │
            └──────────────┬──────────────┘                │
                           ▼                               │
             $ chatquery conn add ...                      │
             $ chatquery mcp <────────────── stdio ────────┴──────── Cursor / Claude Code
```

### 2.1 一体化二进制分流机制
在 `src-tauri/src/main.rs` 的入口处进行参数分流：
- **分支 A（CLI / MCP 模式）**：检测到首个参数为非系统参数（如 `conn`, `env`, `group`, `meta`, `query`, `redis`, `guard`, `mcp` 等），直接初始化 `chatquery` core 库并进入对应的子命令处理，**完全跳过 Tauri Webview 和图形窗口初始化**，启动耗时 < 15ms。
- **分支 B（GUI 桌面模式）**：无参数启动，正常执行 Tauri Builder，渲染桌面主窗口。

### 2.2 启动即安装（Auto-Install Symlink）
桌面端在 GUI 启动的 `setup` 阶段自动执行：
1. 检查 `~/.local/bin/chatquery` 或 `/usr/local/bin/chatquery` 是否存在且指向自身；
2. 若不存在或版本不一致，自动创建/更新符号链接：
   ```bash
   ln -sf "/Applications/智询.app/Contents/MacOS/chatquery" "$HOME/.local/bin/chatquery"
   ```
3. 确保用户的 Shell PATH 生效。
4. 桌面端应用顶部菜单栏“智询”下同时提供：“安装命令行工具 (Install CLI)”一键菜单项，方便手动修复或提升权限。

---

## 3. CLI 命令功能规格 (`chatquery`)

全局通用选项：
- `--format <json|table>`：指定输出格式（终端环境默认友好表格，脚本/重定向环境默认 JSON）。
- 诊断、连接进度和服务日志统一输出至 `stderr`，不污染 `stdout`。

### 3.1 环境管理 (`chatquery env`)
- `chatquery env list [--type mysql|redis]`：列出环境（ID、名称、绑定库类型、子分组数）。
- `chatquery env add <name> [--type mysql|redis]`：
  - 示例：`chatquery env add "本地开发" --type mysql`
  - 输出：`{"id": "env_8f2a10b", "name": "本地开发", "type": "mysql"}`
- `chatquery env rename <id_or_name> <new_name>`：重命名环境。
- `chatquery env rm <id_or_name> [--force]`：删除环境。

### 3.2 分组管理 (`chatquery group`)
- `chatquery group list [--env <env_id_or_name>]`：列出指定或全部环境下的分组。
- `chatquery group add <name> --env <env_id_or_name>`：
  - 示例：`chatquery group add "订单中心" --env "本地开发"`
  - 输出：`{"id": "grp_3c49a1e", "name": "订单中心", "env_id": "env_8f2a10b"}`
- `chatquery group rename <id_or_name> <new_name>`：重命名分组。
- `chatquery group rm <id_or_name> [--force]`：删除分组。

### 3.3 连接管理 (`chatquery conn`) —— 核心基石

#### 1. DSN/URL 便捷添加（AI 极速录入）
```bash
chatquery conn add --name "order-master" \
  --url "mysql://app_user:pwd123@127.0.0.1:3306/orders" \
  --env "本地开发" --group "订单中心" \
  --create-parents --test
```
#### 2. 参数化添加（含 SSH 跳板机、SSL）
```bash
chatquery conn add --name "prod-pay" \
  --type mysql --host 10.0.2.15 --port 3306 \
  --user pay_admin --password "******" --database pay_center \
  --env "生产环境" --group "支付服务" \
  --ssh-host bastion.company.internal --ssh-port 22 --ssh-user ops --ssh-key ~/.ssh/id_rsa \
  --create-parents --test
```
* **核心参数特性**：
  - `--create-parents`：**AI 自动化无感知参数**。若 `--env` 或 `--group` 不存在，自动逐级创建并挂载，无需外部 AI 多次反复探测建表。
  - `--test`：先握手验证网络与密码（含跳板机），成功才写入本地 SQLite，失败直接抛出网络诊断。
* `chatquery conn list [--format json]`：列出连接（出于安全考量，**严格不返回明文密码**）。
* `chatquery conn test <id_or_name>`：单独测试连通性。
* `chatquery conn rm <id_or_name>`：删除指定连接。

### 3.4 资产拓扑全景 (`chatquery tree`)
```bash
chatquery tree --format json
```
AI 运行一次即可完整掌握本地所有的“数据库类型 -> 环境 -> 分组 -> 连接”层级树，无需盲猜连接名。

### 3.5 元数据与 Prompt 上下文 (`chatquery meta`)
- `chatquery meta tables <conn> [--filter "pattern*"]`：列出表名与中文表注释。
- `chatquery meta search <conn> <keyword>`：全局模糊搜索表名、表注释、列名及列注释。
- `chatquery meta schema <conn> <table_names...>`：获取字段类型、索引、约束等全量结构。
- `chatquery meta prompt-ctx <conn> <table_names...>`：**专为 AI Prompt 打造**。输出高度压缩的 Markdown 表结构与外键关系，最大程度节约输入 Token。

### 3.6 安全查询与诊断 (`chatquery query`)
- `chatquery query run <conn> "<sql>" [--limit 50] [--allow-write] [--mask] [--format json]`：
  - **默认只读（Safety by Default）**：严禁无授权写入。
  - **强制分页上限**：未指定时默认追加 `LIMIT 50`。
  - **脱敏集成**：`--mask` 自动给手机号、证件号等打码。
- `chatquery query explain <conn> "<sql>"`：获取执行计划与索引命中分析。

### 3.7 Redis 缓存探查 (`chatquery redis`)
- `chatquery redis keys <conn> "<pattern>"`
- `chatquery redis get <conn> <key> [--unserialize php|json]`：**原生 PHP 反序列化支持**，直接输出反序列化后的规范 JSON 数据。

### 3.8 离线语法与风险预审 (`chatquery guard`)
- `chatquery guard check "<sql>"`：不连库离线分析 SQL 风险（如缺失 WHERE、全表更新、DROP/TRUNCATE 危险）。

---

## 4. 标准 MCP Server 模式 (`chatquery mcp`)

### 4.1 接入配置
只要安装了桌面端（已自动完成 `chatquery` 软链接），在 Cursor、Claude Code、Windsurf 等编辑器的配置文件中填入：
```json
{
  "mcpServers": {
    "chatquery": {
      "command": "chatquery",
      "args": ["mcp"]
    }
  }
}
```

### 4.2 核心 MCP Tools 列表

| Tool 名称 | 核心参数 | 作用说明 |
| :--- | :--- | :--- |
| `cq_list_topology` | 无 | 获取环境/分组/连接完整拓扑树 |
| `cq_add_connection` | `name`, `url` (或各独立参数), `env`, `group`, `create_parents`, `test` | 动态添加数据库连接并持久化 |
| `cq_add_environment` | `name`, `type` | 添加新环境 |
| `cq_add_group` | `name`, `env_name_or_id` | 在指定环境下添加分组 |
| `cq_list_tables` | `connection`, `filter` | 获取表清单及业务注释 |
| `cq_search_tables` | `connection`, `keyword` | 全库模糊搜索表和字段 |
| `cq_get_table_schema` | `connection`, `tables`, `compact` | 获取表结构（`compact=true` 适合塞入上下文） |
| `cq_execute_query` | `connection`, `sql`, `limit`, `allow_write` | 安全执行 SQL 并返回结构化结果 |
| `cq_explain_query` | `connection`, `sql` | SQL 执行计划与性能瓶颈诊断 |
| `cq_redis_get` | `connection`, `key`, `unserialize_php` | 读取 Redis 缓存（支持 PHP 反序列化） |

---

## 5. 实施演进步骤

1. **Step 1：双模入口改造与环境/分组/连接闭环（当前重心）**
   - 改造 `src-tauri/src/main.rs`：无命令行参数进 Tauri GUI；有子命令直接进入 Headless CLI/MCP 模式。
   - 实现启动时自动在 `~/.local/bin/chatquery` 注入软链接机制。
   - 实现 `chatquery env`、`chatquery group`、`chatquery conn add`（支持 `--url`、`--create-parents`、`--test`）及 `chatquery tree`。
   - 终端添加连接 -> 打开/刷新桌面端，验证左侧树完美同步。

2. **Step 2：元数据与安全查询能力**
   - 实现 `chatquery meta tables/schema/search/prompt-ctx`。
   - 实现 `chatquery query run/explain`（强制限制、只读护栏）。

3. **Step 3：Redis 与离线 Guard**
   - 实现 `chatquery redis`（结合 PHP 反序列化）与 `chatquery guard`。

4. **Step 4：标准 MCP Server (Stdio)**
   - 实现 `chatquery mcp` 命令，注册标准 MCP Tools 协议。
   - 在 Cursor / Claude Code 中实测接入联动。
