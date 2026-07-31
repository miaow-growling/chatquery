# ChatQuery 功能实现主计划（2026-07-30）

> 文档性质：本期（7 项功能）的**单一事实来源（single source of truth）**。
> 来源：合并自 `feature-plan-5.md`（导入导出 / 模板 / 网格 / SSL / SSH / EXPLAIN 轻量规划）+ `feature-spec-system-config-key.md`（系统配置·加密密钥完整 PRD）。本文件生成后，两份旧文档即视为被取代。
> 角色：产品通（PM）。信条：产品经理不是需求搬运工，是价值判断官。

---

## 0. 本期全景（Why 优先）

本期要做的 7 项功能构成一条清晰的产品线，按价值递进：

**企业敢用（采用门槛）→ 查询调优（专业感）→ 数据查看效率（日常高频）→ 连接资产管理（备份/迁移/批量）**

| # | 功能 | 一句话价值 | 复杂度 | 依赖 |
|---|------|-----------|--------|------|
| 0 | **系统配置 · 加密密钥** | 治本：让连接密码可跨机器一致解密（其余导入/模板的底座） | 中 | 无 |
| 1 | 连接导入导出（YAML） | 换机/分享/备份连接，跨机器安全迁移 | 低~中 | #0 |
| 2 | 连接导入模板（YAML） | 按模板批量建几十个连接 | 低~中 | #1 |
| 3 | 网格筛选 / 排序 / 搜索 | 200 行结果里秒找目标，专业工具标配 | 低 | 无 |
| 4 | SSL/TLS 连接加密 | 生产库强制加密，否则被 DBA 拒 | 中低 | 无 |
| 5 | SSH 隧道 / 跳板机 | 企业内网只开内网 IP，不跳板打不开库 | 中 | #4（可叠加） |
| 6 | EXPLAIN 可视化（树/火焰图） | 一眼看出全表扫描与成本瓶颈 | 中 | 无 |

> 资源若只能做两项：**优先 #4 + #5（SSL/SSH）**——这是企业采用的硬门槛。若涉及换机/共享/批量建连，**#0+#1+#2 提前到最前**（治本 + 立刻可用）。

---

## 1. 跨切面关注点（先读这节）

### 1.1 双层密钥模型（#0 的底座，#1/#2 共用）

| 层 | 名称 | 来源 | 用途 | 是否导出 |
|----|------|------|------|----------|
| 机器密钥 | **KEK** | 首次运行随机生成，存 `~/.config/chatquery/key`（0600） | ①加密 K 落盘；②加密 AI api_key（本机）；③作为默认 K | 否（永不） |
| 可配置密钥 | **K** | 由用户在系统配置填的**密钥字段**经 KDF 确定性派生 | 加密**连接密码**（含导出密文） | 否（仅"密钥字段"在用户脑中跨机器） |

- **K 可移植，KEK 机器绑定**。跨机器靠"用户把相同密钥字段填到两台机器"，K 本身绝不落导出文件、也不明文存本机。
- 派生：`K = HKDF-SHA256(salt=APP_FIXED_SALT, info="chatquery:conn-key:v1", ikm=key_field_bytes) → 32 bytes`。`APP_FIXED_SALT` 为硬编码常量（保证可复现）；`hkdf`/`sha2` 已在依赖树。
- 本机配置存 `~/.config/chatquery/keycfg.json`：`key_enc`（KEK 加密的 K，供本机启动恢复）、`token`（K 加密的常量，供"测试密钥"即时校验）。
- **向后兼容**：未配置 K 时 K = KEK，行为与今天 100% 相同，老用户零感知升级。
- 引入 K 后，**原"每次导出设 PBKDF2 口令"方案作废**——跨机器能力上移到系统级，更内聚。

### 1.2 统一 YAML 文件格式（#1/#2 共用）

- 导入/导出/模板**统一用 YAML**（`.yaml`）：比 JSON 少括号引号，更适"手工按模板填"。
- **层级结构（2026-07-30 采纳）**：文件按 `db_type → envs → groups → connections` 四级嵌套（以 `mysql:`/`redis:` 等为顶层键），直接镜像应用内连接树（环境/组为 ADR-016 一等实体）。相比早期"扁平 connections 列表 + 每连接带 env/group 名"方案，层级结构更自解释、能保留空环境/空组、多数据库类型更清爽。格式版本升为 `version: 2`；导入同时兼容旧版扁平 `connections:` 写法（按顶层键形状自动识别）。
- **依赖新增**：`src-tauri/Cargo.toml` 当前只有 `serde` + `serde_json`，需加 `serde_yaml`（标准 crate）。`serde_json` 保留供内部与兼容回退。
- **YAML 实现注意**：
  1. 导入按扩展名/内容**优先 YAML 解析，JSON 作兼容回退**（老导出不至于立刻废）；YAML 内部同时兼容层级结构（v2）与扁平 `connections:` 列表（v1），按顶层键形状自动识别。
  2. 导出时字符串字段（尤其 password）由 `serde_yaml` 自动加引号，避免 `:` / 特殊字符被误解析。
  3. YAML 缩进敏感，解析失败报错需带**行号**。
  4. `yes/no/true` 会被 YAML 解析为布尔——连接字段均为字符串无碍，但模板占位值建议显式引号。
- **合规**：明文导出/明文模板属高危，UI 必须醒目警告（红色），默认关闭/需显式勾选。

---

## 2. 功能 #0：系统配置 · 加密密钥配置（完整 PRD）

> 状态：Draft（待 stakeholder alignment）。关联代码：`src/crypto.rs`、`src/config.rs`、`src/store/mod.rs`、`src/db/connection.rs`、`src-tauri/src/commands.rs`、`src-tauri/src/state.rs`。

### 2.1 背景与问题（Why）
当前连接密码加密是**机器绑定的**：AES-256-GCM 密钥随机生成、隔离在 `~/.config/chatquery/key`（0600，见 ADR-004），永不随导出走。结果：导出的密码密文在另一台机器无法解密。**用户真实诉求**：做一个系统配置，加"加密密钥配置"，**密钥字段一致，就能解析到正确的数据库密码**。→ 把跨机器密钥从"每次导出的临时口令"升级为"系统级可配置、跨机器一致的密钥 K"。

### 2.2 目标（Goals）
1. 新增"系统配置 / System"设置分区，首个能力是"加密密钥配置"。
2. 可配置密钥 K：用户设密钥字段 → 确定性派生 32 字节 K，用于加密连接密码。
3. 跨机器一致即可解密：机器 A 设 K 导出 → 机器 B 设相同 K 导入即解密，无需每次设口令。
4. 向后兼容：不配置 K 时行为与今天一致（K 默认 = KEK）。
5. 本机安全不退化：K 在本机仍由 KEK 加密落盘，不出现明文密钥文件。

### 2.3 非目标（Non-goals）
- **不做 OS 钥匙串**（Keychain/libsecret）——延续 ADR-004/ADR-012 的"AES 文件加密"决策。
- **K 不用于 AI api_key**：LLM key 继续用 KEK 加密、本机绑定，不随连接跨机器。
- **不做密钥找回邮箱**：忘记字段不提供找回通道，仅强警告降低误操作。
- **不做多用户/团队密钥托管**：K 是单人、口口相传式共享，不做服务端分发。
- **不做密钥强度强制策略**：仅警告不阻断（与"明文导入"诉求权衡）。

### 2.4 用户故事
- 作为**换了新电脑的开发者**，我希望在系统配置填和旧电脑一样的加密密钥，以便导入旧连接后密码直接解密、不用一个个重填。
- 作为**内网 DBA**，我希望连接密码磁盘始终加密、密钥不落导出文件，以便符合"密钥与密文分离"安全基线。
- 作为**不想折腾的用户**，我希望不碰系统配置也能像今天一样用，以便零配置成本。
- 作为**设了密钥又想改的用户**，我希望重新设一次字段，以便所有连接密码平滑重加密、不丢连接。

### 2.5 设计
- **密钥派生**（确定性）：`K = HKDF-SHA256(APP_FIXED_SALT, "chatquery:conn-key:v1", key_field_bytes)`。字段为空 → K 退化 KEK。
- **存储/运行时**：新增 `~/.config/chatquery/keycfg.json`（`key_enc` + `token`）。`crypto.rs` 新增 `derive_key / load_encryption_key / save_key_config / verify_key`；`store/mod.rs::open()` 改调 `load_encryption_key()`（连接用 K 加密，这是跨机器核心改动）；`config.rs`（LlmConfig）保持 `load_key()`（KEK）不变。
- **验证令牌**：保存后 `verify_key` 解密 token 即时反馈字段是否正确；导入时 `system-key` 密文解密失败给明确引导"请在系统配置填入导出时使用的密钥后重新导入"。
- **默认/迁移/轮换**：
  - 默认（无 keycfg）：K = KEK，老用户无感升级。
  - 首次配置：派生 K' → `Storage::reencrypt_all(KEK, K')` → 写 keycfg。
  - 轮换：旧 K_old → `reencrypt_all(K_old, K_new)` → 写 keycfg（token 用 K_new 重算）。
  - 回退默认：可选功能，MVP 可仅留命令。
  - `Storage` 需新增 `reencrypt_all(old, new)`（事务包裹，遍历 `connections` 表逐条重加密）。
- **前端面板**：设置区新增"系统配置/System"分区 + 加密密钥卡片（遮罩输入、保存、状态展示`已配置/未配置`、"测试密钥"、红色警告"忘记后无法在新机器恢复，本机密钥文件不会随导出"）。导出弹窗联动：默认模式禁用"加密导出"并提示跳转。

### 2.6 数据模型 / 文件改动清单
| 文件 | 改动 |
|------|------|
| `src/crypto.rs` | 新增 `derive_key` / `load_encryption_key` / `save_key_config` / `verify_key` / `keycfg_path()`；保留 `load_key`。 |
| `src/store/mod.rs` | `open()` 用 `load_encryption_key()`；新增 `reencrypt_all(old,new)`。 |
| `src/config.rs` | 不改（继续 `load_key`）。 |
| `src-tauri/src/commands.rs` | 新增 `get_key_status()`、`set_encryption_key(field)`、（可选）`clear_encryption_key()`；`import_connections` 适配 `system-key` cipher 与报错文案。 |
| `src-tauri/src/state.rs` | 无感（K 封装在 Storage 内）。 |
| `Cargo.toml`（lib `src`） | 显式增 `hkdf`、`sha2`。 |
| 前端设置区 | 新增系统配置分区 + 加密密钥卡片；导出弹窗联动。 |

### 2.7 指标（Metrics）
| 指标 | 类型 | 基线 | 目标 |
|------|------|------|------|
| 系统密钥配置率 | 驱动 | 待埋点（0%） | 3 月内 ≥30% 活跃用户至少配置一次 |
| 跨机器导入成功率（system-key） | 北极星 | — | ≥95%（配置同密钥后） |
| 密钥不匹配报错/导入总数 | 健康 | — | ≤5% |
| 明文导出使用占比 | 健康/风险 | — | 监控异常升高 |

### 2.8 风险与缓解
| 风险 | 影响 | 缓解 |
|------|------|------|
| 忘记密钥字段 | 默认模式不影响本机（keycfg 经 KEK 恢复 K）；仅"换新机且未导出"时永久丢失 | 强警告；建议配置时做一次加密导出备份 |
| 明文导出泄露 | 密码裸奔 | 默认关、显式勾选+红警告+落地即本机重加密 |
| 密钥字段过弱 | 暴力可解 | 仅警告不阻断；文档建议长口令 |
| 重加密中途崩溃 | 新旧密钥混合 | `reencrypt_all` 用事务；旧记录可旧 K 解密直到完成 |
| keycfg 与 app.db 不同步 | 解密失败 | 启动/导入遇失败给明确"密钥不匹配"提示，不静默 |

### 2.9 验收标准（DoD）
- [ ] 系统配置面板可见加密密钥卡片，空字段保存后状态"未配置/仅本机"。
- [ ] 填字段保存后，所有连接密码后台重加密为 K（sqlite3 直读 app.db 无明文）。
- [ ] A 配置 K → 加密导出 → B 配**相同** K → 导入，密码全解（≥1 条带密码连接人工验证）。
- [ ] B 填**错误** K → 报"密钥不匹配"引导文案，非笼统失败。
- [ ] 未配置 K 的老用户直接升级：连接照常可用，无需操作。
- [ ] 明文导出/导入仍工作，导入后本机落盘为 KEK 加密。
- [ ] `reencrypt_all` 中途 kill 重启不丢连接、可继续完成。
- [ ] 文档更新：ADR 追加"可配置加密密钥"；README/设置说明补跨机器用法与警告。

### 2.10 开放问题（待你拍板）
1. 轮换是否需要"确认重输一次"？建议需要（防手滑），但增一步摩擦。
2. 默认模式下"加密导出"是置灰还是允许但标 machine-bound？本计划取"置灰+提示"。
3. 是否需要"导出系统密钥配置备份"（keycfg 打包仍由 KEK 保护）？暂不选，避免与"密钥不出本机"冲突。

---

## 3. 功能 #1：连接导入导出（YAML，支持跨机器）

### Why
换机器/团队分享/备份环境配置都需要；手动重建几十个连接很痛苦。通过 #0 的系统密钥 K 根治跨机器（旧方案 KEK 不随导出走，无法跨机器）。

### 跨机器机制
原"每次导出设 PBKDF2 口令"方案**作废**，上移到 #0 系统密钥。本项直接复用 K。

### 导出（两种模式）
- **加密导出（`cipher: system-key`，默认且需先配系统密钥）**：密码 blob 即 K 加密密文，与本地落盘同一把 K；目标机填相同密钥字段即自动解密。默认模式（未配 K）下此选项**置灰**并提示先配密钥；仅允许明文导出。非敏感字段（host/port/user/db/容器）始终明文，便于审阅。
- **明文导出（`cipher: none`，显式可选）**：YAML 直接含 password 明文——满足"明文密码导入"。UI 红警告"文件含明文密码，请勿经不安全渠道传输"，需显式勾选，不做默认。

### YAML 结构示例（层级结构，导出/导入同构）
```yaml
format: chatquery-connections
version: 2
cipher: system-key          # none = 明文；system-key = 系统密钥加密（顶层统一作用于全部密码）
mysql:
  envs:
    - name: 生产环境
      groups:
        - name: 订单库
          connections:
            - name: 主库
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
        - name: __ungrouped     # 该环境下未分组的连接（空组也保留，导出可还原）
          connections: []
    - name: 测试环境
      groups: []                 # 空环境也保留
redis:
  envs:
    - name: 生产环境
      groups:
        - name: __ungrouped
          connections:
            - name: session-cache
              host: 10.0.0.2
              port: 6379
              user: ""
              password: ""
```

### 导入逻辑
- Tauri `import_connections(yaml_text) -> ImportResult`：优先 YAML 解析，JSON 兼容回退；自动识别 cipher。
  - `system-key`：用本机 K 解密；失败明确引导"请在系统配置填入导出时使用的密钥后重新导入"。
  - `none`：password 直用（明文导入诉求）。
- 沿 `(db_type, env, group)` 显式路径重建：每连接/容器重生成 id 避免冲突；同名环境合并、同名分组在对应环境下合并，不存在则新建；空环境/空组按结构原样还原（解决扁平方案丢失空容器的问题）。
- 解密出的明文密码**立即经本机 KEK 重加密落盘**（现有 add/update 已做）——导入后本机仍安全。
- 返回统计：导入 N 连接 / M 容器 / K 密码待补填。

### Non-goals
- 不做 CSV/Excel 导出（YAML 足够结构化）。
- 不做跨应用导入 Navicat/DBeaver。
- 不导出本机密钥（KEK 与密钥字段绝不随文件走）；跨机器靠"口口相传填相同字段"。
- 明文导出不做默认，需显式选择并确认风险。

### 复杂度 / 依赖
低~中。YAML 序列化（`serde_yaml` 新增）+ 层级树遍历与容器合并 + 复用 K 解密（无需 PBKDF2）。导入兼容 v1 扁平与 v2 层级两种形状。**依赖 #0 先做**。

---

## 4. 功能 #2：连接导入模板（YAML 模板）

### Why
手工一个个建几十个连接反人性；给带占位符的 YAML 模板，复制多份填值后一次性导入，批量建连。复用 #1 导入管道，几乎零新增解析成本。

### 模板内容（下载即得样板）
- 新增 Tauri `export_template() -> String`：返回合法 YAML 导入结构，含 **1 条带占位符样板连接**。
- 结构与导出一致（层级 `db_type → envs → groups → connections`）；连接按 `(env, group)` 路径归位，导入时按 name 合并成容器（复用 #1 逻辑）。
- 字段含核心 + 可选高级（与 #4/#5 对齐，预留列）：

```yaml
format: chatquery-connections
version: 2
cipher: none
mysql:
  envs:
    - name: "生产环境"
      groups:
        - name: "订单库"
          connections:
            - name: "示例连接-请改名"
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

### 导入（完全复用 #1 `import_connections`）
- 填好的模板本质即 `cipher: none` 的 YAML → 走明文路径：password 直填 → 按 name 合并 env/group → id 重生成 → 本机 KEK（或 K）重加密。
- **校验（轻量）**：必填缺失（host/user/name 空）→ 跳过该行并汇总"跳过 K 条（缺必填）"；命中明显占位符（`{{...}}`/`CHANGE_ME`/`请填`/`example.com`）→ 黄警告但不阻断。
- 支持整份文件为单 db_type 子树（如上）或多 db_type 并列；新增连接时复制对应的 `connections:` 下的整条 `- name: ...` 块并归到正确的 env/group 路径下。

### Non-goals
- 不做 CSV 模板。
- 不做模板内变量/环境变量替换（直填直导，避免模板引擎）。
- 不做字段级格式强校验（端口非数字等交给底层建连报错）；仅必填 + 占位符检查。
- 模板本身不含密码加密（明文填，落盘时本机密钥加密，与 #1 一致）。

### 复杂度 / 依赖
低~中。`export_template` 无逻辑 YAML 生成；导入 100% 复用 #1，仅加两条校验。**依赖 #1**。合规：模板明文密码，UI 在下载/导入处均提示警告。

---

## 5. 功能 #3：网格筛选 / 排序 / 搜索

### Why
分页结果通常 200 行，但找某条记录仍费劲；列头排序和全局搜索是专业 DB 工具标配。

### 关键实现
- 纯前端，作用当前内存结果集（MySQL browse / 任意 SELECT / Redis 列表）。
- **全局搜索**：结果区顶部输入框，按行匹配任意单元格（大小写可选敏感）。
- **列排序**：点列头切升/降序；数字列按数值、字符串按字典序、日期按时间戳。
- **列筛选**：列头悬停/右键弹出筛选框，支持 包含/等于/不等于/为空/非空/数值范围。
- 与分页解耦：只影响当前页展示，不重查 DB；底部状态栏"显示 N / 共 M 行"。
- 状态存前端 tab 级（切 tab / 重查清空）。

### Non-goals
- 不做服务端排序/筛选（不改写 SQL ORDER BY/WHERE）。
- 不做跨页筛选（当前页 200 行内）。

### 复杂度 / 依赖
低（纯 React 状态 + 渲染过滤）。依赖：无。

---

## 6. 功能 #4：SSL/TLS 连接加密

### Why
生产环境强制加密；没有 TLS 选项会被 DBA/安全策略直接拒绝。

### 关键实现
- `ConnectionConfig`/`ConnInput` 新增：`ssl_mode`（Disabled/Preferred/Required/VerifyCa/VerifyIdentity）、`ssl_ca`、`client_cert`/`client_key`（双向可选）。
- `mysql.rs` 的 `connect_pool_db` 从纯 URL 改 `MySqlConnectOptions` 程序化构建，按字段设 SSL。
- 前端表单加"SSL 模式"下拉 + 可选 CA/证书文件选择器（Tauri dialog 选文件）。
- Redis 同理：`rediss://` 或 `RedisConnectionInfo` 加 TLS builder（云 Redis 常用）。

### Non-goals
- 不做系统证书商店自动检测（先手动选 CA）。
- 不做证书过期自动提醒（可后续 health check 扩展）。

### 复杂度 / 依赖
中低（sqlx/redis 原生支持，主要是 DTO + 表单 + 文件选择器）。依赖：无。

---

## 7. 功能 #5：SSH 隧道 / 跳板机

### Why
企业内网 MySQL/Redis 大多只开内网 IP，必须经 SSH 跳板才能访问；没有 SSH 隧道打不开生产库。

### 关键实现
- `ConnectionConfig` 新增 `ssh` 块：`ssh_host`/`ssh_port`/`ssh_user`/`ssh_auth_kind`（密码/私钥/agent）/`ssh_password`/`ssh_private_key`（加密落盘，同 ADR-010）。
- 后端两路径二选一：
  - **MVP**：系统 `ssh -L local_port:db_host:db_port user@ssh_host -N` 子进程做本地端口转发，成本低但依赖系统有 ssh。
  - **纯 Rust**：引入 `russh` 自实现，不依赖系统 ssh，但工程量/包体积上升。
  - 建议先 MVP 验证，再决定是否迁 russh。
- 生命周期：查询时检查隧道是否已建，未建则 spawn；结束后保一小段 TTL 避免反复 spawn；崩溃自动重连并提示。
- MySQL 实际目标变 `127.0.0.1:<local_port>`，用户/密码/SSL 仍走原逻辑。

### Non-goals
- 不做堡垒机多跳（单跳够 MVP）。
- 不做 SSH 交互式 shell / SFTP。
- 短期不做 `russh` 纯 Rust 实现。

### 复杂度 / 依赖
中（系统 ssh 子进程实现快，但生命周期/错误提示要做细）。建议排 #4 之后（隧道之上仍可叠加 SSL）。

---

## 8. 功能 #6：EXPLAIN 可视化（树 / 火焰图）

### Why
当前 EXPLAIN 只表格，排查慢查询看 id/select_type/key/rows/Extra 费力；树/火焰图一眼看出全表扫描和成本瓶颈。

### 关键实现
- 后端新增 `explain_visual(conn_id, query, db) -> ExplainTree`：
  - MySQL 8.0.18+ 用 `EXPLAIN FORMAT=JSON` 或 `EXPLAIN ANALYZE` 拿结构化计划。
  - 老版本回退 `EXPLAIN` 表格，按 `id` 手工构造父子关系。
- 新 DTO `ExplainNode { id, name, cost, rows, type, children, details }` 返回前端。
- 前端结果子标签加"执行计划"（与 数据/表结构/表关系 并列），D3/echarts 或 SVG 渲染：
  - **树视图**：节点=表/索引/子查询，连线=父子/依赖，颜色=扫描类型（全表扫描红、走索引绿）。
  - **火焰图**：按 cost 或 rows*cost 横向条形，越长越需优化。
- 与原 `explain_query` 表格版共存。

### Non-goals
- 不做索引优化建议 AI（可后续让 LLM 读 ExplainTree 生成）。
- 不做 MySQL 8 以下完整图形化（老版本回退表格）。
- Redis 无 EXPLAIN，保持现有提示。

### 复杂度 / 依赖
中（后端解析 JSON 不难，前端可视化需打磨）。依赖：无。

---

## 9. 推荐实现顺序 / 路线图

按"价值/复杂度比 + 基础设施依赖"排：

| 序 | 功能 | 估时 | 说明 |
|----|------|------|------|
| 1 | **#0 系统配置·加密密钥** | 1~1.5 周 | 中复杂度，#1/#2 前置，治本 |
| 2 | **#1 连接导入导出 YAML** | 0.5~1 周 | 复用 K，低风险，立刻解决备份/迁移 |
| 3 | **#2 连接导入模板 YAML** | 0.5 周 | 复用 #1 管道 + `export_template` |
| 4 | **#3 网格筛选/排序/搜索** | 1 周 | 纯前端，天天用 |
| 5 | **#4 SSL/TLS** | 1~2 周 | 企业生产必备 |
| 6 | **#5 SSH 隧道** | 2~3 周 | 企业内网必备，可先 MVP 系统 ssh |
| 7 | **#6 EXPLAIN 可视化** | 2 周 | 调优专业感，依赖 EXPLAIN FORMAT=JSON |

**Now / Next / Later 视角**
- **Now（1~2 迭代）**：#0 + #1 + #2 + #3 —— 先打通"跨机器采用 + 批量建连 + 日常查看效率"，纯前端和加密底座风险低、见效快。
- **Next（本季度）**：#4 + #5 —— 对标企业采用硬门槛（SSL/SSH）。
- **Later（探索）**：#6 EXPLAIN 可视化 —— 专业调优亮点，可并行于 Next 启动（无依赖）。

> 取舍：若资源只够两个，做 **#4 + #5**（企业硬门槛）；若涉及换机/共享/批量建连，把 **#0+#1+#2** 提前到最前。

---

## 10. 统一风险登记 & 待确认项

**跨功能风险**
- 明文导出/明文模板：高危，必须 UI 红警告 + 默认关闭 + 落地即本机重加密（见 #0 2.8、#1、#2）。
- YAML 解析：加 `serde_yaml` 依赖；解析失败带行号；占位值显式引号（见 1.2）。
- 密钥忘记：仅强警告 + 建议配置时做一次加密导出备份（#0 2.8）。

**待你拍板的开放问题（集中在 #0）**
1. 轮换是否需"确认重输一次"？
2. 默认模式下"加密导出"置灰 vs 允许但标 machine-bound？（本计划取置灰）
3. 是否导出 keycfg 备份？（本计划暂不选）

---

> 修订记录：2026-07-30 初版，合并 `feature-plan-5.md` 与 `feature-spec-system-config-key.md` 为单一主计划。
