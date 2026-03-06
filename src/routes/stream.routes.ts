/**
 * SSE streaming route — the main endpoint for Claude Agent interaction.
 *
 * POST /api/stream
 * Body: { sessionId, prompt, attachments?, options? }
 * Response: text/event-stream
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Options as SDKOptions, HookInput, PreToolUseHookInput, PreToolUseHookSpecificOutput, SyncHookJSONOutput, SubagentStartHookInput, SubagentStopHookInput, TeammateIdleHookInput, TaskCompletedHookInput } from '@anthropic-ai/claude-agent-sdk';
import { GLOBAL_SKILLS_DIR, BRIDGE_ROOT, MEMORY_DIR, SESSIONS_DIR, DATA_DIR, EVOLUTION_DIR, getClaudeCodeExecutablePath, type SessionManager } from '../services/session-manager.js';
import type { QueryRequest, SSEEvent, RawSDKMessage, RawContentBlock, Attachment, DelegationMode, DebateConfig, QueryMetrics } from '../types.js';
import type { EvolutionEngine } from '../services/evolution-engine.js';
import { transformSDKMessage, formatSSE, formatSSEDone } from '../utils/message-transform.js';
import { resolve, normalize } from 'path';
import type { SdkBridge } from '../services/sdk-bridge.js';

// Store active query references for abort support (with child process tracking)
interface ActiveQuery {
  abort: () => void;
  startTime: number;
}
const activeQueries = new Map<string, ActiveQuery>();

// Periodic stale query cleanup (queries stuck > 30 minutes)
const STALE_QUERY_TIMEOUT = 30 * 60_000;
// Busy session without active query — reset after 5 minutes
const ORPHAN_BUSY_TIMEOUT = 5 * 60_000;
let _staleCleanupSessionManager: SessionManager | null = null;

setInterval(() => {
  const now = Date.now();
  // 1. Clean up stale active queries
  for (const [id, query] of activeQueries) {
    if (now - query.startTime > STALE_QUERY_TIMEOUT) {
      console.warn(`[STALE_QUERY] Cleaning up stuck query for session ${id} (age: ${Math.round((now - query.startTime) / 60_000)}min)`);
      try { query.abort(); } catch {}
      activeQueries.delete(id);
      if (_staleCleanupSessionManager) {
        try { killChildClaude(console as any, id); } catch {}
        _staleCleanupSessionManager.markIdle(id);
      }
    }
  }
  // 2. Clean up orphaned busy sessions (no active query but still marked busy)
  if (_staleCleanupSessionManager) {
    for (const session of _staleCleanupSessionManager.list()) {
      if (session.status === 'busy' && !activeQueries.has(session.id)) {
        if (now - session.lastActiveAt > ORPHAN_BUSY_TIMEOUT) {
          console.warn(`[ORPHAN_BUSY] Session ${session.id} (${session.name}) stuck busy with no active query for ${Math.round((now - session.lastActiveAt) / 60_000)}min — resetting to idle`);
          try { killChildClaude(console as any, session.id); } catch {}
          _staleCleanupSessionManager.markIdle(session.id);
        }
      }
    }
  }
}, 60_000); // Check every minute

// ---------------------------------------------------------------------------
// Tool Observation Logger — append-only JSONL per session
// ---------------------------------------------------------------------------
const OBSERVATIONS_DIR = join(EVOLUTION_DIR, 'observations');
try { mkdirSync(OBSERVATIONS_DIR, { recursive: true }); } catch {}

interface ToolObservation {
  ts: number;
  tool: string;
  input: string;    // truncated summary
  decision: 'allow' | 'deny';
  error?: boolean;
  durationMs?: number;
}

function logObservation(sessionId: string, obs: ToolObservation): void {
  try {
    const file = join(OBSERVATIONS_DIR, `${sessionId}.jsonl`);
    appendFileSync(file, JSON.stringify(obs) + '\n');
  } catch {}
}

/**
 * Aggregate session observations into an Evolution Engine finding.
 * Called on session close. Returns null if no observations exist.
 */
export function aggregateSessionObservations(sessionId: string): {
  toolFrequency: Record<string, number>;
  denyCount: number;
  errorCount: number;
  totalCalls: number;
  topTools: string[];
  summary: string;
} | null {
  const file = join(OBSERVATIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(file)) return null;
  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const freq: Record<string, number> = {};
    let denyCount = 0;
    let errorCount = 0;
    for (const line of lines) {
      try {
        const obs: ToolObservation = JSON.parse(line);
        freq[obs.tool] = (freq[obs.tool] || 0) + 1;
        if (obs.decision === 'deny') denyCount++;
        if (obs.error) errorCount++;
      } catch {}
    }
    const topTools = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t}(${c})`);
    const summary = `会话 ${sessionId.slice(0, 8)} 共 ${lines.length} 次工具调用: ${topTools.join(', ')}` +
      (denyCount > 0 ? ` | ${denyCount} 次拒绝` : '') +
      (errorCount > 0 ? ` | ${errorCount} 次错误` : '');
    // Clean up observation file (ephemeral — aggregated data goes to Evolution)
    try { unlinkSync(file); } catch {}
    return { toolFrequency: freq, denyCount, errorCount, totalCalls: lines.length, topTools, summary };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Delegation Mode — strict mode disallowed tools (Team Lead only)
// ---------------------------------------------------------------------------
const DELEGATION_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

// ---------------------------------------------------------------------------
// Structured Execution Logger
// ---------------------------------------------------------------------------
type LogPhase =
  | 'QUERY_START' | 'SDK_INIT' | 'SDK_MSG'
  | 'TOOL_CALL' | 'TOOL_RESULT' | 'TOOL_DENIED' | 'TOOL_ALLOWED'
  | 'AGENT_SPAWN' | 'AGENT_DONE' | 'TEAM_CREATE' | 'TEAM_DELETE' | 'SEND_MESSAGE'
  | 'TASK_EVENT' | 'THINKING'
  | 'RESULT' | 'QUERY_END' | 'QUERY_ABORT' | 'QUERY_ERROR';

function execLog(
  log: import('fastify').FastifyBaseLogger,
  phase: LogPhase,
  sessionId: string,
  detail: Record<string, unknown> = {},
) {
  log.info({ sessionId, phase, ...detail }, `[${phase}]`);
}

/**
 * Kill claude SDK child processes spawned by this bridge server.
 *
 * SAFETY: Only targets direct child processes of the bridge server PID
 * via `pgrep -P`. Does NOT use broad pattern matching that could hit
 * the user's independent Claude Code terminals or other unrelated processes.
 */
function killChildClaude(log: import('fastify').FastifyBaseLogger, sessionId: string) {
  const serverPid = process.pid;
  try {
    // Step 1: Find direct children of bridge server that are node/claude processes
    // pgrep -P only returns direct children — safe, won't touch unrelated terminals
    const out = execSync(
      `pgrep -P ${serverPid} 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    if (!out) return;

    const childPids = out.split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
    if (childPids.length === 0) return;

    // Step 2: For each child, check if it's a claude SDK process (not tsx/node watcher)
    // We look at grandchildren too — SDK spawns node → claude chain
    const pidsToKill: number[] = [];
    for (const cpid of childPids) {
      try {
        const cmdline = execSync(
          `ps -o command= -p ${cpid} 2>/dev/null || true`,
          { encoding: 'utf8', timeout: 2000 },
        ).trim();
        // Only kill processes related to claude SDK query (not tsx watcher, not the bridge itself)
        if (cmdline && /claude/.test(cmdline) && !/tsx|claude-agent-bridge/.test(cmdline)) {
          pidsToKill.push(cpid);
        }
        // Also check grandchildren of this child (SDK may spawn sub-processes)
        const grandOut = execSync(
          `pgrep -P ${cpid} 2>/dev/null || true`,
          { encoding: 'utf8', timeout: 2000 },
        ).trim();
        if (grandOut) {
          for (const gp of grandOut.split('\n')) {
            const gpid = parseInt(gp.trim(), 10);
            if (!isNaN(gpid) && gpid > 0) pidsToKill.push(gpid);
          }
        }
      } catch { /* skip */ }
    }

    if (pidsToKill.length === 0) return;

    log.info({ sessionId, pidsToKill }, '[PROCESS_CLEANUP] Sending SIGTERM to SDK child processes');
    for (const pid of pidsToKill) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }

    // Wait 2s then SIGKILL any survivors
    setTimeout(() => {
      for (const pid of pidsToKill) {
        try {
          process.kill(pid, 0); // check if still alive
          log.warn({ sessionId, pid }, '[PROCESS_CLEANUP] Force-killing surviving process');
          process.kill(pid, 'SIGKILL');
        } catch { /* already dead — good */ }
      }
    }, 2000);
  } catch (err) {
    log.warn({ sessionId, err }, '[PROCESS_CLEANUP] Failed to enumerate child processes');
  }
}

// Module-level reference set by registerStreamRoutes
let _evolutionEngine: EvolutionEngine | null = null;

export function registerStreamRoutes(
  app: FastifyInstance,
  bridge: SdkBridge,
  sessionManager: SessionManager,
  evolutionEngine?: EvolutionEngine,
) {
  _evolutionEngine = evolutionEngine ?? null;
  _staleCleanupSessionManager = sessionManager;
  /**
   * SSE streaming — directly invokes SDK query and pipes to response.
   */
  app.post<{ Body: QueryRequest }>('/api/stream', (request, reply: FastifyReply) => {
    const { sessionId, prompt, attachments, options } = request.body ?? {};

    if (!sessionId || !prompt) {
      reply.code(400).send({ error: 'sessionId and prompt are required' });
      return;
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      reply.code(404).send({ error: `Session not found: ${sessionId}` });
      return;
    }

    if (session.status === 'busy') {
      reply.code(409).send({ error: 'Session is busy' });
      return;
    }

    reply.hijack();
    const res = reply.raw;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': request.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
    });

    let aborted = false;
    request.raw.on('close', () => {
      aborted = true;
    });

    // Save attachments to data dir and augment prompt
    const uploadDir = sessionManager.getUploadDir(sessionId);
    const { prompt: finalPrompt, savedFiles } = saveAttachmentsAndAugmentPrompt(prompt, attachments, uploadDir, request.log);

    // Emit upload_complete event so frontend can store server URLs
    if (savedFiles.length > 0) {
      res.write(formatSSE({
        type: 'status' as SSEEvent['type'],
        data: {
          status: 'uploads_saved',
          files: savedFiles.map(f => ({ url: f.url, mediaType: f.mediaType, filename: f.filename, size: f.size })),
        },
        timestamp: Date.now(),
      }));
    }

    runStreamQuery(sessionId, finalPrompt, options, sessionManager, res, aborted, request.log)
      .catch((err) => {
        request.log.error(err, 'Stream query fatal error');
        // Safety net: ensure session is not stuck in busy if runStreamQuery rejects
        // without reaching its own finally block
        sessionManager.markIdle(sessionId);
      });
  });

  /** Abort a running query — also kills child claude processes */
  app.post<{ Params: { id: string } }>('/api/session/:id/abort', async (request, reply) => {
    const { id } = request.params;
    const active = activeQueries.get(id);
    if (active) {
      execLog(request.log, 'QUERY_ABORT', id, { reason: 'user_initiated' });

      // 1. Signal SDK to stop
      active.abort();

      // 2. Kill SDK child processes (only direct children of bridge, safe)
      killChildClaude(request.log, id);

      // 3. Clean up session state
      activeQueries.delete(id);
      sessionManager.markIdle(id);

      return reply.send({ ok: true, message: 'Query aborted and processes cleaned up' });
    }

    // Safety net: no active query but session still busy — force reset to idle
    const session = sessionManager.get(id);
    if (session && session.status === 'busy') {
      sessionManager.markIdle(id);
      return reply.send({ ok: true, message: 'No active query found; session reset from stuck busy to idle' });
    }

    return reply.code(404).send({ error: 'No active query for this session' });
  });

  /**
   * Plan approval — approve or provide feedback on a plan-first query.
   * POST /api/session/:id/plan-approve
   * Body: { approved: boolean, feedback?: string, originalPrompt: string }
   */
  app.post<{
    Params: { id: string };
    Body: { approved: boolean; feedback?: string; originalPrompt: string };
  }>('/api/session/:id/plan-approve', (request, reply: FastifyReply) => {
    const { id } = request.params;
    const { approved, feedback, originalPrompt } = request.body ?? {};

    const session = sessionManager.get(id);
    if (!session) {
      reply.code(404).send({ error: `Session not found: ${id}` });
      return;
    }
    if (session.status === 'busy') {
      reply.code(409).send({ error: 'Session is busy' });
      return;
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': request.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
    });

    let aborted = false;
    request.raw.on('close', () => { aborted = true; });

    if (approved) {
      // User approved — re-run with original prompt in normal (non-plan) mode
      const execPrompt = 'Approved. Proceed with the plan you just created.';
      runStreamQuery(id, execPrompt, {
        ...({} as QueryRequest['options']),
        planApproved: true,
      }, sessionManager, res, aborted, request.log)
        .catch((err) => { request.log.error(err, 'Plan-approve execute error'); sessionManager.markIdle(id); });
    } else {
      // User provided feedback — re-run in plan mode with feedback
      const feedbackPrompt = feedback
        ? `根据以下反馈修改你的计划:\n\n${feedback}`
        : '请重新制定计划。';
      runStreamQuery(id, feedbackPrompt, {}, sessionManager, res, aborted, request.log)
        .catch((err) => { request.log.error(err, 'Plan-approve feedback error'); sessionManager.markIdle(id); });
    }
  });

  /** Debug: test SSE mechanism */
  app.get('/api/stream/test', (_request, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let i = 0;
    const interval = setInterval(() => {
      if (i >= 3) {
        clearInterval(interval);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: {"type":"text","data":{"text":"chunk ${i}"},"timestamp":${Date.now()}}\n\n`);
      i++;
    }, 500);
  });

  /**
   * Non-streaming query — waits for SDK to finish, returns all events.
   */
  app.post<{ Body: QueryRequest }>('/api/query', async (request, reply) => {
    const { sessionId, prompt, attachments, options } = request.body;

    if (!sessionId || !prompt) {
      return reply.code(400).send({ error: 'sessionId and prompt are required' });
    }

    const session = sessionManager.get(sessionId);
    if (!session) {
      return reply.code(404).send({ error: `Session not found: ${sessionId}` });
    }

    const uploadDir2 = sessionManager.getUploadDir(sessionId);
    const { prompt: finalPrompt } = saveAttachmentsAndAugmentPrompt(prompt, attachments, uploadDir2, request.log);

    const events: SSEEvent[] = [];
    try {
      for await (const event of bridge.executeQuery(sessionId, finalPrompt, options)) {
        events.push(event);
      }
      return reply.send({ events });
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : 'Query failed',
      });
    }
  });
}

interface SavedFile {
  filePath: string;
  filename: string;
  /** URL path for frontend: /api/uploads/{sessionId}/{filename} */
  url: string;
  mediaType: string;
  size: number;
}

/**
 * Save base64 attachments to data dir and return augmented prompt + file metadata.
 * Claude Code can read these files via its multimodal Read tool.
 */
function saveAttachmentsAndAugmentPrompt(
  prompt: string,
  attachments: Attachment[] | undefined,
  uploadDir: string,
  log: import('fastify').FastifyBaseLogger,
): { prompt: string; savedFiles: SavedFile[] } {
  if (!attachments?.length) return { prompt, savedFiles: [] };

  try {
    mkdirSync(uploadDir, { recursive: true });
  } catch {
    log.warn('Could not create upload directory');
  }

  // Extract sessionId from uploadDir path (last segment)
  const sessionId = uploadDir.split('/').pop() || '';
  const savedFiles: SavedFile[] = [];

  for (const att of attachments) {
    const safeFilename = `${Date.now()}-${att.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = join(uploadDir, safeFilename);

    try {
      const buf = Buffer.from(att.base64, 'base64');
      writeFileSync(filePath, buf);
      savedFiles.push({
        filePath,
        filename: safeFilename,
        url: `/api/uploads/${sessionId}/${safeFilename}`,
        mediaType: att.mediaType,
        size: buf.length,
      });
      log.info({ filePath, size: buf.length, type: att.mediaType }, 'Attachment saved');
    } catch (err) {
      log.error(err, `Failed to save attachment: ${att.filename}`);
    }
  }

  if (savedFiles.length === 0) return { prompt, savedFiles: [] };

  // Build augmented prompt — instruct Claude to read the files
  const imageFiles = savedFiles.filter((f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f.filename));
  const otherFiles = savedFiles.filter((f) => !/\.(jpg|jpeg|png|gif|webp)$/i.test(f.filename));

  let augmentation = '';
  if (imageFiles.length > 0) {
    augmentation += `\n\n[Uploaded Images: ${imageFiles.length}]\n${imageFiles.map((f) => `  - ${f.filePath}`).join('\n')}`;
  }
  if (otherFiles.length > 0) {
    augmentation += `\n\n[Uploaded Files: ${otherFiles.length}]\n${otherFiles.map((f) => `  - ${f.filePath}`).join('\n')}`;
  }

  return { prompt: prompt + augmentation, savedFiles };
}

// ---------------------------------------------------------------------------
// Memory Layer Loader (with mtime-based caching)
// ---------------------------------------------------------------------------
const GLOBAL_MEMORY_FILES = ['SOUL.md', 'IDENTITY.md', 'STYLE.md', 'USER.md', 'CLAUDE.md', 'KNOWLEDGE.md'] as const;
const MEMORY_SECTION_NAMES: Record<string, string> = {
  'SOUL.md': 'SOUL',
  'IDENTITY.md': 'IDENTITY',
  'STYLE.md': 'STYLE',
  'USER.md': 'USER',
  'CLAUDE.md': 'CLAUDE',
  'KNOWLEDGE.md': 'KNOWLEDGE',
};
const MAX_MEMORY_CHARS = 8000; // ~2000 tokens per file
const MAX_CLAUDE_MD_CHARS = 16000; // CLAUDE.md gets higher limit (~4000 tokens) — it's the core ruleset

// --- File content cache keyed by path, invalidated by mtime ---
interface CachedFile { content: string; mtimeMs: number; }
const fileCache = new Map<string, CachedFile>();

function readCached(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.content;
    const content = readFileSync(filePath, 'utf-8').trim();
    fileCache.set(filePath, { content, mtimeMs: st.mtimeMs });
    return content;
  } catch { return null; }
}

// --- Skill directory cache (invalidated every 30s or on mtime change) ---
interface SkillCache { names: string[]; timestamp: number; mtimeMs: number; }
let skillCache: SkillCache | null = null;
const SKILL_CACHE_TTL = 30_000; // 30 seconds

function loadSkillNames(globalSkillsPath: string, projectSkillsPath: string): string[] {
  // Check global skills dir mtime for cache invalidation
  let dirMtime = 0;
  try { dirMtime = statSync(globalSkillsPath).mtimeMs; } catch {}

  const now = Date.now();
  if (skillCache && skillCache.mtimeMs === dirMtime && (now - skillCache.timestamp) < SKILL_CACHE_TTL) {
    return skillCache.names;
  }

  const names: string[] = [];
  if (existsSync(globalSkillsPath)) {
    try {
      for (const d of readdirSync(globalSkillsPath, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(globalSkillsPath, d.name, 'SKILL.md'))) {
          names.push(d.name);
        }
      }
    } catch {}
  }
  if (existsSync(projectSkillsPath)) {
    try {
      for (const d of readdirSync(projectSkillsPath, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(projectSkillsPath, d.name, 'SKILL.md'))) {
          names.push(d.name);
        }
      }
    } catch {}
  }
  skillCache = { names, timestamp: now, mtimeMs: dirMtime };
  return names;
}

// --- Memory System instructions (compact, pre-built once) ---
const MEMORY_SYSTEM_BASE = `\n\n[Memory System]\n` +
  `记忆文件是跨会话连续性。主动记住重要的事，先回答用户再静默写入。\n\n` +
  `**三层架构:**\n` +
  `- L1 身份 (${MEMORY_DIR}/): USER.md(偏好) SOUL.md(人格) IDENTITY.md(身份) STYLE.md(风格) CLAUDE.md(规则)\n` +
  `- L2 知识 (KNOWLEDGE.md): 成功模式/踩坑/方案。自主迭代: ⚠️→✅→✅常用, ❌直接删\n` +
  `- L3 会话 ({{SESSION_MEM_PATH}}): 临时决策/线索，会话关闭删除\n\n` +
  `**判断**: "明天还需要?" → 是=L1/L2, 否=L3。写入前 Read 现有内容，用 Edit 追加`;

/**
 * Load memory layers with conditional loading:
 * - Global memory files: always loaded (mtime-cached)
 * - DEBATE_RULES.md: only loaded when useAgentTeams=true
 * - Session memory: always loaded (not cached, changes frequently)
 * - Memory system instructions: pre-built constant
 */
function loadMemoryLayers(sessionId: string, useAgentTeams = false): string {
  let layers = '';

  // Global memory files (mtime-cached — stat is ~100x cheaper than readFile)
  for (const file of GLOBAL_MEMORY_FILES) {
    const filePath = join(MEMORY_DIR, file);
    let content = readCached(filePath);
    if (!content) continue;
    const limit = file === 'CLAUDE.md' ? MAX_CLAUDE_MD_CHARS : MAX_MEMORY_CHARS;
    if (content.length > limit) {
      content = content.slice(0, limit) + '\n... (truncated)';
    }
    const section = MEMORY_SECTION_NAMES[file] || file;
    layers += `\n\n[${section}]\n${content}`;
  }

  // Debate rules — only loaded when Agent Teams / debate mode is active
  if (useAgentTeams) {
    const debatePath = join(MEMORY_DIR, 'DEBATE_RULES.md');
    let debateContent = readCached(debatePath);
    if (debateContent) {
      if (debateContent.length > MAX_CLAUDE_MD_CHARS) {
        debateContent = debateContent.slice(0, MAX_CLAUDE_MD_CHARS) + '\n... (truncated)';
      }
      layers += `\n\n[DEBATE_RULES]\n${debateContent}`;
    }
  }

  // Session-level memory (not cached — changes frequently during queries)
  try {
    const sessionMemPath = join(SESSIONS_DIR, `${sessionId}.memory.md`);
    if (existsSync(sessionMemPath)) {
      let content = readFileSync(sessionMemPath, 'utf-8').trim();
      if (content) {
        if (content.length > MAX_MEMORY_CHARS) {
          content = content.slice(0, MAX_MEMORY_CHARS) + '\n... (truncated)';
        }
        layers += `\n\n[SESSION_MEMORY]\n${content}`;
      }
    }
  } catch {}

  // Memory system instructions (pre-built constant, only replace session path)
  const sessionMemPath = join(SESSIONS_DIR, `${sessionId}.memory.md`);
  layers += MEMORY_SYSTEM_BASE.replace('{{SESSION_MEM_PATH}}', sessionMemPath);

  return layers;
}

/**
 * Run the SDK query and write SSE events to the raw HTTP response.
 */
async function runStreamQuery(
  sessionId: string,
  prompt: string,
  options: QueryRequest['options'],
  sessionManager: SessionManager,
  res: import('http').ServerResponse,
  aborted: boolean,
  log: import('fastify').FastifyBaseLogger,
) {
  const session = sessionManager.getOrThrow(sessionId);
  sessionManager.markBusy(sessionId);
  sessionManager.addHistory(sessionId, { role: 'user', content: prompt, timestamp: Date.now() });

  // Dynamic import of SDK
  let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
  } catch {
    const errEvent = formatSSE({
      type: 'error',
      data: { message: 'Failed to load @anthropic-ai/claude-agent-sdk' },
      timestamp: Date.now(),
    });
    if (!res.destroyed) {
      try { res.write(errEvent); res.write(formatSSEDone()); res.end(); } catch {}
    }
    sessionManager.markIdle(sessionId);
    return;
  }

  // Build clean env
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  // Redirect SDK config dir to bridge data directory (teams, tasks, etc.)
  cleanEnv.CLAUDE_CONFIG_DIR = DATA_DIR;

  // Model channel routing — override API key/base URL for non-default providers
  const effectiveModel = options?.model ?? session.model;
  const modelChannel = sessionManager.resolveModelChannel(effectiveModel);
  if (modelChannel) {
    cleanEnv.ANTHROPIC_API_KEY = modelChannel.apiKey;
    cleanEnv.ANTHROPIC_BASE_URL = modelChannel.baseUrl;
  }

  // Enable Agent Teams
  const useAgentTeams = options?.enableAgentTeams ?? session.agentTeamsEnabled;
  if (useAgentTeams) {
    cleanEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  }

  // AbortController for interrupt support
  const abortController = new AbortController();
  const queryStartTime = Date.now();
  activeQueries.set(sessionId, {
    abort: () => abortController.abort(),
    startTime: queryStartTime,
  });

  // Build SDK options with ALL capabilities
  // Agent Teams (especially debates) need more turns: main agent + N sub-agents each use turns
  const baseMaxTurns = options?.maxTurns ?? session.maxTurns ?? 80;
  const effectiveMaxTurns = useAgentTeams ? Math.max(baseMaxTurns, baseMaxTurns * 3) : baseMaxTurns;
  const sdkOptions: SDKOptions = {
    permissionMode: (options?.permissionMode ?? session.permissionMode) as SDKOptions['permissionMode'],
    cwd: session.cwd,
    maxTurns: effectiveMaxTurns,
    includePartialMessages: true,
    model: options?.model ?? session.model,
    env: cleanEnv,
    tools: { type: 'preset', preset: 'claude_code' },
    abortController,
    pathToClaudeCodeExecutable: getClaudeCodeExecutablePath(),
  };

  // System prompt
  const sysPrompt = options?.systemPrompt ?? session.systemPrompt;
  if (sysPrompt) {
    sdkOptions.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: sysPrompt,
    };
  }

  // Thinking mode
  const thinkingMode = options?.thinkingMode ?? session.thinkingMode;
  if (thinkingMode) {
    switch (thinkingMode) {
      case 'adaptive':
        sdkOptions.thinking = { type: 'adaptive' };
        break;
      case 'enabled':
        sdkOptions.thinking = { type: 'enabled' };
        break;
      case 'disabled':
        sdkOptions.thinking = { type: 'disabled' };
        break;
    }
  }

  // Effort level
  const effort = options?.effort ?? session.effort;
  if (effort) {
    sdkOptions.effort = effort as SDKOptions['effort'];
  }

  // Max budget
  const maxBudget = options?.maxBudgetUsd ?? session.maxBudgetUsd;
  if (maxBudget && maxBudget > 0) {
    sdkOptions.maxBudgetUsd = maxBudget;
  }

  // Additional directories — always include global skills dir, bridge root, and data dir for memory access
  sdkOptions.additionalDirectories = [
    ...(session.additionalDirectories || []),
    GLOBAL_SKILLS_DIR,
    BRIDGE_ROOT,
    DATA_DIR,
  ];

  // Load enabled MCP servers and inject into SDK options
  const mcpServers = sessionManager.loadMcpServers();
  const enabledMcpServers = mcpServers.filter(s => s.enabled);
  if (enabledMcpServers.length > 0) {
    const mcpConfig: Record<string, unknown> = {};
    for (const s of enabledMcpServers) {
      if (s.transport === 'stdio') {
        mcpConfig[s.name] = { type: 'stdio', command: s.command!, args: s.args, env: s.env };
      } else if (s.transport === 'sse') {
        mcpConfig[s.name] = { type: 'sse', url: s.url!, headers: s.headers };
      } else if (s.transport === 'http') {
        mcpConfig[s.name] = { type: 'http', url: s.url!, headers: s.headers };
      }
    }
    (sdkOptions as Record<string, unknown>).mcpServers = mcpConfig;
  }

  // Preload installed skill names (mtime-cached, refreshes every 30s)
  const globalSkillsPath = join(GLOBAL_SKILLS_DIR, '.claude', 'skills');
  const projectSkillsPath = join(session.cwd, '.claude', 'skills');
  const skillNames = loadSkillNames(globalSkillsPath, projectSkillsPath);
  // Build system prompt additions: dynamic paths + skill catalog
  // (Static rules are in memory/CLAUDE.md, loaded by loadMemoryLayers)
  let promptAdditions = `\n\n[Bridge Environment]\n` +
    `Bridge root: ${BRIDGE_ROOT}\n` +
    `Bridge node_modules: ${BRIDGE_ROOT}/node_modules\n` +
    `Session working directory: ${session.cwd}`;

  if (skillNames.length > 0) {
    // Try to preload skills via SDK (type not exported but runtime may support)
    (sdkOptions as Record<string, unknown>).skills = skillNames;

    // Compact skill listing: names only (Read SKILL.md on demand for details)
    promptAdditions += `\n\n[Installed Skills] (${skillNames.length} skills)\n` +
      `Directory: ${globalSkillsPath}\n` +
      `Names: ${skillNames.join(', ')}\n` +
      `Usage: Read <skill-dir>/SKILL.md for instructions before executing any skill.`;
  }

  // Progressive disclosure: knowledge base discovery hint (not content dump)
  promptAdditions += `\n\n[Knowledge Base]\n` +
    `The bridge knowledge directory (${GLOBAL_SKILLS_DIR}) contains additional resources:\n` +
    `- agents/: Agent role definitions (Glob + Read on demand)\n` +
    `- .claude/commands/: Slash command definitions (Glob + Read on demand)\n` +
    `When users ask about available agents, commands, or bridge capabilities, search these directories instead of guessing.`;

  // Elicitation guidance: encourage structured questioning during planning
  promptAdditions += `\n\n[Elicitation]\n` +
    `When a task is ambiguous or has multiple possible approaches, use the AskUserQuestion tool to clarify before proceeding. ` +
    `This is especially valuable during plan mode — ask structured questions with concrete options rather than open-ended text.`;

  // Load memory layers (global + session)
  const memoryLayers = loadMemoryLayers(sessionId, useAgentTeams);
  if (memoryLayers) {
    promptAdditions += memoryLayers;
  }

  if (sdkOptions.systemPrompt && typeof sdkOptions.systemPrompt === 'object') {
    const sp = sdkOptions.systemPrompt as { type: string; preset: string; append?: string };
    sp.append = (sp.append || '') + promptAdditions;
  } else {
    sdkOptions.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: promptAdditions,
    };
  }

  // Allowed/disallowed tools
  // Always auto-allow read-oriented and utility tools so they don't get
  // blocked by permissionMode in non-interactive bridge mode.
  // Write tools (Edit/Write/NotebookEdit) are guarded by canUseTool below.
  // Progressive disclosure: Team tools only exposed when Agent Teams is active,
  // reducing decision complexity for single-agent queries (~20 → ~17 tools).
  const baseAllowed = [
    'Read', 'Glob', 'Grep', 'Bash',
    'WebSearch', 'WebFetch',
    'Agent', 'AskUserQuestion',
    'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
    ...(useAgentTeams ? ['TeamCreate', 'TeamDelete', 'SendMessage'] : []),
    'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree',
    'Edit', 'Write', 'NotebookEdit', // allowed here, restricted by canUseTool
  ];
  const mergedAllowed = [...new Set([...baseAllowed, ...(options?.allowedTools || [])])];
  sdkOptions.allowedTools = mergedAllowed;

  if (options?.disallowedTools?.length) {
    sdkOptions.disallowedTools = options.disallowedTools;
  }

  // Permission guard: write operations restricted to cwd + additionalDirectories;
  // read operations allowed everywhere.
  const allowedDirs = [
    normalize(resolve(session.cwd)),
    ...(session.additionalDirectories || []).map(d => normalize(resolve(d))),
    normalize(resolve(GLOBAL_SKILLS_DIR)),
    normalize(resolve(BRIDGE_ROOT)),
    normalize(resolve(DATA_DIR)),
  ];

  const homeDir = process.env.HOME || '/tmp';

  function expandPath(p: string): string {
    // Expand ~ to home directory, strip quotes
    const cleaned = p.replace(/^["']|["']$/g, '');
    return cleaned.startsWith('~') ? cleaned.replace(/^~/, homeDir) : cleaned;
  }

  function isPathAllowed(filePath: string): boolean {
    const norm = normalize(resolve(expandPath(filePath)));
    return allowedDirs.some(dir => norm === dir || norm.startsWith(dir + '/'));
  }

  // Detect Bash commands that write to paths outside allowed directories
  function checkBashWrite(command: string): string | null {
    const WRITE_CMDS = /\b(cp|mv|install|rsync)\s/;
    const CREATE_CMDS = /\b(mkdir|touch|rm|rmdir|unlink)\s/;
    // Match > or >> including at start of command (lookbehind for non->)
    const REDIRECT = /(?:^|[^>])>{1,2}\s*([^\s;&|]+)/;
    const TEE_CMD = /\btee\s+(?:-a\s+)?([^\s;&|]+)/;

    // Safe targets that should always be allowed (standard Unix devices, temp dirs)
    const SAFE_TARGETS = ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/tmp/', '/private/tmp/'];
    function isSafeTarget(target: string): boolean {
      const expanded = expandPath(target);
      return SAFE_TARGETS.some(safe => expanded === safe || expanded.startsWith(safe));
    }

    // Check redirections: > file, >> file
    const redirMatch = command.match(REDIRECT);
    if (redirMatch) {
      const target = redirMatch[1];
      if (target && !isSafeTarget(target) && !isPathAllowed(target)) {
        return `重定向目标 ${target} 不在授权目录内`;
      }
    }

    // Check tee
    const teeMatch = command.match(TEE_CMD);
    if (teeMatch) {
      const target = teeMatch[1];
      if (target && !isSafeTarget(target) && !isPathAllowed(target)) {
        return `tee 目标 ${target} 不在授权目录内`;
      }
    }

    // Check cp/mv/install/rsync — last argument is usually the destination
    if (WRITE_CMDS.test(command)) {
      const segments = command.split(/[|;&]+/);
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!WRITE_CMDS.test(trimmed)) continue;
        const parts = trimmed.split(/\s+/).filter(p => !p.startsWith('-'));
        if (parts.length >= 3) {
          const dest = parts[parts.length - 1];
          if (!isSafeTarget(dest) && !isPathAllowed(dest)) {
            return `${parts[0]} 目标 ${dest} 不在授权目录内`;
          }
        }
      }
    }

    // Check mkdir/touch/rm — all arguments are targets
    if (CREATE_CMDS.test(command)) {
      const segments = command.split(/[|;&]+/);
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!CREATE_CMDS.test(trimmed)) continue;
        const parts = trimmed.split(/\s+/).filter(p => !p.startsWith('-'));
        for (let i = 1; i < parts.length; i++) {
          if (!isSafeTarget(parts[i]) && !isPathAllowed(parts[i])) {
            return `${parts[0]} 目标 ${parts[i]} 不在授权目录内`;
          }
        }
      }
    }

    return null; // no violation detected
  }

  // PreToolUse hook — runs at CLI level, NOT bypassed by allowedTools
  sdkOptions.hooks = {
    ...sdkOptions.hooks,
    PreToolUse: [{
      hooks: [async (input: HookInput) => {
        const hookInput = input as PreToolUseHookInput;
        const toolName = hookInput.tool_name;
        const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;

        // Block access to ~/.claude/ — not relevant to Bridge sessions
        const homeDotClaude = join(process.env.HOME || '/Users/apple', '.claude');
        const checkPathBlocked = (p: string | undefined): boolean => {
          if (!p) return false;
          const abs = normalize(resolve(p));
          return abs.startsWith(normalize(homeDotClaude));
        };

        if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
          const targetPath = (toolInput.file_path ?? toolInput.path) as string | undefined;
          if (checkPathBlocked(targetPath)) {
            const reason = `访问被拒绝: ~/.claude/ 不在 Bridge 授权范围内`;
            execLog(log, 'TOOL_DENIED', sessionId, { toolName, targetPath, reason });
            logObservation(sessionId, { ts: Date.now(), tool: toolName, input: targetPath ?? '', decision: 'deny' });
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: reason,
              },
            } satisfies SyncHookJSONOutput;
          }
        }

        // Edit/Write/NotebookEdit: check file path
        if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
          const filePath = (toolInput.file_path ?? toolInput.notebook_path) as string | undefined;
          if (filePath) {
            const normFilePath = normalize(resolve(expandPath(filePath)));
            const sessionsNorm = normalize(resolve(SESSIONS_DIR));
            // In sessions dir, only allow writing .memory.md files
            if (normFilePath.startsWith(sessionsNorm + '/') && !normFilePath.endsWith('.memory.md')) {
              const reason = `写入被拒绝: sessions 目录下只允许写 .memory.md 文件`;
              execLog(log, 'TOOL_DENIED', sessionId, { toolName, filePath, reason });
              logObservation(sessionId, { ts: Date.now(), tool: toolName, input: filePath ?? '', decision: 'deny' });
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: reason,
                },
              } satisfies SyncHookJSONOutput;
            }
            if (!isPathAllowed(filePath)) {
              const reason = `编辑被拒绝: ${filePath} 不在授权目录内 (${allowedDirs.join(', ')})`;
              execLog(log, 'TOOL_DENIED', sessionId, { toolName, filePath, reason });
              logObservation(sessionId, { ts: Date.now(), tool: toolName, input: filePath ?? '', decision: 'deny' });
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: reason,
                },
              } satisfies SyncHookJSONOutput;
            }
          }
        }

        // Bash: check for write operations targeting paths outside allowed dirs
        if (toolName === 'Bash') {
          const command = toolInput.command as string | undefined;
          if (command) {
            const violation = checkBashWrite(command);
            if (violation) {
              const reason = `Bash 写入被拒绝: ${violation} — 授权目录: ${allowedDirs.join(', ')}`;
              execLog(log, 'TOOL_DENIED', sessionId, { toolName, command: command.slice(0, 300), reason });
              logObservation(sessionId, { ts: Date.now(), tool: toolName, input: command.slice(0, 200), decision: 'deny' });
              return {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'deny' as const,
                  permissionDecisionReason: reason,
                },
              } satisfies SyncHookJSONOutput;
            }
          }
        }

        // Allow everything else
        execLog(log, 'TOOL_ALLOWED', sessionId, { toolName });
        // Observe tool call (async, non-blocking)
        const inputSummary = toolName === 'Bash'
          ? (toolInput.command as string ?? '').slice(0, 200)
          : Object.entries(toolInput).map(([k, v]) => `${k}:${typeof v === 'string' ? v.slice(0, 80) : typeof v}`).join('; ').slice(0, 200);
        logObservation(sessionId, { ts: Date.now(), tool: toolName, input: inputSummary, decision: 'allow' });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
          },
        } satisfies SyncHookJSONOutput;
      }],
    }],
  };

  // ---- SDK Hooks: Agent Teams lifecycle (SubagentStart/Stop, TeammateIdle, TaskCompleted) ----
  if (useAgentTeams) {
    sdkOptions.hooks = {
      ...sdkOptions.hooks,
      SubagentStart: [{
        hooks: [async (input: HookInput) => {
          const hi = input as SubagentStartHookInput;
          execLog(log, 'AGENT_SPAWN', sessionId, {
            source: 'SubagentStart_hook',
            agentId: hi.agent_id,
            agentType: hi.agent_type,
          });
          if (!aborted && !res.destroyed) {
            safeWrite(formatSSE({
              type: 'subagent_lifecycle',
              data: {
                hook: 'SubagentStart',
                agentId: hi.agent_id,
                agentType: hi.agent_type,
              },
              timestamp: Date.now(),
            }));
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'SubagentStart' as const,
            },
          };
        }],
      }],
      SubagentStop: [{
        hooks: [async (input: HookInput) => {
          const hi = input as SubagentStopHookInput;
          execLog(log, 'AGENT_DONE', sessionId, {
            source: 'SubagentStop_hook',
            agentId: hi.agent_id,
            agentType: hi.agent_type,
            transcriptPath: hi.agent_transcript_path,
          });
          if (!aborted && !res.destroyed) {
            safeWrite(formatSSE({
              type: 'subagent_lifecycle',
              data: {
                hook: 'SubagentStop',
                agentId: hi.agent_id,
                agentType: hi.agent_type,
                transcriptPath: hi.agent_transcript_path,
              },
              timestamp: Date.now(),
            }));
          }
          return { continue: true };
        }],
      }],
      TeammateIdle: [{
        hooks: [async (input: HookInput) => {
          const hi = input as TeammateIdleHookInput;
          execLog(log, 'SDK_MSG', sessionId, {
            source: 'TeammateIdle_hook',
            teammateName: hi.teammate_name,
            teamName: hi.team_name,
          });
          if (!aborted && !res.destroyed) {
            safeWrite(formatSSE({
              type: 'subagent_lifecycle',
              data: {
                hook: 'TeammateIdle',
                teammateName: hi.teammate_name,
                teamName: hi.team_name,
              },
              timestamp: Date.now(),
            }));
          }
          return { continue: true };
        }],
      }],
      TaskCompleted: [{
        hooks: [async (input: HookInput) => {
          const hi = input as TaskCompletedHookInput;
          execLog(log, 'TASK_EVENT', sessionId, {
            source: 'TaskCompleted_hook',
            taskId: hi.task_id,
            taskSubject: hi.task_subject,
            teammateName: hi.teammate_name,
            teamName: hi.team_name,
          });
          if (!aborted && !res.destroyed) {
            safeWrite(formatSSE({
              type: 'subagent_lifecycle',
              data: {
                hook: 'TaskCompleted',
                taskId: hi.task_id,
                taskSubject: hi.task_subject,
                teammateName: hi.teammate_name,
                teamName: hi.team_name,
              },
              timestamp: Date.now(),
            }));
          }
          return { continue: true };
        }],
      }],
    };
  }

  // ---- Delegation Mode: restrict Team Lead tools ----
  const delegationMode: DelegationMode = (options?.delegationMode ?? session.delegationMode) || 'off';
  const debateConfig: DebateConfig | undefined = options?.debateConfig ?? session.debateConfig;

  if (delegationMode === 'strict' && useAgentTeams) {
    // In strict mode, disallow write tools for Team Lead
    const existingDisallowed = sdkOptions.disallowedTools ?? [];
    sdkOptions.disallowedTools = [...new Set([
      ...(Array.isArray(existingDisallowed) ? existingDisallowed : []),
      ...DELEGATION_DISALLOWED_TOOLS,
    ])];
    execLog(log, 'SDK_MSG', sessionId, {
      action: 'delegation_strict_mode',
      disallowedTools: sdkOptions.disallowedTools,
    });
  }

  // ---- Delegation System Prompt Injection ----
  if (delegationMode !== 'off' && useAgentTeams) {
    const delegationPrompt = buildDelegationPrompt(delegationMode, debateConfig);
    if (sdkOptions.systemPrompt && typeof sdkOptions.systemPrompt === 'object') {
      // Append to existing system prompt
      const existing = sdkOptions.systemPrompt as { type: string; preset: string; append?: string };
      existing.append = (existing.append ? existing.append + '\n\n' : '') + delegationPrompt;
    } else {
      sdkOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: delegationPrompt,
      };
    }
  }

  // Agent definitions
  const agentDefs = options?.agents ?? session.agents;
  if (useAgentTeams && agentDefs && Object.keys(agentDefs).length > 0) {
    sdkOptions.agents = agentDefs as SDKOptions['agents'];
  }

  // Resume
  if (session.sdkSessionId) {
    sdkOptions.resume = session.sdkSessionId as SDKOptions['resume'];
  }

  let resultText = '';
  let costUsd = 0;
  let chunkCount = 0;
  // Evolution engine counters
  let numTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let agentStartCount = 0;
  let teamDeletedFlag = false;
  let forceStopFlag = false;
  let hasReportFlag = false;

  /** Safe SSE write — guards against write-after-end and destroyed socket */
  function safeWrite(data: string): boolean {
    if (aborted || res.destroyed || res.writableEnded) return false;
    try { res.write(data); return true; } catch { return false; }
  }

  // SSE heartbeat to prevent proxy/browser timeout during long Agent Teams runs
  const heartbeat = setInterval(() => {
    safeWrite(': heartbeat\n\n');
  }, 15_000);

  try {
    // [QUERY_START] — log all query parameters
    execLog(log, 'QUERY_START', sessionId, {
      model: sdkOptions.model,
      cwd: sdkOptions.cwd,
      permissionMode: sdkOptions.permissionMode,
      agentTeams: useAgentTeams,
      maxTurns: sdkOptions.maxTurns,
      thinkingMode: thinkingMode ?? 'default',
      effort: effort ?? 'default',
      maxBudget: maxBudget ?? 'unlimited',
      resume: !!session.sdkSessionId,
      promptLength: prompt.length,
      systemPromptLength: sysPrompt?.length ?? 0,
      delegationMode,
      debateConfig: debateConfig ? { protocol: debateConfig.protocol, minRounds: debateConfig.minRounds, maxRounds: debateConfig.maxRounds, enableMetaAgent: debateConfig.enableMetaAgent, metaAgentRole: debateConfig.metaAgentRole } : undefined,
    });

    const q = queryFn({ prompt, options: sdkOptions });

    for await (const rawMsg of q) {
      if (aborted) {
        execLog(log, 'QUERY_ABORT', sessionId, { reason: 'client_disconnected' });
        break;
      }

      const raw = rawMsg as unknown as RawSDKMessage;

      // Capture SDK session ID
      if (raw.session_id && !session.sdkSessionId) {
        sessionManager.setSdkSessionId(sessionId, raw.session_id);
      }

      // ---- Structured logging for each SDK message type ----
      logRawSDKMessage(log, sessionId, raw);

      // ---- Evolution engine counters ----
      if (raw.type === 'assistant' && raw.message?.content) {
        for (const block of raw.message.content as RawContentBlock[]) {
          if (block.type === 'tool_use') {
            toolCallCount++;
            if (block.name === 'Agent') agentStartCount++;
            if (block.name === 'TeamDelete') teamDeletedFlag = true;
          }
          if (block.type === 'tool_result' && (block as unknown as Record<string, unknown>).is_error) {
            toolErrorCount++;
            const errContent = (block as unknown as Record<string, unknown>).content;
            logObservation(sessionId, {
              ts: Date.now(),
              tool: (block as unknown as Record<string, string>).tool_use_id ?? 'unknown',
              input: typeof errContent === 'string' ? errContent.slice(0, 200) : 'tool_error',
              decision: 'allow',
              error: true,
            });
          }
        }
      }
      if (raw.type === 'result') {
        numTurns = raw.num_turns ?? 0;
        const usage = raw.usage as Record<string, number> | undefined;
        inputTokens = usage?.inputTokens ?? usage?.input_tokens ?? 0;
        outputTokens = usage?.outputTokens ?? usage?.output_tokens ?? 0;
        forceStopFlag = raw.stop_reason === 'max_turns';
      }

      const events = transformSDKMessage(raw);
      for (const event of events) {
        if (event.type === 'result') {
          const data = event.data as { result?: string; costUsd?: number };
          resultText = data.result ?? '';
          costUsd = data.costUsd ?? 0;
        }
        chunkCount++;
        safeWrite(formatSSE(event));
      }

      // RESULT is the final semantic message from the SDK.
      // The SDK iterator may hang after this (waiting for child process cleanup),
      // so break immediately to prevent the stream from stalling.
      // For Agent Teams: the SDK processes all sub-agents within this single query
      // and sends `result` when the main agent's turn ends. If agents spawned but
      // the main agent didn't synthesize, the frontend auto-continuation will send
      // a follow-up query to resume and synthesize.
      if (raw.type === 'result') {
        break;
      }
    }

    // [QUERY_END]
    execLog(log, 'QUERY_END', sessionId, {
      chunkCount,
      agentTeams: useAgentTeams,
      totalDurationMs: Date.now() - queryStartTime,
    });
  } catch (err) {
    execLog(log, 'QUERY_ERROR', sessionId, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : undefined,
    });
    const errEvent: SSEEvent = {
      type: 'error',
      data: { message: err instanceof Error ? err.message : String(err) },
      timestamp: Date.now(),
    };
    safeWrite(formatSSE(errEvent));
  } finally {
    clearInterval(heartbeat);
    activeQueries.delete(sessionId);

    // Clean up any lingering child claude processes after query ends.
    // For Agent Teams the SDK iterator should have already waited for all sub-agents,
    // so this only catches truly orphaned processes.
    killChildClaude(log, sessionId);

    sessionManager.addHistory(sessionId, {
      role: 'assistant',
      content: resultText || '(no text result)',
      timestamp: Date.now(),
      costUsd,
    });
    sessionManager.markIdle(sessionId);

    // Emit metrics to Evolution Engine
    if (_evolutionEngine) {
      const queryMetrics: QueryMetrics = {
        sessionId,
        timestamp: Date.now(),
        type: useAgentTeams ? 'debate' : 'query',
        costUsd,
        durationMs: Date.now() - queryStartTime,
        inputTokens,
        outputTokens,
        numTurns,
        toolCalls: toolCallCount,
        toolErrors: toolErrorCount,
        agentCount: agentStartCount,
        protocol: debateConfig?.protocol,
        continuationRounds: 0,
        teamDeleted: teamDeletedFlag,
        forceStop: forceStopFlag,
        hasReport: hasReportFlag,
      };
      _evolutionEngine.emit('query:end', queryMetrics);
    }

    if (safeWrite(formatSSEDone())) {
      try { res.end(); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Structured SDK Message Logger
// ---------------------------------------------------------------------------

/** Truncate a value for logging (avoid huge tool inputs flooding logs) */
function truncate(val: unknown, maxLen = 500): string {
  const s = typeof val === 'string' ? val : JSON.stringify(val ?? null);
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

/**
 * Log detailed structured information from each raw SDK message.
 * Skips noisy stream_event deltas but captures content_block_start/stop.
 */
function logRawSDKMessage(
  log: import('fastify').FastifyBaseLogger,
  sessionId: string,
  raw: RawSDKMessage,
) {
  switch (raw.type) {
    // ---- system.init: SDK session established ----
    case 'system': {
      if (raw.subtype === 'init') {
        execLog(log, 'SDK_INIT', sessionId, {
          sdkSessionId: raw.session_id,
          model: raw.model,
          cwd: raw.cwd,
          version: raw.claude_code_version,
          permissionMode: raw.permissionMode,
          tools: raw.tools,
          agents: raw.agents,
          mcpServers: raw.mcp_servers?.map(s => `${s.name}:${s.status}`),
        });
      } else if (raw.subtype === 'task_started') {
        execLog(log, 'TASK_EVENT', sessionId, {
          action: 'started',
          taskId: raw.task_id,
          description: raw.description?.slice(0, 200),
          taskType: raw.task_type,
        });
      } else if (raw.subtype === 'task_progress') {
        execLog(log, 'TASK_EVENT', sessionId, {
          action: 'progress',
          taskId: raw.task_id,
          description: raw.description?.slice(0, 200),
          lastToolName: raw.last_tool_name,
          usage: raw.usage,
        });
      } else if (raw.subtype === 'task_notification') {
        execLog(log, 'TASK_EVENT', sessionId, {
          action: raw.status ?? 'completed',
          taskId: raw.task_id,
          summary: raw.summary?.slice(0, 200),
          usage: raw.usage,
        });
      } else {
        // Other system subtypes (status, compact_boundary, hooks, etc.)
        execLog(log, 'SDK_MSG', sessionId, { type: raw.type, subtype: raw.subtype });
      }
      break;
    }

    // ---- assistant: extract tool_use blocks and thinking ----
    case 'assistant': {
      execLog(log, 'SDK_MSG', sessionId, { type: 'assistant', subtype: raw.subtype });

      if (raw.message?.content) {
        for (const block of raw.message.content as RawContentBlock[]) {
          if (block.type === 'tool_use') {
            const input = block.input ?? {};
            // Special handling for Agent Teams tools
            if (block.name === 'Agent') {
              execLog(log, 'AGENT_SPAWN', sessionId, {
                agentId: block.id,
                agentType: (input as Record<string, unknown>).subagent_type ?? 'general-purpose',
                name: (input as Record<string, unknown>).name,
                description: (input as Record<string, unknown>).description,
                isBackground: !!(input as Record<string, unknown>).run_in_background,
                teamName: (input as Record<string, unknown>).team_name,
              });
            } else if (block.name === 'TeamCreate') {
              execLog(log, 'TEAM_CREATE', sessionId, {
                teamName: (input as Record<string, unknown>).team_name,
                description: (input as Record<string, unknown>).description,
              });
            } else if (block.name === 'TeamDelete') {
              execLog(log, 'TEAM_DELETE', sessionId, {});
            } else if (block.name === 'SendMessage') {
              execLog(log, 'SEND_MESSAGE', sessionId, {
                recipient: (input as Record<string, unknown>).recipient,
                messageType: (input as Record<string, unknown>).type,
                contentPreview: truncate((input as Record<string, unknown>).content, 200),
              });
            } else {
              // Generic tool call
              execLog(log, 'TOOL_CALL', sessionId, {
                toolName: block.name,
                toolId: block.id,
                toolInput: truncate(input),
              });
            }
          } else if (block.type === 'tool_result') {
            const content = block.content;
            const contentPreview = typeof content === 'string'
              ? truncate(content, 300)
              : truncate(content, 300);
            execLog(log, 'TOOL_RESULT', sessionId, {
              toolId: block.tool_use_id,
              contentPreview,
              isError: !!(block as unknown as Record<string, unknown>).is_error,
            });
          } else if (block.type === 'thinking') {
            execLog(log, 'THINKING', sessionId, {
              thinkingLength: block.thinking?.length ?? 0,
            });
          }
        }
      }
      break;
    }

    // ---- result: final cost/usage/duration ----
    case 'result': {
      execLog(log, 'RESULT', sessionId, {
        costUsd: raw.total_cost_usd,
        durationMs: raw.duration_ms,
        durationApiMs: raw.duration_api_ms,
        numTurns: raw.num_turns,
        isError: raw.is_error,
        errors: raw.errors,
        usage: raw.usage,
        modelUsage: raw.modelUsage,
        stopReason: raw.stop_reason,
      });
      break;
    }

    // ---- stream_event: only log content_block_start/stop, skip deltas ----
    case 'stream_event': {
      const evt = raw.event;
      if (!evt) break;
      if (evt.type === 'content_block_start' && evt.content_block) {
        execLog(log, 'SDK_MSG', sessionId, {
          type: 'stream_event',
          subtype: 'content_block_start',
          blockType: evt.content_block.type,
          blockName: evt.content_block.name,
          blockIndex: evt.index,
        });
      } else if (evt.type === 'content_block_stop') {
        execLog(log, 'SDK_MSG', sessionId, {
          type: 'stream_event',
          subtype: 'content_block_stop',
          blockIndex: evt.index,
        });
      }
      // Skip noisy content_block_delta / message_start / message_stop
      break;
    }

    // ---- tool_progress ----
    case 'tool_progress': {
      // Only log every 10s to reduce noise
      const elapsed = raw.elapsed_time_seconds ?? 0;
      if (elapsed > 0 && elapsed % 10 < 1) {
        execLog(log, 'SDK_MSG', sessionId, {
          type: 'tool_progress',
          toolName: raw.tool_name,
          toolUseId: raw.tool_use_id,
          elapsedSeconds: elapsed,
        });
      }
      break;
    }

    // ---- All other message types (rate_limit, auth, etc.) ----
    default: {
      if (raw.type !== 'user') {
        execLog(log, 'SDK_MSG', sessionId, {
          type: raw.type,
          subtype: raw.subtype,
        });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Delegation Prompt Builder
// ---------------------------------------------------------------------------

function buildDelegationPrompt(mode: DelegationMode, debateConfig?: DebateConfig): string {
  // Static delegation/debate rules are in memory/CLAUDE.md
  // Here we only inject the dynamic activation context
  const parts: string[] = [];

  parts.push(`=== DELEGATION MODE ACTIVE: ${mode} ===`);
  parts.push(`Follow the delegation rules defined in [CLAUDE] section above.`);

  if (mode === 'strict') {
    parts.push(`STRICT MODE is active — direct use of Edit, Write, NotebookEdit, Bash is FORBIDDEN.`);
  }

  if (debateConfig) {
    parts.push(`\n=== DEBATE MODE ACTIVE (v2.0 Phase Toolkit) ===`);
    if (debateConfig.topic) parts.push(`Topic: ${debateConfig.topic}`);

    const protocol = debateConfig.protocol || 'auto';
    const minRounds = debateConfig.minRounds ?? debateConfig.rounds ?? 1;
    const maxRounds = debateConfig.maxRounds ?? Math.max(minRounds + 2, 5);
    const dynamic = debateConfig.dynamicRounds !== false;

    parts.push(`Protocol: ${protocol}${protocol === 'auto' ? ' (AI decides phase composition based on task complexity)' : ''}`);
    parts.push(`Cross-examination bounds: min=${minRounds}, max=${maxRounds}, dynamic=${dynamic}`);

    if (debateConfig.enableMetaAgent !== false) {
      const role = debateConfig.metaAgentRole || 'impartial-judge';
      parts.push(`Meta-Agent: enabled, role=${role}. Must be SEPARATE from participants.`);
    }

    if (debateConfig.enableAwakening !== false) {
      parts.push(`AWAKENING: After verdict, self-evaluate for unexplored high-value directions.`);
    }

    parts.push(`TOOLS: Proactively use WebSearch/Skills/MCP to enhance analysis.`);
    parts.push(`REPORT: McKinsey-level deliverable. Adapt report sections to chosen phases.`);
    parts.push(`CRITICAL RULES:`);
    parts.push(`1. MUST use TeamCreate to create a team FIRST.`);
    parts.push(`2. MUST spawn SEPARATE Agent for EACH role/perspective (via Agent tool with team_name). NEVER use a single "executor" agent.`);
    parts.push(`3. MUST use SendMessage for ALL inter-agent communication. NEVER simulate conversations within one agent.`);
    parts.push(`4. Each Agent reply MUST come from a REAL spawned Agent, not generated by Team Lead.`);
    parts.push(`5. TaskCreate before start. Explain chosen protocol to user. Verify before TeamDelete.`);
  }

  return parts.join('\n');
}
