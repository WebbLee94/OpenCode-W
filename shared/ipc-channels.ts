// IPC channel name constants shared between main and renderer processes

// Query channels (read-only)
export const IPC_CHANNELS = {
  // Dashboard
  DASHBOARD_OVERVIEW: 'dashboard:overview',
  DASHBOARD_TOKENS: 'dashboard:tokens',
  DASHBOARD_TOOL_RANKING: 'dashboard:toolRanking',
  DASHBOARD_SKILL_USAGE: 'dashboard:skillUsage',
  DASHBOARD_MODEL_RANKING: 'dashboard:modelRanking',
  DASHBOARD_PROVIDER_STATS: 'dashboard:providerStats',
  DASHBOARD_SESSION_TREND: 'dashboard:sessionTrend',
  DASHBOARD_COST_TREND: 'dashboard:costTrend',
  DASHBOARD_MESSAGE_TREND: 'dashboard:messageTrend',

  // Sessions
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_DETAIL: 'sessions:detail',
  SESSIONS_PROJECTS: 'sessions:projects',
  SESSIONS_DELETE: 'sessions:delete',
  SESSIONS_CHILDREN: 'sessions:children',
  SESSIONS_RENAME: 'sessions:rename',

  // Messages
  MESSAGES_LIST: 'messages:list',
  MESSAGES_DETAIL: 'messages:detail',
  MESSAGES_LIST_BY_PARENT: 'messages:list-by-parent',
  MESSAGES_SEARCH: 'messages:search',

  // Operations
  CLEANUP_PREVIEW: 'cleanup:preview',
  CLEANUP_EXECUTE: 'cleanup:execute',
  DATABASE_VACUUM: 'database:vacuum',
  DATABASE_CHECKPOINT: 'database:checkpoint',
  DATABASE_OPEN: 'database:open',
  DATABASE_HEALTH: 'database:health',

  // Dialog
  DIALOG_OPEN_FILE: 'dialog:openFile',

  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',

  // Backup
  BACKUP_CREATE: 'backup:create',
  BACKUP_LIST: 'backup:list',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_DELETE: 'backup:delete',
  BACKUP_PREVIEW: 'backup:preview',

  // Todos — 仅保留会话详情页内嵌 Tab 所需的 by-parent
  TODOS_BY_PARENT: 'todos:by-parent',

  // Session Share — 仅保留会话详情页所需的单条查询
  SESSION_SHARE_GET: 'session-share:get',
} as const;
