import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

export default function SubtaskBubble({ part }: { part: PartDTO }) {
  const hasDetail =
    Boolean(part.subtaskDescription) || Boolean(part.subtaskPrompt) || Boolean(part.subtaskCommand)

  return (
    <PartBubbleShell
      icon="🌿"
      title="子任务"
      meta={part.subtaskAgent}
      variant="action"
      collapsible={hasDetail}
      defaultExpanded={true}
    >
      {part.subtaskDescription && (
        <div className="text-sm text-gray-700 mb-1">{part.subtaskDescription}</div>
      )}
      {part.subtaskPrompt && (
        <pre className="text-xs bg-gray-50 p-2 rounded whitespace-pre-wrap">
          {part.subtaskPrompt}
        </pre>
      )}
      {part.subtaskCommand && (
        <div className="mt-1 text-xs font-mono text-gray-600">$ {part.subtaskCommand}</div>
      )}
    </PartBubbleShell>
  )
}
