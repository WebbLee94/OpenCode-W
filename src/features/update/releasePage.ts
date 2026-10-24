/**
 * 官方发布页入口
 *
 * 更新失败且**重试无意义**时（签名校验不通过 / 本平台没有产物），
 * 用户唯一能执行的下一步就是去发布页手动下载安装。
 * 错误文案里说的「请从官方发布页手动下载」必须有一个真的能点的入口，
 * 否则用户只会被告知失败，却拿不到可执行的动作。
 */
import { useCallback } from 'react'
import { openExternal } from '@/lib/ipc'
import { useToast } from '@/hooks/useToast'
import pkg from '../../../package.json'

/**
 * 官方发布页地址。
 *
 * 与 `src-tauri/tauri.conf.json` 里的 updater endpoint 同源：
 * endpoint 是 `.../releases/latest/download/latest.json`，
 * 对应的发布页就是 `.../releases/latest`。
 */
export const RELEASE_PAGE_URL = `${pkg.repository.url}/releases/latest`

/**
 * 打开发布页。
 *
 * @returns 是否成功打开（失败时由调用方决定如何提示用户）
 */
export async function openReleasePage(): Promise<boolean> {
  try {
    await openExternal(RELEASE_PAGE_URL)
    return true
  } catch (err) {
    console.error('打开发布页失败:', err)
    return false
  }
}

/**
 * 「打开发布页」按钮的通用处理：成功则由系统浏览器打开，
 * 失败时给一条可操作的提示（附上地址，用户可以手动复制）。
 */
export function useOpenReleasePage(): () => Promise<void> {
  const { addToast } = useToast()
  return useCallback(async () => {
    const ok = await openReleasePage()
    if (!ok) {
      addToast(`打开发布页失败，请手动访问 ${RELEASE_PAGE_URL}`, 'error')
    }
  }, [addToast])
}
