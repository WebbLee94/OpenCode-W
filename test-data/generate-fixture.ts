/**
 * v1（OpenCode 1.x）数据库夹具生成脚本 —— **完全确定性**。
 *
 * 夹具必须可复现：CI 每次 checkout 后重新生成，若内容随时间/随机数漂移，
 * Rust 侧按夹具校准过的断言（会话 id、消息/内容块数量、体积字节数、
 * 硬编码时间窗）就会随机失败。因此本脚本：
 *
 * - **不用** `randomUUID()`：会话 id 固定常量，其余 id 由计数器派生的
 *   UUID 形状字符串生成（唯一且可复现）；
 * - **不用** `Math.random()`：统一走固定种子的 mulberry32 PRNG；
 * - **不用** `Date.now()`：统一走固定基准时间 `BASE_TIME`。
 *
 * 固定会话 id（Rust 侧断言依赖）：
 * | id | 角色 |
 * | --- | --- |
 * | `96c5a5bc-4237-4b07-ac06-a7efab9cf637` | 根会话（Rust 侧按此 id 删除/改名） |
 * | `b06297c0-4c0c-428e-8531-807fa0d15fef` | 根会话 |
 * | `66260988-e9a8-4e89-81c3-c6fb4deda3d0` | 根会话 |
 * | `ff6feeb6-8bf6-4cff-9791-23c056973e36` | 根会话 1 的子会话 |
 * | `bd565d35-bd33-4cc1-bcf3-04c39e8e5417` | 根会话 1 的子会话 |
 *
 * 固定基准时间同样有原因：Rust 侧 `cleanup.rs` 用硬编码时间窗
 * `time_updated > 1792329374316 AND time_updated < 1792331174316` 精确选出
 * 根会话 1（子会话的 time_updated 正好落在边界上被排除）。改基准时间会让该
 * 断言失效，因此这里固定为生成陈旧产物时的同一基准时刻。
 *
 * 运行：`npm run generate-fixture`（v2 夹具见 `generate-v2-fixtures.ts`）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, 'test.db')

/**
 * 固定 PRNG 种子：换种子会改变 token/时间抖动，进而改变体积字节数。
 *
 * 取 52 是有意为之：该种子下 `SUM(LENGTH(part.data))` 全库为 **14020**、
 * 根会话为 **4519**，与 Rust 侧既有断言（`cleanup.rs` 的
 * `estimated_size == 14020` 与 `legacy_bytes == 4519`）完全一致，
 * 因此换种子等于改动那些断言的期望值。
 */
export const SEED = 52

/**
 * 固定基准时间（2026-10-22T09:16:14.316Z）。
 *
 * 与 Rust 侧硬编码时间窗保持一致，见文件头说明。
 */
export const BASE_TIME = 1792586174316

/** Rust 侧断言依赖的 5 个会话 id，顺序固定。 */
const FIXED_SESSION_IDS = [
  '96c5a5bc-4237-4b07-ac06-a7efab9cf637',
  'b06297c0-4c0c-428e-8531-807fa0d15fef',
  '66260988-e9a8-4e89-81c3-c6fb4deda3d0',
  'ff6feeb6-8bf6-4cff-9791-23c056973e36',
  'bd565d35-bd33-4cc1-bcf3-04c39e8e5417',
] as const

/** 根会话 1 的 id：Rust 侧删除/改名断言都指向它。 */
export const ROOT_SESSION_ID = FIXED_SESSION_IDS[0]

/**
 * mulberry32：32 位状态的确定性 PRNG。
 *
 * 同一 seed 永远产出同一序列，且分布足够均匀（用于 token 抖动）。
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 由计数器派生的 UUID 形状 id。
 *
 * 形状与真实库一致（8-4-4-4-12，version 4），末 4 字节写计数器保证唯一，
 * 因此无需 `crypto.randomUUID()` 也绝不重复。
 */
function deterministicUuid(counter: number, rand: () => number): string {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Math.floor(rand() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  bytes[12] = (counter >>> 24) & 0xff
  bytes[13] = (counter >>> 16) & 0xff
  bytes[14] = (counter >>> 8) & 0xff
  bytes[15] = counter & 0xff
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type FixtureSession = {
  id: string
  title: string
  directory: string
  model: string
  agent: string
  project_id: string
  parent_id: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  cost: number
  time_created: number
  time_updated: number
}

export type FixtureMessage = {
  id: string
  session_id: string
  data: string
  time_created: number
}

export type FixturePart = {
  id: string
  session_id: string
  message_id: string
  data: string
  time_created: number
}

export type FixtureTodo = {
  session_id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
  position: number
  time_created: number
  time_updated: number
}

export type Fixture = {
  sessions: FixtureSession[]
  messages: FixtureMessage[]
  parts: FixturePart[]
  todos: FixtureTodo[]
}

/**
 * 构建夹具内容（纯函数，不触碰文件系统）。
 *
 * 导出以便在不改文件的情况下校验长度口径（例如按 seed 搜索能命中
 * Rust 侧既有体积断言的取值）。
 */
export function buildFixture(seed: number = SEED): Fixture {
  const rand = mulberry32(seed)

  const models = ['claude-sonnet-4-20250514', 'gpt-4o', 'claude-opus-4-20250514']
  const projects = ['my-webapp', 'api-server', 'data-pipeline']
  const directories = ['/Users/dev/my-webapp', '/Users/dev/api-server', '/Users/dev/data-pipeline']
  const agents = ['coder', 'architect', 'debugger']
  const sessionTitles = [
    'Fix authentication middleware bug',
    'Implement user dashboard feature',
    'Refactor database query optimization',
  ]

  const now = BASE_TIME
  const sessions: FixtureSession[] = []

  for (let i = 0; i < 3; i += 1) {
    const created = now - (3 - i) * 86400000
    const updated = now - (3 - i) * 86400000 + 3600000
    const tokensInput = 2000 + Math.floor(rand() * 8000)
    const tokensOutput = 1000 + Math.floor(rand() * 6000)
    const tokensReasoning = Math.floor(rand() * 4000)
    const tokensCacheRead = Math.floor(rand() * 2000)
    const tokensCacheWrite = Math.floor(rand() * 500)
    const cost = +(tokensInput * 0.000003 + tokensOutput * 0.000015 + tokensReasoning * 0.000005).toFixed(6)

    sessions.push({
      id: FIXED_SESSION_IDS[i],
      title: sessionTitles[i],
      directory: directories[i],
      model: models[i],
      agent: agents[i],
      project_id: projects[i],
      parent_id: null,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      tokens_reasoning: tokensReasoning,
      tokens_cache_read: tokensCacheRead,
      tokens_cache_write: tokensCacheWrite,
      cost,
      time_created: created,
      time_updated: updated,
    })
  }

  // 子会话：根会话 1 的两个子任务（Rust 侧断言「v1 不递归删除」依赖此结构）。
  const childTitles = [
    'Authentication middleware - 子任务 A',
    'Authentication middleware - 子任务 B',
  ]
  const parentSession = sessions[0]
  for (let i = 0; i < childTitles.length; i += 1) {
    const childCreated = parentSession.time_created + (i + 1) * 1800000 // 30 min after parent
    const childUpdated = childCreated + 600000
    const childId = FIXED_SESSION_IDS[3 + i]
    const childTokensInput = 1500 + Math.floor(rand() * 4000)
    const childTokensOutput = 800 + Math.floor(rand() * 3000)
    const childCost = +(childTokensInput * 0.000003 + childTokensOutput * 0.000015).toFixed(6)

    sessions.push({
      id: childId,
      title: childTitles[i],
      directory: parentSession.directory,
      model: parentSession.model,
      agent: parentSession.agent,
      project_id: parentSession.project_id,
      parent_id: parentSession.id,
      tokens_input: childTokensInput,
      tokens_output: childTokensOutput,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost: childCost,
      time_created: childCreated,
      time_updated: childUpdated,
    })
  }

  // 消息：role 在 data JSON 里，没有独立列。
  const roles: ('user' | 'assistant' | 'tool')[] = ['user', 'assistant', 'tool']
  const messages: FixtureMessage[] = []
  let idCounter = 0

  let msgTime = now - 3 * 86400000
  for (let i = 0; i < 20; i += 1) {
    const sessionId = sessions[i % 3].id
    const role = roles[i % 3]
    msgTime += 30000 + Math.floor(rand() * 60000)

    const data = {
      role,
      time: { created: msgTime },
      summary: { diffs: [] },
      agent: agents[i % 3],
      model: { providerID: 'anthropic', modelID: models[i % 3] },
    }

    messages.push({
      id: deterministicUuid(idCounter, rand),
      session_id: sessionId,
      data: JSON.stringify(data),
      time_created: msgTime,
    })
    idCounter += 1
  }

  // 内容块：type 在 data JSON 里，没有独立列。
  const partTypes: ('text' | 'tool' | 'reasoning' | 'step-start' | 'step-finish')[] = [
    'text',
    'tool',
    'reasoning',
    'step-start',
    'step-finish',
  ]
  const toolNames = ['read_file', 'write_file', 'bash', 'search', 'skill']
  const skillNames = ['brainstorming', 'tdd', 'frontend', 'debugging', 'writing']

  const parts: FixturePart[] = []

  for (let i = 0; i < 80; i += 1) {
    const msg = messages[i % 20]
    const type = partTypes[i % 5]

    let data: Record<string, unknown>
    switch (type) {
      case 'text':
        data = { type: 'text', text: `This is text content for part ${i}. It contains some realistic output from the AI model discussing the implementation details of the authentication system.` }
        break
      case 'tool': {
        const toolIdx = i % 5
        const toolName = toolNames[toolIdx]
        if (toolName === 'skill') {
          data = {
            type: 'tool',
            tool_name: 'skill',
            skill_name: skillNames[i % 5],
            tool_input: { name: skillNames[i % 5], args: { task: `Task ${i}` } },
            tool_output: { result: `Skill ${skillNames[i % 5]} executed successfully` },
            status: 'completed'
          }
        } else {
          data = {
            type: 'tool',
            tool_name: toolName,
            tool_input: { path: `/src/module${i}.ts`, content: `// Module ${i} content` },
            tool_output: { result: `Output from ${toolName} for module ${i}` },
            status: i % 7 === 0 ? 'failed' : 'completed'
          }
        }
        break
      }
      case 'reasoning':
        data = { type: 'reasoning', text: `Let me think about this step by step. First, I need to understand the requirements, then analyze the existing code structure. The authentication middleware needs to properly validate JWT tokens before passing the request to the next handler.`, metadata: {}, time: {} }
        break
      case 'step-start':
        data = { type: 'step-start', snapshot: { step_id: `step-${i}`, step_name: `Step ${i}` } }
        break
      case 'step-finish':
        data = {
          type: 'step-finish',
          result: 'completed',
          tokens: {
            input: 100 + Math.floor(rand() * 500),
            output: 50 + Math.floor(rand() * 200),
            reasoning: Math.floor(rand() * 100),
            cache_read: Math.floor(rand() * 10000),
            cache_write: Math.floor(rand() * 1000),
          }
        }
        break
    }

    parts.push({
      id: deterministicUuid(idCounter, rand),
      session_id: msg.session_id,
      message_id: msg.id,
      data: JSON.stringify(data),
      time_created: msg.time_created + i * 1000,
    })
    idCounter += 1
  }

  // 待办：覆盖父/子会话与多种状态、优先级。
  const todoSamples: {
    sessionId: string
    content: string
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
    priority: 'high' | 'medium' | 'low'
  }[] = []

  for (let i = 0; i < 4; i += 1) {
    const statuses: ('pending' | 'in_progress' | 'completed' | 'cancelled')[] = [
      'completed',
      'in_progress',
      'pending',
      'completed',
    ]
    const priorities: ('high' | 'medium' | 'low')[] = ['high', 'high', 'medium', 'low']
    todoSamples.push({
      sessionId: sessions[0].id,
      content: `Phase ${i + 1}: ${['需求分析', '架构设计', '核心实现', '测试验证'][i]}`,
      status: statuses[i],
      priority: priorities[i],
    })
  }

  for (let i = 0; i < 3; i += 1) {
    const statuses: ('pending' | 'in_progress' | 'completed' | 'cancelled')[] = [
      'completed',
      'in_progress',
      'pending',
    ]
    const priorities: ('high' | 'medium' | 'low')[] = ['medium', 'medium', 'low']
    todoSamples.push({
      sessionId: sessions[1].id,
      content: `子任务 ${i + 1}: 数据迁移与兼容性验证`,
      status: statuses[i],
      priority: priorities[i],
    })
  }

  for (let i = 0; i < 3; i += 1) {
    const statuses: ('pending' | 'in_progress' | 'completed' | 'cancelled')[] = [
      'completed',
      'in_progress',
      'pending',
    ]
    const priorities: ('high' | 'medium' | 'low')[] = ['medium', 'medium', 'low']
    todoSamples.push({
      sessionId: sessions[2].id,
      content: `优化项 ${i + 1}: ${['查询性能', '缓存命中率', '索引重建'][i]}`,
      status: statuses[i],
      priority: priorities[i],
    })
  }

  // 每个子会话两条待办：验证父/子合并查询。
  const childRows = sessions.filter((session) => session.parent_id === sessions[0].id)
  for (const child of childRows) {
    for (let i = 0; i < 2; i += 1) {
      todoSamples.push({
        sessionId: child.id,
        content: `子任务-A-${i + 1}: 边界条件与异常处理`,
        status: i === 0 ? 'completed' : 'in_progress',
        priority: 'high',
      })
    }
  }

  const todos: FixtureTodo[] = todoSamples.map((todo, position) => ({
    session_id: todo.sessionId,
    content: todo.content,
    status: todo.status,
    priority: todo.priority,
    position,
    time_created: BASE_TIME + position * 1000,
    time_updated: BASE_TIME + position * 1000,
  }))

  return { sessions, messages, parts, todos }
}

/** 把夹具写入 SQLite 文件。 */
export function writeFixture(path: string, fixture: Fixture): void {
  if (existsSync(path)) {
    unlinkSync(path)
  }
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(path + ext)) unlinkSync(path + ext)
  }

  mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)

  // 表结构与真实 OpenCode v1 库一致：
  // - message 表没有 role 列（role 在 data JSON）
  // - part 表没有 type 列（type 在 data JSON）
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      model TEXT,
      agent TEXT,
      project_id TEXT,
      parent_id TEXT,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      data TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      data TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id);
    CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id);
    CREATE INDEX IF NOT EXISTS idx_part_session ON part(session_id);

    CREATE TABLE IF NOT EXISTS todo (
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      position INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      PRIMARY KEY (session_id, position),
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS todo_session_idx ON todo (session_id);
  `)

  const insertSession = db.prepare(`
    INSERT INTO session (id, title, directory, model, agent, project_id, parent_id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const session of fixture.sessions) {
    insertSession.run(
      session.id,
      session.title,
      session.directory,
      session.model,
      session.agent,
      session.project_id,
      session.parent_id,
      session.tokens_input,
      session.tokens_output,
      session.tokens_reasoning,
      session.tokens_cache_read,
      session.tokens_cache_write,
      session.cost,
      session.time_created,
      session.time_updated
    )
  }

  const insertMessage = db.prepare(`
    INSERT INTO message (id, session_id, data, time_created)
    VALUES (?, ?, ?, ?)
  `)

  for (const message of fixture.messages) {
    insertMessage.run(message.id, message.session_id, message.data, message.time_created)
  }

  const insertPart = db.prepare(`
    INSERT INTO part (id, session_id, message_id, data, time_created)
    VALUES (?, ?, ?, ?, ?)
  `)

  for (const part of fixture.parts) {
    insertPart.run(part.id, part.session_id, part.message_id, part.data, part.time_created)
  }

  const insertTodo = db.prepare(`
    INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  db.exec('BEGIN')
  try {
    for (const todo of fixture.todos) {
      insertTodo.run(
        todo.session_id,
        todo.content,
        todo.status,
        todo.priority,
        todo.position,
        todo.time_created,
        todo.time_updated
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const sessionCount = (db.prepare('SELECT COUNT(*) as count FROM session').get() as { count: number }).count
  const messageCount = (db.prepare('SELECT COUNT(*) as count FROM message').get() as { count: number }).count
  const partCount = (db.prepare('SELECT COUNT(*) as count FROM part').get() as { count: number }).count
  const todoCount = (db.prepare('SELECT COUNT(*) as count FROM todo').get() as { count: number }).count
  const partBytes = (
    db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part').get() as { total: number }
  ).total
  const rootBytes = (
    db
      .prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part WHERE session_id = ?1')
      .get(ROOT_SESSION_ID) as { total: number }
  ).total

  db.close()

  console.log(`Test database generated at: ${path}`)
  console.log(`   Sessions: ${sessionCount}`)
  console.log(`   Messages: ${messageCount}`)
  console.log(`   Parts:    ${partCount}`)
  console.log(`   Todos:    ${todoCount}`)
  console.log(`   Part bytes: ${partBytes} (root session: ${rootBytes})`)
  console.log(`   Seed: ${SEED}  Base time: ${BASE_TIME}`)
}

// 仅在直接执行本脚本时写库；被 import 时只暴露纯函数（便于校验长度口径）。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  writeFixture(DB_PATH, buildFixture(SEED))
}
