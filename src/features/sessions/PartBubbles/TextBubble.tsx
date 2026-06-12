import { useState } from 'react'
import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

const CONTENT_PREVIEW = 500

function ExpandableText({ content, threshold = CONTENT_PREVIEW }: { content: string; threshold?: number }) {
  const [expanded, setExpanded] = useState(false)
  if (!content) return null
  if (content.length <= threshold) {
    return <div className="whitespace-pre-wrap text-sm text-gray-800">{content}</div>
  }
  return (
    <div>
      <div className="whitespace-pre-wrap text-sm text-gray-800">
        {expanded ? content : content.slice(0, threshold) + '…'}
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs text-brand-600 hover:text-brand-800"
      >
        {expanded ? '▲ 收起' : `▼ 展开全部 (${content.length} 字符)`}
      </button>
    </div>
  )
}

export default function TextBubble({ part }: { part: PartDTO }) {
  if (!part.text) return null
  const isSynthetic = part.synthetic
  const isIgnored = part.ignored

  return (
    <PartBubbleShell
      icon="📝"
      title={
        <span className="flex items-center gap-2">
          Text
          {isSynthetic && <span className="text-xs text-gray-400 font-normal">(synthetic)</span>}
          {isIgnored && <span className="text-xs text-gray-400 font-normal">(ignored)</span>}
        </span>
      }
      variant="neutral"
    >
      <ExpandableText content={part.text} />
      {part.time?.start !== undefined && (
        <div className="mt-1 text-xs text-gray-400">
          ⏱ {part.time.start}
          {part.time.end !== undefined && ` → ${part.time.end}`}
        </div>
      )}
    </PartBubbleShell>
  )
}
