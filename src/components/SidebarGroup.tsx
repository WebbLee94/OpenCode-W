import type { ReactNode } from 'react'

interface SidebarGroupProps {
  label: string
  children: ReactNode
}

export default function SidebarGroup({ label, children }: SidebarGroupProps) {
  return (
    <div className="space-y-1">
      <div className="px-3 pt-3 pb-1 text-xs font-medium text-gray-400 uppercase tracking-wider">
        {label}
      </div>
      {children}
    </div>
  )
}
