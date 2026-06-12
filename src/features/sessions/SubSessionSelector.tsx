import { useEffect, useRef, useState } from 'react'
import type { SessionDTO } from '../../../shared/types'

interface SubSessionSelectorProps {
  childSessions: SessionDTO[]
  selectedChildId: string
  onChange: (id: string) => void
}

export default function SubSessionSelector({ childSessions, selectedChildId, onChange }: SubSessionSelectorProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="relative inline-block mb-3" ref={ref}>
      <button onClick={() => setOpen(!open)} className="text-sm text-gray-500 hover:text-gray-700 border rounded px-2 py-0.5">
        ▼ {selectedChildId ? childSessions.find(c => c.id === selectedChildId)?.title?.slice(0, 20) || '已选' : '全部子会话'}
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 mt-1 bg-white border rounded shadow-lg py-1 w-64 max-h-48 overflow-y-auto">
          <button onClick={() => { onChange(''); setOpen(false) }} className="block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 font-medium">全部子会话</button>
          {childSessions.map(c => (
            <button key={c.id} onClick={() => { onChange(c.id); setOpen(false) }}
              className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${selectedChildId === c.id ? 'bg-brand-50' : ''}`}>
              {c.title || '无标题'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
