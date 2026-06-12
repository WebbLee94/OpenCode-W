import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

export default function AgentBubble({ part }: { part: PartDTO }) {
  return (
    <PartBubbleShell
      icon="🤖"
      title={`Agent: ${part.agentName || 'unknown'}`}
      variant="neutral"
    >
      {part.agentSource && (
        <div className="text-xs text-gray-500">
          <div>value: {part.agentSource.value}</div>
          <div>
            offset: {part.agentSource.start}-{part.agentSource.end}
          </div>
        </div>
      )}
    </PartBubbleShell>
  )
}
