import { User, Bot, Wrench, FileText } from 'lucide-react'

// ---------------------------------------------------------------------------
// Role helpers
// ---------------------------------------------------------------------------

export interface RoleConfig {
  label: string
  icon: typeof User
  badgeClass: string
  bgClass: string
}

export const ROLE_CONFIG: Record<string, RoleConfig> = {
  user: { label: 'User', icon: User, badgeClass: 'bg-brand-100 text-brand-700', bgClass: 'bg-brand-50' },
  assistant: { label: 'Assistant', icon: Bot, badgeClass: 'bg-green-100 text-green-700', bgClass: 'bg-green-50' },
  tool: { label: 'Tool', icon: Wrench, badgeClass: 'bg-orange-100 text-orange-700', bgClass: 'bg-orange-50' },
  system: { label: 'System', icon: FileText, badgeClass: 'bg-gray-100 text-gray-700', bgClass: 'bg-gray-50' },
}

// ---------------------------------------------------------------------------
// Part type helpers
// ---------------------------------------------------------------------------

export interface PartTypeConfig {
  label: string
  emoji: string
  badgeClass: string
}

export const PART_TYPE_CONFIG: Record<string, PartTypeConfig> = {
  text: { label: 'text', emoji: '📝', badgeClass: 'bg-green-100 text-green-700' },
  tool: { label: 'tool', emoji: '🔧', badgeClass: 'bg-brand-100 text-brand-700' },
  reasoning: { label: 'reasoning', emoji: '🧠', badgeClass: 'bg-orange-100 text-orange-700' },
  'step-start': { label: 'step-start', emoji: '▶', badgeClass: 'bg-gray-100 text-gray-600' },
  'step-finish': { label: 'step-finish', emoji: '✅', badgeClass: 'bg-gray-100 text-gray-600' },
}

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
