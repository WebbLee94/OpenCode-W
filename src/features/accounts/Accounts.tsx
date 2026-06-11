import { useEffect, useState } from 'react'
import type { AccountDTO, AccountStateDTO, AccountUsageItem } from '../../../shared/types'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import { invokeSafe } from '../../lib/ipc'
import { formatDateTime } from '../../lib/format'
import { UserCircle, Crown, Globe, Building2, Clock, Mail } from 'lucide-react'

// ─── Accounts Page ───────────────────────────────────────────────────────────

function Accounts() {
  const [accounts, setAccounts] = useState<AccountDTO[]>([])
  const [activeAccount, setActiveAccount] = useState<AccountStateDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [usageData, setUsageData] = useState<AccountUsageItem[]>([])

  useEffect(() => {
    setLoading(true)
    Promise.all([
      invokeSafe<AccountDTO[]>(IPC_CHANNELS.ACCOUNTS_LIST).catch(() => []),
      invokeSafe<AccountStateDTO | null>(IPC_CHANNELS.ACCOUNTS_ACTIVE).catch(() => null),
    ]).then(([accs, active]) => {
      setAccounts(accs)
      setActiveAccount(active)
    }).finally(() => setLoading(false))
    invokeSafe<AccountUsageItem[]>(IPC_CHANNELS.ACCOUNTS_USAGE).then(setUsageData).catch(() => setUsageData([]))
  }, [])

  const activeId = activeAccount?.active_account_id

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-gray-400">加载中...</div>
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <UserCircle size={24} className="text-brand-600" />
          <h2 className="text-2xl font-semibold text-gray-900">账户管理</h2>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-6 space-y-6">
        {/* Active Account Card */}
        <div>
          <h3 className="text-base font-medium text-gray-900 mb-3 flex items-center gap-2">
            <Crown size={16} className="text-yellow-500" />
            当前活跃账户
          </h3>
          {activeAccount?.active_account_id ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white">
                  <Crown size={12} />
                </span>
                <span className="text-sm font-medium text-green-800">已激活</span>
              </div>
              <div className="space-y-1.5 text-sm">
                {activeAccount.account_email && (
                  <div className="flex items-center gap-2 text-gray-700">
                    <Mail size={14} className="text-gray-400 shrink-0" />
                    {activeAccount.account_email}
                  </div>
                )}
                {activeAccount.account_url && (
                  <div className="flex items-center gap-2 text-gray-700">
                    <Globe size={14} className="text-gray-400 shrink-0" />
                    {activeAccount.account_url}
                  </div>
                )}
                {activeAccount.active_org_id && (
                  <div className="flex items-center gap-2 text-gray-700">
                    <Building2 size={14} className="text-gray-400 shrink-0" />
                    组织: {activeAccount.active_org_id}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <p className="text-sm text-gray-500">未配置活跃账户</p>
            </div>
          )}
        </div>

        {/* Route B: Account Usage Stats */}
        {usageData.length > 0 && (
          <div className="grid grid-cols-4 gap-4 mb-4">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-xs text-gray-400 mb-1">账户数</div>
              <div className="text-xl font-semibold text-gray-900">{usageData.length}</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-xs text-gray-400 mb-1">总会话</div>
              <div className="text-xl font-semibold text-gray-900">{usageData.reduce((s, u) => s + u.sessionCount, 0).toLocaleString()}</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-xs text-gray-400 mb-1">总 Token</div>
              <div className="text-xl font-semibold text-gray-900">{(usageData.reduce((s, u) => s + u.tokenCount, 0) / 1000).toFixed(0)}K</div>
            </div>
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-xs text-gray-400 mb-1">总成本</div>
              <div className="text-xl font-semibold text-gray-900">${usageData.reduce((s, u) => s + u.totalCost, 0).toFixed(2)}</div>
            </div>
          </div>
        )}

        {/* All Accounts Table */}
        <div>
          <h3 className="text-base font-medium text-gray-900 mb-3">全部账户</h3>
          {accounts.length === 0 ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <p className="text-sm text-gray-500">暂无账户信息</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-4 py-3 text-left font-medium text-gray-500">#</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">邮箱</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">服务地址</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Token 过期</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">状态</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">会话数</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">Token</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">成本</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account, idx) => {
                    const isActive = account.id === activeId
                    return (
                      <tr key={account.id} className={`border-b border-gray-100 ${idx % 2 === 1 ? 'bg-gray-50/50' : ''}`}>
                        <td className="px-4 py-3 text-gray-400 text-xs">{idx + 1}</td>
                        <td className="px-4 py-3 text-gray-900 font-medium">
                          <span className="flex items-center gap-1.5">
                            {account.email}
                            {isActive && <Crown size={14} className="text-yellow-500" />}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">{account.url}</td>
                        <td className="px-4 py-3 text-gray-600">
                          {account.token_expiry ? (
                            <span className="flex items-center gap-1.5">
                              <Clock size={12} className="text-gray-400" />
                              {formatDateTime(account.token_expiry)}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {isActive ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                              🟢 活跃
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                              ⚪ 未激活
                            </span>
                          )}
                        </td>
                        {(() => { const u = usageData.find(x => x.accountId === account.id); return (<>
                          <td className="px-4 py-3 text-right text-gray-600">{u?.sessionCount?.toLocaleString() ?? '-'}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{u ? `${(u.tokenCount / 1000).toFixed(0)}K` : '-'}</td>
                          <td className="px-4 py-3 text-right text-gray-600">{u ? `$${u.totalCost.toFixed(2)}` : '-'}</td>
                        </>)})()}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Accounts
