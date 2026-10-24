/**
 * 更新状态机转换校验
 * 防止 UI / IPC 事件触发非法状态跃迁
 */
import type { UpdateState } from '@shared/types'

const ALLOWED: Record<UpdateState, UpdateState[]> = {
  idle:        ['available'],
  available:   ['downloading', 'idle'],
  downloading: ['downloaded', 'idle'],
  downloaded:  ['installing', 'idle'],
  // installing → downloaded：重启失败时回到「已下载待安装」，允许用户再点一次安装
  installing:  ['downloaded', 'idle'],
}

export function isValidTransition(from: UpdateState, to: UpdateState): boolean {
  if (from === to) return true
  return ALLOWED[from].includes(to)
}
