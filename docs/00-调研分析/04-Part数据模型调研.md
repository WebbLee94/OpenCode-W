# OpenCode Part 数据模型调研

> 调研对象：OpenCode 消息 part 的所有类型与 schema
> 调研时间：2026-06-12
> 数据来源：OpenCode 开源仓库 canonical schema（`packages/opencode/src/session/message-v2.ts`，commit `5d2dc888` / `5c5069b6` / `dev`）以及实际测试 DB 数据
> 关联文档：[01-Part渲染与解析方案.md](../04-技术方案/01-Part渲染与解析方案.md)（基于本调研的设计方案）

## 一、调研背景

OpenCode 的 `part` 表存储消息的组成单元，一个 message 可由多个 part 组成（文本片段、推理片段、工具调用、文件附件等）。完整理解所有 part type 的 schema 与字段语义，是应用层实现正确解析与渲染的前提。

OpenCode 的 part 数据具有以下复杂性：

1. **文本片段的双层来源** — assistant/user 消息的真实文本主要存储在 `part.data.text`（`type="text"`），`text` 字段存在 `text`（canonical）与 `content`（旧 flat）两种命名，并支持 `synthetic`（合成文本）与 `ignored`（忽略标记）两类状态。
2. **工具调用的状态机** — `tool` part 使用 `state.status` discriminated union 表示 4 种执行阶段（pending/running/completed/error），与旧 flat 格式的 `tool_name/tool_input/tool_output/status` 字段并存。
3. **特殊 part 类型的元数据差异** — 除 text/reasoning/tool 外，还有 file、patch、snapshot、agent、step-start、step-finish、subtask、retry、compaction 等 9 种特殊类型，各自承载不同的元数据。
4. **Schema 演进** — OpenCode 在不同版本中会调整 part schema（如 step-start 的 snapshot 字段从对象改为字符串、step-finish 增加 cost 字段、compaction 新增 tail_start_id 字段等），应用层需具备向前兼容能力。
5. **嵌套结构** — 部分 part 内部嵌套对象（如 tool.state、step-finish.tokens），数据访问层需递归提取。

本文档汇总 12 种 part type 的完整 schema 与字段语义，作为后续解析与渲染的权威依据；具体的 OpenCode-W 解析策略与渲染方案见 [01-Part渲染与解析方案.md](../04-技术方案/01-Part渲染与解析方案.md)。

## 二、Part 类型总览

| 类型 | 中文名 | 用途 | Canonical 字段数 | 当前覆盖度 |
|------|--------|------|------------------|------------|
| `text` | 文本片段 | 用户输入 / 助手响应 | 5 | 部分（仅 `text`） |
| `reasoning` | 推理片段 | 思考链（CoT） | 3 | 部分（仅 `text`） |
| `tool` | 工具调用 | 工具/函数调用记录 | 动态（4 state 子类型） | 仅 flat |
| `file` | 文件附件 | 用户上传的图片/PDF/文件 | 3 | 占位符 |
| `patch` | 代码补丁 | 代码 diff 应用记录 | 2 | 占位符 |
| `snapshot` | 会话快照 | 会话历史快照（用于回滚） | 1 | 未覆盖 |
| `agent` | 代理选择 | 标记消息使用的 agent | 2 | 未覆盖 |
| `step-start` | 步骤开始 | 标记推理步骤开始 | 1 | 部分 |
| `step-finish` | 步骤结束 | 标记步骤结束 + token 汇总 | 5+ | 部分 |
| `subtask` | 子任务 | 标记用户执行的子任务 | 4-5 | 未覆盖 |
| `retry` | 重试 | 记录 API 重试 | 3+ | 未覆盖 |
| `compaction` | 上下文压缩 | 上下文压缩事件 | 2-3 | 占位符 |

> 注：所有 part type 共享基础字段 `id, message_id, session_id, time_created, time_updated, data, data_size`。`type` 字段**不**是表列，而是存储在 `data` JSON 内部（见 `AGENTS.md` Schema 关键点）。

## 三、详细 Schema 定义

> 以下 schema 直接取自 OpenCode 仓库 `packages/opencode/src/session/message-v2.ts`（commit `5d2dc888` / `5c5069b6` / `dev`）。canonical 与 flat 字段名不同时，下方分别列出。
> 各 part type 在 OpenCode-W 中的解析策略与渲染方案见 [01-Part渲染与解析方案.md](../04-技术方案/01-Part渲染与解析方案.md)。

### 3.1 TextPart（文本片段）

**Canonical Schema**：

```typescript
export const TextPart = z.object({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().nullish(),     // 合成文本（注入的提示）
  ignored: z.boolean().nullish(),       // 标记忽略
  time: z.object({ start: z.number(), end: z.number().nullish() }).nullish(),
  metadata: z.record(z.string(), z.any()).nullish(),
})

export type TextPart = z.infer<typeof TextPart>
```

**Flat/兼容 Schema**（旧测试数据可能存在）：

```typescript
{
  type: "text",
  text: string,                         // 主字段
  content: string,                      // 旧 fallback
}
```

**关键字段说明**：

- `text` — 唯一必填字段，存储实际文本
- `synthetic` — 标记非用户原始输入的合成内容（系统注入、模板替换等）
- `time` — 该 part 渲染耗时（start/end 毫秒），可计算打字/响应速度

### 3.2 ReasoningPart（推理片段）

**Canonical Schema**：

```typescript
export const ReasoningPart = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  metadata: z.record(z.string(), z.any()).nullish(),
  time: z.object({ start: z.number(), end: z.number().nullish() }),  // 必填
})
```

**关键字段说明**：

- `text` — 模型的 Chain-of-Thought 完整文本，可能非常长（KB-MB 级）
- `time` — 必填；用于统计推理耗时

### 3.3 ToolPart（工具调用）

**Canonical Schema**（discriminated union on `state.status`）：

```typescript
export const ToolState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), input: z.record(z.string(), z.any()), raw: z.string() }),
  z.object({
    status: z.literal("running"),
    input: z.record(z.string(), z.any()),
    title: z.string().nullish(),
    metadata: z.record(z.string(), z.any()).nullish(),
    time: z.object({ start: z.number() }),  // 必填
  }),
  z.object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.any()),
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), z.any()),
    time: z.object({ start: z.number(), end: z.number(), compacted: z.boolean().nullish() }),
    attachments: z.array(FilePart).nullish(),  // 引用 FilePart
  }),
  z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.any()),
    error: z.string(),
    metadata: z.record(z.string(), z.any()).nullish(),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
])

export const ToolPart = z.object({
  type: z.literal("tool"),
  callID: z.string(),              // 工具调用唯一 ID
  tool: z.string(),                // 工具名
  state: ToolState,
  metadata: z.record(z.string(), z.any()).nullish(),
})
```

**Flat/兼容 Schema**（旧测试数据）：

```typescript
{
  type: "tool",
  tool_name: string,         // ↔ canonical.tool
  tool_input: object,        // ↔ canonical.state.input
  tool_output: string,       // ↔ canonical.state.output (completed)
  status: "completed" | "failed" | "pending",
  result: string,            // ↔ canonical.state.output / state.error
}
```

**关键字段说明**：

- `state.status` — 当前执行阶段，4 选 1
- `state.input` — 工具输入参数对象（canonical 是 object；flat 是 string）
- `state.output` — 工具输出（仅 completed）
- `state.attachments` — 工具产生的附件引用（completed 可选）
- `state.time.start/end` — 执行起止时间戳
- `state.compacted` — 该 tool 结果是否已被上下文压缩（completed 可选）

### 3.4 FilePart（文件附件）

**Canonical Schema**：

```typescript
export const FilePartSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), path: z.string(),
              text: z.object({ value: z.string(), start: z.number(), end: z.number() }) }),
  z.object({ type: z.literal("symbol"), path: z.string(), range: z.object(...),
              name: z.string(), kind: z.string(),
              text: z.object({ value: z.string(), start: z.number(), end: z.number() }) }),
  z.object({ type: z.literal("resource"), clientName: z.string(), uri: z.string(),
              text: z.object({ value: z.string(), start: z.number(), end: z.number() }) }),
])

export const FilePart = z.object({
  type: z.literal("file"),
  mime: z.string(),
  filename: z.string().nullish(),
  url: z.string(),
  source: FilePartSource.nullish(),
})
```

### 3.5 PatchPart（代码补丁）

**Canonical Schema**：

```typescript
export const PatchPart = z.object({
  type: z.literal("patch"),
  hash: z.string(),        // 补丁内容哈希
  files: z.array(z.string()),  // 涉及的文件路径列表
})
```

### 3.6 SnapshotPart（会话快照）

**Canonical Schema**：

```typescript
export const SnapshotPart = z.object({
  type: z.literal("snapshot"),
  snapshot: z.string(),    // 快照 ID
})
```

### 3.7 AgentPart（代理选择）

**Canonical Schema**：

```typescript
export const AgentPart = z.object({
  type: z.literal("agent"),
  name: z.string(),
  source: z.object({ value: z.string(), start: z.number(), end: z.number() }).nullish(),
})
```

### 3.8 StepStartPart（步骤开始）

**Canonical Schema**（新版，snapshot 为字符串）：

```typescript
export const StepStartPart = z.object({
  type: z.literal("step-start"),
  snapshot: z.string().nullish(),
})
```

**Flat/兼容 Schema**（旧版，snapshot 为对象）：

```typescript
{
  type: "step-start",
  snapshot: {
    step_id: string | number,
    step_name: string,
  } | undefined,
}
```

### 3.9 StepFinishPart（步骤结束）

**Canonical Schema**：

```typescript
export const StepFinishPart = z.object({
  type: z.literal("step-finish"),
  reason: z.string(),                // 结束原因（end_turn/tool_use/max_steps）
  snapshot: z.string().nullish(),
  cost: z.number(),                  // 美元成本
  tokens: z.object({
    total: z.number().nullish(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
})
```

**Flat/兼容 Schema**：

```typescript
{
  type: "step-finish",
  result: string,                    // ↔ canonical.reason
  tokens: {
    input: number,
    output: number,
    reasoning: number,
    cache_read: number,              // ↔ canonical.tokens.cache.read
    cache_write: number,             // ↔ canonical.tokens.cache.write
  },
}
```

### 3.10 SubtaskPart（子任务）

**Canonical Schema**：

```typescript
export const SubtaskPart = z.object({
  type: z.literal("subtask"),
  prompt: z.string(),                 // 子任务的提示词
  description: z.string(),            // 子任务描述
  agent: z.string(),                  // 执行的 agent 名
  model: z.object({ providerID: z.string(), modelID: z.string() }).nullish(),
  command: z.string().nullish(),      // 可选命令
})
```

### 3.11 RetryPart（重试）

**Canonical Schema**：

```typescript
export const APIError = z.object({
  message: z.string(),
  statusCode: z.number().nullish(),
  isRetryable: z.boolean(),
  responseHeaders: z.record(z.string(), z.string()).nullish(),
  responseBody: z.string().nullish(),
  metadata: z.record(z.string(), z.any()).nullish(),
})

export const RetryPart = z.object({
  type: z.literal("retry"),
  attempt: z.number(),                // 第 N 次重试
  error: APIError,                    // 错误详情
  time: z.object({ created: z.number() }),  // 重试发起时间
})
```

### 3.12 CompactionPart（上下文压缩）

**Canonical Schema**：

```typescript
export const CompactionPart = z.object({
  type: z.literal("compaction"),
  auto: z.boolean(),                  // 是否自动压缩
  overflow: z.boolean().nullish(),    // 是否因溢出触发
  // 新版本可能含：tail_start_id: z.string().nullish()
})
```

---

**关键引用**：

- OpenCode 源码：`packages/opencode/src/session/message-v2.ts`（commit `5d2dc888` / `5c5069b6` / `dev`）
- TypeScript Types 文档：<https://www.mintlify.com/anomalyco/opencode/sdk/types>
