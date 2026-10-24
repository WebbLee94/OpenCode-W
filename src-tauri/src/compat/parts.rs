//! v2 `content[]` → 前端 `PartDTO` 映射。
//!
//! v2 把 v1 的 `part` 行内联进 `session_message.data.content`，形状见真库：
//!
//! ```json
//! {"type":"tool","id":"call_...","name":"read",
//!  "state":{"status":"completed","input":{...},"content":[{"type":"text","text":"..."}]}}
//! ```
//!
//! 映射规则（实施计划 TASK-012 / TASK-013）：
//!
//! | v2 块 | 输出 |
//! | --- | --- |
//! | `text` / `reasoning` | 直接映射 `text` / `summary` / `time` |
//! | `tool` | `callID = id`、`tool = name`、`state = {status,input,output,error,title}` |
//! | 其它（含未来新增） | 原样透传到 `metadata`，`type` 保留原始字符串，不 panic |
//!
//! 合成 ID 为 `<message_id>:<6 位序号>`（字典序 = 实际顺序），合成的
//! `step-finish` 用 `<message_id>:step-finish`，因此永远排在内容块之后。
//!
//! `state.content` / `state.metadata` / `state.error` 都可能缺失，全部按
//! `Option` 处理（夹具覆盖了 error 无 `content` 键的情况）。

use serde_json::Value;

use crate::commands::messages::PartDTOOut;
use crate::models::dto::{PartTimeRange, PartTokens};

/// 摘要长度上限，与 v1 `parse_part_data` 一致。
const SUMMARY_LIMIT: usize = 200;

/// 前端 `toolState` 白名单（未知状态只保留在 `status` 里）。
const KNOWN_TOOL_STATES: [&str; 4] = ["pending", "running", "completed", "error"];

/// 把一条 v2 消息翻译成逻辑内容块列表。
///
/// - `content[]` 存在时逐块映射；
/// - 没有 `content[]` 但有 `data.text` 时（v2 的 `user` / `system` / `synthetic`
///   / `compaction` 消息就是这样存的）合成一个 `text` 块，保持与 v1
///   「用户文本在 part 里」一致的内容块口径；
/// - `assistant` 消息额外合成一个 `step-finish` 逻辑块（v2 没有该分片）。
pub fn map_message(
    message_id: &str,
    session_id: &str,
    message_type: &str,
    data: &Value,
) -> Vec<PartDTOOut> {
    let mut parts = Vec::new();

    match data.get("content").and_then(Value::as_array) {
        Some(blocks) => {
            for (index, block) in blocks.iter().enumerate() {
                parts.push(map_block(
                    message_id,
                    session_id,
                    index + 1,
                    block,
                ));
            }
        }
        None => {
            if let Some(text) = data.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    let mut part = PartDTOOut::new(
                        &synthetic_id(message_id, 1),
                        message_id,
                        session_id,
                        String::from("text"),
                        data_size(None),
                    );
                    part.text = Some(text.to_string());
                    part.summary = truncate_with_ellipsis(text, SUMMARY_LIMIT);
                    part.time = time_range(data.get("time"));
                    parts.push(part);
                }
            }
        }
    }

    if message_type == "assistant" {
        parts.push(step_finish(message_id, session_id, data));
    }

    parts
}

/// 消息正文（`MessageDetailDTO.content`）：拼接 `content[]` 的 text 块，
/// 否则退回 `data.text`，最后兜底整段 JSON —— 与原 v1 的「尽量给出可读正文」
/// 语义一致。
pub fn message_text(data: &Value) -> String {
    if let Some(blocks) = data.get("content").and_then(Value::as_array) {
        let texts: Vec<&str> = blocks
            .iter()
            .filter(|block| block_type(block) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect();
        if !texts.is_empty() {
            return texts.join("\n\n");
        }
    }
    if let Some(text) = data.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    serde_json::to_string_pretty(data).unwrap_or_default()
}

fn map_block(message_id: &str, session_id: &str, index: usize, block: &Value) -> PartDTOOut {
    let block_type = block_type(block).unwrap_or("unknown");
    let id = synthetic_id(message_id, index);
    let size = data_size(Some(block));

    match block_type {
        "text" => {
            let mut part = PartDTOOut::new(&id, message_id, session_id, String::from("text"), size);
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            part.summary = truncate_with_ellipsis(&text, SUMMARY_LIMIT);
            part.text = if text.is_empty() { None } else { Some(text) };
            part.synthetic = bool_field(block, "synthetic");
            part.ignored = bool_field(block, "ignored");
            part.time = time_range(block.get("time"));
            part
        }
        "reasoning" => {
            let mut part =
                PartDTOOut::new(&id, message_id, session_id, String::from("reasoning"), size);
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            part.summary = truncate_with_ellipsis(&text, SUMMARY_LIMIT);
            part.text = if text.is_empty() { None } else { Some(text) };
            part.time = time_range(block.get("time"));
            part
        }
        "tool" => map_tool(&id, message_id, session_id, block, size),
        // 未知块类型（包含 v2 未来新增类型）：透传原始 JSON，绝不 panic。
        other => {
            let mut part =
                PartDTOOut::new(&id, message_id, session_id, other.to_string(), size);
            part.summary = Some(format!("[{other}]"));
            part.metadata = Some(block.clone());
            part
        }
    }
}

fn map_tool(
    id: &str,
    message_id: &str,
    session_id: &str,
    block: &Value,
    size: i64,
) -> PartDTOOut {
    let mut part = PartDTOOut::new(id, message_id, session_id, String::from("tool"), size);

    part.tool_name = Some(
        block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    );
    // v2 用 `id` 表示 call id；v1 是 `callID`。
    part.call_id = non_empty(block.get("id").and_then(Value::as_str));
    part.summary = Some(
        part.tool_name
            .clone()
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| String::from("[tool]")),
    );

    let Some(state) = block.get("state").filter(|state| state.is_object()) else {
        // 字段缺失也要能展示：按 v1 默认状态处理。
        part.status = Some(String::from("completed"));
        part.tool_state = Some(String::from("completed"));
        return part;
    };

    let status = state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("completed");
    part.status = Some(status.to_string());
    if KNOWN_TOOL_STATES.contains(&status) {
        part.tool_state = Some(status.to_string());
    }

    part.input = state.get("input").and_then(as_string);
    part.output = tool_output(state.get("content"));
    part.error = state.get("error").and_then(as_string);
    part.title = non_empty(state.get("title").and_then(Value::as_str));
    part.metadata = block
        .get("metadata")
        .or_else(|| state.get("metadata"))
        .filter(|meta| !meta.is_null())
        .cloned();
    part.time = time_range(state.get("time")).or_else(|| time_range(block.get("time")));

    part
}

/// 合成的 `step-finish` 逻辑块：v2 把 token/cost 挂在 assistant 消息上，
/// 没有独立分片，这里按 v1 语义补齐 `tokens` / `cost` / `reason`。
fn step_finish(message_id: &str, session_id: &str, data: &Value) -> PartDTOOut {
    let mut part = PartDTOOut::new(
        &format!("{message_id}:step-finish"),
        message_id,
        session_id,
        String::from("step-finish"),
        0,
    );

    let reason = data
        .get("finish")
        .and_then(Value::as_str)
        .unwrap_or("completed")
        .to_string();
    part.reason = Some(reason.clone());
    part.status = Some(reason.clone());
    part.cost = data.get("cost").and_then(Value::as_f64);
    part.time = time_range(data.get("time"));

    match data.get("tokens").filter(|tokens| tokens.is_object()) {
        Some(tokens) => {
            let cache_nested = tokens.get("cache").filter(|cache| cache.is_object());
            let cache_read = cache_nested
                .and_then(|cache| cache.get("read"))
                .or_else(|| tokens.get("cache_read"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let cache_write = cache_nested
                .and_then(|cache| cache.get("write"))
                .or_else(|| tokens.get("cache_write"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let input = tokens.get("input").and_then(Value::as_i64).unwrap_or(0);
            let output = tokens.get("output").and_then(Value::as_i64).unwrap_or(0);
            let reasoning = tokens.get("reasoning").and_then(Value::as_i64).unwrap_or(0);
            let total = input + output + reasoning + cache_read + cache_write;

            let mut summary = Vec::new();
            if input != 0 {
                summary.push(format!("in {input}"));
            }
            if output != 0 {
                summary.push(format!("out {output}"));
            }
            part.summary = Some(format!(
                "Step finished: {} ({})",
                reason,
                summary.join("/")
            ));
            part.tokens = Some(PartTokens {
                input,
                output,
                reasoning,
                cache_read,
                cache_write,
                total: Some(total),
            });
        }
        None => {
            part.summary = Some(format!("Step finished: {reason}"));
        }
    }

    part
}

fn block_type(block: &Value) -> Option<&str> {
    block.get("type").and_then(Value::as_str)
}

pub fn synthetic_id(message_id: &str, index: usize) -> String {
    format!("{message_id}:{index:06}")
}

/// `state.content` 是内容块数组（通常只有 text），拼接成可展示文本。
fn tool_output(content: Option<&Value>) -> Option<String> {
    match content {
        Some(Value::String(text)) => non_empty(Some(text.as_str())),
        Some(Value::Array(blocks)) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        }
        Some(other) if !other.is_null() => as_string(other),
        _ => None,
    }
}

/// v1 `asString` 语义：字符串原样，其它序列化为 JSON。
fn as_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => non_empty(Some(text.as_str())),
        other => Some(
            serde_json::to_string_pretty(other).unwrap_or_else(|_| String::from("[无法序列化]")),
        ),
    }
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool).filter(|flag| *flag)
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

fn data_size(block: Option<&Value>) -> i64 {
    block
        .and_then(|block| serde_json::to_string(block).ok())
        .map(|json| json.len() as i64)
        .unwrap_or(0)
}

/// v2 时间戳字段名是 `created` / `completed`，v1 是 `start` / `end`。
fn time_range(value: Option<&Value>) -> Option<PartTimeRange> {
    let value = value.filter(|value| value.is_object())?;
    let start = value
        .get("start")
        .or_else(|| value.get("created"))
        .and_then(Value::as_i64);
    let end = value
        .get("end")
        .or_else(|| value.get("completed"))
        .and_then(Value::as_i64);
    if start.is_none() && end.is_none() {
        return None;
    }
    Some(PartTimeRange { start, end })
}

fn truncate_with_ellipsis(text: &str, max: usize) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if text.chars().count() > max {
        let truncated: String = text.chars().take(max).collect();
        return Some(format!("{truncated}..."));
    }
    Some(text.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{map_message, message_text};

    #[test]
    fn text_and_reasoning_blocks_map_directly_with_stable_ids() {
        let data = json!({
            "content": [
                {"type": "reasoning", "text": "先确认入口", "time": {"created": 10, "completed": 20}},
                {"type": "text", "text": "结论：入口在 db.rs"}
            ]
        });

        let parts = map_message("msg_1", "ses_1", "assistant", &data);

        // 两个内容块 + 合成的 step-finish
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].id, "msg_1:000001");
        assert_eq!(parts[0].part_type, "reasoning");
        assert_eq!(parts[0].text.as_deref(), Some("先确认入口"));
        assert_eq!(parts[0].time.as_ref().and_then(|t| t.start), Some(10));
        assert_eq!(parts[0].time.as_ref().and_then(|t| t.end), Some(20));

        assert_eq!(parts[1].id, "msg_1:000002");
        assert_eq!(parts[1].part_type, "text");
        assert_eq!(parts[1].text.as_deref(), Some("结论：入口在 db.rs"));
        assert_eq!(parts[1].summary.as_deref(), Some("结论：入口在 db.rs"));

        assert_eq!(parts[2].id, "msg_1:step-finish");
    }

    #[test]
    fn tool_block_maps_call_id_output_and_error_without_content() {
        let data = json!({
            "content": [
                {
                    "type": "tool",
                    "id": "call_ok",
                    "name": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/tmp/a.rs"},
                        "content": [{"type": "text", "text": "第一段"}, {"type": "text", "text": "第二段"}],
                        "metadata": {"bytes": 12}
                    }
                },
                {
                    "type": "tool",
                    "id": "call_err",
                    "name": "read",
                    "state": {
                        "status": "error",
                        "input": {"filePath": "/tmp/missing.rs"},
                        "error": {"type": "tool.execution", "message": "File not found"}
                    }
                }
            ]
        });

        let parts = map_message("msg_tool", "ses_1", "assistant", &data);

        let ok = &parts[0];
        assert_eq!(ok.call_id.as_deref(), Some("call_ok"));
        assert_eq!(ok.tool_name.as_deref(), Some("read"));
        assert_eq!(ok.tool_state.as_deref(), Some("completed"));
        assert_eq!(ok.output.as_deref(), Some("第一段\n第二段"));
        assert!(ok.input.as_deref().unwrap_or_default().contains("filePath"));
        assert!(ok.metadata.is_some());

        // error 分支没有 state.content：不得 panic，output 为空，error 有值
        let err = &parts[1];
        assert_eq!(err.tool_state.as_deref(), Some("error"));
        assert!(err.output.is_none());
        assert!(err
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("File not found"));
    }

    #[test]
    fn unknown_block_type_is_passed_through_as_raw_json() {
        let data = json!({
            "content": [{"type": "future-block", "payload": {"nested": true}}]
        });

        let parts = map_message("msg_x", "ses_x", "user", &data);

        assert_eq!(parts.len(), 1, "user 消息不合成 step-finish");
        assert_eq!(parts[0].part_type, "future-block");
        assert_eq!(parts[0].summary.as_deref(), Some("[future-block]"));
        assert_eq!(
            parts[0]
                .metadata
                .as_ref()
                .and_then(|meta| meta.get("payload"))
                .and_then(|payload| payload.get("nested"))
                .and_then(|nested| nested.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn assistant_message_synthesizes_step_finish_with_total_tokens() {
        let data = json!({
            "content": [{"type": "text", "text": "ok"}],
            "finish": "tool-calls",
            "cost": 0.0042,
            "tokens": {"input": 100, "output": 20, "reasoning": 5, "cache": {"read": 7, "write": 3}},
            "time": {"created": 100, "completed": 200}
        });

        let parts = map_message("msg_a", "ses_a", "assistant", &data);
        let finish = parts.last().expect("step-finish is appended");

        assert_eq!(finish.part_type, "step-finish");
        assert_eq!(finish.id, "msg_a:step-finish");
        assert_eq!(finish.reason.as_deref(), Some("tool-calls"));
        assert_eq!(finish.cost, Some(0.0042));
        let tokens = finish.tokens.as_ref().expect("tokens are mapped");
        assert_eq!(tokens.input, 100);
        assert_eq!(tokens.cache_read, 7);
        assert_eq!(tokens.cache_write, 3);
        assert_eq!(tokens.total, Some(135));
        assert_eq!(
            finish.summary.as_deref(),
            Some("Step finished: tool-calls (in 100/out 20)")
        );
    }

    #[test]
    fn assistant_message_without_tokens_still_gets_step_finish() {
        let data = json!({"content": [], "time": {"created": 1}});

        let parts = map_message("msg_plain", "ses_a", "assistant", &data);

        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].part_type, "step-finish");
        assert!(parts[0].tokens.is_none());
        assert_eq!(parts[0].reason.as_deref(), Some("completed"));
        assert_eq!(parts[0].summary.as_deref(), Some("Step finished: completed"));
    }

    #[test]
    fn message_without_content_array_falls_back_to_text_field() {
        let data = json!({"text": "旧表尾消息（迁移后 v1 客户端追加写入）", "time": {"created": 9}});

        let parts = map_message("msg_user", "ses_u", "user", &data);

        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].id, "msg_user:000001");
        assert_eq!(parts[0].part_type, "text");
        assert_eq!(
            parts[0].text.as_deref(),
            Some("旧表尾消息（迁移后 v1 客户端追加写入）")
        );
        assert_eq!(message_text(&data), "旧表尾消息（迁移后 v1 客户端追加写入）");
    }

    #[test]
    fn message_text_joins_text_blocks_and_ignores_reasoning() {
        let data = json!({
            "content": [
                {"type": "reasoning", "text": "思考"},
                {"type": "text", "text": "答案一"},
                {"type": "text", "text": "答案二"}
            ]
        });

        assert_eq!(message_text(&data), "答案一\n\n答案二");
    }
}
