import { useEffect, useMemo, useRef, useState } from 'react'
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
import { RoleBadge } from '../messages/badges'
import type { MessageDTO, MessageDetailDTO, PartDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatNumber, formatRelativeTime } from '../../lib/format'

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

function MarkdownBlock({ content }: { content: string }) {
  const components: any = useMemo(() => ({
    code({ inline, className, children, ...props }: any) {
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

function ToolBubble({ part }: { part: PartDTO }) {
  const [expanded, setExpanded] = useState(false)
  const toolName = part.toolName || part.summary || part.type
  const statusOk = part.status === 'completed' || part.status === 'success'
  const statusFail = part.status === 'failed' || part.status === 'error'
  const statusColor = statusOk ? 'text-green-600' : statusFail ? 'text-red-600' : 'text-gray-500'
  const statusIcon = statusOk ? '✓' : statusFail ? '✗' : '·'
  const summaryLine = part.summary || (part.input ? part.input.split('\n')[0].slice(0, 80) : '(无输入)')

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50/40 p-2.5 text-sm">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-orange-600 font-mono">🔧 {toolName}</span>
        <span className={`font-mono text-base ${statusColor}`}>{statusIcon}</span>
        {(part.input || part.output) && (
          <button onClick={() => setExpanded(!expanded)} className="ml-auto text-xs text-gray-500 hover:text-gray-700">
            {expanded ? '▲ 收起' : '▼ 展开'}
          </button>
        )}
      </div>
      <div className="text-xs text-gray-700 font-mono mb-1.5 whitespace-pre-wrap break-all">{summaryLine}</div>
      {expanded && (
        <div className="mt-2 space-y-2 text-xs">
          {part.input && (
            <div>
              <div className="text-gray-500 mb-1">Input:</div>
              <pre className="bg-gray-800 text-gray-100 p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap break-all">{part.input}</pre>
            </div>
          )}
          {part.output && (
            <div>
              <div className="text-gray-500 mb-1">Output:</div>
              <pre className="bg-gray-800 text-gray-100 p-2 rounded overflow-auto max-h-48 whitespace-pre-wrap break-all">{part.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReasoningBubble({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-lg border border-orange-100 bg-orange-50/20 p-2.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-orange-500">💭</span>
        <button onClick={() => setExpanded(!expanded)} className="text-xs text-gray-600 hover:text-gray-800">
          {expanded ? '▲ 收起推理过程' : '▼ 展开推理过程'}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 p-2 bg-white rounded text-xs text-gray-700 whitespace-pre-wrap break-all border border-orange-100">{text}</div>
      )}
    </div>
  )
}

function StepFinishFooter({ tokens }: { tokens?: PartDTO['tokens'] }) {
  if (!tokens) return null
  const items: string[] = []
  if (tokens.input) items.push(`${formatNumber(tokens.input)} in`)
  if (tokens.output) items.push(`${formatNumber(tokens.output)} out`)
  if (tokens.reasoning) items.push(`${formatNumber(tokens.reasoning)} reasoning`)
  if (tokens.cache_read) items.push(`${formatNumber(tokens.cache_read)} cache_read`)
  if (tokens.cache_write) items.push(`${formatNumber(tokens.cache_write)} cache_write`)
  if (items.length === 0) return null
  return (
    <div className="text-center text-xs text-gray-400 py-2">
      Token: {items.join(' / ')}
    </div>
  )
}

function renderPart(part: PartDTO) {
  if (part.type === 'step-start') return null
  if (part.type === 'step-finish') return <StepFinishFooter key={part.id} tokens={part.tokens} />
  if (part.type === 'reasoning') return <ReasoningBubble key={part.id} text={part.summary || part.input || ''} />
  return <ToolBubble key={part.id} part={part} />
}

export default function ConversationView({ messages, loading }: ConversationViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<Map<string, MessageDetailDTO>>(new Map())
  const [loadingDetail, setLoadingDetail] = useState<Set<string>>(new Set())
  const cacheRef = useRef({ details, loadingDetail })
  cacheRef.current = { details, loadingDetail }

  // Auto-mark all tool messages as expanded (default visible, no toggle)
  useEffect(() => {
    if (messages.length === 0) return
    setExpanded(prev => {
      const next = new Set(prev)
      let changed = false
      for (const m of messages) {
        if (m.role === 'tool' && !next.has(m.id)) {
          next.add(m.id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [messages])

  // Lazy-load details for expanded messages
  useEffect(() => {
    expanded.forEach(id => {
      if (!cacheRef.current.details.has(id) && !cacheRef.current.loadingDetail.has(id)) {
        void loadDetail(id)
      }
    })
  }, [expanded])

  async function loadDetail(msgId: string) {
    setLoadingDetail(prev => new Set(prev).add(msgId))
    try {
      const d = await invokeSafe<MessageDetailDTO | null>(IPC_CHANNELS.MESSAGES_DETAIL, msgId)
      if (d) setDetails(prev => new Map(prev).set(msgId, d))
    } catch { /* ignore */ }
    finally {
      setLoadingDetail(prev => {
        const n = new Set(prev)
        n.delete(msgId)
        return n
      })
    }
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

        const detail = details.get(msg.id)
        const isLoadingDetail = loadingDetail.has(msg.id)

        return (
          <div key={msg.id} className={`rounded-lg p-3 ${containerClass}`}>
            <div className="flex items-center justify-between mb-2">
              <RoleBadge role={msg.role} />
              <span className="text-xs text-gray-400">{formatRelativeTime(msg.time_created)}</span>
            </div>

            {msg.role === 'user' && msg.content && (
              <div className="text-sm text-gray-800 whitespace-pre-wrap">{msg.content}</div>
            )}

            {msg.role === 'assistant' && msg.content && (
              <MarkdownBlock content={msg.content} />
            )}

            {msg.role === 'tool' && (
              <div className="space-y-2">
                {isLoadingDetail ? (
                  <div className="text-xs text-gray-400 py-2">加载工具调用详情...</div>
                ) : detail?.parts && detail.parts.length > 0 ? (
                  detail.parts.map(p => renderPart(p))
                ) : msg.content ? (
                  <div className="text-xs text-gray-600 font-mono whitespace-pre-wrap break-all">{msg.content}</div>
                ) : (
                  <div className="text-xs text-gray-400">(工具调用)</div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
