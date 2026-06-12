import { useEffect, useRef, useState } from 'react'
import { ChevronRight, ListTree, X } from 'lucide-react'
import type { SessionDTO } from '../../../shared/types'
import { formatRelativeTime } from '../../lib/format'

interface SubSessionSelectorProps {
  childSessions: SessionDTO[]
  selectedChildId: string
  onChange: (id: string) => void
}

export default function SubSessionSelector({ childSessions, selectedChildId, onChange }: SubSessionSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // 关闭时清空搜索,避免下次打开看到旧搜索词
  useEffect(() => { if (!open) setSearch('') }, [open])

  const filtered = search
    ? childSessions.filter(c => (c.title || '').toLowerCase().includes(search.toLowerCase()))
    : childSessions

  const selectedTitle = selectedChildId
    ? childSessions.find(c => c.id === selectedChildId)?.title?.slice(0, 24) || '已选'
    : '全部子会话'

  return (
    <div className="relative min-w-[200px]" ref={ref}>
      <ListTree size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
      <button
        onClick={() => setOpen(!open)}
        className={`w-full appearance-none rounded-md border bg-white py-1.5 pl-9 pr-8 text-sm text-left truncate focus:outline-none focus:ring-1 ${
          selectedChildId ? 'border-brand-400 text-brand-700' : 'border-gray-300 text-gray-900'
        } focus:border-brand-500 focus:ring-brand-500`}
        title={selectedChildId ? childSessions.find(c => c.id === selectedChildId)?.title || '已选' : '全部子会话'}
      >
        {selectedTitle}
      </button>
      <ChevronRight size={14} className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 transition-transform ${open ? 'rotate-90' : 'rotate-0'}`} />
      {selectedChildId && (
        <button
          onClick={(e) => { e.stopPropagation(); onChange(''); setOpen(false) }}
          className="absolute right-7 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          title="清除选择"
        >
          <X size={12} />
        </button>
      )}
      {open && (
        <div className="absolute z-30 top-full left-0 mt-1 w-80 bg-white border border-gray-200 rounded shadow-lg max-h-64 overflow-hidden">
          <div className="p-2 border-b border-gray-200">
            <input
              type="text"
              placeholder="搜索子会话..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white text-gray-900 placeholder-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              autoFocus
            />
          </div>
          <ul className="overflow-y-auto max-h-48">
            <li
              className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 ${!selectedChildId ? 'bg-brand-50 text-brand-700' : ''}`}
              onClick={() => { onChange(''); setOpen(false) }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">全部子会话</span>
                <span className="text-xs text-gray-400 shrink-0">共 {childSessions.length} 个</span>
              </div>
            </li>
            {filtered.length > 0 ? filtered.map(c => (
              <li
                key={c.id}
                className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 truncate ${selectedChildId === c.id ? 'bg-brand-50 text-brand-700' : ''}`}
                onClick={() => { onChange(c.id); setOpen(false) }}
                title={c.title || '无标题'}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{c.title || '无标题'}</span>
                  <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(c.time_created)}</span>
                </div>
              </li>
            )) : (
              childSessions.length > 0 ? (
                <li className="px-3 py-4 text-xs text-gray-400 text-center">无匹配子会话</li>
              ) : (
                <li className="px-3 py-4 text-xs text-gray-400 text-center">该会话无子会话</li>
              )
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
