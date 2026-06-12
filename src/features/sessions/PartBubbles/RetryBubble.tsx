import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

export default function RetryBubble({ part }: { part: PartDTO }) {
  return (
    <PartBubbleShell
      icon="🔄"
      title={`Retry 第 ${part.retryAttempt ?? '?'} 次尝试`}
      meta={part.retryTime ? new Date(part.retryTime).toLocaleString() : undefined}
      variant="event"
      collapsible={Boolean(part.retryError)}
      defaultExpanded={true}
    >
      {part.retryError && (
        <pre className="text-xs text-red-700 bg-red-50 p-2 rounded whitespace-pre-wrap break-all border border-red-200">
          {part.retryError}
        </pre>
      )}
    </PartBubbleShell>
  )
}
