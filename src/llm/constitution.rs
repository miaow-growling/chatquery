//! Agent 宪法（constitution）：注入到 Chat agent 系统提示词的最高优先级约束。
//!
//! 宪法独立于各注入点自己的「规则」段落：那些规则描述的是单个角色
//! （Orchestrator / Explorer / Executor）的日常行为偏好，而宪法是不可违反的
//! 硬性红线，凌驾于任何普通规则之上——两者冲突时以宪法为准。新增规则只需在
//! [`RULES`] 里追加一个条目，`build_system_prompt` 与 `build_worker_system`
//! 的注入会自动带上，无需改动调用方。

/// 一条宪法规则。`id` 保持稳定，便于测试与审计日志引用规则本身而不是
/// 复述全文。
pub struct ConstitutionRule {
    pub id: &'static str,
    pub title: &'static str,
    /// 面向模型的规则正文，写成可直接执行的指令。
    pub body: &'static str,
}

/// 宪法条文本体。顺序即渲染顺序。每条都会注入到每个 agent 的提示词里，
/// 所以保持条目精炼、无条件生效——冗长的宪法是对每一轮对话的 token 税。
pub const RULES: &[ConstitutionRule] = &[
    ConstitutionRule {
        id: "C1",
        title: "SQL 禁止凭印象输出字段",
        body: "为现有数据库编写任何 SQL（查询、写操作或示例）时，严禁凭记忆、印象或猜测\
           输出表名、字段名或字段类型。只要表结构能通过工具获取——execute_query 执行 \
           SHOW CREATE TABLE / DESCRIBE / information_schema 查询，或 search_knowledge \
           检索知识库——就必须先拿到真实表结构，再基于它编写 SQL，并在写之前核对你用到的\
           每个字段都真实存在。只有当目标表结构确实无法通过任何工具获取时，才允许基于\
           上下文已有信息输出，且必须明确标注其中未经核实的部分，提醒用户先行确认。",
    },
    ConstitutionRule {
        id: "C2",
        title: "严禁谎报执行结果",
        body: "查询或写入是否执行、结果如何，只能以工具返回的真实输出为准。没有调用\
           execute_query 并拿到成功结果，就严禁说「已执行」「已写入」「查询完成」；工具\
           返回错误时必须如实转述错误内容。宁可告知用户「我还没有执行」，也绝不允许\
           在缺少工具结果的情况下编造成功结论。",
    },
];

/// 把宪法渲染成系统提示词块。宪法为空时返回空串，注入点因此是无副作用的，
/// 没有规则的部署得到的提示词与之前逐字节一致。
pub fn render() -> String {
    if RULES.is_empty() {
        return String::new();
    }
    let mut p = String::from("## 宪法（最高优先级硬性约束，与任何普通规则冲突时以宪法为准）\n");
    for r in RULES {
        p.push_str(&format!("- [{}] {}：{}\n", r.id, r.title, r.body));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_contains_every_rule_with_header() {
        let block = render();
        assert!(block.contains("宪法"));
        for r in RULES {
            assert!(block.contains(&format!("[{}]", r.id)), "rule {} missing", r.id);
            assert!(block.contains(r.title));
            assert!(block.contains(r.body));
        }
    }

    #[test]
    fn rule_ids_are_unique() {
        let mut ids: Vec<&str> = RULES.iter().map(|r| r.id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "constitution rule ids must be unique");
    }

    /// C1 的核心语义：禁止凭印象 + 必须先拿真实表结构 + 知识库也算合法来源。
    /// 这三个关键词一旦在改写规则时被丢掉，测试会立刻报警。
    #[test]
    fn c1_covers_memory_bias_and_schema_sources() {
        let c1 = RULES.iter().find(|r| r.id == "C1").expect("C1 exists");
        assert!(c1.body.contains("印象"));
        assert!(c1.body.contains("表结构"));
        assert!(c1.body.contains("知识库"));
    }

    /// C2 的核心语义：结果只能来自工具返回、无工具结果不得宣称成功、
    /// 工具报错必须如实转述。
    #[test]
    fn c2_requires_tool_backed_claims() {
        let c2 = RULES.iter().find(|r| r.id == "C2").expect("C2 exists");
        assert!(c2.body.contains("工具返回"));
        assert!(c2.body.contains("严禁"));
        assert!(c2.body.contains("如实"));
    }
}
