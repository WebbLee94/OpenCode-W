import type { ReactNode } from 'react'

interface PageHeaderProps {
  icon: ReactNode
  title: string
  description?: ReactNode
  right?: ReactNode
}

export default function PageHeader({ icon, title, description, right }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <span className="text-brand-600">{icon}</span>
        <h2 className="text-2xl font-semibold text-gray-900">{title}</h2>
        {description && <span className="text-sm text-gray-500 ml-2">{description}</span>}
      </div>
      {right}
    </div>
  )
}
