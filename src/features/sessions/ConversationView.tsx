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
import type { MessageDTO, MessageDetailDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatRelativeTime } from '../../lib/format'
import { renderPart } from './PartBubbles/registry'

hljs.registerLanguage('typescript', ts)
hljs.registerLanguage('javascript', js)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', html)

const CONTENT_PREVIEW_THRESHOLD = 800

interface ConversationViewProps {
  messages: MessageDTO[]
  loading?: boolean
}

function MarkdownBlock({ content }: { content: string }) {
  const components = useMemo(() => ({
    code({ inline, className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { inline?: boolean }) {
      if (inline) return <code className="bg-gray-100 px-1 rounded text-sm" {...props}>{children}</code>
      const match = /language-(\w+)/.exec(className || '')
      const code = String(children).replace(/\n$/, '')
      if (match && hljs.getLanguage(match[1])) {
        try {
          const highlighted = hljs.highlight(code, { language: match[1] }).value
          return <pre className="hljs bg-gray-900 text-gray-100 p-3 rounded text-sm whitespace-pre-wrap break-all max-w-full !overflow-hidden"><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
        } catch { /* fallthrough */ }
      }
      return <pre className="bg-gray-100 p-3 rounded text-sm whitespace-pre-wrap break-all max-w-full !overflow-hidden"><code>{code}</code></pre>
    }
  }), [])
  return (
    <div className="prose prose-sm text-gray-800 break-words min-w-0 markdown-content [&_pre]:!overflow-hidden [&_pre]:max-w-full [&_table]:!overflow-hidden">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </div>
  )
}

function ExpandableContent({ content, threshold = CONTENT_PREVIEW_THRESHOLD }: { content: string; threshold?: number }) {
  const [expanded, setExpanded] = useState(false)
  if (!content) return null
  if (content.length <= threshold) return <div className="whitespace-pre-wrap">{content}</div>
  return (
    <div>
      <div className="whitespace-pre-wrap">
        {expanded ? content : content.slice(0, threshold) + '…'}
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs text-brand-600 hover:text-brand-800 inline-flex items-center gap-1"
      >
        {expanded ? '▲ 收起' : `▼ 展开全部 (${content.length} 字符)`}
      </button>
    </div>
  )
}

function ExpandableMarkdown({ content, threshold = CONTENT_PREVIEW_THRESHOLD }: { content: string; threshold?: number }) {
  const [expanded, setExpanded] = useState(false)
  if (!content) return null
  if (content.length <= threshold) return <MarkdownBlock content={content} />
  const displayContent = expanded ? content : content.slice(0, threshold) + '…'
  return (
    <div>
      <MarkdownBlock content={displayContent} />
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-2 text-xs text-brand-600 hover:text-brand-800 inline-flex items-center gap-1"
      >
        {expanded ? '▲ 收起' : `▼ 展开全部 (${content.length} 字符)`}
      </button>
    </div>
  )
}

export default function ConversationView({ messages, loading }: ConversationViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<Map<string, MessageDetailDTO>>(new Map())
  const [loadingDetail, setLoadingDetail] = useState<Set<string>>(new Set())
  const cacheRef = useRef({ details, loadingDetail })
  cacheRef.current = { details, loadingDetail }

  // Auto-mark tool and assistant messages as expanded (default visible, no toggle)
  // Assistant messages may contain tool/reasoning/step-* parts that need detail loading
  useEffect(() => {
    if (messages.length === 0) return
    setExpanded(prev => {
      const next = new Set(prev)
      let changed = false
      for (const m of messages) {
        if ((m.role === 'tool' || m.role === 'assistant') && !next.has(m.id)) {
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
    <div className="space-y-4 w-full min-w-0">
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
          ? 'ml-auto mr-8 w-1/2 bg-brand-50 border border-brand-100'
          : msg.role === 'tool'
            ? 'mx-4 bg-orange-50/30 border border-orange-200'
            : 'mr-auto ml-8 w-[90%] bg-white border border-gray-200'

        const detail = details.get(msg.id)
        const isLoadingDetail = loadingDetail.has(msg.id)

        return (
          <div key={msg.id} className={`rounded-lg p-3 min-w-0 max-w-full overflow-hidden ${containerClass}`}>
            <div className="flex items-center justify-between mb-2">
              <RoleBadge role={msg.role} />
              <span className="text-xs text-gray-400">{formatRelativeTime(msg.time_created)}</span>
            </div>

            {msg.role === 'user' && msg.content && (
              <ExpandableContent content={msg.content} />
            )}

            {msg.role === 'assistant' && (
              <div className="space-y-3">
                {msg.content && <ExpandableMarkdown content={msg.content} />}

                {detail && detail.parts && detail.parts.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-gray-100">
                    {detail.parts.map(p => renderPart(p))}
                  </div>
                )}

                {isLoadingDetail && !detail && (
                  <div className="text-xs text-gray-400 italic">加载详情...</div>
                )}

                {!msg.content && (!detail || !detail.parts || detail.parts.length === 0) && !isLoadingDetail && (
                  <div className="text-xs text-gray-400 italic">（执行中...）</div>
                )}
              </div>
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
