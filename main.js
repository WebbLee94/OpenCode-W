var H = Object.defineProperty;
var v = (s, e, t) => e in s ? H(s, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : s[e] = t;
var N = (s, e, t) => v(s, typeof e != "symbol" ? e + "" : e, t);
import { ipcMain as u, dialog as I, app as g, BrowserWindow as M } from "electron";
import E from "node:path";
import d from "node:fs";
import b from "node:os";
import { fileURLToPath as j } from "node:url";
import U from "better-sqlite3";
const R = class R {
  constructor() {
    N(this, "connections", /* @__PURE__ */ new Map());
    N(this, "currentPath", null);
  }
  static getInstance() {
    return R.instance || (R.instance = new R()), R.instance;
  }
  open(e) {
    if (!d.existsSync(e))
      throw new Error(`Database file not found: ${e}`);
    const t = E.resolve(e);
    this.connections.has(t) && this.close(t);
    const o = new U(t, { readonly: !1 });
    return o.pragma("journal_mode = WAL"), o.pragma("foreign_keys = ON"), this.connections.set(t, o), this.currentPath = t, o;
  }
  close(e) {
    const t = e ? E.resolve(e) : this.currentPath;
    t && this.connections.has(t) && (this.connections.get(t).close(), this.connections.delete(t), this.currentPath === t && (this.currentPath = null));
  }
  getDb() {
    if (!this.currentPath || !this.connections.has(this.currentPath))
      throw new Error("No database currently open");
    return this.connections.get(this.currentPath);
  }
  getCurrentPath() {
    return this.currentPath;
  }
  healthCheck() {
    const e = this.getDb();
    try {
      const t = e.prepare("PRAGMA integrity_check").get(), o = e.prepare("PRAGMA page_count").get().page_count, a = e.prepare("PRAGMA freelist_count").get().freelist_count;
      let n = 0;
      if (this.currentPath) {
        const r = this.currentPath + "-wal";
        try {
          n = d.existsSync(r) ? d.statSync(r).size : 0;
        } catch {
        }
      }
      return {
        ok: t.integrity_check === "ok",
        pageCount: o,
        freelistPages: a,
        walSize: n
      };
    } catch {
      return { ok: !1, pageCount: 0, freelistPages: 0, walSize: 0 };
    }
  }
  getStats() {
    const e = this.getDb();
    let t = 0, o = 0;
    if (this.currentPath)
      try {
        t = d.statSync(this.currentPath).size;
        const _ = this.currentPath + "-wal";
        o = d.existsSync(_) ? d.statSync(_).size : 0;
      } catch {
      }
    const a = e.prepare("SELECT COUNT(*) as cnt FROM session").get().cnt, n = e.prepare(
      "SELECT COUNT(DISTINCT project_id) as cnt FROM session WHERE project_id IS NOT NULL AND project_id != ''"
    ).get().cnt, r = e.prepare("SELECT COUNT(*) as cnt FROM part").get().cnt, i = e.prepare("PRAGMA freelist_count").get().freelist_count, l = e.prepare("PRAGMA page_size").get().page_size;
    return {
      dbSize: t,
      sessionCount: a,
      projectCount: n,
      partCount: r,
      freelistSize: i * l,
      walSize: o
    };
  }
  getTableStats() {
    const e = this.getDb();
    return ["session", "message", "part"].map((o) => {
      const a = e.prepare(`SELECT COUNT(*) as cnt FROM ${o}`).get(), n = e.prepare(`SELECT SUM(LENGTH(data)) as size FROM ${o}`).get();
      return {
        name: o,
        rowCount: a.cnt,
        dataSize: (n == null ? void 0 : n.size) ?? 0
      };
    });
  }
  vacuum() {
    const e = this.getDb();
    let t = 0;
    this.currentPath && (t = d.statSync(this.currentPath).size), e.pragma("vacuum");
    let o = 0;
    return this.currentPath && (o = d.statSync(this.currentPath).size), { before: t, after: o, freed: t - o };
  }
  checkpoint() {
    this.getDb().pragma("wal_checkpoint(TRUNCATE)");
  }
  rawQuery(e, t = []) {
    return this.getDb().prepare(e).all(...t);
  }
  rawGet(e, t = []) {
    return this.getDb().prepare(e).get(...t);
  }
  run(e, t = []) {
    const a = this.getDb().prepare(e).run(...t);
    return { changes: a.changes, lastInsertRowid: a.lastInsertRowid };
  }
  closeAll() {
    for (const [e] of this.connections)
      this.connections.get(e).close();
    this.connections.clear(), this.currentPath = null;
  }
};
N(R, "instance", null);
let f = R;
const c = f.getInstance(), p = {
  // App info
  APP_GET_VERSION: "app:getVersion",
  APP_GET_PLATFORM: "app:getPlatform",
  // Dashboard
  DASHBOARD_OVERVIEW: "dashboard:overview",
  DASHBOARD_TOKENS: "dashboard:tokens",
  DASHBOARD_TOOL_RANKING: "dashboard:toolRanking",
  DASHBOARD_SKILL_USAGE: "dashboard:skillUsage",
  DASHBOARD_TRENDS: "dashboard:trends",
  // Sessions
  SESSIONS_LIST: "sessions:list",
  SESSIONS_DETAIL: "sessions:detail",
  SESSIONS_PROJECTS: "sessions:projects",
  SESSIONS_DELETE: "sessions:delete",
  // Messages
  MESSAGES_LIST: "messages:list",
  MESSAGES_DETAIL: "messages:detail",
  // Operations
  CLEANUP_PREVIEW: "cleanup:preview",
  CLEANUP_EXECUTE: "cleanup:execute",
  DATABASE_VACUUM: "database:vacuum",
  DATABASE_CHECKPOINT: "database:checkpoint",
  DATABASE_OPEN: "database:open",
  DATABASE_HEALTH: "database:health",
  // Dialog
  DIALOG_OPEN_FILE: "dialog:openFile",
  // Backup
  BACKUP_CREATE: "backup:create",
  BACKUP_LIST: "backup:list",
  BACKUP_RESTORE: "backup:restore",
  BACKUP_DELETE: "backup:delete",
  BACKUP_PREVIEW: "backup:preview"
};
function y(s) {
  const e = typeof s.time_created == "string" ? new Date(s.time_created).getTime() : s.time_created, t = typeof s.time_updated == "string" ? new Date(s.time_updated).getTime() : s.time_updated;
  return {
    id: s.id,
    title: s.title ?? "",
    directory: s.directory,
    model: s.model,
    agent: s.agent,
    project_id: s.project_id,
    msg_count: s.msg_count ?? 0,
    total_tokens: s.total_tokens ?? 0,
    data_size: s.data_size ?? 0,
    tokens_input: s.tokens_input ?? 0,
    tokens_output: s.tokens_output ?? 0,
    tokens_reasoning: s.tokens_reasoning ?? 0,
    time_created: e,
    time_updated: t,
    cost: s.cost
  };
}
function G() {
  u.handle(
    p.SESSIONS_LIST,
    (s, e) => {
      const t = (e == null ? void 0 : e.page) ?? 1, o = (e == null ? void 0 : e.pageSize) ?? 50, a = (t - 1) * o, n = (e == null ? void 0 : e.sortBy) ?? "time_updated", r = (e == null ? void 0 : e.sortOrder) ?? "desc", i = [], l = [];
      e != null && e.search && (i.push("(s.title LIKE ? OR s.id LIKE ?)"), l.push(`%${e.search}%`, `%${e.search}%`)), e != null && e.projectId && (i.push("s.directory = ?"), l.push(e.projectId));
      const _ = i.length > 0 ? `WHERE ${i.join(" AND ")}` : "", m = ["time_created", "time_updated", "title", "cost", "msg_count", "total_tokens", "data_size", "tokens_input", "tokens_output"].includes(n) ? n : "time_updated", C = r === "asc" ? "ASC" : "DESC", h = ["msg_count", "total_tokens", "data_size"].includes(m) ? m : `s.${m}`, A = c.rawGet(
        `SELECT COUNT(*) as cnt FROM session s ${_}`,
        l
      ), z = (A == null ? void 0 : A.cnt) ?? 0;
      return {
        data: c.rawQuery(
          `SELECT
          s.*,
          COALESCE(msg_cnt.cnt, 0) as msg_count,
          (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
          COALESCE(part_size.total, 0) as data_size
        FROM session s
        LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
        LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
        ${_}
        ORDER BY ${h} ${C}
        LIMIT ? OFFSET ?`,
          [...l, o, a]
        ).map(y),
        total: z,
        page: t,
        pageSize: o
      };
    }
  ), u.handle(
    p.SESSIONS_DETAIL,
    (s, e) => {
      const t = c.rawGet(
        `SELECT
          s.*,
          COALESCE(msg_cnt.cnt, 0) as msg_count,
          (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
          COALESCE(part_size.total, 0) as data_size
        FROM session s
        LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
        LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
        WHERE s.id = ?`,
        [e]
      );
      if (!t) return null;
      const o = y(t), a = c.rawGet(
        `SELECT
          COALESCE(SUM(tokens_input), 0) as inputTokens,
          COALESCE(SUM(tokens_output), 0) as outputTokens,
          COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
          COALESCE(SUM(tokens_cache_read), 0) as cacheRead,
          COALESCE(SUM(tokens_cache_write), 0) as cacheWrite,
          COALESCE(SUM(cost), 0) as estimatedCost
        FROM session WHERE id = ?`,
        [e]
      ), n = (a == null ? void 0 : a.inputTokens) ?? 0, r = (a == null ? void 0 : a.cacheRead) ?? 0, i = n > 0 ? r / n * 100 : 0, l = {
        inputTokens: (a == null ? void 0 : a.inputTokens) ?? 0,
        outputTokens: (a == null ? void 0 : a.outputTokens) ?? 0,
        reasoningTokens: (a == null ? void 0 : a.reasoningTokens) ?? 0,
        cacheRead: r,
        cacheWrite: (a == null ? void 0 : a.cacheWrite) ?? 0,
        estimatedCost: (a == null ? void 0 : a.estimatedCost) ?? 0,
        cacheHitRate: Math.round(i * 100) / 100
      }, S = c.rawQuery(
        `SELECT
          json_extract(data, '$.tool') as toolName,
          COUNT(*) as count
        FROM part
        WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') IS NOT NULL
        GROUP BY toolName
        ORDER BY count DESC`,
        [e]
      ).map((h) => ({
        toolName: h.toolName,
        count: h.count
      })), C = c.rawQuery(
        `SELECT DISTINCT json_extract(data, '$.state.input.name') as skillName
        FROM part
        WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') = 'skill' AND json_extract(data, '$.state.input.name') IS NOT NULL`,
        [e]
      ).map((h) => h.skillName);
      return {
        ...o,
        tokenStats: l,
        toolRanking: S,
        skillList: C
      };
    }
  ), u.handle(p.SESSIONS_PROJECTS, () => c.rawQuery(
    "SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory != '' ORDER BY directory"
  ).map((e) => e.directory)), u.handle(
    p.SESSIONS_DELETE,
    (s, e) => {
      const t = c.run("DELETE FROM part WHERE session_id = ?", [e]), o = c.run("DELETE FROM message WHERE session_id = ?", [e]), a = c.run("DELETE FROM session WHERE id = ?", [e]);
      return {
        success: a.changes > 0,
        deletedParts: t.changes,
        deletedMessages: o.changes,
        deletedSessions: a.changes
      };
    }
  );
}
function x(s) {
  let e = {};
  try {
    const n = s.data;
    typeof n == "string" ? e = JSON.parse(n) : typeof n == "object" && n !== null && (e = n);
  } catch {
  }
  const t = e.type ?? "text", o = typeof s.data == "string" ? s.data.length : 0, a = {
    id: s.id,
    message_id: s.message_id,
    session_id: s.session_id,
    type: t,
    data_size: o
  };
  switch (t) {
    case "text": {
      const n = e.text ?? e.content ?? "";
      a.summary = n.length > 200 ? n.slice(0, 200) + "..." : n;
      break;
    }
    case "tool": {
      if (a.toolName = e.tool_name ?? e.toolName ?? "", a.summary = a.toolName, e.tool_input !== void 0 || e.input !== void 0) {
        const n = e.tool_input ?? e.input;
        a.input = typeof n == "string" ? n : JSON.stringify(n, null, 2);
      }
      if (e.tool_output !== void 0 || e.output !== void 0) {
        const n = e.tool_output ?? e.output;
        a.output = typeof n == "string" ? n : JSON.stringify(n, null, 2);
      }
      a.status = e.status ?? e.result ?? "completed";
      break;
    }
    case "reasoning": {
      const n = e.text ?? "";
      a.summary = n.length > 200 ? n.slice(0, 200) + "..." : n;
      break;
    }
    case "step-start": {
      const n = e.snapshot;
      a.summary = (n == null ? void 0 : n.step_name) ?? `Step ${(n == null ? void 0 : n.step_id) ?? ""}`;
      break;
    }
    case "step-finish": {
      if (a.status = e.result ?? "completed", a.summary = `Step finished: ${a.status}`, e.tokens && typeof e.tokens == "object") {
        const n = e.tokens;
        a.tokens = {
          input: n.input ?? 0,
          output: n.output ?? 0,
          reasoning: n.reasoning ?? 0,
          cache_read: n.cache_read ?? 0,
          cache_write: n.cache_write ?? 0
        };
      }
      break;
    }
    case "compaction":
    case "patch":
    case "file": {
      a.summary = `[${t}]`;
      break;
    }
  }
  return a;
}
function W() {
  u.handle(
    p.MESSAGES_LIST,
    (s, e) => {
      const t = (e == null ? void 0 : e.page) ?? 1, o = (e == null ? void 0 : e.pageSize) ?? 50, a = (t - 1) * o, n = c.rawGet(
        "SELECT COUNT(*) as cnt FROM message WHERE session_id = ?",
        [e.sessionId]
      ), r = (n == null ? void 0 : n.cnt) ?? 0;
      return {
        data: c.rawQuery(
          `SELECT id, session_id, json_extract(data, '$.role') as role, LENGTH(data) as data_size, time_created
        FROM message
        WHERE session_id = ?
        ORDER BY time_created ASC
        LIMIT ? OFFSET ?`,
          [e.sessionId, o, a]
        ).map((_) => ({
          id: _.id,
          session_id: _.session_id,
          role: _.role ?? "user",
          data_size: _.data_size ?? 0,
          time_created: typeof _.time_created == "string" ? new Date(_.time_created).getTime() : _.time_created
        })),
        total: r,
        page: t,
        pageSize: o
      };
    }
  ), u.handle(
    p.MESSAGES_DETAIL,
    (s, e) => {
      const t = c.rawGet(
        "SELECT * FROM message WHERE id = ?",
        [e]
      );
      if (!t) return null;
      let o = "", a = "user";
      try {
        const i = typeof t.data == "string" ? JSON.parse(t.data) : t.data;
        typeof i == "string" ? o = i : (i != null && i.role && (a = i.role), i != null && i.content ? o = typeof i.content == "string" ? i.content : JSON.stringify(i.content, null, 2) : o = JSON.stringify(i, null, 2));
      } catch {
        o = t.data ?? "";
      }
      const n = {
        id: t.id,
        session_id: t.session_id,
        role: a,
        data_size: typeof t.data == "string" ? t.data.length : 0,
        time_created: typeof t.time_created == "string" ? new Date(t.time_created).getTime() : t.time_created,
        content: o,
        parts: []
      }, r = c.rawQuery(
        "SELECT * FROM part WHERE message_id = ? ORDER BY id ASC",
        [e]
      );
      return n.parts = r.map(x), n;
    }
  );
}
function $(s) {
  const e = typeof s.time_created == "string" ? new Date(s.time_created).getTime() : s.time_created, t = typeof s.time_updated == "string" ? new Date(s.time_updated).getTime() : s.time_updated;
  return {
    id: s.id,
    title: s.title ?? "",
    directory: s.directory,
    model: s.model,
    agent: s.agent,
    project_id: s.project_id,
    msg_count: s.msg_count ?? 0,
    total_tokens: s.total_tokens ?? 0,
    data_size: s.data_size ?? 0,
    tokens_input: s.tokens_input ?? 0,
    tokens_output: s.tokens_output ?? 0,
    tokens_reasoning: s.tokens_reasoning ?? 0,
    time_created: e,
    time_updated: t,
    cost: s.cost
  };
}
function P(s) {
  const e = [], t = [];
  switch (s.strategy) {
    case "time": {
      const a = s.days ?? 30, n = Date.now() - a * 24 * 60 * 60 * 1e3;
      e.push("s.time_updated < ?"), t.push(n);
      break;
    }
    case "size": {
      const a = (s.sizeMB ?? 100) * 1024 * 1024;
      e.push("COALESCE(part_size.total, 0) > ?"), t.push(a);
      break;
    }
    case "project": {
      s.projectId && (e.push("s.project_id = ?"), t.push(s.projectId));
      break;
    }
    case "custom": {
      s.customWhere && e.push(s.customWhere);
      break;
    }
  }
  if (s.excludedSessionIds && s.excludedSessionIds.length > 0) {
    const a = s.excludedSessionIds.map(() => "?").join(",");
    e.push(`s.id NOT IN (${a})`), t.push(...s.excludedSessionIds);
  }
  return { sql: e.length > 0 ? `WHERE ${e.join(" AND ")}` : "", params: t };
}
function V() {
  u.handle(
    p.CLEANUP_PREVIEW,
    (s, e) => {
      var C, O, h;
      const { sql: t, params: o } = P(e), n = c.rawQuery(
        `SELECT
          s.*,
          COALESCE(msg_cnt.cnt, 0) as msg_count,
          (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
          COALESCE(part_size.total, 0) as data_size
        FROM session s
        LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
        LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
        ${t}`,
        o
      ).map($), r = n.map((A) => A.id);
      if (r.length === 0)
        return {
          sessionCount: 0,
          messageCount: 0,
          partCount: 0,
          estimatedSize: 0,
          sessions: []
        };
      const i = r.map(() => "?").join(","), l = ((C = c.rawGet(
        `SELECT COUNT(*) as cnt FROM message WHERE session_id IN (${i})`,
        r
      )) == null ? void 0 : C.cnt) ?? 0, _ = ((O = c.rawGet(
        `SELECT COUNT(*) as cnt FROM part WHERE session_id IN (${i})`,
        r
      )) == null ? void 0 : O.cnt) ?? 0, S = ((h = c.rawGet(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part WHERE session_id IN (${i})`,
        r
      )) == null ? void 0 : h.total) ?? 0;
      return {
        sessionCount: n.length,
        messageCount: l,
        partCount: _,
        estimatedSize: S,
        sessions: n
      };
    }
  ), u.handle(
    p.CLEANUP_EXECUTE,
    (s, e) => {
      var O;
      const { sql: t, params: o } = P(e), n = c.rawQuery(
        `SELECT id FROM session s ${t}`,
        o
      ).map((h) => h.id);
      if (n.length === 0)
        return {
          deletedSessions: 0,
          deletedMessages: 0,
          deletedParts: 0,
          freedBytes: 0,
          vacuumBefore: 0,
          vacuumAfter: 0
        };
      const r = n.map(() => "?").join(","), i = ((O = c.rawGet(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part WHERE session_id IN (${r})`,
        n
      )) == null ? void 0 : O.total) ?? 0, l = c.run(
        `DELETE FROM part WHERE session_id IN (${r})`,
        n
      ).changes, _ = c.run(
        `DELETE FROM message WHERE session_id IN (${r})`,
        n
      ).changes, S = c.run(
        `DELETE FROM session WHERE id IN (${r})`,
        n
      ).changes, m = c.vacuum();
      return {
        deletedSessions: S,
        deletedMessages: _,
        deletedParts: l,
        freedBytes: i,
        vacuumBefore: m.before,
        vacuumAfter: m.after
      };
    }
  );
}
function K() {
  u.handle(p.DASHBOARD_OVERVIEW, () => c.getStats()), u.handle(p.DASHBOARD_TOKENS, () => {
    const s = c.rawGet(
      `SELECT
        COALESCE(SUM(tokens_input), 0) as inputTokens,
        COALESCE(SUM(tokens_output), 0) as outputTokens,
        COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
        COALESCE(SUM(tokens_cache_read), 0) as cacheRead,
        COALESCE(SUM(tokens_cache_write), 0) as cacheWrite,
        COALESCE(SUM(cost), 0) as estimatedCost
      FROM session`
    ), e = (s == null ? void 0 : s.inputTokens) ?? 0, t = (s == null ? void 0 : s.cacheRead) ?? 0, o = e > 0 ? t / e * 100 : 0;
    return {
      inputTokens: e,
      outputTokens: (s == null ? void 0 : s.outputTokens) ?? 0,
      reasoningTokens: (s == null ? void 0 : s.reasoningTokens) ?? 0,
      cacheRead: t,
      cacheWrite: (s == null ? void 0 : s.cacheWrite) ?? 0,
      estimatedCost: (s == null ? void 0 : s.estimatedCost) ?? 0,
      cacheHitRate: Math.round(o * 100) / 100
    };
  }), u.handle(p.DASHBOARD_TOOL_RANKING, () => c.rawQuery(
    `SELECT
        COALESCE(json_extract(data, '$.tool'), 'unknown') as toolName,
        COUNT(*) as count
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
      GROUP BY toolName
      ORDER BY count DESC
      LIMIT 20`
  ).map((t) => ({
    toolName: t.toolName,
    count: t.count
  }))), u.handle(p.DASHBOARD_SKILL_USAGE, () => c.rawQuery(
    `SELECT
        COALESCE(json_extract(data, '$.state.input.name'), 'unknown') as skillName,
        COUNT(*) as count
      FROM part
      WHERE json_extract(data, '$.type') = 'tool'
        AND json_extract(data, '$.tool') = 'skill'
      GROUP BY skillName
      ORDER BY count DESC
      LIMIT 20`
  ).map((t) => ({
    skillName: t.skillName,
    count: t.count
  }))), u.handle(p.DASHBOARD_TRENDS, () => {
    const s = c.rawQuery(
      `SELECT
        date(time_created / 1000, 'unixepoch') as date,
        COUNT(*) as newSessions
      FROM session
      GROUP BY date
      ORDER BY date ASC`
    ), e = c.rawQuery(
      `SELECT
        date(time_created / 1000, 'unixepoch') as date,
        COUNT(*) as messageCount
      FROM message
      GROUP BY date
      ORDER BY date ASC`
    ), t = /* @__PURE__ */ new Map();
    for (const n of s) {
      const r = n.date;
      t.set(r, {
        date: r,
        newSessions: n.newSessions ?? 0,
        sizeGrowth: 0,
        messageCount: 0
      });
    }
    for (const n of e) {
      const r = n.date, i = t.get(r);
      i ? i.messageCount = n.messageCount ?? 0 : t.set(r, {
        date: r,
        newSessions: 0,
        sizeGrowth: 0,
        messageCount: n.messageCount ?? 0
      });
    }
    let o = 0;
    const a = [...t.keys()].sort();
    for (const n of a) {
      const r = t.get(n), i = c.rawGet(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) as total
        FROM part
        WHERE date(time_created / 1000, 'unixepoch') = ?`,
        [n]
      ), l = (i == null ? void 0 : i.total) ?? 0;
      o += l, r.sizeGrowth = o;
    }
    return a.map((n) => t.get(n));
  });
}
const T = E.join(b.homedir(), ".DBScope-OC", "backups");
function w() {
  d.existsSync(T) || d.mkdirSync(T, { recursive: !0 });
}
function Y() {
  w();
  const s = d.readdirSync(T), e = [];
  for (const t of s) {
    if (!t.endsWith(".db")) continue;
    const o = E.join(T, t);
    try {
      const a = d.statSync(o), n = t.match(/opencode-backup-(.+)\.db/), r = n ? (() => {
        const i = n[1], l = i.indexOf("T");
        if (l === -1) return a.mtime.toISOString();
        const _ = i.slice(0, l), m = i.slice(l + 1).split("-"), C = m.slice(0, 3).join(":"), O = m[3] || "000";
        return `${_}T${C}.${O}`;
      })() : a.mtime.toISOString();
      e.push({
        fileName: t,
        filePath: o,
        fileSize: a.size,
        createdAt: r,
        compressed: !1
      });
    } catch {
    }
  }
  return e.sort((t, o) => o.createdAt.localeCompare(t.createdAt));
}
function Q() {
  u.handle(p.BACKUP_CREATE, async () => {
    const s = c.getCurrentPath();
    if (!s)
      throw new Error("No database currently open");
    w();
    const t = `opencode-backup-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.db`, o = E.join(T, t);
    d.copyFileSync(s, o);
    const a = s + "-wal", n = s + "-shm";
    d.existsSync(a) && d.copyFileSync(a, o + "-wal"), d.existsSync(n) && d.copyFileSync(n, o + "-shm");
    const r = d.statSync(o);
    return {
      fileName: t,
      filePath: o,
      fileSize: r.size,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      compressed: !1
    };
  }), u.handle(p.BACKUP_LIST, () => Y()), u.handle(
    p.BACKUP_RESTORE,
    async (s, e) => {
      let t;
      if (e)
        t = e;
      else {
        const { canceled: o, filePaths: a } = await I.showOpenDialog({
          title: "Select Backup to Restore",
          filters: [{ name: "SQLite Database", extensions: ["db"] }],
          properties: ["openFile"]
        });
        if (o || a.length === 0) return { success: !1 };
        t = a[0];
      }
      if (!d.existsSync(t))
        throw new Error("Backup file not found");
      c.closeAll();
      try {
        return c.open(t), { success: !0, path: t };
      } catch (o) {
        return { success: !1, error: o.message };
      }
    }
  ), u.handle(
    p.BACKUP_DELETE,
    (s, e) => {
      const t = E.join(T, e), o = E.resolve(t);
      if (!o.startsWith(E.resolve(T)))
        throw new Error("Invalid backup file path");
      if (!d.existsSync(o))
        throw new Error("Backup file not found");
      d.unlinkSync(o);
      const a = o + "-wal", n = o + "-shm";
      return d.existsSync(a) && d.unlinkSync(a), d.existsSync(n) && d.unlinkSync(n), { success: !0 };
    }
  ), u.handle(
    p.BACKUP_PREVIEW,
    (s, e) => {
      const t = E.join(T, e), o = E.resolve(t);
      if (!o.startsWith(E.resolve(T)))
        throw new Error("Invalid backup file path");
      if (!d.existsSync(o))
        throw new Error("Backup file not found");
      const a = d.statSync(o), n = {
        fileName: e,
        filePath: o,
        fileSize: a.size,
        createdAt: a.mtime.toISOString(),
        compressed: !1
      };
      let r = 0, i = 0, l = 0;
      try {
        const S = new U(o, { readonly: !0 });
        try {
          r = S.prepare("SELECT COUNT(*) as cnt FROM session").get().cnt, i = S.prepare("SELECT COUNT(*) as cnt FROM message").get().cnt, l = S.prepare("SELECT COUNT(*) as cnt FROM part").get().cnt;
        } finally {
          S.close();
        }
      } catch {
      }
      return {
        ...n,
        sessionCount: r,
        messageCount: i,
        partCount: l
      };
    }
  );
}
const J = j(import.meta.url), B = E.dirname(J);
process.env.APP_ROOT = E.join(B, "..");
const k = process.env.VITE_DEV_SERVER_URL, ie = E.join(process.env.APP_ROOT, "dist-electron"), F = E.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = k ? E.join(process.env.APP_ROOT, "public") : F;
let L = null;
g.setName("DBScope-OC");
function D() {
  L = new M({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "DBScope-OC",
    icon: E.join(process.env.APP_ROOT, "build", "icon.icns"),
    webPreferences: {
      preload: E.join(B, "preload.cjs"),
      contextIsolation: !0,
      nodeIntegration: !1,
      sandbox: !1
    }
  }), k ? L.loadURL(k) : L.loadFile(E.join(F, "index.html")), L.on("closed", () => {
    L = null;
  });
}
function q() {
  u.handle(p.APP_GET_VERSION, () => g.getVersion()), u.handle(p.APP_GET_PLATFORM, () => process.platform), u.handle(p.DATABASE_OPEN, async (s, e) => {
    try {
      return c.open(e), { success: !0, path: e };
    } catch (t) {
      return { success: !1, error: t.message };
    }
  }), u.handle(p.DATABASE_HEALTH, () => {
    try {
      return c.healthCheck();
    } catch {
      return { ok: !1, pageCount: 0, freelistPages: 0, walSize: 0 };
    }
  }), u.handle(p.DATABASE_VACUUM, () => c.vacuum()), u.handle(p.DATABASE_CHECKPOINT, () => (c.checkpoint(), { success: !0 })), G(), W(), V(), K(), Q(), u.handle(p.DIALOG_OPEN_FILE, async () => {
    const s = await I.showOpenDialog(L, {
      properties: ["openFile"],
      filters: [{ name: "SQLite Database", extensions: ["db", "sqlite", "sqlite3"] }]
    });
    return s.canceled || s.filePaths.length === 0 ? null : s.filePaths[0];
  });
}
g.whenReady().then(() => {
  process.platform === "darwin" && g.dock.setIcon(E.join(process.env.APP_ROOT, "build", "icon.png")), g.setAboutPanelOptions({
    applicationName: "DBScope-OC",
    applicationVersion: g.getVersion(),
    credits: "by WEBB"
  }), D(), g.on("activate", () => {
    M.getAllWindows().length === 0 && D();
  }), q();
  const s = b.homedir(), e = E.join(s, ".local", "share", "opencode", "opencode.db"), t = E.join(process.env.APP_ROOT, "test-data", "test.db");
  if (d.existsSync(e))
    try {
      c.open(e);
    } catch {
    }
  else if (d.existsSync(t))
    try {
      c.open(t);
    } catch {
    }
});
g.on("window-all-closed", () => {
  process.platform !== "darwin" && g.quit();
});
g.on("before-quit", () => {
  c.closeAll();
});
export {
  ie as MAIN_DIST,
  F as RENDERER_DIST,
  k as VITE_DEV_SERVER_URL
};
