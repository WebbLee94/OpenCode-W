import { useEffect, useState, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router'
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
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Filter, Search, X } from 'lucide-react'
import type { MessageDTO, MessageDetailDTO, PartDTO, SearchResult } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatRelativeTime, formatDateTime, truncateText } from '../../lib/format'
import { useToast } from '../../hooks/useToast'
import { RoleBadge, PartTypeBadge, StatusBadge, ROLE_CONFIG } from './badges'
import PaginationBar from '../../components/PaginationBar'

// Register highlight.js languages
hljs.registerLanguage('typescript', ts)
hljs.registerLanguage('javascript', js)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', html)
// Also register common aliases
hljs.registerLanguage('ts', ts)
hljs.registerLanguage('js', js)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const
const DEFAULT_PAGE_SIZE = 20
const PAGE_SIZE_STORAGE_KEY = 'dbscope-messages-page-size'

function getStoredPageSize(): number {
  try {
    const stored = localStorage.getItem(PAGE_SIZE_STORAGE_KEY)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (PAGE_SIZE_OPTIONS.includes(parsed as typeof PAGE_SIZE_OPTIONS[number])) return parsed
    }
  } catch { /* ignore */ }
  return DEFAULT_PAGE_SIZE
}

type PartTypeFilter = 'all' | 'text' | 'tool' | 'reasoning'

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Size indicator with color coding */
function SizeIndicator({ bytes }: { bytes: number }) {
  if (bytes > 50 * 1024) {
    return <span className="font-bold text-red-600">{formatBytes(bytes)}</span>
  }
  if (bytes > 20 * 1024) {
    return <span className="text-red-500">{formatBytes(bytes)}</span>
  }
  return <span className="text-gray-500">{formatBytes(bytes)}</span>
}

/** Markdown renderer for assistant messages */
function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm prose-gray max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const codeStr = String(children).replace(/\n$/, '')

            // Block code (has language class or is multi-line)
            if (match || codeStr.includes('\n')) {
              let highlighted: string
              try {
                if (match) {
                  highlighted = hljs.highlight(codeStr, { language: match[1] }).value
                } else {
                  highlighted = hljs.highlightAuto(codeStr).value
                }
              } catch {
                highlighted = codeStr
              }
              return (
                <pre className="hljs">
                  <code className={className} dangerouslySetInnerHTML={{ __html: highlighted }} {...props} />
                </pre>
              )
            }

            // Inline code — no highlighting
            return <code className={className} {...props}>{children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/** Expandable tool part detail */
function ToolPartDetail({ part, onCopy }: { part: PartDTO; onCopy: (text: string) => void }) {
  const [outputExpanded, setOutputExpanded] = useState(false)

  return (
    <div className="ml-6 mt-2 p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2 text-sm">
      {/* Tool name */}
      <div className="flex items-center gap-2">
        <span className="text-gray-500 font-medium">Tool:</span>
        <span className="font-mono text-brand-600">{part.toolName || '-'}</span>
        <StatusBadge status={part.status} />
      </div>

      {/* Input */}
      {part.input && (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500 font-medium">Input:</span>
            <button
              onClick={() => onCopy(part.input || '')}
              className="text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1"
              title="复制输入"
            >
              📋 复制
            </button>
          </div>
          <pre className="mt-1 p-2 bg-gray-800 text-gray-100 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto">
            {part.input}
          </pre>
        </div>
      )}

      {/* Output */}
      {part.output && (
        <div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500 font-medium">Output:</span>
            {part.output.length > 500 && (
              <button
                onClick={() => setOutputExpanded(!outputExpanded)}
                className="text-xs text-brand-500 hover:text-brand-700 underline"
              >
                {outputExpanded ? '收起' : '展开全部'}
              </button>
            )}
            <button
              onClick={() => onCopy(part.output || '')}
              className="text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1 ml-auto"
              title="复制输出"
            >
              📋 复制
            </button>
          </div>
          <pre className="mt-1 p-2 bg-gray-800 text-gray-100 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
            {outputExpanded ? part.output : truncateText(part.output, 500)}
          </pre>
        </div>
      )}
    </div>
  )
}

/** Token breakdown for step-finish parts */
function TokenBreakdown({ tokens }: { tokens: PartDTO['tokens'] }) {
  if (!tokens) return null
  return (
    <div className="ml-6 mt-2 p-3 bg-indigo-50 rounded-lg border border-indigo-200 text-sm">
      <span className="font-medium text-indigo-700">Token Usage:</span>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-gray-600">Input: <strong className="text-gray-900">{tokens.input.toLocaleString()}</strong></span>
        <span className="text-gray-600">Output: <strong className="text-gray-900">{tokens.output.toLocaleString()}</strong></span>
        <span className="text-gray-600">Reasoning: <strong className="text-gray-900">{tokens.reasoning.toLocaleString()}</strong></span>
        <span className="text-gray-600">Cache Read: <strong className="text-gray-900">{tokens.cache_read.toLocaleString()}</strong></span>
        <span className="text-gray-600">Cache Write: <strong className="text-gray-900">{tokens.cache_write.toLocaleString()}</strong></span>
      </div>
    </div>
  )
}

/** Collapsible reasoning text */
function ReasoningDetail({ part }: { part: PartDTO }) {
  const [expanded, setExpanded] = useState(false)
  const text = part.summary ?? ''
  return (
    <div className="ml-6 mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-orange-600 hover:text-orange-800"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {expanded ? '收起推理过程' : '展开推理过程'}
      </button>
      {expanded && text && (
        <div className="mt-1 p-3 bg-orange-50 rounded-lg border border-orange-200 text-sm text-gray-700 whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function Messages() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const highlightKeyword = searchParams.get('highlight') || ''
  const { addToast } = useToast()

  // Message list state
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(getStoredPageSize)
  const [listLoading, setListLoading] = useState(true)

  // Handle page size change
  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize)
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(newSize))
  }, [])

  // Message detail state
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MessageDetailDTO | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Part filter state
  const [partFilter, setPartFilter] = useState<PartTypeFilter>('all')

  // Expanded tool parts
  const [expandedParts, setExpandedParts] = useState<Set<string>>(new Set())

  // Session title (from first message or ID)
  const [sessionTitle, setSessionTitle] = useState('')
  const sessionTitleSetRef = useRef(false)

  // Search state
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [showSearchResults, setShowSearchResults] = useState(false)

  // Initialize session title when sessionId changes
  useEffect(() => {
    sessionTitleSetRef.current = false
    setSessionTitle('')
  }, [sessionId])

  // ---- Load message list ----
  const loadMessages = useCallback(async (p: number) => {
    if (!sessionId) return
    setListLoading(true)
    try {
      const result = await invokeSafe<{ data: MessageDTO[]; total: number; page: number }>(IPC_CHANNELS.MESSAGES_LIST, {
        sessionId,
        page: p,
        pageSize,
      })
      setMessages(result.data)
      setTotal(result.total)
      setPage(result.page)

      // Derive session title from first user message (only once per sessionId)
      if (!sessionTitleSetRef.current && result.data.length > 0) {
        sessionTitleSetRef.current = true
        setSessionTitle(`Session ${sessionId.slice(0, 8)}`)
      }
    } catch {
      /* ignore */
    } finally {
      setListLoading(false)
    }
  }, [sessionId, pageSize])

  useEffect(() => {
    loadMessages(1)
  }, [loadMessages])

  // ---- Search messages ----
  const handleSearch = useCallback(async () => {
    if (!searchKeyword.trim()) return
    setSearchLoading(true)
    setShowSearchResults(true)
    try {
      const results = await invokeSafe<SearchResult[]>(IPC_CHANNELS.MESSAGES_SEARCH, searchKeyword.trim())
      setSearchResults(results)
    } catch {
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }, [searchKeyword])

  // ---- Extract snippet around keyword ----
  const extractSnippet = useCallback((content: string, keyword: string): string => {
    const lowerContent = content.toLowerCase()
    const lowerKeyword = keyword.toLowerCase()
    const index = lowerContent.indexOf(lowerKeyword)
    if (index === -1) return content.slice(0, 160)
    const start = Math.max(0, index - 80)
    const end = Math.min(content.length, index + keyword.length + 80)
    return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '')
  }, [])

  // ---- Highlight keyword in text ----
  const highlightText = useCallback((text: string, keyword: string): ReactNode => {
    if (!keyword) return text
    const parts: ReactNode[] = []
    const lowerText = text.toLowerCase()
    const lowerKeyword = keyword.toLowerCase()
    let lastIndex = 0
    let index = lowerText.indexOf(lowerKeyword)
    let key = 0
    while (index !== -1) {
      parts.push(text.slice(lastIndex, index))
      parts.push(<mark key={key++} className="bg-yellow-200 px-0.5 rounded">{text.slice(index, index + keyword.length)}</mark>)
      lastIndex = index + keyword.length
      index = lowerText.indexOf(lowerKeyword, lastIndex)
    }
    parts.push(text.slice(lastIndex))
    return parts
  }, [])

  // ---- Load message detail ----
  const loadDetail = useCallback(async (messageId: string) => {
    setDetailLoading(true)
    setSelectedId(messageId)
    setExpandedParts(new Set())
    try {
      const result = await invokeSafe<MessageDetailDTO | null>(IPC_CHANNELS.MESSAGES_DETAIL, messageId)
      setDetail(result)
    } catch {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  // ---- Part filter ----
  const filteredParts = useMemo(() => {
    if (!detail?.parts) return []
    if (partFilter === 'all') return detail.parts
    return detail.parts.filter((p) => p.type === partFilter)
  }, [detail, partFilter])

  // ---- Toggle expanded part ----
  const togglePart = (partId: string) => {
    setExpandedParts((prev) => {
      const next = new Set(prev)
      if (next.has(partId)) {
        next.delete(partId)
      } else {
        next.add(partId)
      }
      return next
    })
  }

  // ---- Pagination helpers ----
  const totalPages = Math.ceil(total / pageSize)

  // ---- Content renderer ----
  const renderContent = () => {
    if (!detail) return null

    // Error detection
    const isError = detail.content?.toLowerCase().includes('error') &&
      (detail.role === 'tool' || detail.content?.toLowerCase().includes('failed'))

    if (isError) {
      return (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">消息内容</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(detail.content)
                addToast('已复制到剪贴板', 'success')
              }}
              className="text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1"
              title="复制消息内容"
            >
              📋 复制
            </button>
          </div>
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 whitespace-pre-wrap">
            {highlightKeyword ? highlightText(detail.content, highlightKeyword) : detail.content}
          </div>
        </div>
      )
    }

    if (detail.role === 'user') {
      return (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">消息内容</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(detail.content)
                addToast('已复制到剪贴板', 'success')
              }}
              className="text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1"
              title="复制消息内容"
            >
              📋 复制
            </button>
          </div>
          <div className="p-4 bg-brand-50 border border-brand-100 rounded-lg text-sm text-gray-800 whitespace-pre-wrap">
            {highlightKeyword ? highlightText(detail.content, highlightKeyword) : detail.content}
          </div>
        </div>
      )
    }

    // Assistant / others -> Markdown (no highlight for markdown to avoid breaking HTML)
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">消息内容</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(detail.content)
              addToast('已复制到剪贴板', 'success')
            }}
            className="text-xs text-gray-400 hover:text-blue-600 flex items-center gap-1"
            title="复制消息内容"
          >
            📋 复制
          </button>
        </div>
        <div className="p-4 bg-white border border-gray-200 rounded-lg">
          <MarkdownContent content={detail.content} />
        </div>
      </div>
    )
  }

  // ---- Render ----
  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shrink-0">
        <button
          onClick={() => navigate('/sessions')}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft size={16} />
          返回会话列表
        </button>
        <div className="h-4 w-px bg-gray-300" />
        <h1 className="text-sm font-semibold text-gray-900 truncate">
          {sessionTitle || `Session ${sessionId?.slice(0, 8) ?? ''}`}
        </h1>
        <span className="text-xs text-gray-400 font-mono">{sessionId}</span>

        {/* Search bar */}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="全文搜索消息..."
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
              className="w-56 rounded-md border border-gray-300 bg-white py-1.5 pl-8 pr-3 text-xs text-gray-900 placeholder-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {searchKeyword && (
              <button
                onClick={() => { setSearchKeyword(''); setSearchResults([]); setShowSearchResults(false) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            onClick={handleSearch}
            disabled={searchLoading || !searchKeyword.trim()}
            className="px-3 py-1.5 text-xs rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {searchLoading ? '搜索中...' : '搜索'}
          </button>
        </div>
      </div>

      {/* Search results panel */}
      {showSearchResults && (
        <div className="border-b border-gray-200 bg-yellow-50 px-4 py-3 max-h-64 overflow-y-auto shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-700">
              搜索结果 ({searchResults.length} 条)
            </span>
            <button
              onClick={() => { setShowSearchResults(false); setSearchResults([]) }}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={14} />
            </button>
          </div>
          {searchLoading ? (
            <div className="flex items-center justify-center py-4 text-gray-400 text-xs">
              <Loader2 size={14} className="animate-spin mr-2" />
              搜索中...
            </div>
          ) : searchResults.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-4">未找到匹配的消息</p>
          ) : (
            <div className="space-y-2">
              {searchResults.map((result) => (
                <div
                  key={result.id}
                  onClick={() => navigate(`/sessions/${result.session_id}/messages?highlight=${encodeURIComponent(searchKeyword)}`)}
                  className="p-2 bg-white rounded-md border border-gray-200 cursor-pointer hover:bg-brand-50 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-900 truncate max-w-[300px]">
                      {result.session_title || '无标题'}
                    </span>
                    <span className="text-xs text-gray-400">
                      {formatRelativeTime(result.time_created)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 line-clamp-2">
                    {highlightText(extractSnippet(result.content, searchKeyword), searchKeyword)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Split view */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel - Message list */}
        <div className="w-2/5 border-r border-gray-200 flex flex-col bg-white">
          {/* List header */}
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 flex items-center justify-between shrink-0">
            <span>共 {total} 条消息</span>
            {totalPages > 1 && (
              <span>第 {page}/{totalPages} 页</span>
            )}
          </div>

          {/* List body */}
          <div className="flex-1 overflow-y-auto">
            {listLoading ? (
              <div className="flex items-center justify-center py-12 text-gray-400">
                <Loader2 size={20} className="animate-spin mr-2" />
                加载中...
              </div>
            ) : messages.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
                暂无消息
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {messages.map((msg, idx) => {
                  const seq = (page - 1) * pageSize + idx + 1
                  const isSelected = selectedId === msg.id
                  const config = ROLE_CONFIG[msg.role] ?? ROLE_CONFIG.system
                  const Icon = config.icon
                  return (
                    <div
                      key={msg.id}
                      onClick={() => loadDetail(msg.id)}
                      className={`message-item flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-brand-50 border-l-2 border-l-brand-500'
                          : 'hover:bg-gray-50 border-l-2 border-l-transparent'
                      }`}
                    >
                      {/* Sequence number */}
                      <span className="text-xs text-gray-400 w-8 shrink-0 text-right font-mono">
                        #{seq}
                      </span>

                      {/* Role icon badge */}
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded ${config.badgeClass} shrink-0`}>
                        <Icon size={13} />
                      </span>

                      {/* Content preview + meta */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <SizeIndicator bytes={msg.data_size} />
                          <span className="text-xs text-gray-400">
                            {formatRelativeTime(msg.time_created)}
                          </span>
                        </div>
                        {msg.content && (
                          <p className="text-xs text-gray-500 mt-0.5 truncate">
                            {msg.content.length > 300 ? msg.content.slice(0, 300) + '...' : msg.content}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Pagination - sticky bottom */}
            <PaginationBar
              page={page}
              total={total}
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageChange={loadMessages}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        </div>

        {/* Right panel - Message detail */}
        <div className="w-3/5 flex flex-col bg-gray-50 overflow-hidden">
          {!selectedId ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              选择左侧消息查看详情
            </div>
          ) : detailLoading ? (
            <div className="flex items-center justify-center h-full text-gray-400">
              <Loader2 size={20} className="animate-spin mr-2" />
              加载详情...
            </div>
          ) : !detail ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              未找到消息详情
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* Message header */}
              <div className="flex items-center gap-3">
                <RoleBadge role={detail.role} />
                <span className="text-xs text-gray-500">
                  {formatDateTime(detail.time_created)}
                </span>
                <SizeIndicator bytes={detail.data_size} />
              </div>

              {/* Content */}
              {renderContent()}

              {/* Part breakdown */}
              {detail.parts.length > 0 && (
                <div>
                  {/* Part filter */}
                  <div className="flex items-center gap-2 mb-3">
                    <Filter size={14} className="text-gray-400" />
                    <span className="text-xs text-gray-500 font-medium">Part 筛选:</span>
                    {(['all', 'text', 'tool', 'reasoning'] as PartTypeFilter[]).map((f) => (
                      <button
                        key={f}
                        onClick={() => setPartFilter(f)}
                        className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                          partFilter === f
                            ? 'bg-brand-500 text-white border-brand-500'
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {f === 'all' ? '全部' : f}
                      </button>
                    ))}
                    <span className="text-xs text-gray-400 ml-1">
                      ({filteredParts.length}/{detail.parts.length})
                    </span>
                  </div>

                   {/* Part table */}
                   <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                     <table className="w-full text-sm">
                       <thead className="bg-gray-50 border-b border-gray-200">
                         <tr>
                           <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs w-36">类型</th>
                           <th className="text-right px-3 py-2 font-medium text-gray-500 text-xs w-24">大小</th>
                           <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs flex-1">摘要</th>
                           <th className="text-center px-3 py-2 font-medium text-gray-500 text-xs w-12">操作</th>
                         </tr>
                       </thead>
                       <tbody>
                         {filteredParts.map((part) => {
                           const isExpandable = part.type === 'tool' || part.type === 'reasoning' || part.type === 'step-finish'
                           const isExpanded = expandedParts.has(part.id)
                           return (
                             <tr key={part.id} className="border-b border-gray-100 last:border-b-0">
                               {/* Type */}
                               <td className="px-3 py-2">
                                 <div className="flex items-center gap-1">
                                   {isExpandable && (
                                     <button
                                       onClick={() => togglePart(part.id)}
                                       className="text-gray-400 hover:text-gray-600 transition-colors"
                                     >
                                       {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                     </button>
                                   )}
                                   <PartTypeBadge type={part.type} />
                                 </div>
                               </td>

                               {/* Size */}
                               <td className="px-3 py-2 text-right">
                                 <SizeIndicator bytes={part.data_size} />
                               </td>

                               {/* Summary */}
                               <td className="px-3 py-2 text-gray-600 text-xs max-w-xs truncate">
                                 {part.type === 'tool' && part.toolName
                                   ? part.toolName
                                   : part.summary
                                     ? truncateText(part.summary, 100)
                                     : '-'}
                               </td>

                               {/* Copy button */}
                               <td className="px-3 py-2 text-center">
                                 <button
                                   onClick={() => {
                                     const textToCopy = part.type === 'tool' && part.toolName
                                       ? part.toolName
                                       : part.summary || ''
                                     navigator.clipboard.writeText(textToCopy)
                                     addToast('已复制', 'success')
                                   }}
                                   className="text-gray-400 hover:text-blue-600 transition-colors"
                                   title="复制"
                                 >
                                   📋
                                 </button>
                               </td>
                             </tr>
                           )
                         })}

                         {filteredParts.length === 0 && (
                           <tr>
                             <td colSpan={4} className="px-3 py-4 text-center text-gray-400 text-xs">
                               无匹配的 Part
                             </td>
                           </tr>
                         )}
                       </tbody>
                     </table>
                   </div>

                   {/* Expanded part details */}
                   {filteredParts.map((part) => {
                     const isExpanded = expandedParts.has(part.id)
                     if (!isExpanded) return null

                     return (
                       <div key={`detail-${part.id}`}>
                         {part.type === 'tool' && <ToolPartDetail part={part} onCopy={(text) => { navigator.clipboard.writeText(text); addToast('已复制', 'success') }} />}
                         {part.type === 'step-finish' && <TokenBreakdown tokens={part.tokens} />}
                         {part.type === 'reasoning' && <ReasoningDetail part={part} />}
                       </div>
                     )
                   })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Messages
