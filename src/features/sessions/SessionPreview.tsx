import { useEffect, useState } from 'react'
import type { SessionDTO, MessageDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import ConversationView from './ConversationView'

interface SessionPreviewProps {
  activeSessionId: string
  childSessions: SessionDTO[]
  page: number
  pageSize: number
  total: number
  onPageChange: (p: number) => void
  onPageSizeChange: (s: number) => void
  onTotalChange: (t: number) => void
  selectedChildId: string
  onSelectedChildIdChange: (id: string) => void
}

export default function SessionPreview({
  activeSessionId,
  childSessions,
  page,
  pageSize,
  total: _total,
  onPageChange: _onPageChange,
  onPageSizeChange: _onPageSizeChange,
  onTotalChange,
  selectedChildId,
}: SessionPreviewProps) {
  const [messages, setMessages] = useState<MessageDTO[]>([])
  const [loading, setLoading] = useState(true)

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
      .then(r => { setMessages(r.data || []); onTotalChange(r.total) })
      .catch(() => { setMessages([]); onTotalChange(0) })
      .finally(() => setLoading(false))
  }, [activeSessionId, selectedChildId, page, pageSize, childSessions, onTotalChange])

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <ConversationView messages={messages} loading={loading} />
      </div>
    </div>
  )
}
