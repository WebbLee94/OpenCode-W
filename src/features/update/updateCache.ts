/**
 * 本地更新缓存
 * 持久化"上次检查时间 + 上次已知版本"到 userData/update-cache.json
 * 用于 UI 展示"上次检查于 X 分钟前"以及"已知版本"
 */
import fs from 'node:fs'
import path from 'node:path'

export interface UpdateCache {
  lastCheckedAt: string
  lastVersion: string
}

const FILE_NAME = 'update-cache.json'

export function loadUpdateCache(userDataDir: string): UpdateCache | null {
  const file = path.join(userDataDir, FILE_NAME)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as UpdateCache
  } catch {
    // 文件损坏视为无缓存
    return null
  }
}

export function saveUpdateCache(userDataDir: string, cache: UpdateCache): void {
  const file = path.join(userDataDir, FILE_NAME)
  fs.writeFileSync(file, JSON.stringify(cache), 'utf-8')
}
