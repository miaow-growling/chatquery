//! Per-turn structured trace (ADR-AI-7).
//!
//! 面向开发的排障数据，与面向用户的 `BackendMsg::ChatTool` 互补：后者回答
//! 「它做了什么」，本模块回答「它为什么失败、慢在哪、花了多少」。
//!
//! 设计约束：桌面端单机场景，不引入重型 tracing / OTel 框架依赖；
//! 数据结构全部支持 serde 序列化，落地为 JSON Lines 便于 grep / jq 离线分析。

use crate::model::TokenUsage;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

/// 对字符串计算 64 位哈希值，用于精确对比工具参数指纹。
pub fn hash_str(s: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

/// 单次工具调用的执行记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepTrace {
    /// 1-based 迭代序号。
    pub iter: usize,
    /// 执行该步骤的 Worker 角色（Orchestrator / Explorer / Executor）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// 工具名，如 `execute_query` / `search_knowledge` / `mcp__xxx`。
    pub tool: String,
    /// 目标连接名（若能从 arguments 解析出）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    /// 工具执行的主要参数或 SQL 摘要预览（如 `SELECT ...`），便于排查问题
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_preview: Option<String>,
    /// 工具执行返回的结果简要摘要（如 `查出 14 行数据` 或报错文本）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 工具调用参数的哈希指纹，用于精确判定是否在重复调用相同参数。
    pub args_hash: u64,
    /// 本步相对于 Turn 开始时刻的毫秒偏移量，用于绘制甘特瀑布流时序图。
    #[serde(default)]
    pub start_offset_ms: u64,
    /// 本步耗时（毫秒）。
    pub cost_ms: u64,
    /// 工具返回摘要的字符数（不落全量内容，避免敏感数据泄漏与日志膨胀）。
    pub result_len: usize,
    /// 是否命中护栏或策略拦截（如 "scope-blocked" / "deny" / "write-approved" / "write-rejected" / "write-expired"）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guarded: Option<String>,
}

/// turn 结束原因。用于区分「正常完成」与「异常终止」，是排障的第一现场。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminateReason {
    /// 模型主动给出最终结论。
    Completed,
    /// 达到 max_tool_iters 上限，随后触发了强制总结。
    ToolBudgetExhausted,
    /// 用户主动取消。
    Cancelled,
    /// 超过单轮时间上限（TURN_TIMEOUT）。
    Timeout,
    /// 流式请求或执行返回错误。
    Errored,
}

/// 单次大模型 LLM 推理往返调用记录（Langfuse Generation 概念）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationTrace {
    /// 阶段标识（如 "Planning" / "ReAct Step 1" / "Synthesizer" / "Forced Summary"）。
    pub name: String,
    /// 调用的模型名称（如 "deepseek-chat", "gpt-4o"）。
    pub model: String,
    /// 相对于整轮 Turn 开始的毫秒时间偏移量（用于甘特图时序定位）。
    pub start_offset_ms: u64,
    /// 本次 LLM 流式调用的纯耗时（毫秒）。
    pub cost_ms: u64,
    /// 本次调用消耗的 Token 指标（若 Provider 有上报）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// 输入提示词摘要预览（用于回溯当时给模型的输入）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_preview: Option<String>,
    /// 大模型生成的回答或思考内容预览。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<String>,
}

/// 一个 turn 的完整 trace 记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnTrace {
    pub turn_id: String,
    /// 归属的会话 ID（可选，用于按会话分组排查）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conv_id: Option<String>,
    /// 用户本轮发起的提问内容预览（用于直观识别本轮交互意图）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_query: Option<String>,
    /// 本轮由 Planner 规划器生成的任务拆解步骤（若有）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plan: Vec<String>,
    /// 任务规划阶段耗时（毫秒，若有规划阶段）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_cost_ms: Option<u64>,
    /// 最终综合回答生成阶段耗时（毫秒，仅多 Agent 复杂任务有）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesis_cost_ms: Option<u64>,
    /// 记录生成时刻的毫秒时间戳。
    #[serde(default)]
    pub created_at: i64,
    /// 主角色标签（通常为 Orchestrator 或单 Agent 角色）。
    pub role: String,
    /// 本轮执行过程中调用的全部工具步骤。
    #[serde(default)]
    pub steps: Vec<StepTrace>,
    /// 本轮执行过程中调用的全部大模型 LLM 生成步骤（Langfuse Generations）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub generations: Vec<GenerationTrace>,
    /// 终止原因。
    pub terminate: TerminateReason,
    /// 实际发生的 LLM 往返轮数（含无工具调用的总结与规划轮次）。
    pub llm_rounds: usize,
    /// 全流程端到端耗时（毫秒）。
    pub total_ms: u64,
    /// 终态 Token 消耗累计（provider 未上报时为 None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// 检出的重复工具调用（同一 tool + 同一 connection + 同一 args_hash 出现 ≥2 次），
    /// 是「Agent 在原地打转」最直接的诊断信号。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub redundant_calls: Vec<String>,
}

/// 检出重复的工具调用：同一 tool + 同一 connection + 同一 args_hash 出现 ≥2 次。
pub fn detect_redundant(steps: &[StepTrace]) -> Vec<String> {
    let mut seen: HashMap<(String, Option<String>, u64), usize> = HashMap::new();
    for s in steps {
        *seen
            .entry((s.tool.clone(), s.connection.clone(), s.args_hash))
            .or_insert(0) += 1;
    }
    seen.into_iter()
        .filter(|(_, n)| *n >= 2)
        .map(|((tool, conn, hash), n)| {
            let conn_str = conn.as_deref().unwrap_or("default");
            format!("{}::{} (args_hash:{:x}) ×{}", tool, conn_str, hash, n)
        })
        .collect()
}

/// Host callback that persists a `TurnTrace`。由 Tauri 命令层注入（追加写本地文件），
/// TUI 注入 no-op。沿用 `AuditSink` 的注入模式，使 `llm` crate 保持对底层存储与运行环境解耦。
pub type TraceSink = Arc<dyn Fn(&TurnTrace) + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_with_omitted_fields_succeeds() {
        let json_line = r#"{"turn_id":"t1","conv_id":"c1","role":"Orchestrator","steps":[{"iter":1,"tool":"execute_query","cost_ms":10,"result_len":50,"args_hash":123}],"terminate":"completed","llm_rounds":1,"total_ms":100}"#;
        let trace: TurnTrace = serde_json::from_str(json_line).expect("should deserialize even when optional fields are omitted");
        assert_eq!(trace.turn_id, "t1");
        assert_eq!(trace.steps.len(), 1);
        assert_eq!(trace.steps[0].connection, None);
        assert_eq!(trace.steps[0].guarded, None);
        assert!(trace.redundant_calls.is_empty());
        assert!(trace.usage.is_none());

        // Also test the real line in the log file if it exists
        if let Ok(content) = std::fs::read_to_string("/Users/hel04/Library/Logs/com.chatquery.app/agent-trace.jsonl") {
            for line in content.lines() {
                if !line.trim().is_empty() {
                    let t: TurnTrace = serde_json::from_str(line).expect("real log line must deserialize");
                    assert!(!t.turn_id.is_empty());
                }
            }
        }
    }

    #[test]
    fn detect_redundant_catches_repeated_calls_only() {
        let h1 = hash_str("SELECT * FROM t1");
        let h2 = hash_str("SELECT * FROM t2");

        let steps = vec![
            StepTrace {
                iter: 1,
                role: Some("Explorer".into()),
                tool: "execute_query".into(),
                connection: Some("db1".into()),
                query_preview: Some("SELECT * FROM t1".into()),
                summary: Some("查出 10 行".into()),
                args_hash: h1,
                start_offset_ms: 100,
                cost_ms: 10,
                result_len: 100,
                guarded: None,
            },
            StepTrace {
                iter: 2,
                role: Some("Explorer".into()),
                tool: "execute_query".into(),
                connection: Some("db1".into()),
                query_preview: Some("SELECT * FROM t2".into()),
                summary: Some("查出 20 行".into()),
                args_hash: h2, // 不同参数不应判为打转
                start_offset_ms: 120,
                cost_ms: 12,
                result_len: 200,
                guarded: None,
            },
            StepTrace {
                iter: 3,
                role: Some("Executor".into()),
                tool: "execute_query".into(),
                connection: Some("db1".into()),
                query_preview: Some("SELECT * FROM t1".into()),
                summary: Some("查出 10 行".into()),
                args_hash: h1, // 重复调用相同参数！
                start_offset_ms: 150,
                cost_ms: 11,
                result_len: 100,
                guarded: None,
            },
        ];

        let redundant = detect_redundant(&steps);
        assert_eq!(redundant.len(), 1);
        assert!(redundant[0].contains("execute_query::db1"));
        assert!(redundant[0].contains("×2"));
    }
}
