import { useEffect, useState } from 'react'
import type { SessionShareDTO } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe, openExternal } from '../../lib/ipc'
import { formatRelativeTime, truncateText } from '../../lib/format'
import { useNavigate } from 'react-router'
import { Share2 } from 'lucide-react'
import PageHeader from '../../components/PageHeader'
import PaginationBar from '../../components/PaginationBar'

function Shares() {
  const [shares, setShares] = useState<SessionShareDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const pageSize = 50
  const navigate = useNavigate()

  useEffect(() => {
    setLoading(true)
    invokeSafe<{ data: SessionShareDTO[]; total: number }>(IPC_CHANNELS.SESSION_SHARES_LIST, { page, pageSize })
      .then(r => { setShares(r.data); setTotal(r.total) })
      .finally(() => setLoading(false))
  }, [page])

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-4">
        <PageHeader
          icon={<Share2 size={24} />}
          title="分享管理"
          right={<span className="text-sm text-gray-500">共 {total} 条分享</span>}
        />
      </div>
      <div className="flex-1 overflow-auto px-6 py-0">
        {loading && shares.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">加载中...</div>
        ) : shares.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-400">暂无分享记录</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="w-12 px-4 py-3 text-center font-medium text-gray-500">#</th>
                <th className="py-3 pr-4 text-left font-medium text-gray-500">分享 ID</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">会话</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">创建时间</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody>
              {shares.map((s, i) => (
                <tr key={s.id} className={`border-b border-gray-100 transition-colors hover:bg-brand-50 ${i % 2 === 1 ? 'bg-gray-50/50' : ''}`}>
                  <td className="px-4 py-3 text-center text-gray-400 text-xs">{(page - 1) * pageSize + i + 1}</td>
                  <td className="py-3 pr-4 text-gray-900 font-mono text-xs">{truncateText(s.id, 16)}</td>
                  <td className="px-4 py-3 text-gray-600">{truncateText((s as any).session_title || '-', 30)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{formatRelativeTime(s.time_created)}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => navigate(`/sessions?session=${s.session_id}&tab=shares`)}
                      className="text-gray-400 hover:text-blue-600 mr-2" title="跳转到会话">🔗</button>
                    <button onClick={() => { const url = (s as any).url; if (url) openExternal(url) }}
                      className="text-gray-400 hover:text-blue-600" title="在浏览器打开">🌐</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <PaginationBar
        page={page}
        total={total}
        pageSize={pageSize}
        pageSizeOptions={[10, 20, 50]}
        onPageChange={setPage}
        onPageSizeChange={() => { /* pageSize is fixed in Shares */ }}
        sticky={false}
      />
    </div>
  )
}

export default Shares
