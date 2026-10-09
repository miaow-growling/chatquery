use crate::config::LlmConfig;
use crate::model::ChatMessage;
use std::collections::VecDeque;
use std::time::Duration;

/// Lightweight working memory for an agent turn (and, later, across turns via
/// the session). Keeps the current connection/db and a bounded log of recent
/// tool results so the model doesn't re-derive context every step.
#[derive(Default, Clone)]
pub struct SessionMemory {
    pub current_conn: Option<String>,
    pub current_db: Option<String>,
    pub last_results: VecDeque<String>,
}

impl SessionMemory {
    pub fn new(conn: Option<String>, db: Option<String>) -> Self {
        Self {
            current_conn: conn,
            current_db: db,
            last_results: VecDeque::new(),
        }
    }

    /// Record a short label for the most recent tool result (bounded to 8).
    pub fn note_result(&mut self, label: &str) {
        self.last_results.push_back(label.to_string());
        if self.last_results.len() > 8 {
            self.last_results.pop_front();
        }
    }
}

/// A detected signal indicating user correction, negative feedback, or harsh attitude.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorrectionSignal {
    pub is_harsh: bool,
    pub rule_candidate: Option<String>,
    pub user_raw: String,
}

/// Detect whether the user's latest input is correcting the AI, expressing frustration/harsh tone,
/// or stating explicit negative/exclusion constraints (e.g. "不要测过项目的", "用code不是key", "你没跑啊").
pub fn detect_user_correction(user_text: &str, _history: &[ChatMessage]) -> Option<CorrectionSignal> {
    let raw = user_text.trim();
    if raw.is_empty() {
        return None;
    }

    // 1. Harsh / frustrated / impatient tone markers
    const HARSH_PATTERNS: &[&str] = &[
        "你到底懂不懂", "懂不懂啊", "不是说过了吗", "说了多少次", "说了几遍",
        "怎么又", "怎么搞的", "你没跑啊", "你没跑", "你没查", "不是这个",
        "别搞错", "瞎查", "胡说", "不对", "服了", "无语", "烦死了",
        "脑子呢", "不要搞错", "不要瞎", "别瞎", "不要瞎搞", "瞎写",
    ];

    let is_harsh = HARSH_PATTERNS.iter().any(|p| raw.contains(p));

    // 2. Explicit correction or exclusion patterns
    let mut candidate: Option<String> = None;

    // Pattern: "不要..." / "别查..."
    if raw.starts_with("不要") || raw.contains("不要") {
        let after = if let Some(idx) = raw.find("不要") {
            &raw[idx + 6..]
        } else {
            raw
        };
        let item = after.trim_matches(|c: char| c == '，' || c == ',' || c == '。' || c == '！' || c == '!' || c == ' ');
        if !item.is_empty() && item.chars().count() <= 30 {
            candidate = Some(format!("查询与处理时，必须排除/不要{}", item));
        }
    } else if raw.starts_with("别") || raw.contains("别查") || raw.contains("排除") || raw.contains("过滤掉") {
        for prefix in &["别查", "排除掉", "排除", "过滤掉", "别用", "不要用"] {
            if let Some(idx) = raw.find(prefix) {
                let after = &raw[idx + prefix.len()..];
                let item = after.trim_matches(|c: char| c == '，' || c == ',' || c == '。' || c == '！' || c == '!' || c == ' ');
                if !item.is_empty() && item.chars().count() <= 30 {
                    candidate = Some(format!("查询与处理时，必须排除{}", item));
                    break;
                }
            }
        }
    }

    // Pattern: "不是...是..." or "用的是...不是..."
    if candidate.is_none() {
        if let Some(is_idx) = raw.find("不是") {
            let after_bushi = &raw[is_idx + 6..];
            if let Some(shi_idx) = after_bushi.find("是") {
                let wrong = after_bushi[..shi_idx].trim_matches(|c: char| c == '，' || c == ',' || c == ' ');
                let right = after_bushi[shi_idx + 3..].trim_matches(|c: char| c == '，' || c == ',' || c == '。' || c == '！' || c == '!' || c == ' ');
                if !wrong.is_empty() && !right.is_empty() {
                    candidate = Some(format!("使用「{}」，而非「{}」", right, wrong));
                }
            }
        } else if let Some(yong_idx) = raw.find("用的是") {
            let after_yong = &raw[yong_idx + 9..];
            if let Some(bushi_idx) = after_yong.find("不是") {
                let right = after_yong[..bushi_idx].trim_matches(|c: char| c == '，' || c == ',' || c == ' ');
                let wrong = after_yong[bushi_idx + 6..].trim_matches(|c: char| c == '，' || c == ',' || c == '。' || c == '！' || c == '!' || c == ' ');
                if !wrong.is_empty() && !right.is_empty() {
                    candidate = Some(format!("使用「{}」，而非「{}」", right, wrong));
                }
            }
        }
    }

    // Pattern: "字段是/叫..." or "表是/叫..." or "原来...用的是..."
    if candidate.is_none() {
        if raw.contains("字段") || raw.contains("表名") || raw.contains("用的是") || raw.contains("原来") {
            if raw.contains("不是") || raw.contains("错了") || raw.contains("没有") || raw.contains("才是") {
                candidate = Some(format!("纠错规范：{}", raw));
            }
        }
    }

    // If harsh tone is present, even without regex rule match, capture raw as candidate
    if is_harsh && candidate.is_none() {
        candidate = Some(format!("用户重点指正：{}", raw));
    }

    if is_harsh || candidate.is_some() {
        Some(CorrectionSignal {
            is_harsh,
            rule_candidate: candidate,
            user_raw: raw.to_string(),
        })
    } else {
        None
    }
}

/// Ask the LLM to distill 1 concise declarative business/SQL rule from the user's correction
/// and prior assistant response. Bounded with a 3-second timeout for rapid completion.
pub async fn distill_correction_rule(
    cfg: &LlmConfig,
    user_text: &str,
    prior_assistant: Option<&str>,
) -> Option<String> {
    let prior_snippet: String = prior_assistant
        .map(|s| crate::llm::planner::strip_think_tags(s))
        .map(|s| s.chars().take(300).collect())
        .unwrap_or_default();

    let sys_prompt = "你是一个数据库与业务偏好记忆提炼助手。\
        用户刚刚对 AI 提出了纠错、过滤限制或严厉指责。\
        请从用户最新输入中，提炼出 1 条高度确定性、精炼的陈述句规则（例如：「查询房产时必须排除包含测试的项目」、「yk_config 表使用 code 字段作为配置键，而非 key 字段」）。\
        硬性要求：\
        1. 仅输出提取出的一句话规则正文，30字以内，不要输出任何编号、引号、解释或废话；\
        2. 若用户输入仅是纯宣泄而无法提炼出任何具体的业务或数据库规则，仅输出 NONE。";

    let mut user_prompt = String::new();
    if !prior_snippet.is_empty() {
        user_prompt.push_str(&format!("AI上轮输出摘要：{}\n", prior_snippet));
    }
    user_prompt.push_str(&format!("用户纠错输入：{}\n请提炼规则：", user_text));

    let messages = vec![
        ChatMessage::system(sys_prompt),
        ChatMessage::user(&user_prompt),
    ];

    let mut on_delta = |_d: &str| {};
    let stream_fut = crate::llm::client::stream_chat(cfg, &messages, &[], &mut on_delta);
    let result = tokio::time::timeout(Duration::from_secs(8), stream_fut).await.ok()?.ok()?;
    let clean = crate::llm::planner::strip_think_tags(&result.content);
    let trimmed = clean.trim();
    if trimmed.is_empty() || trimmed == "NONE" || trimmed.contains("NONE") {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_harsh_corrections() {
        let signal = detect_user_correction("你到底懂不懂啊，怎么又查了测试项目？", &[]).unwrap();
        assert!(signal.is_harsh);
        assert!(signal.rule_candidate.is_some());
        assert!(signal.user_raw.contains("你到底懂不懂"));

        let signal2 = detect_user_correction("你没跑啊", &[]).unwrap();
        assert!(signal2.is_harsh);
    }

    #[test]
    fn detects_negative_exclusions() {
        let signal = detect_user_correction("不要测过项目的", &[]).unwrap();
        assert!(signal.rule_candidate.unwrap().contains("排除/不要测过项目的"));

        let signal2 = detect_user_correction("排除掉测试项目", &[]).unwrap();
        assert!(signal2.rule_candidate.unwrap().contains("排除测试项目"));
    }

    #[test]
    fn detects_field_corrections() {
        let signal = detect_user_correction("不是key是code", &[]).unwrap();
        let cand = signal.rule_candidate.unwrap();
        assert!(cand.contains("code"));
        assert!(cand.contains("key"));

        let signal2 = detect_user_correction("原来 yk_config 表用的是 code 字段，不是 key 字段", &[]).unwrap();
        assert!(signal2.rule_candidate.is_some());
    }

    #[test]
    fn ignores_normal_queries() {
        assert!(detect_user_correction("查询一下yk_config里面ai_kefu_scope的值", &[]).is_none());
        assert!(detect_user_correction("帮我统计一下订单总数", &[]).is_none());
        assert!(detect_user_correction("解释一下这段 SQL 的含义", &[]).is_none());
    }
}
