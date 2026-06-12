import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js/lib/core'
import ts from 'highlight.js/lib/languages/typescript'
import js from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import css from 'highlight.js/lib/languages/css'
import html from 'highlight.js/lib/languages/xml'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { RoleBadge, PartTypeBadge, StatusBadge } from '../messages/badges'
import type { MessageDTO, MessageDetailDTO, PartDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatRelativeTime } from '../../lib/format'

hljs.registerLanguage('typescript', ts)
hljs.registerLanguage('javascript', js)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', html)

interface ConversationViewProps {
  messages: MessageDTO[]
  loading?: boolean
}

const SIZE_COLORS = [
  { threshold: 100000, cls: 'text-red-600' },
  { threshold: 50000, cls: 'text-orange-500' },
  { threshold: 10000, cls: 'text-yellow-600' },
  { threshold: 0, cls: 'text-green-600' },
]

function sizeColor(size: number) {
  return SIZE_COLORS.find(s => size > s.threshold)?.cls || 'text-green-600'
}

function truncateForDisplay(text: string, max: number) {
  return text.length > max ? text.slice(0, max) + `\n\n... (截断显示，共 ${text.length} 字符)` : text
}

function MarkdownBlock({ content }: { content: string }) {
  const components: any = useMemo(() => ({
    code({ node, inline, className, children, ...props }: any) {
      if (inline) return <code className="bg-gray-100 px-1 rounded text-sm" {...props}>{children}</code>
      const match = /language-(\w+)/.exec(className || '')
      const code = String(children).replace(/\n$/, '')
      if (match && hljs.getLanguage(match[1])) {
        try {
          const highlighted = hljs.highlight(code, { language: match[1] }).value
          return <pre className="hljs bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto text-sm"><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
        } catch { /* fallthrough */ }
      }
      return <pre className="bg-gray-100 p-3 rounded overflow-x-auto text-sm"><code>{code}</code></pre>
    }
  }), [])
  return (
    <div className="prose prose-sm max-w-none text-gray-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </div>
  )
}

function PartRow({ part }: { part: PartDTO }) {
  return (
    <div className="rounded border border-orange-200 bg-orange-50/30 p-2 text-xs space-y-1">
      <div className="flex items-center gap-2">
        <PartTypeBadge type={part.type} />
        {part.status && <StatusBadge status={part.status} />}
        <span className={`ml-auto font-mono ${sizeColor(part.data_size)}`}>{formatBytes(part.data_size)}</span>
      </div>
      {part.toolName && <div><span className="text-gray-500">Tool:</span> <span className="font-mono text-brand-600">{part.toolName}</span></div>}
      {part.input && (
        <div>
          <div className="text-gray-500 mb-1">Input:</div>
          <pre className="bg-gray-800 text-gray-100 p-2 rounded text-xs overflow-x-auto max-h-60 whitespace-pre-wrap break-all">{part.input}</pre>
        </div>
      )}
      {part.output && (
        <div>
          <div className="text-gray-500 mb-1">Output:</div>
          <pre className="bg-gray-800 text-gray-100 p-2 rounded text-xs overflow-x-auto max-h-60 whitespace-pre-wrap break-all">{truncateForDisplay(part.output, 2000)}</pre>
        </div>
      )}
      {part.summary && !part.input && !part.output && <div className="text-gray-600">{part.summary}</div>}
    </div>
  )
}

export default function ConversationView({ messages, loading }: ConversationViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<Map<string, MessageDetailDTO>>(new Map())
  const [loadingDetail, setLoadingDetail] = useState<Set<string>>(new Set())

  async function toggleExpand(msgId: string) {
    const next = new Set(expanded)
    if (next.has(msgId)) {
      next.delete(msgId)
      setExpanded(next)
      return
    }
    next.add(msgId)
    setExpanded(next)

    if (details.has(msgId) || loadingDetail.has(msgId)) return
    setLoadingDetail(prev => new Set(prev).add(msgId))
    try {
      const d = await invokeSafe<MessageDetailDTO | null>(IPC_CHANNELS.MESSAGES_DETAIL, msgId)
      if (d) setDetails(prev => new Map(prev).set(msgId, d))
    } catch { /* ignore */ }
    finally { setLoadingDetail(prev => { const n = new Set(prev); n.delete(msgId); return n }) }
  }

  if (loading && messages.length === 0) {
    return <div className="flex items-center justify-center py-20 text-gray-400 text-sm">加载中...</div>
  }
  if (messages.length === 0) {
    return <div className="flex items-center justify-center py-20 text-gray-400 text-sm">暂无消息</div>
  }

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      {messages.map(msg => {
        const isExpanded = expanded.has(msg.id)
        const detail = details.get(msg.id)
        const isLoading = loadingDetail.has(msg.id)

        if (msg.role === 'system') {
          return (
            <div key={msg.id} className="text-center text-xs text-gray-500 py-2">
              {msg.content || 'system'}
              <span className="ml-2 text-gray-400">{formatRelativeTime(msg.time_created)}</span>
            </div>
          )
        }

        const containerClass = msg.role === 'user'
          ? 'ml-8 bg-brand-50 border border-brand-100'
          : msg.role === 'tool'
            ? 'mx-4 bg-orange-50/30 border border-orange-200'
            : 'mr-8 bg-white border border-gray-200'

        return (
          <div key={msg.id} className={`rounded-lg p-3 ${containerClass}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <RoleBadge role={msg.role} />
                <span className={`text-xs font-mono ${sizeColor(msg.data_size)}`}>{formatBytes(msg.data_size)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">{formatRelativeTime(msg.time_created)}</span>
                <button
                  onClick={() => toggleExpand(msg.id)}
                  className="text-gray-400 hover:text-gray-600 p-0.5"
                  title={isExpanded ? '收起' : '展开详情'}
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              </div>
            </div>

            {msg.content && msg.role !== 'tool' && (
              <div className="text-sm text-gray-800">
                {msg.role === 'assistant' ? <MarkdownBlock content={msg.content} /> : <div className="whitespace-pre-wrap">{msg.content}</div>}
              </div>
            )}
            {msg.role === 'tool' && (
              <div className="text-xs text-gray-600 font-mono">{msg.content || '(工具调用)'}</div>
            )}

            {isExpanded && (
              <div className="mt-3 pt-3 border-t border-gray-200/50 space-y-2">
                {isLoading ? (
                  <div className="text-xs text-gray-400 py-2">加载详情...</div>
                ) : detail ? (
                  <>
                    {detail.content && detail.content !== msg.content && (
                      <div className="text-sm">
                        {msg.role === 'assistant' ? <MarkdownBlock content={detail.content} /> : <div className="whitespace-pre-wrap">{detail.content}</div>}
                      </div>
                    )}
                    {detail.parts && detail.parts.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-gray-500 uppercase">Parts ({detail.parts.length})</div>
                        {detail.parts.map((p, i) => <PartRow key={i} part={p} />)}
                      </div>
                    )}
                    {(!detail.parts || detail.parts.length === 0) && (!detail.content || detail.content === msg.content) && (
                      <div className="text-xs text-gray-400">无额外详情</div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-400">加载失败</div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
