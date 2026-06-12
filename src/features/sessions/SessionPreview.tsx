import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { SessionDTO, MessageDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatNumber } from '../../lib/format'
import SubSessionSelector from './SubSessionSelector'
import ConversationView from './ConversationView'

interface SessionPreviewProps {
  activeSessionId: string
  childSessions: SessionDTO[]
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 50

export default function SessionPreview({ activeSessionId, childSessions }: SessionPreviewProps) {
  const [selectedChildId, setSelectedChildId] = useState<string>('')
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeState] = useState(() => {
    const saved = localStorage.getItem('dbscope-preview-page-size')
    return saved ? parseInt(saved, 10) : DEFAULT_PAGE_SIZE
  })

  useEffect(() => {
    setLoading(true)
    setPage(1)
  }, [selectedChildId, activeSessionId])

  useEffect(() => {
    setLoading(true)
    const params: { parentSessionId?: string; childSessionIds?: string[]; page: number; pageSize: number } = {
      page, pageSize,
    }
    if (selectedChildId) {
      params.childSessionIds = [selectedChildId]
    } else {
      params.parentSessionId = activeSessionId
      params.childSessionIds = childSessions.map(c => c.id)
    }
    invokeSafe<{ data: MessageDTO[]; total: number }>(
      IPC_CHANNELS.MESSAGES_LIST_BY_PARENT,
      params
    )
      .then(r => { setMessages(r.data || []); setTotal(r.total) })
      .catch(() => { setMessages([]); setTotal(0) })
      .finally(() => setLoading(false))
  }, [activeSessionId, selectedChildId, page, pageSize, childSessions])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const changePageSize = (size: number) => {
    localStorage.setItem('dbscope-preview-page-size', String(size))
    setPageSizeState(size)
    setPage(1)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <SubSessionSelector childSessions={childSessions} selectedChildId={selectedChildId} onChange={setSelectedChildId} />
        <div className="text-xs text-gray-500">
          {selectedChildId ? '1 个子会话' : `${childSessions.length + 1} 个会话合并`} · 共 {formatNumber(total)} 条消息
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <ConversationView messages={messages} loading={loading} />
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between px-3 py-2 border-t bg-white shrink-0 text-xs text-gray-500">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="disabled:opacity-30 hover:text-gray-700">
            <ChevronLeft size={14} />
          </button>
          <div className="flex items-center gap-2">
            <select value={pageSize} onChange={e => changePageSize(Number(e.target.value))} className="border rounded px-1.5 py-0.5 text-xs">
              {PAGE_SIZE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <span>{page}/{totalPages} · {total} 条</span>
          </div>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="disabled:opacity-30 hover:text-gray-700">
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
