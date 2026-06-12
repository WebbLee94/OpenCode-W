import type { ComponentType, ReactNode } from 'react'
import type { PartDTO, PartType } from '../../../../shared/types'
import TextBubble from './TextBubble'
import ReasoningBubble from './ReasoningBubble'
import ToolBubble from './ToolBubble'
import FileBubble from './FileBubble'
import PatchBubble from './PatchBubble'
import SnapshotBubble from './SnapshotBubble'
import AgentBubble from './AgentBubble'
import StepStartBubble from './StepStartBubble'
import StepFinishBubble from './StepFinishBubble'
import SubtaskBubble from './SubtaskBubble'
import RetryBubble from './RetryBubble'
import CompactionBubble from './CompactionBubble'

export { default as PartBubbleShell } from './PartBubbleShell'
export { default as TextBubble } from './TextBubble'
export { default as ReasoningBubble } from './ReasoningBubble'
export { default as ToolBubble } from './ToolBubble'
export { default as FileBubble } from './FileBubble'
export { default as PatchBubble } from './PatchBubble'
export { default as SnapshotBubble } from './SnapshotBubble'
export { default as AgentBubble } from './AgentBubble'
export { default as StepStartBubble } from './StepStartBubble'
export { default as StepFinishBubble } from './StepFinishBubble'
export { default as SubtaskBubble } from './SubtaskBubble'
export { default as RetryBubble } from './RetryBubble'
export { default as CompactionBubble } from './CompactionBubble'

/**
 * Part type → Bubble 组件注册表
 * 未来新增 part type：导入新组件 + 在此注册即可
 */
export const PART_BUBBLES: Record<PartType, ComponentType<{ part: PartDTO }>> = {
  text: TextBubble,
  reasoning: ReasoningBubble,
  tool: ToolBubble,
  file: FileBubble,
  patch: PatchBubble,
  snapshot: SnapshotBubble,
  agent: AgentBubble,
  'step-start': StepStartBubble,
  'step-finish': StepFinishBubble,
  subtask: SubtaskBubble,
  retry: RetryBubble,
  compaction: CompactionBubble,
}

/** 通用 renderPart 函数：查注册表渲染 */
export function renderPart(part: PartDTO): ReactNode {
  const Bubble = PART_BUBBLES[part.type]
  if (!Bubble) return null
  return <Bubble key={part.id} part={part} />
}
