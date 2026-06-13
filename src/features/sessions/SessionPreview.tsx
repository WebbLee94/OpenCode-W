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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  total: _total,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onPageChange: _onPageChange,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
      if (childSessions.length > 0) {
        params.childSessionIds = childSessions.map(c => c.id)
      }
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
    <div className="flex flex-col h-full w-full min-w-0">
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 w-full min-w-0">
        <ConversationView messages={messages} loading={loading} />
      </div>
    </div>
  )
}
