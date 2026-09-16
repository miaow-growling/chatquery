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
    ConstitutionRule {
        id: "C3",
        title: "写后验证严禁全表扫描",
        body: "执行 INSERT、UPDATE 或 DELETE 后若需验证结果，必须优先依据 execute_query \
           返回的受影响行数（affected）与自增 ID（last_insert_id）进行确认。若确需通过 \
           SELECT 回查验证，严禁执行不带精确条件的全表查询（如 SELECT * FROM table）！\
           必须严格指定本次操作的主键或唯一条件并带 LIMIT 1，只精确查回刚刚变动的那一条\
           数据，坚决避免给线上大表带来性能冲击与慢查询。",
    },
    ConstitutionRule {
        id: "C4",
        title: "严禁口头承诺，必须立即行动",
        body: "如果你决定执行查询，或在多轮对话中接收到追加/过滤条件（如「不要测试项目」「换一个样本」），必须在当前轮次直接发起 execute_query 工具调用；\
           严禁在文本中仅输出「我正在查询」「现在跑」「这就为您执行」「我过滤掉...再找一个样本」等未来时态的表态与口头承诺；\
           没有调用工具时直接给出分析或说明无法执行，不得空头承诺。",
    },
    ConstitutionRule {
        id: "C5",
        title: "严格遵循用户纠错记忆",
        body: "在编写 SQL、执行查询或作答时，必须优先检索并遵循「用户历史纠错与偏好记忆」中的规则。\
           严禁重复犯下用户已纠正过的历史错误（如使用废弃字段、漏掉过滤条件或误查测试数据）。",
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

    /// C3 的核心语义：写后验证禁止全表扫描、优先看受影响行数/自增ID、回查必须单条。
    #[test]
    fn c3_forbids_full_table_scan_on_verify() {
        let c3 = RULES.iter().find(|r| r.id == "C3").expect("C3 exists");
        assert!(c3.body.contains("受影响行数"));
        assert!(c3.body.contains("全表"));
        assert!(c3.body.contains("LIMIT 1"));
    }

    /// C4 的核心语义：严禁口头承诺、必须立即行动发起工具调用、不得空头承诺。
    #[test]
    fn c4_requires_immediate_action_no_verbal_promise() {
        let c4 = RULES.iter().find(|r| r.id == "C4").expect("C4 exists");
        assert!(c4.body.contains("execute_query"));
        assert!(c4.body.contains("严禁"));
        assert!(c4.body.contains("口头承诺"));
    }

    /// C5 的核心语义：严格遵循纠错记忆、优先遵循、禁止重复犯错。
    #[test]
    fn c5_requires_following_user_memories() {
        let c5 = RULES.iter().find(|r| r.id == "C5").expect("C5 exists");
        assert!(c5.body.contains("纠错"));
        assert!(c5.body.contains("优先"));
        assert!(c5.body.contains("严禁"));
    }
}
