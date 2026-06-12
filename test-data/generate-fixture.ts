import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, 'test.db')

// Remove existing test database
if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH)
}
for (const ext of ['-wal', '-shm']) {
  if (existsSync(DB_PATH + ext)) unlinkSync(DB_PATH + ext)
}

mkdirSync(__dirname, { recursive: true })

const db = new Database(DB_PATH)

// Create tables matching actual OpenCode schema
// - message table has NO role column (role is in data JSON)
// - part table has NO type column (type is in data JSON)
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

// Generate realistic session data
const models = ['claude-sonnet-4-20250514', 'gpt-4o', 'claude-opus-4-20250514']
const projects = ['my-webapp', 'api-server', 'data-pipeline']
const directories = ['/Users/dev/my-webapp', '/Users/dev/api-server', '/Users/dev/data-pipeline']
const agents = ['coder', 'architect', 'debugger']
const sessionTitles = [
  'Fix authentication middleware bug',
  'Implement user dashboard feature',
  'Refactor database query optimization',
]

const sessions = []
const now = Date.now()

for (let i = 0; i < 3; i++) {
  const created = now - (3 - i) * 86400000
  const updated = now - (3 - i) * 86400000 + 3600000
  const tokensInput = 2000 + Math.floor(Math.random() * 8000)
  const tokensOutput = 1000 + Math.floor(Math.random() * 6000)
  const tokensReasoning = Math.floor(Math.random() * 4000)
  const tokensCacheRead = Math.floor(Math.random() * 2000)
  const tokensCacheWrite = Math.floor(Math.random() * 500)
  const cost = +(tokensInput * 0.000003 + tokensOutput * 0.000015 + tokensReasoning * 0.000005).toFixed(6)

  sessions.push({
    id: randomUUID(),
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

// Insert sessions
const insertSession = db.prepare(`
  INSERT INTO session (id, title, directory, model, agent, project_id, parent_id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost, time_created, time_updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

for (const s of sessions) {
  insertSession.run(
    s.id, s.title, s.directory, s.model, s.agent, s.project_id, s.parent_id,
    s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write,
    s.cost, s.time_created, s.time_updated
  )
}

// Generate child (sub) sessions for the first parent session
const childTitles = [
  'Authentication middleware - 子任务 A',
  'Authentication middleware - 子任务 B',
]
const parentSession = sessions[0]
for (let i = 0; i < childTitles.length; i++) {
  const childCreated = parentSession.time_created + (i + 1) * 1800000 // 30 min after parent
  const childUpdated = childCreated + 600000
  const childId = randomUUID()
  const childTokensInput = 1500 + Math.floor(Math.random() * 4000)
  const childTokensOutput = 800 + Math.floor(Math.random() * 3000)
  const childCost = +(childTokensInput * 0.000003 + childTokensOutput * 0.000015).toFixed(6)

  insertSession.run(
    childId, childTitles[i], parentSession.directory, parentSession.model,
    parentSession.agent, parentSession.project_id, parentSession.id,
    childTokensInput, childTokensOutput, 0, 0, 0, childCost, childCreated, childUpdated
  )
}

// Generate messages - role is inside data JSON
const roles: ('user' | 'assistant' | 'tool')[] = ['user', 'assistant', 'tool']
const messages: { id: string; session_id: string; data: string; time_created: number }[] = []

let msgTime = now - 3 * 86400000
for (let i = 0; i < 20; i++) {
  const sessionId = sessions[i % 3].id
  const role = roles[i % 3]
  msgTime += 30000 + Math.floor(Math.random() * 60000)

  let data: Record<string, unknown>
  if (role === 'user') {
    data = {
      role: 'user',
      time: { created: msgTime },
      summary: { diffs: [] },
      agent: agents[i % 3],
      model: { providerID: 'anthropic', modelID: models[i % 3] },
    }
  } else if (role === 'assistant') {
    data = {
      role: 'assistant',
      time: { created: msgTime },
      summary: { diffs: [] },
      agent: agents[i % 3],
      model: { providerID: 'anthropic', modelID: models[i % 3] },
    }
  } else {
    data = {
      role: 'tool',
      time: { created: msgTime },
      summary: { diffs: [] },
      agent: agents[i % 3],
      model: { providerID: 'anthropic', modelID: models[i % 3] },
    }
  }

  messages.push({
    id: randomUUID(),
    session_id: sessionId,
    data: JSON.stringify(data),
    time_created: msgTime,
  })
}

const insertMessage = db.prepare(`
  INSERT INTO message (id, session_id, data, time_created)
  VALUES (?, ?, ?, ?)
`)

for (const m of messages) {
  insertMessage.run(m.id, m.session_id, m.data, m.time_created)
}

// Generate parts - type is inside data JSON
const partTypes: ('text' | 'tool' | 'reasoning' | 'step-start' | 'step-finish')[] = ['text', 'tool', 'reasoning', 'step-start', 'step-finish']
const toolNames = ['read_file', 'write_file', 'bash', 'search', 'skill']
const skillNames = ['brainstorming', 'tdd', 'frontend', 'debugging', 'writing']

const parts: { id: string; session_id: string; message_id: string; data: string; time_created: number }[] = []

for (let i = 0; i < 80; i++) {
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
          input: 100 + Math.floor(Math.random() * 500),
          output: 50 + Math.floor(Math.random() * 200),
          reasoning: Math.floor(Math.random() * 100),
          cache_read: Math.floor(Math.random() * 10000),
          cache_write: Math.floor(Math.random() * 1000),
        }
      }
      break
  }

  parts.push({
    id: randomUUID(),
    session_id: msg.session_id,
    message_id: msg.id,
    data: JSON.stringify(data),
    time_created: msg.time_created + i * 1000,
  })
}

const insertPart = db.prepare(`
  INSERT INTO part (id, session_id, message_id, data, time_created)
  VALUES (?, ?, ?, ?, ?)
`)

for (const p of parts) {
  insertPart.run(p.id, p.session_id, p.message_id, p.data, p.time_created)
}

// Generate todos — covers parent and sub sessions, varied status/priority
const todoSamples: { sessionId: string; content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; priority: 'high' | 'medium' | 'low' }[] = []
let todoPos = 0

// Parent session 1 — 4 todos
for (let i = 0; i < 4; i++) {
  const statuses: ('pending' | 'in_progress' | 'completed' | 'cancelled')[] = ['completed', 'in_progress', 'pending', 'completed']
  const priorities: ('high' | 'medium' | 'low')[] = ['high', 'high', 'medium', 'low']
  todoSamples.push({
    sessionId: sessions[0].id,
    content: `Phase ${i + 1}: ${['需求分析', '架构设计', '核心实现', '测试验证'][i]}`,
    status: statuses[i],
    priority: priorities[i],
  })
}

// Parent session 2 — 2 todos
for (let i = 0; i < 2; i++) {
  todoSamples.push({
    sessionId: sessions[1].id,
    content: `子任务 ${i + 1}: 数据迁移与兼容性验证`,
    status: i === 0 ? 'in_progress' : 'pending',
    priority: i === 0 ? 'high' : 'medium',
  })
}

// Parent session 3 — 3 todos
for (let i = 0; i < 3; i++) {
  todoSamples.push({
    sessionId: sessions[2].id,
    content: `优化项 ${i + 1}: ${['查询性能', '缓存命中率', '索引重建'][i]}`,
    status: i === 0 ? 'completed' : (i === 1 ? 'in_progress' : 'pending'),
    priority: 'medium',
  })
}

// Each child session also gets todos — verifies the parent+child merged query
const childRows = db.prepare('SELECT id, time_created FROM session WHERE parent_id = ?').all(sessions[0].id) as { id: string; time_created: number }[]
for (const child of childRows) {
  for (let i = 0; i < 2; i++) {
    todoSamples.push({
      sessionId: child.id,
      content: `子任务-A-${i + 1}: 边界条件与异常处理`,
      status: i === 0 ? 'completed' : 'in_progress',
      priority: 'high',
    })
  }
}

const insertTodo = db.prepare(`
  INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

const todoInsertStmt = db.transaction((items: typeof todoSamples) => {
  for (const t of items) {
    const now = Date.now()
    insertTodo.run(t.sessionId, t.content, t.status, t.priority, todoPos++, now, now)
  }
})
todoInsertStmt(todoSamples)

// Verify data
const sessionCount = (db.prepare('SELECT COUNT(*) as count FROM session').get() as { count: number }).count
const messageCount = (db.prepare('SELECT COUNT(*) as count FROM message').get() as { count: number }).count
const partCount = (db.prepare('SELECT COUNT(*) as count FROM part').get() as { count: number }).count
const todoCount = (db.prepare('SELECT COUNT(*) as count FROM todo').get() as { count: number }).count

db.close()

console.log(`Test database generated at: ${DB_PATH}`)
console.log(`   Sessions: ${sessionCount}`)
console.log(`   Messages: ${messageCount}`)
console.log(`   Parts:    ${partCount}`)
console.log(`   Todos:    ${todoCount}`)
