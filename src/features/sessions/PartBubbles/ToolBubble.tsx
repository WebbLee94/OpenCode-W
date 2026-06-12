import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

type ToolState = NonNullable<PartDTO['toolState']>

const STATE_CONFIG: Record<ToolState, { icon: string; label: string; color: string }> = {
  pending: { icon: '⏳', label: '待执行', color: 'text-gray-500' },
  running: { icon: '⟳', label: '执行中', color: 'text-blue-500 animate-spin' },
  completed: { icon: '✓', label: '完成', color: 'text-green-600' },
  error: { icon: '✗', label: '失败', color: 'text-red-600' },
}

const FALLBACK_STATE: { icon: string; label: string; color: string } = {
  icon: '✓',
  label: '完成',
  color: 'text-green-600',
}

export default function ToolBubble({ part }: { part: PartDTO }) {
  const state: ToolState = part.toolState || 'completed'
  const config = STATE_CONFIG[state] || FALLBACK_STATE
  const toolName = part.toolName || part.summary || 'tool'
  const hasInput = Boolean(part.input)
  const hasOutput = Boolean(part.output)
  const hasError = Boolean(part.error)
  const attachments = part.attachments
  const hasAttachments = Boolean(attachments && attachments.length > 0)
  const hasDetail = hasInput || hasOutput || hasError || hasAttachments

  return (
    <PartBubbleShell
      icon="🔧"
      title={
        <span>
          <span className="font-mono">{toolName}</span>
          {part.title && part.title !== part.toolName && (
            <span className="text-gray-500 font-normal ml-1">· {part.title}</span>
          )}
        </span>
      }
      status={
        <span className={`font-mono text-base ${config.color}`}>
          {config.icon} {config.label}
        </span>
      }
      meta={part.callID ? `call: ${part.callID.slice(0, 8)}` : undefined}
      variant="action"
      collapsible={hasDetail}
      defaultExpanded={false}
    >
      {hasDetail && (
        <div className="space-y-2 text-xs min-w-0 max-w-full">
          {hasInput && (
            <div>
              <div className="text-gray-500 mb-1">Input:</div>
              <pre className="bg-gray-800 text-gray-100 p-2 rounded max-h-48 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-all">
                {part.input}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="text-gray-500 mb-1">Output:</div>
              <pre className="bg-gray-800 text-gray-100 p-2 rounded max-h-48 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-all">
                {part.output}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <div className="text-red-500 mb-1">Error:</div>
              <pre className="bg-red-50 text-red-800 p-2 rounded max-h-48 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-all border border-red-200">
                {part.error}
              </pre>
            </div>
          )}
          {hasAttachments && attachments && (
            <div>
              <div className="text-gray-500 mb-1">附件 ({attachments.length}):</div>
              <div className="space-y-1">
                {attachments.map((a, i) => (
                  <div key={i} className="text-gray-600 truncate">
                    📎 {a.filename || a.mime}:{' '}
                    <a href={a.url} className="text-blue-600 hover:underline">
                      {a.url.slice(0, 60)}…
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </PartBubbleShell>
  )
}
