import { useEffect, useState, useMemo } from 'react'
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
import { User, Bot, Wrench, ChevronLeft, ChevronRight, FileText } from 'lucide-react'
import type { MessageDTO, MessageDetailDTO, PartDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatRelativeTime, truncateText } from '../../lib/format'

hljs.registerLanguage('typescript', ts)
hljs.registerLanguage('javascript', js)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', html)

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const
const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZE_STORAGE_KEY = 'dbscope-messageviewer-page-size'

interface MessageViewerProps { sessionId: string }

export default function MessageViewer({ sessionId }: MessageViewerProps) {
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeState] = useState(() => {
    const saved = localStorage.getItem(PAGE_SIZE_STORAGE_KEY)
    return saved ? parseInt(saved, 10) : DEFAULT_PAGE_SIZE
  })
  const setPageSize = (size: number) => {
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size))
    setPageSizeState(size)
    setPage(1)
  }
  const [detail, setDetail] = useState<MessageDetailDTO | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [expandedPart, setExpandedPart] = useState<number | null>(null)

  useEffect(() => {
    setLoading(true)
    invokeSafe<{ data: MessageDTO[]; total: number }>(IPC_CHANNELS.MESSAGES_LIST, { sessionId, page, pageSize })
      .then(r => { setMessages(r.data || []); setTotal(r.total) }).catch(() => { setMessages([]); setTotal(0) }).finally(() => setLoading(false))
  }, [sessionId, page, pageSize])

  async function loadDetail(msgId: string) {
    setDetailLoading(true)
    try { const d = await invokeSafe<MessageDetailDTO>(IPC_CHANNELS.MESSAGES_DETAIL, msgId); setDetail(d) }
    catch { setDetail(null) } finally { setDetailLoading(false) }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  function roleBadge(role: string) {
    const map: Record<string, { icon: any; color: string; label: string }> = {
      user: { icon: User, color: 'text-blue-600 bg-blue-50', label: 'User' },
      assistant: { icon: Bot, color: 'text-purple-600 bg-purple-50', label: 'Assistant' },
      tool: { icon: Wrench, color: 'text-yellow-600 bg-yellow-50', label: 'Tool' },
      system: { icon: FileText, color: 'text-gray-600 bg-gray-100', label: 'System' },
    }
    const m = map[role] || map.system; const Icon = m.icon
    return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${m.color}`}><Icon size={12} />{m.label}</span>
  }

  function sizeColor(size: number) { return size > 100000 ? 'text-red-600' : size > 50000 ? 'text-orange-500' : size > 10000 ? 'text-yellow-600' : 'text-green-600' }

  const markdownComponents: any = useMemo(() => ({
    code({ node, inline, className, children, ...props }: any) {
      if (inline) return <code className="bg-gray-100 px-1 rounded text-sm" {...props}>{children}</code>
      const match = /language-(\w+)/.exec(className || ''); const lang = match?.[1]; const code = String(children).replace(/\n$/, '')
      if (lang && hljs.getLanguage(lang)) {
        try { const highlighted = hljs.highlight(code, { language: lang }).value; return <pre className="bg-gray-900 text-gray-100 p-3 rounded overflow-x-auto text-sm"><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre> } catch {}
      }
      return <pre className="bg-gray-100 p-3 rounded overflow-x-auto text-sm"><code>{code}</code></pre>
    }
  }), [])

  function renderParts(parts: PartDTO[]) {
    return (
      <div className="mt-4">
        <h5 className="text-xs font-medium text-gray-500 mb-2 uppercase">Part 明细</h5>
        <table className="w-full text-xs">
          <thead><tr className="bg-gray-50 border-b"><th className="text-left px-2 py-1 text-gray-500">类型</th><th className="text-left px-2 py-1 text-gray-500">大小</th><th className="text-left px-2 py-1 text-gray-500">摘要</th></tr></thead>
          <tbody>
            {parts.map((p, i) => (
              <tr key={i} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => setExpandedPart(expandedPart === i ? null : i)}>
                <td className="px-2 py-1"><span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-700">{p.type}</span></td>
                <td className={`px-2 py-1 font-mono ${sizeColor(p.data_size)}`}>{formatBytes(p.data_size)}</td>
                <td className="px-2 py-1 text-gray-500 truncate max-w-xs">{p.summary || '-'}</td>
              </tr>
            ))}
            {parts.map((p, i) => expandedPart === i && (
              <tr key={`expanded-${i}`} className="bg-gray-50/50 border-b">
                <td colSpan={3} className="px-2 py-2">
                  <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto max-h-40">{JSON.stringify(p, null, 2)}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="w-[35%] border-r border-gray-200 flex flex-col">
        <div className="flex-1 overflow-y-auto">
          {loading && messages.length === 0 ? <div className="flex items-center justify-center py-20 text-gray-400 text-sm">加载中...</div>
          : messages.length === 0 ? <div className="flex items-center justify-center py-20 text-gray-400 text-sm">暂无消息</div>
          : messages.map(msg => (
            <div key={msg.id} onClick={() => loadDetail(msg.id)}
              className={`px-3 py-2.5 border-b cursor-pointer hover:bg-gray-50 ${detail?.id === msg.id ? 'bg-brand-50 border-l-2 border-l-brand-500' : ''}`}>
              <div className="flex items-center justify-between mb-1">{roleBadge(msg.role)}<span className={`text-xs font-mono ${sizeColor(msg.data_size)}`}>{formatBytes(msg.data_size)}</span></div>
              <div className="text-xs text-gray-500 truncate mt-0.5">{truncateText(msg.content || '', 80)}</div>
              <div className="text-xs text-gray-400 mt-1">{formatRelativeTime(msg.time_created)}</div>
            </div>
          ))}
        </div>
        {total > 0 && (
          <div className="flex items-center justify-between px-3 py-2 border-t bg-white shrink-0 text-xs text-gray-500">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="disabled:opacity-30 hover:text-gray-700"><ChevronLeft size={14} /></button>
            <div className="flex items-center gap-2">
              <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} className="border rounded px-1.5 py-0.5 text-xs">
                {PAGE_SIZE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span>{page}/{totalPages} · {total} 条</span>
            </div>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="disabled:opacity-30 hover:text-gray-700"><ChevronRight size={14} /></button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {detailLoading ? <div className="flex items-center justify-center py-20 text-gray-400 text-sm">加载中...</div>
        : detail ? (
          <div>
            <div className="flex items-center justify-between mb-4">{roleBadge(detail.role)}<span className="text-xs text-gray-400">{formatRelativeTime(detail.time_created)} · {formatBytes(detail.data_size)}</span></div>
            <div className="prose prose-sm max-w-none text-gray-800"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{detail.content || ''}</ReactMarkdown></div>
            {detail.parts && detail.parts.length > 0 && renderParts(detail.parts)}
          </div>
        ) : <div className="flex items-center justify-center py-20 text-gray-400 text-sm">选择左侧消息查看详情</div>}
      </div>
    </div>
  )
}
