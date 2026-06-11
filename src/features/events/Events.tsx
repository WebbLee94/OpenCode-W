import { useEffect, useState } from 'react'
import type { EventDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { truncateText } from '../../lib/format'
import { ChevronLeft, ChevronRight, Activity, X } from 'lucide-react'

function Events() {
  const [events, setEvents] = useState<EventDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const pageSize = 50

  useEffect(() => {
    setLoading(true)
    invokeSafe<EventDTO[]>(IPC_CHANNELS.EVENTS_LIST, search ? { aggregateId: search } : {})
      .then(r => { setEvents(r); setTotal(r.length) })
      .finally(() => setLoading(false))
  }, [page, search])

  const totalPages = Math.ceil(total / pageSize)
  const pagedEvents = events.slice((page - 1) * pageSize, page * pageSize)

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={24} className="text-brand-600" />
            <h2 className="text-2xl font-semibold text-gray-900">事件溯源</h2>
          </div>
          <span className="text-sm text-gray-500">共 {total} 条事件</span>
        </div>
        <div className="relative max-w-md">
          <input type="text" placeholder="搜索 aggregate_id..." value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="w-full rounded-md border border-gray-300 py-2 px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
          {search && <button onClick={() => { setSearch(''); setPage(1) }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={14} /></button>}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6">
        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">加载中...</div>
        ) : events.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">暂无事件数据</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="w-12 px-4 py-3 text-center font-medium text-gray-500">#</th>
                <th className="py-3 pr-4 text-left font-medium text-gray-500">aggregate_id</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">类型</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">序列号</th>
              </tr>
            </thead>
            <tbody>
              {pagedEvents.map((e, i) => (
                <tr key={e.id || i} className={`border-b border-gray-100 transition-colors hover:bg-brand-50 ${i % 2 === 1 ? 'bg-gray-50/50' : ''}`}>
                  <td className="px-4 py-3 text-center text-gray-400 text-xs">{(page - 1) * pageSize + i + 1}</td>
                  <td className="py-3 pr-4 text-gray-900 font-mono text-xs">{truncateText(e.aggregate_id || '-', 24)}</td>
                  <td className="px-4 py-3 text-gray-600">{e.type || '-'}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{e.seq ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {total > pageSize && (
        <div className="shrink-0 flex items-center justify-between border-t border-gray-200 bg-white px-6 py-3">
          <span className="text-sm text-gray-500">显示 {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} / {total}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft size={16} /></button>
            <span className="text-sm text-gray-500">{page} / {totalPages || 1}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"><ChevronRight size={16} /></button>
          </div>
        </div>
      )}
    </div>
  )
}

export default Events
