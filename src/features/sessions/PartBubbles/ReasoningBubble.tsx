import { useState } from 'react'
import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

const REASONING_PREVIEW = 200

export default function ReasoningBubble({ part }: { part: PartDTO }) {
  const [expanded, setExpanded] = useState(false)
  if (!part.text) return null
  const isLong = part.text.length > REASONING_PREVIEW
  const display = expanded || !isLong ? part.text : part.text.slice(0, REASONING_PREVIEW) + '…'

  return (
    <PartBubbleShell
      icon="🧠"
      title="已思考"
      variant="neutral"
      collapsible={true}
      defaultExpanded={false}
    >
      <div className="text-sm text-gray-700 whitespace-pre-wrap bg-white p-2 rounded border border-gray-100">
        {display}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-brand-600 hover:text-brand-800"
        >
          {expanded ? '收起推理过程' : '展开推理过程'}
        </button>
      )}
      {part.time?.start !== undefined && (
        <div className="mt-1 text-xs text-gray-400">⏱ {part.time.start}ms</div>
      )}
    </PartBubbleShell>
  )
}
