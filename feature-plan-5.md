# ChatQuery 功能轻量规划（导入导出 / 模板采用 YAML）

> 基于当前 ChatQuery 现状（MySQL URL 直连、ConnInput/ConnectionConfig 字段简单、测试连接按钮已存在）。

---

## 1. SSL/TLS 连接加密

**Why**：生产环境强制加密；没有 TLS 选项会被 DBA/安全策略直接拒绝。

**关键实现**
- `ConnectionConfig` / `ConnInput` 新增字段：`ssl_mode`（Disabled/Preferred/Required/VerifyCa/VerifyIdentity）、`ssl_ca`（可选 CA 路径/内容）、`client_cert` / `client_key`（双向 TLS 可选）。
- `mysql.rs` 的 `connect_pool_db` 从纯 URL 字符串改为 `MySqlConnectOptions` 程序化构建，按字段设 `ssl_mode`、`ssl_ca`、`ssl_client_cert`、`ssl_client_key`。
- 前端连接表单新增"SSL 模式"下拉 + 可选 CA/证书文件选择器（Tauri 可用 dialog 选文件）。
- Redis 同理：很多 Redis 云实例启用了 TLS，`redis-rs` 支持 `rediss://` 或 `RedisConnectionInfo` 加 TLS builder。

**Non-goals**
- 不做系统证书商店的自动检测（先让用户手动选 CA 文件）。
- 不做证书过期自动提醒（可在后续 health check 里扩展）。

**复杂度**：中低。sqlx/redis 原生支持，主要工作是配置 DTO + 表单 + 文件选择器。

**依赖**：无。

---

## 2. SSH 隧道 / 跳板机

**Why**：企业内网 MySQL/Redis 大多只开内网 IP，必须经 SSH 跳板机才能访问；没有 SSH 隧道就打不开生产库。

**关键实现**
- `ConnectionConfig` 新增 `ssh` 可选块：`ssh_host`、`ssh_port`、`ssh_user`、`ssh_auth_kind`（密码 / 私钥 / agent）、`ssh_password`、`ssh_private_key`（加密落盘，同 ADR-010）。
- 后端两种实现路径（二选一）：
  - **MVP**：用系统 `ssh -L local_port:db_host:db_port user@ssh_host -N` 子进程做本地端口转发，成本低但依赖用户系统有 ssh。
  - **纯 Rust**：引入 `russh` crate 自己实现客户端+端口转发，不依赖系统 ssh，但工程量和包体积上升明显。
  - 建议先做系统 ssh 子进程的 MVP，验证需求后再决定是否迁移 russh。
- 生命周期：连接查询时检查隧道是否已建立，未建立则 spawn；查询结束后保持一小段 TTL，避免反复 spawn；隧道进程崩溃要自动重连并提示。
- MySQL 实际连接目标变成 `127.0.0.1:<local_port>`，用户名/密码/SSL 仍走原有逻辑。

**Non-goals**
- 不做 SSH 堡垒机的多跳跳板（单跳足够 MVP）。
- 不做 SSH 会话的交互式 shell / SFTP。
- 不（短期）做 `russh` 纯 Rust 实现。

**复杂度**：中。系统 ssh 子进程方案实现快，但生命周期管理和错误提示要做好。

**依赖**：建议排在 SSL/TLS 之后，因为通过 SSH 隧道后再连 DB，SSL 选项仍可叠加使用。

---

## 3. EXPLAIN 可视化（树 / 火焰图）

**Why**：当前 EXPLAIN 只是表格，排查慢查询时看 `id`、`select_type`、`key`、`rows`、`Extra` 很费力；树/火焰图能一眼看出全表扫描和成本瓶颈。

**关键实现**
- 后端新增命令 `explain_visual(conn_id, query, db) -> ExplainTree`：
  - MySQL 8.0.18+ 用 `EXPLAIN FORMAT=JSON ...` 或 `EXPLAIN ANALYZE ...` 拿结构化执行计划。
  - 老版本回退 `EXPLAIN ...` 表格，再手工按 `id` 列构造简单父子关系。
- 新 DTO `ExplainNode { id, name, cost, rows, type, children, details }` 返回前端。
- 前端结果子标签增加"执行计划"（与"数据"/"表结构"/"表关系"并列），用 D3/echarts 或简单 SVG 渲染：
  - **树视图**：节点 = table/index/subquery，连线 = 父子/依赖关系，颜色 = 扫描类型（全表扫描标红、走索引标绿）。
  - **火焰图**：按 `cost` 或 `rows * cost` 横向条形展示，越长越需要优化。
- 与现有 `explain_query` 命令共存：原表格版保留，新增可视化命令。

**Non-goals**
- 不做索引优化建议 AI（可后续让 LLM 读 ExplainTree 再生成建议）。
- 不做 MySQL 8 以下版本的完整图形化（老版本回退表格）。
- Redis 无 EXPLAIN，保持现有提示。

**复杂度**：中。后端解析 JSON 执行计划不难，前端可视化组件需要一定打磨。

**依赖**：无。

---

## 4. 网格内筛选 / 排序 / 搜索

**Why**：分页结果通常只有 200 行，但在 200 行里找某条记录仍然费劲；列头排序和全局搜索是专业 DB 工具标配。

**关键实现**
- 前端纯功能，作用在当前内存中的结果集（对 MySQL browse / 任意 SELECT / Redis 列表）。
- **全局搜索**：结果区顶部加输入框，按行匹配任意单元格（大小写可选敏感）。
- **列排序**：点击列头切换升/降序；数字列按数值排，字符串按字典序，日期按时间戳。
- **列筛选**：每列头右键或悬停弹出筛选框，支持：包含 / 等于 / 不等于 / 为空 / 非空 / 数值范围。
- 与分页解耦：筛选/排序只影响**当前页**的展示，不重新查询 DB；底部状态栏显示"显示 N / 共 M 行"。
- 状态保存在前端 tab 级（切 tab / 重新查询时清空）。

**Non-goals**
- 不做服务端排序/筛选（不改写 SQL ORDER BY / WHERE），避免复杂度爆炸。
- 不做跨页筛选（当前页 200 行内搜索）。

**复杂度**：低。纯 React 状态 + 渲染过滤。

**依赖**：无。

---

## 5. 连接的导入导出（YAML 格式，支持跨机器）

**Why**：换机器、团队内分享连接结构、备份环境配置时都需要；手动重建几十个连接很痛苦。当前本机密码用机器 KEK（`~/.config/chatquery/key`）AES 加密，该 KEK 不随导出走，旧方案无法跨机器——现通过"系统配置 → 加密密钥配置"（见 `feature-spec-system-config-key.md`）提供一把可跨机器一致的密钥 K 来根治，本第 5 项直接复用 K。

**跨机器机制（重要变更）**：原"每次导出设 PBKDF2 口令"方案已**作废**——跨机器能力上移到"系统配置 → 加密密钥配置"（见独立 PRD `feature-spec-system-config-key.md`）。用户在系统配置里设一个密钥字段，确定性派生出便携密钥 K 用于加密连接密码；两台机器填相同字段即可互相解密导出的密码。本第 5 项直接复用该 K，不再叠加导出级口令。

**导出（两种模式）**
- **加密导出（`cipher:"system-key"`，默认且需先配置系统密钥）**：密码 blob 即用系统密钥 K 加密的密文（与本地落盘同一把 K）。只要目标机器在系统配置填了相同密钥字段，导入即自动解密——天然跨机器。
  - 处于**默认模式（未配置系统密钥）**时，此选项**置灰**，提示"请先在系统配置设置加密密钥以支持跨机器"；仅允许明文导出。
  - 非敏感字段（host/port/user/db/容器）始终明文，便于人工审阅 YAML。
- **明文导出（`cipher:"none"`，显式可选）**：YAML 直接含 `password` 明文——满足你点名要的"明文密码导入"。UI 红色警告"文件含明文密码，请勿经不安全渠道传输"，需显式勾选，不做默认。

**YAML 结构示例（导出/导入同构）**
```yaml
format: chatquery-connections
version: 1
cipher: system-key      # none = 明文；system-key = 系统密钥加密
connections:
  - name: 主库
    db_type: mysql
    env: 生产环境
    group: 订单库
    host: 10.0.0.1
    port: 3306
    user: dba
    password: "<system-key 密文 或 明文>"
    database: orders
    ssl_mode: disabled
    ssh_host: ""
    ssh_port: 22
    ssh_user: ""
    ssh_auth_kind: password
    ssh_password: ""
```

**导入逻辑**
- Tauri 命令 `import_connections(yaml_text) -> ImportResult`：按扩展名/内容**优先 YAML 解析**，JSON 作为兼容回退；自动识别 cipher。
  - `system-key`：用本机 K 解密；**失败给出明确引导**"本机未配置匹配的加密密钥，请在系统配置 → 加密密钥配置填入导出时使用的密钥后重新导入"（而非笼统"解密失败"）。
  - `none`：password 直用（明文导入诉求）。
- 每个连接/容器重新生成 id，避免冲突；容器按 name 合并（同名环境合并、同名分组在对应环境下合并，不存在则新建）。
- 解密出的明文密码**立即经本机 KEK 重新加密落盘**（现有 add/update 流程已做）——导入后本机仍安全，仅传输中的 YAML 文件按其策略保护。
- 返回统计：导入 N 连接 / M 容器 / K 密码待补填。

**Non-goals**
- 不做 CSV/Excel 格式的连接导出（YAML 足够结构化）。
- 不做跨应用导入 Navicat/DBeaver（后续可扩展）。
- 不导出本机密钥：`~/.config/chatquery/key`（KEK）与系统密钥字段都**绝不随连接文件走**——跨机器靠"用户口口相传填相同字段"，而非导出密钥。
- 明文导出不做"默认"，需用户显式选择并确认风险。

**复杂度**：低~中。YAML 序列化（`serde_yaml`，需新增依赖） + 容器合并 + 复用系统密钥 K 解密（无需 PBKDF2；`hkdf`/`sha2` 已在依赖树）。

**依赖**：**系统配置 / 加密密钥配置 PRD 必须先做**（K 是本功能跨机器的前置）。新增 `serde_yaml` 依赖（src-tauri/Cargo.toml）；`serde_json` 保留供内部/兼容回退。
**YAML 实现注意**：① 导入按扩展名/内容优先 YAML 解析，JSON 作为兼容回退（serde_json 已在）；② 导出时字符串字段（尤其 password）由 serde_yaml 自动加引号，避免 `:`、特殊字符被误解析；③ YAML 缩进敏感，解析失败报错需带行号；④ `yes/no/true` 等会被 YAML 解析为布尔，连接字段均为字符串故无碍，但模板占位值建议显式引号。
**合规风险**：明文导出属高危，UI 必须醒目警告；默认走系统密钥加密以符合"默认安全"原则（与 ADR-012 同源）。

---

## 6. 连接导入模板（YAML 模板）

> 格式选择（2026-07-30 确认选 JSON，后改为 YAML）：**YAML 模板**（与导出格式同源，比 JSON 少括号引号，更适合"按模板填"，手工/程序都能用）。CSV 不做（用户已选 YAML）。

**Why**：手工在 UI 里一个个建几十个连接很反人性；给一份带占位符的 YAML 模板，复制多份填值后一次性导入，批量建连接。复用第 5 项的导入管道，几乎零新增解析成本。

**模板内容（下载即得一份样板）**
- 新增 Tauri 命令 `export_template() -> String`：返回一份合法的 YAML 导入结构，内含 **1 条带占位符的样板连接**，供用户复制 N 份填值。
- 结构**与导出格式一致**（`format/version/cipher` + `connections` 数组）；连接对象用 **env / group 名称**（非 id，便于人工填），导入时按 name 解析成容器（复用第 5 项合并逻辑）。
- 字段含核心 + 可选高级（与第 1/2 项对齐，提前预留列）：

```yaml
format: chatquery-connections
version: 1
cipher: none
connections:
  - name: "示例连接-请改名"
    db_type: mysql
    env: "生产环境"
    group: "订单库"
    host: "127.0.0.1"
    port: 3306
    user: "root"
    password: "请填密码"
    database: "mydb"
    ssl_mode: disabled
    ssh_host: ""
    ssh_port: 22
    ssh_user: ""
    ssh_auth_kind: password
    ssh_password: ""
```

**导入（完全复用第 5 项 `import_connections`）**
- 用户填好的模板本质就是 `cipher:"none"` 的 YAML 导入文件 → 走明文导入路径：password 直填 → 按 name 合并 env/group 容器 → id 重生成 → 导入后本机 **KEK 重加密**（若已配置系统密钥则 K）。
- **校验（新增，轻量）**：
  - 必填缺失（host / user 为空，或 name 为空）→ 该行跳过并在结果汇总"跳过 K 条（缺必填）"。
  - 命中明显占位符（`{{...}}` / `CHANGE_ME` / `请填` / `example.com` / `127.0.0.1` 视情况）→ 黄色警告但**不阻断**，让用户自己确认。
- 支持顶层含 `connections:` 列表，或根即为单个连接映射两种写法。

**Non-goals**
- 不做 CSV 模板（用户已选 YAML）。
- 不做模板内的"变量 / 环境变量替换"（保持直填直导，避免引入模板引擎）。
- 不做字段级格式强校验（如端口非数字、host 非法字符）——交给底层连接测试/建连时报错，模板只做必填 + 占位符检查。
- 模板本身不含密码加密（明文填，落盘时由本机密钥加密，与第 5 项一致）。

**复杂度**：低~中。`export_template` 是无逻辑 YAML 生成；导入 100% 复用第 5 项，仅加必填/占位符两条校验。

**依赖**：**第 5 项（import_connections 管道）必须先做**；系统密钥 PRD 决定落盘用的是 K 还是 KEK。
**合规风险**：模板里是明文密码，UI 在"下载模板"和"导入"处均提示"文件含明文密码，请勿经不安全渠道传输/留存"。

---

## 推荐实现顺序

按"价值/复杂度比 + 基础设施依赖"排：

1. **系统配置 · 加密密钥配置**（1~1.5 周，中复杂度，是连接导入导出的前置，根治跨机器）——详见 `feature-spec-system-config-key.md`
2. **连接导入导出 YAML（.yaml）**（0.5~1 周，复用系统密钥 K，低风险，立刻解决备份/迁移痛点）
3. **连接导入模板（YAML）**（0.5 周，复用第 5 项导入管道 + 一个 `export_template` 命令，批量建连接的刚需）
4. **网格筛选 / 排序 / 搜索**（1 周，纯前端，天天用）
5. **SSL/TLS 连接加密**（1–2 周，企业生产必备）
6. **SSH 隧道 / 跳板机**（2–3 周，企业内网必备，可先用系统 ssh 子进程 MVP）
7. **EXPLAIN 可视化**（2 周，查询调优专业感，依赖 EXPLAIN FORMAT=JSON）

如果资源只能做两个，建议先做 **SSL/TLS + SSH 隧道**——这是企业采用的硬门槛，其他功能都属于"更好用"。若涉及换机/共享连接/批量建连，则把"系统配置·加密密钥 + 导入导出 + 模板"提前到最前。
