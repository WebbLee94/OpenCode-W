import { ROLE_CONFIG, PART_TYPE_CONFIG } from './badgeConfig'
export { ROLE_CONFIG, PART_TYPE_CONFIG } from './badgeConfig'

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Colored badge for a role */
export function RoleBadge({ role }: { role: string }) {
  const config = ROLE_CONFIG[role] ?? ROLE_CONFIG.system
  const Icon = config.icon
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}`}>
      <Icon size={12} />
      {config.label}
    </span>
  )
}

/** Colored badge for a part type */
export function PartTypeBadge({ type }: { type: string }) {
  const config = PART_TYPE_CONFIG[type] ?? { label: type, emoji: '', badgeClass: 'bg-gray-100 text-gray-600' }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.badgeClass}`}>
      {config.emoji} {config.label}
    </span>
  )
}

/** Status badge for tool execution status */
export function StatusBadge({ status }: { status?: string }) {
  if (!status) return null
  const isOk = status === 'completed' || status === 'success'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${isOk ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {status}
    </span>
  )
}
