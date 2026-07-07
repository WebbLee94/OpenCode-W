/**
 * 侧边栏更新红点
 * 当 state === 'available' 或 'downloaded' 时显示红点
 */
import { useUpdateStatus } from './useUpdateStatus'

export function UpdateBadge() {
  const { state } = useUpdateStatus()
  if (state !== 'available' && state !== 'downloaded') return null
  return (
    <span
      aria-label="有可用更新"
      className="inline-block w-2 h-2 rounded-full bg-red-500 ml-auto shrink-0"
    />
  )
}
