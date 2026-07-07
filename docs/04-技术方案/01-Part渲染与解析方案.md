# OpenCode-W Part 渲染与解析方案

> 基于调研：[04-Part数据模型调研.md](../00-调研分析/04-Part数据模型调研.md)
> 适用范围：OpenCode-W 预览 Tab（ConversationView）和解析 Tab（MessageViewer）

本文档面向 OpenCode-W 实现侧，定义 12 种 part type 的解析策略、PartDTO 扩展、PartBubbles 渲染注册表与扩展流程。Schema 与字段语义以 [04-Part数据模型调研.md](../00-调研分析/04-Part数据模型调研.md) 为权威来源，本文不再重复列出。

## 一、各 Part 类型解析策略

> 各小节中"当前 OpenCode-W 覆盖度"指实际代码已支持的范围；"解析策略"给出目标实现；"渲染建议"为 UI 落点。
> 完整 Schema 定义见 [04-Part数据模型调研.md#三](../00-调研分析/04-Part数据模型调研.md)。

### 3.1 TextPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#31](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：部分（`electron/ipc/messages.ts:33-37` 仅读 `text/content`，未读 `synthetic/ignored/time/metadata`）。

**解析策略**：

```typescript
case 'text': {
  const text = (data.text as string) ?? (data.content as string) ?? ''
  part.summary = text.length > 200 ? text.slice(0, 200) + '...' : text
  part.synthetic = data.synthetic as boolean | undefined
  part.ignored = data.ignored as boolean | undefined
  part.text = text                       // 新增：保留完整文本
  break
}
```

**渲染建议**：

- assistant 角色 → `<MarkdownBlock content={part.text}>`（react-markdown + highlight.js）
- user 角色 → `<ExpandableContent content={part.text}>`（纯文本，可展开）
- `synthetic=true` → 灰色 + 斜体 + "synthetic" 徽章
- `ignored=true` → 删除线或折叠为「已忽略」徽章

### 3.2 ReasoningPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#32](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：部分（`messages.ts:52-56` 仅读 `text`）。

**解析策略**：

```typescript
case 'reasoning': {
  const text = (data.text as string) ?? ''
  part.text = text
  part.summary = text.length > 200 ? text.slice(0, 200) + '...' : text
  // time 字段透传
  if (data.time && typeof data.time === 'object') {
    part.time = data.time as { start: number; end?: number }
  }
  break
}
```

**渲染建议**：

- 默认**折叠**的橙色卡片（🧠）
- 标题：`💭 推理过程` + 展开/收起按钮 + token 估算
- 展开后显示完整 `text`（可保留等宽字体或 prose 排版）

### 3.3 ToolPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#33](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：仅 flat（`messages.ts:38-51`，丢失 `pending/running` 状态）。

**解析策略**：

```typescript
case 'tool': {
  // 兼容 canonical state 形式
  if (data.state && typeof data.state === 'object') {
    const state = data.state as Record<string, unknown>
    const status = (state.status as string) ?? 'completed'
    part.status = status
    part.toolName = (data.tool as string) ?? (data.tool_name as string) ?? ''
    part.callID = data.callID as string | undefined
    const input = state.input ?? data.tool_input ?? data.input
    part.input = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    if (state.output !== undefined || data.tool_output !== undefined) {
      const output = state.output ?? data.tool_output ?? data.output
      part.output = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    }
    if (state.error) part.output = String(state.error)
    if (state.title) part.title = String(state.title)
    // 透传 attachments 与 time
    if (Array.isArray(state.attachments)) part.attachments = state.attachments
    if (state.time) part.time = state.time
  } else {
    // 旧 flat 形式
    part.toolName = (data.tool_name as string) ?? (data.toolName as string) ?? ''
    part.status = (data.status as string) ?? (data.result as string) ?? 'completed'
    if (data.tool_input !== undefined) part.input = JSON.stringify(data.tool_input, null, 2)
    if (data.tool_output !== undefined) part.output = String(data.tool_output)
  }
  part.summary = part.toolName
  break
}
```

**渲染建议**（按 state.status 区分）：

| status | 图标 | 颜色 | 行为 |
|--------|------|------|------|
| `pending` | ⏳ | 灰色 | 折叠显示「等待执行」 |
| `running` | ⟳ | 蓝色 + 旋转动画 | 折叠显示 title，可展开查看 input |
| `completed` | ✓ | 绿色 | 折叠显示 title + 耗时，展开查看 input/output |
| `error` | ✗ | 红色 | 强制展开 + 错误详情（红色背景） |

### 3.4 FilePart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#34](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：占位符（`messages.ts:79-81` 折叠为 `[file]`）。

**解析策略**：

```typescript
case 'file': {
  part.mime = data.mime as string | undefined
  part.filename = data.filename as string | undefined
  part.url = data.url as string | undefined
  if (data.source && typeof data.source === 'object') {
    const src = data.source as Record<string, unknown>
    part.sourceType = src.type as 'file' | 'symbol' | 'resource' | undefined
    if (src.type === 'file') part.sourcePath = src.path as string | undefined
    if (src.type === 'symbol') {
      part.sourcePath = src.path as string | undefined
      part.sourceName = src.name as string | undefined
    }
    if (src.type === 'resource') {
      part.sourceClient = src.clientName as string | undefined
      part.sourceUri = src.uri as string | undefined
    }
  }
  part.summary = part.filename || part.url || '[file]'
  break
}
```

**渲染建议**：

- `mime` 以 `image/*` 开头 → 缩略图（`<img src={url} />`），点击放大
- `mime` 以 `application/pdf` 开头 → PDF 图标 + 链接
- 其他 → 通用文件图标 + filename + 大小

### 3.5 PatchPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#35](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：占位符。

**解析策略**：

```typescript
case 'patch': {
  part.patchHash = data.hash as string | undefined
  part.patchFiles = Array.isArray(data.files) ? (data.files as string[]) : []
  part.summary = `补丁 #${(part.patchHash || '').slice(0, 8)} · ${part.patchFiles.length} 个文件`
  break
}
```

**渲染建议**：

- 📝 补丁卡片（紫色背景）
- 显示 hash 前 8 位 + 文件数
- 展开后列出 `files` 列表（最多 20 条，溢出折叠）

### 3.6 SnapshotPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#36](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：未覆盖（被 switch 落到 default）。

**解析策略**：

```typescript
case 'snapshot': {
  part.snapshotId = data.snapshot as string | undefined
  part.summary = `快照 #${(part.snapshotId || '').slice(0, 8)}`
  break
}
```

**渲染建议**：

- 📸 快照徽章（灰色小标签）
- 仅显示前 8 位 ID，hover 提示完整 ID

### 3.7 AgentPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#37](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：未覆盖。

**解析策略**：

```typescript
case 'agent': {
  part.agentName = data.name as string | undefined
  part.summary = `🤖 ${part.agentName || 'agent'}`
  if (data.source && typeof data.source === 'object') {
    part.agentSource = data.source as { value: string; start: number; end: number }
  }
  break
}
```

**渲染建议**：

- 🤖 agent 名称徽章（蓝色背景）
- 可选 `source` 信息：用户消息中被识别为 agent 调用的文本范围

### 3.8 StepStartPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#38](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：部分（`messages.ts:57-61` 仅处理 flat 对象形式）。

**解析策略**：

```typescript
case 'step-start': {
  const snap = data.snapshot
  if (typeof snap === 'string') {
    part.snapshot = snap
    part.summary = `▶ ${snap.slice(0, 8)}`
  } else if (snap && typeof snap === 'object') {
    const s = snap as Record<string, unknown>
    part.summary = `▶ ${(s.step_name as string) ?? `Step ${s.step_id ?? ''}`}`
  } else {
    part.summary = '▶ 步骤开始'
  }
  break
}
```

**渲染建议**：

- 步骤分隔线（左侧竖线 + ▶ 标记 + summary）
- 视觉上不抢眼，用于切分多步骤会话

### 3.9 StepFinishPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#39](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：部分（`messages.ts:62-76` 处理 flat 格式的 `result/tokens`）。

**解析策略**：

```typescript
case 'step-finish': {
  // 兼容 canonical 与 flat
  const reason = (data.reason as string) ?? (data.result as string) ?? 'completed'
  part.status = reason
  part.summary = `Step finished: ${reason}`

  // cost 字段
  if (typeof data.cost === 'number') part.cost = data.cost

  // tokens 兼容
  const tokens = data.tokens
  if (tokens && typeof tokens === 'object') {
    const t = tokens as Record<string, unknown>
    if (t.cache && typeof t.cache === 'object') {
      // canonical 嵌套
      const c = t.cache as Record<string, number>
      part.tokens = {
        input: (t.input as number) ?? 0,
        output: (t.output as number) ?? 0,
        reasoning: (t.reasoning as number) ?? 0,
        cache_read: (c.read as number) ?? 0,
        cache_write: (c.write as number) ?? 0,
      }
    } else {
      // flat
      part.tokens = {
        input: (t.input as number) ?? 0,
        output: (t.output as number) ?? 0,
        reasoning: (t.reasoning as number) ?? 0,
        cache_read: (t.cache_read as number) ?? 0,
        cache_write: (t.cache_write as number) ?? 0,
      }
    }
  }
  break
}
```

**渲染建议**：

- 步骤底部 token 摘要卡片（紫色背景）
- 显示 Input / Output / Reasoning / Cache Read / Cache Write 网格
- `cost > 0` 时附加美元金额
- reason 颜色编码：`end_turn` 绿、`tool_use` 蓝、`max_steps` 黄

### 3.10 SubtaskPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#310](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：未覆盖。

**解析策略**：

```typescript
case 'subtask': {
  part.subtaskPrompt = data.prompt as string | undefined
  part.subtaskDescription = data.description as string | undefined
  part.subtaskAgent = data.agent as string | undefined
  if (data.model && typeof data.model === 'object') {
    part.subtaskModel = data.model as { providerID: string; modelID: string }
  }
  part.subtaskCommand = data.command as string | undefined
  part.summary = `🌿 ${part.subtaskAgent || 'subtask'}: ${part.subtaskDescription?.slice(0, 50) || ''}`
  break
}
```

**渲染建议**：

- 🌿 子任务卡片（淡黄色背景）
- 显示 agent 名 + 描述前 50 字符
- 展开后显示完整 prompt、model、command

### 3.11 RetryPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#311](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：未覆盖。

**解析策略**：

```typescript
case 'retry': {
  part.retryAttempt = data.attempt as number | undefined
  if (data.error && typeof data.error === 'object') {
    part.retryError = data.error as {
      message: string
      statusCode?: number
      isRetryable?: boolean
    }
  }
  part.summary = `🔄 第 ${part.retryAttempt ?? '?'} 次重试`
  break
}
```

**渲染建议**：

- 🔄 重试卡片（黄色警示背景）
- 显示 attempt 次数 + 错误摘要（`message` + `statusCode`）
- `isRetryable=false` 时显示「不可重试」徽章

### 3.12 CompactionPart 解析策略

> 参考 Schema 定义：[04-Part数据模型调研.md#312](../00-调研分析/04-Part数据模型调研.md)

**当前 OpenCode-W 覆盖度**：占位符（`messages.ts:77-78` 折叠为 `[compaction]`）。

**解析策略**：

```typescript
case 'compaction': {
  part.compactionAuto = data.auto as boolean | undefined
  part.compactionOverflow = data.overflow as boolean | undefined
  if (typeof data.tail_start_id === 'string') {
    part.compactionTailStartId = data.tail_start_id
  }
  part.summary = `🗜 压缩 ${part.compactionAuto ? '(自动)' : '(手动)'}`
  break
}
```

**渲染建议**：

- 🗜 压缩事件卡片（深灰色背景）
- 显示 `auto/manual` 标签 + 是否 overflow
- 新版本若有 `tail_start_id`，可作为「保留对话起点」的可点击链接

## 二、解析方案

### 4.1 兼容性策略

**两层兼容**：canonical 优先 → flat 兜底 → 缺省占位。

```typescript
// 通用模式
function pick<T>(...candidates: (T | undefined | null)[]): T | undefined {
  for (const c of candidates) if (c !== undefined && c !== null) return c
  return undefined
}
```

每个 part type 的解析函数遵循：

1. 优先读取 canonical 字段（如 `data.state.status`）
2. 缺失时回退到 flat 字段（如 `data.status`）
3. 仍缺失时填默认值（`'completed'` / `''` / `[]`）
4. 异常时 try/catch 兜底，保证 `parsePartData` 永不抛错

### 4.2 PartDTO 扩展

`shared/types.ts:154-173` 现有字段已不足，需扩展：

```typescript
export interface PartDTO {
  // 基础（已有）
  id: string
  message_id: string
  session_id: string
  type: PartType                         // 扩展为 12 种联合类型
  data_size: number
  summary?: string

  // 通用新增（按 type 填充）
  text?: string                          // text / reasoning 完整文本
  time?: { start: number; end?: number } // text / reasoning / tool
  synthetic?: boolean                    // text
  ignored?: boolean                      // text

  // tool 专用
  toolName?: string
  callID?: string
  input?: string
  output?: string
  status?: string                        // pending/running/completed/error
  title?: string
  attachments?: unknown[]                // FilePart[]
  cost?: number                          // step-finish

  // step-finish tokens（已有，需对齐 canonical 嵌套）
  tokens?: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache_read: number
    cache_write: number
  }

  // file 专用
  mime?: string
  filename?: string
  url?: string
  sourceType?: 'file' | 'symbol' | 'resource'
  sourcePath?: string
  sourceName?: string
  sourceClient?: string
  sourceUri?: string

  // patch 专用
  patchHash?: string
  patchFiles?: string[]

  // snapshot 专用
  snapshotId?: string
  snapshot?: string                      // step-start 中是 string，旧 flat 是 object

  // agent 专用
  agentName?: string
  agentSource?: { value: string; start: number; end: number }

  // subtask 专用
  subtaskPrompt?: string
  subtaskDescription?: string
  subtaskAgent?: string
  subtaskModel?: { providerID: string; modelID: string }
  subtaskCommand?: string

  // retry 专用
  retryAttempt?: number
  retryError?: { message: string; statusCode?: number; isRetryable?: boolean }

  // compaction 专用
  compactionAuto?: boolean
  compactionOverflow?: boolean
  compactionTailStartId?: string
}

export type PartType =
  | 'text' | 'tool' | 'reasoning'
  | 'step-start' | 'step-finish'
  | 'compaction' | 'patch' | 'file'
  | 'snapshot' | 'agent' | 'subtask' | 'retry'
```

### 4.3 parsePartData 重构（规划中，尚未实施）

> 当前实现：`parsePartData` 仍为单文件内联 switch-case，集中在 `electron/ipc/messages.ts` 中。
> 下方为规划中的分文件解析器方案，可在后续迭代中按此拆分：

将现有 80 行 switch 重构为分文件解析器 + 统一调度：

```
electron/ipc/part-parsers/
├── index.ts                # parsePartData 调度
├── text.ts                 # TextPart
├── reasoning.ts            # ReasoningPart
├── tool.ts                 # ToolPart（含 4 state）
├── file.ts                 # FilePart
├── patch.ts                # PatchPart
├── snapshot.ts             # SnapshotPart
├── agent.ts                # AgentPart
├── step-start.ts           # StepStartPart
├── step-finish.ts          # StepFinishPart
├── subtask.ts              # SubtaskPart
├── retry.ts                # RetryPart
└── compaction.ts           # CompactionPart
```

每个解析器签名：

```typescript
export function parseXxxPart(data: Record<string, unknown>, part: PartDTO): void
```

调度逻辑：

```typescript
export function parsePartData(row: Record<string, unknown>): PartDTO {
  const data = parseDataField(row.data)
  const part = createBasePart(row, data.type ?? 'text')
  try {
    switch (part.type) {
      case 'text':        parseTextPart(data, part); break
      case 'reasoning':   parseReasoningPart(data, part); break
      case 'tool':        parseToolPart(data, part); break
      // ... 其他
      default:            part.summary = `[${part.type}]`
    }
  } catch {
    part.summary = `[parse-error: ${part.type}]`
  }
  return part
}
```

## 三、渲染方案

### 5.1 组件设计（PartBubbles 注册表）

将渲染从 `ConversationView.tsx:94-173` 的内联组件抽离为可复用注册表：

> 当前实现：UI Bubble 与注册表实际位于 `src/features/sessions/PartBubbles/`，下方为历史方案中规划的目录树。

```
src/components/part-bubbles/
├── index.tsx               # PartBubble 入口（注册表模式）
├── registry.ts             # PART_BUBBLES 注册表
├── TextBubble.tsx          # Markdown 渲染
├── ReasoningBubble.tsx     # 折叠卡片
├── ToolBubble.tsx          # 4 state 状态机
├── FileBubble.tsx          # mime 适配
├── PatchBubble.tsx         # 紫色卡片
├── SnapshotBadge.tsx       # 灰色徽章
├── AgentBadge.tsx          # agent 名称
├── StepStartDivider.tsx    # 分隔线
├── StepFinishFooter.tsx    # token 摘要
├── SubtaskCard.tsx         # 子任务卡片
├── RetryCard.tsx           # 重试卡片
└── CompactionCard.tsx      # 压缩事件
```

注册表模式：

```typescript
// registry.ts
import type { PartType, PartDTO } from '../../../shared/types'
import type { ComponentType } from 'react'

export const PART_BUBBLES: Record<PartType, ComponentType<{ part: PartDTO }>> = {
  'text':        TextBubble,
  'reasoning':   ReasoningBubble,
  'tool':        ToolBubble,
  'file':        FileBubble,
  'patch':       PatchBubble,
  'snapshot':    SnapshotBadge,
  'agent':       AgentBadge,
  'step-start':  StepStartDivider,
  'step-finish': StepFinishFooter,
  'subtask':     SubtaskCard,
  'retry':       RetryCard,
  'compaction':  CompactionCard,
}

// index.tsx
export function PartBubble({ part }: { part: PartDTO }) {
  const Component = PART_BUBBLES[part.type] ?? GenericFallback
  return <Component part={part} />
}
```

### 5.2 复用范围

| 消费者 | 文件 | 用法 |
|--------|------|------|
| 预览 Tab | `src/features/sessions/ConversationView.tsx` | 替换内联 `renderPart`，传入 `detail.parts` |
| 解析 Tab | `src/features/messages/MessageViewer.tsx` | 替换 `renderParts` 表格展开后的 JSON 渲染 |
| 未来扩展 | 仪表盘详情、全文搜索结果预览 | 直接复用 |

调用示例：

```tsx
// ConversationView.tsx
import { PartBubble } from '../../components/part-bubbles'

// 替换原 renderPart
{role === 'tool' && detail?.parts.map(p => <PartBubble key={p.id} part={p} />)}
```

## 四、扩展指南

当 OpenCode 未来新增 part type 时，按以下流程扩展：

### 1. 更新 `PartType` 联合

`shared/types.ts:154-158` 与第二节中的 `PartType` 联合类型同步追加新值。

### 2. 编写解析器

在 `electron/ipc/messages.ts` 的 `parsePartData` 函数中追加新 case，遵循 canonical 优先 + flat 兜底。

### 3. 实现 Bubble 组件

在 `src/features/sessions/PartBubbles/<NewType>Bubble.tsx` 中实现 UI，签名固定为 `{ part: PartDTO }: JSX.Element`。

### 4. 注册到 PART_BUBBLES

`src/features/sessions/PartBubbles/registry.tsx` 中追加映射键值对。TypeScript 类型系统会自动校验完整性（漏注册会编译报错）。

### 5. 更新类型对照表

在调研文档 [04-Part数据模型调研.md#二](../00-调研分析/04-Part数据模型调研.md) 表格中追加一行。

### 6. 更新徽章配置（如有）

`src/features/messages/badges.tsx` 中的 `PartTypeBadge` 可能需要追加颜色/图标配置（如 MessageViewer 中仍在用）。

### 7. 兼容性测试

用 `npm run generate-fixture` 生成包含新 part type 的测试数据，验证：

- 解析器不抛错
- DTO 字段正确填充
- 渲染组件在 12 种状态变体下正常显示

---

**关键引用（OpenCode-W 实现）**：

- `electron/ipc/messages.ts:6-86`（parsePartData）
- `shared/types.ts:154-173`（PartDTO）
- `src/features/sessions/ConversationView.tsx:94-173`（内联渲染）
- `src/features/messages/MessageViewer.tsx:80-105`（解析 Tab 表格）
