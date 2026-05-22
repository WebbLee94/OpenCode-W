import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { ArrowLeft, User, Bot, Wrench, ChevronDown, ChevronRight, Loader2, Filter, FileText } from 'lucide-react'
import type { MessageDTO, MessageDetailDTO, PartDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatBytes, formatRelativeTime, formatDateTime, truncateText } from '../../lib/format'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50

type PartTypeFilter = 'all' | 'text' | 'tool' | 'reasoning'

// ---------------------------------------------------------------------------
// Role helpers
// ---------------------------------------------------------------------------

interface RoleConfig {
  label: string
  icon: typeof User
  badgeClass: string
  bgClass: string
}

const ROLE_CONFIG: Record<string, RoleConfig> = {
  user: { label: 'User', icon: User, badgeClass: 'bg-brand-100 text-brand-700', bgClass: 'bg-brand-50' },
  assistant: { label: 'Assistant', icon: Bot, badgeClass: 'bg-green-100 text-green-700', bgClass: 'bg-green-50' },
  tool: { label: 'Tool', icon: Wrench, badgeClass: 'bg-orange-100 text-orange-700', bgClass: 'bg-orange-50' },
  system: { label: 'System', icon: FileText, badgeClass: 'bg-gray-100 text-gray-700', bgClass: 'bg-gray-50' },
}

// ---------------------------------------------------------------------------
// Part type helpers
// ---------------------------------------------------------------------------

interface PartTypeConfig {
  label: string
  emoji: string
  badgeClass: string
}

const PART_TYPE_CONFIG: Record<string, PartTypeConfig> = {
  text: { label: 'text', emoji: '\uD83D\uDCDD', badgeClass: 'bg-green-100 text-green-700' },
  tool: { label: 'tool', emoji: '\uD83D\uDD27', badgeClass: 'bg-brand-100 text-brand-700' },
  reasoning: { label: 'reasoning', emoji: '\uD83E\uDDE0', badgeClass: 'bg-orange-100 text-orange-700' },
  'step-start': { label: 'step-start', emoji: '\u25B6', badgeClass: 'bg-gray-100 text-gray-600' },
  'step-finish': { label: 'step-finish', emoji: '\u2705', badgeClass: 'bg-gray-100 text-gray-600' },
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Colored badge for a role */
function RoleBadge({ role }: { role: string }) {
  const config = ROLE_CONFIG[role] ?? ROLE_CONFIG.system
  const Icon = config.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}`}>
      <Icon size={12} />
      {config.label}
    </span>
  )
}

/** Colored badge for a part type */
function PartTypeBadge({ type }: { type: string }) {
  const config = PART_TYPE_CONFIG[type] ?? { label: type, emoji: '', badgeClass: 'bg-gray-100 text-gray-600' }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}`}>
      {config.emoji} {config.label}
    </span>
  )
}

/** Status badge for tool execution status */
function StatusBadge({ status }: { status?: string }) {
  if (!status) return null
  const isOk = status === 'completed' || status === 'success'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${isOk ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {status}
    </span>
  )
}

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
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

/** Expandable tool part detail */
function ToolPartDetail({ part }: { part: PartDTO }) {
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
          <span className="text-gray-500 font-medium">Input:</span>
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

  // Message list state
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [listLoading, setListLoading] = useState(true)

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
        pageSize: PAGE_SIZE,
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
  }, [sessionId])

  useEffect(() => {
    loadMessages(1)
  }, [loadMessages])

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
  const totalPages = Math.ceil(total / PAGE_SIZE)

  // ---- Content renderer ----
  const renderContent = () => {
    if (!detail) return null

    // Error detection
    const isError = detail.content?.toLowerCase().includes('error') &&
      (detail.role === 'tool' || detail.content?.toLowerCase().includes('failed'))

    if (isError) {
      return (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 whitespace-pre-wrap">
          {detail.content}
        </div>
      )
    }

    if (detail.role === 'user') {
      return (
        <div className="p-4 bg-brand-50 border border-brand-100 rounded-lg text-sm text-gray-800 whitespace-pre-wrap">
          {detail.content}
        </div>
      )
    }

    // Assistant / others -> Markdown
    return (
      <div className="p-4 bg-white border border-gray-200 rounded-lg">
        <MarkdownContent content={detail.content} />
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
      </div>

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
                  const seq = (page - 1) * PAGE_SIZE + idx + 1
                  const isSelected = selectedId === msg.id
                  const config = ROLE_CONFIG[msg.role] ?? ROLE_CONFIG.system
                  const Icon = config.icon
                  return (
                    <div
                      key={msg.id}
                      onClick={() => loadDetail(msg.id)}
                      className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${
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

                      {/* Size + time */}
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <SizeIndicator bytes={msg.data_size} />
                        <span className="text-xs text-gray-400">
                          {formatRelativeTime(msg.time_created)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 flex items-center justify-between shrink-0">
              <button
                onClick={() => loadMessages(page - 1)}
                disabled={page <= 1}
                className="px-3 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                上一页
              </button>
              <span className="text-xs text-gray-500">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => loadMessages(page + 1)}
                disabled={page >= totalPages}
                className="px-3 py-1 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                下一页
              </button>
            </div>
          )}
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
                          <th className="text-left px-3 py-2 font-medium text-gray-500 text-xs">摘要</th>
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
                            </tr>
                          )
                        })}

                        {filteredParts.length === 0 && (
                          <tr>
                            <td colSpan={3} className="px-3 py-4 text-center text-gray-400 text-xs">
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
                        {part.type === 'tool' && <ToolPartDetail part={part} />}
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
