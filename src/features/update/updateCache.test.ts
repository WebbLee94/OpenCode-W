/**
 * 更新缓存读写单测
 * 缓存记录"上次检查时间 + 上次已知版本",用于 UI 展示
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadUpdateCache, saveUpdateCache } from './updateCache'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cache-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadUpdateCache', () => {
  it('returns null when cache file does not exist', () => {
    expect(loadUpdateCache(tmpDir)).toBeNull()
  })
})

describe('saveUpdateCache + loadUpdateCache', () => {
  it('round-trips lastCheckedAt and lastVersion', () => {
    const cache = { lastCheckedAt: '2026-07-07T00:00:00.000Z', lastVersion: '1.2.1' }
    saveUpdateCache(tmpDir, cache)
    expect(loadUpdateCache(tmpDir)).toEqual(cache)
  })

  it('overwrites previous cache on second save', () => {
    saveUpdateCache(tmpDir, { lastCheckedAt: 't1', lastVersion: '1.0.0' })
    saveUpdateCache(tmpDir, { lastCheckedAt: 't2', lastVersion: '2.0.0' })
    expect(loadUpdateCache(tmpDir)).toEqual({ lastCheckedAt: 't2', lastVersion: '2.0.0' })
  })
})
