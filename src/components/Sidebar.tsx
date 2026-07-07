import { NavLink } from 'react-router'
import logoSvg from '/brand/logo.svg'
import { useState, useEffect, useCallback } from 'react'
import { invokeSafe, isElectron } from '@/lib/ipc'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import SidebarGroup from './SidebarGroup'
import {
  LayoutDashboard, MessageSquare, Trash2, HardDrive, Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react'

interface NavItemDef {
  to: string
  label: string
  icon: LucideIcon
}

const navGroups: { label: string; items: NavItemDef[] }[] = [
  {
    label: '概览',
    items: [
      { to: '/', label: '仪表盘', icon: LayoutDashboard },
    ],
  },
  {
    label: '数据',
    items: [
      { to: '/sessions', label: '会话浏览', icon: MessageSquare },
    ],
  },
  {
    label: '工具',
    items: [
      { to: '/cleanup', label: '清理向导', icon: Trash2 },
      { to: '/backup', label: '备份恢复', icon: HardDrive },
    ],
  },
]

export function Sidebar() {
  const [dbConnected, setDbConnected] = useState(false)

  const checkConnection = useCallback(async () => {
    if (!isElectron()) {
      setDbConnected(false)
      return
    }
    try {
      const health = await invokeSafe<{ ok: boolean }>(IPC_CHANNELS.DATABASE_HEALTH)
      setDbConnected(health.ok)
    } catch {
      setDbConnected(false)
    }
  }, [])

  useEffect(() => { checkConnection() }, [checkConnection])

  return (
    <nav className="w-56 bg-white border-r border-gray-200 flex flex-col shrink-0 overflow-visible">
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <img src={logoSvg} alt="OpenCode-W" className="w-6 h-6" />
          <div>
            <h1 className="text-base font-semibold text-gray-900">OpenCode-W</h1>
            <p className="text-xs text-gray-500">你的 AI 编程工坊</p>
          </div>
        </div>
      </div>
      <div className="flex-1 p-2 overflow-y-auto">
        {navGroups.map(group => (
          <SidebarGroup key={group.label} label={group.label}>
            {group.items.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`
                }
              >
                <Icon size={18} />
                <span className="flex-1">{label}</span>
              </NavLink>
            ))}
          </SidebarGroup>
        ))}
      </div>
      <div className="min-h-14 p-3 border-t border-gray-200 flex items-center">
        <div className="flex items-center gap-2 w-full">
          <div className="flex-1 flex items-center gap-2 px-3 py-2 text-xs text-gray-700 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${dbConnected ? 'bg-green-500' : 'bg-gray-400'}`} />
            <span className="truncate">{dbConnected ? '已连接' : '未连接'}</span>
          </div>
          <NavLink
            to="/settings"
            title="设置"
            className={({ isActive }) =>
              `flex items-center justify-center w-8 h-8 rounded-md transition-colors shrink-0 ${
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'bg-gray-50 hover:bg-gray-100 text-gray-500 hover:text-gray-700'
              }`
            }
          >
            <SettingsIcon size={14} />
          </NavLink>
        </div>
      </div>
    </nav>
  )
}
