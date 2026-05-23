import type { ReactNode } from 'react'

interface StatCardProps {
  label: string
  value: string | number
  icon?: ReactNode
  onClick?: () => void
  trend?: string
  children?: ReactNode
}

export default function StatCard({ label, value, icon, onClick, trend, children }: StatCardProps) {
  const Wrapper = onClick ? 'button' : 'div'

  return (
    <Wrapper
      onClick={onClick}
      className={[
        'bg-white rounded-lg border border-gray-200 p-4 transition-shadow',
        onClick ? 'cursor-pointer hover:shadow-md active:shadow-sm' : '',
      ].join(' ')}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-500 mb-1 truncate">{label}</p>
          <p className="text-xl font-semibold text-gray-900 truncate">{value}</p>
          {children}
          {trend && (
            <p className="text-xs text-green-600 mt-1">{trend}</p>
          )}
        </div>
        {icon && (
          <div className="flex-shrink-0 ml-3 text-gray-400">{icon}</div>
        )}
      </div>
    </Wrapper>
  )
}
