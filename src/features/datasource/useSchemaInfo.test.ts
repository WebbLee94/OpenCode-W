/**
 * deriveSchemaState 单测 —— 覆盖规格 08.1 第 1.1 节优先级表的全部输出。
 */
import { describe, it, expect } from 'vitest'
import { deriveSchemaState, type SchemaUiState } from './useSchemaInfo'
import type { SchemaInfoDTO } from '@shared/types'

function info(overrides: Partial<SchemaInfoDTO> = {}): SchemaInfoDTO {
  return {
    mode: 'v1',
    migrationPhase: 'none',
    hasLegacyTables: false,
    v2SessionCount: 0,
    unsupportedReason: null,
    ...overrides,
  }
}

describe('deriveSchemaState', () => {
  it('1. loading 优先于其它状态', () => {
    const d = deriveSchemaState({ kind: 'loading' })
    expect(d.key).toBe('loading')
    expect(d.isReadOnly).toBe(false)
    expect(d.isSchemaBlocked).toBe(false)
  })

  it('2. 没有库时为 none', () => {
    const d = deriveSchemaState({ kind: 'none' })
    expect(d.key).toBe('none')
    expect(d.isReadOnly).toBe(false)
  })

  it('3. migrationPhase=running 时优先于 unsupported', () => {
    const d = deriveSchemaState({
      kind: 'ready',
      info: info({ mode: 'unsupported', migrationPhase: 'running', unsupportedReason: '缺少表' }),
    })
    expect(d.key).toBe('running')
    expect(d.isReadOnly).toBe(true)
    expect(d.isMigrationRunning).toBe(true)
    expect(d.isSchemaBlocked).toBe(false)
    // 原因仍需保留，供徽标补充「结构尚未就绪」
    expect(d.reason).toBe('缺少表')
  })

  it('4. migrationPhase=failed 时优先于 unsupported', () => {
    const d = deriveSchemaState({
      kind: 'ready',
      info: info({ mode: 'unsupported', migrationPhase: 'failed', unsupportedReason: '缺少表' }),
    })
    expect(d.key).toBe('failed')
    expect(d.isReadOnly).toBe(true)
    expect(d.isMigrationFailed).toBe(true)
  })

  it('5. mode=unsupported 且无迁移阶段时为 unsupported', () => {
    const d = deriveSchemaState({
      kind: 'ready',
      info: info({ mode: 'unsupported', unsupportedReason: '缺少 session_message / session_v2 等表' }),
    })
    expect(d.key).toBe('unsupported')
    expect(d.isSchemaBlocked).toBe(true)
    expect(d.isReadOnly).toBe(false)
    expect(d.reason).toBe('缺少 session_message / session_v2 等表')
  })

  it('6. v2-mixed 与 v2 同为数据面正常（v2-only 收口）', () => {
    const d = deriveSchemaState({
      kind: 'ready',
      info: info({ mode: 'v2-mixed', migrationPhase: 'completed' }),
    })
    expect(d.key).toBe('v2')
    expect(d.mode).toBe('v2-mixed')
    expect(d.isReadOnly).toBe(false)
  })

  it('7a. mode=v2 时为 v2', () => {
    const d = deriveSchemaState({ kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) })
    expect(d.key).toBe('v2')
    expect(d.mode).toBe('v2')
    expect(d.isReadOnly).toBe(false)
  })

  it('7b. v2-mixed 但旧表无独有会话时按 v2 展示（标签仍为 v2-mixed）', () => {
    const d = deriveSchemaState({ kind: 'ready', info: info({ mode: 'v2-mixed', migrationPhase: 'completed' }) })
    expect(d.key).toBe('v2')
    expect(d.mode).toBe('v2-mixed')
  })

  it('8. mode=v1 时为 v1', () => {
    const d = deriveSchemaState({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'unknown' }) })
    expect(d.key).toBe('v1')
    expect(d.mode).toBe('v1')
    expect(d.isReadOnly).toBe(false)
  })

  it('9. 前端合成的 unsupported 状态同样映射为 unsupported', () => {
    const d = deriveSchemaState({ kind: 'unsupported', reason: '该文件不是受支持的 OpenCode 数据库', path: '/tmp/x.db' })
    expect(d.key).toBe('unsupported')
    expect(d.isSchemaBlocked).toBe(true)
    expect(d.path).toBe('/tmp/x.db')
    expect(d.reason).toBe('该文件不是受支持的 OpenCode 数据库')
  })

  it('9b. 后端返回 unsupported DTO 时以 DTO 为准（原因与路径）', () => {
    const d = deriveSchemaState({
      kind: 'ready',
      info: info({ mode: 'unsupported', unsupportedReason: '后端给的原因' }),
      path: '/tmp/x.db',
    })
    expect(d.key).toBe('unsupported')
    expect(d.isSchemaBlocked).toBe(true)
    expect(d.reason).toBe('后端给的原因')
    expect(d.path).toBe('/tmp/x.db')
  })

  it('9c. 后端返回 unsupported DTO 且处于迁移中时，仍按 running 优先', () => {
    const d = deriveSchemaState({
      kind: 'ready',
      info: info({ mode: 'unsupported', migrationPhase: 'running', unsupportedReason: '后端给的原因' }),
    })
    expect(d.key).toBe('running')
    expect(d.isReadOnly).toBe(true)
    expect(d.reason).toBe('后端给的原因')
  })

  it('isReadOnly 仅在 running / failed 时为 true', () => {
    const cases: Array<[SchemaUiState, boolean]> = [
      [{ kind: 'loading' }, false],
      [{ kind: 'none' }, false],
      [{ kind: 'ready', info: info({ mode: 'v1' }) }, false],
      [{ kind: 'ready', info: info({ mode: 'v2' }) }, false],
      [{ kind: 'ready', info: info({ mode: 'v2-mixed' }) }, false],
      [{ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) }, true],
      [{ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'failed' }) }, true],
      [{ kind: 'unsupported', reason: null, path: null }, false],
    ]
    for (const [state, expected] of cases) {
      expect(deriveSchemaState(state).isReadOnly).toBe(expected)
    }
  })

  it('phase=none / completed / unknown 不单独成状态', () => {
    for (const phase of ['none', 'completed', 'unknown'] as const) {
      const d = deriveSchemaState({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: phase }) })
      expect(d.key).toBe('v1')
      expect(d.isReadOnly).toBe(false)
    }
  })
})
