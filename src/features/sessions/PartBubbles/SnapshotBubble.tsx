import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

export default function SnapshotBubble({ part }: { part: PartDTO }) {
  return (
    <PartBubbleShell
      icon="📸"
      title="会话快照"
      meta={part.snapshotData?.slice(0, 30)}
      variant="neutral"
    >
      {part.snapshotData && (
        <pre className="text-xs bg-gray-50 p-2 rounded font-mono break-all">{part.snapshotData}</pre>
      )}
    </PartBubbleShell>
  )
}
