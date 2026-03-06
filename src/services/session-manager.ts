/**
 * Session lifecycle management with file-based persistence.
 * Sessions survive server restarts via JSON file storage.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { nanoid } from 'nanoid';
import type { Session, CreateSessionRequest, HistoryEntry, PermissionMode, DelegationMode, McpServerEntry, ModelChannel } from '../types.js';

const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();

// Persistence directories — Three-zone architecture:
//   Zone 1: src/              — Source code (git tracked)
//   Zone 2: knowledge/        — Knowledge content (git tracked, user-editable)
//   Zone 3: data/             — Runtime data (gitignored)
export const BRIDGE_ROOT = process.env.BRIDGE_ROOT || process.cwd(); // claude-agent-bridge install root
export const DATA_DIR = process.env.DATA_DIR ?? join(BRIDGE_ROOT, 'data');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const UPLOADS_DIR = join(DATA_DIR, 'uploads');
export const KNOWLEDGE_DIR = join(BRIDGE_ROOT, 'knowledge');
/** @deprecated alias — use KNOWLEDGE_DIR directly for new code. Kept for SDK compatibility (SDK discovers .claude/skills/ and .claude/commands/ inside). */
export const GLOBAL_SKILLS_DIR = KNOWLEDGE_DIR;
export const MEMORY_DIR = join(KNOWLEDGE_DIR, 'memory');
export const CONFIG_DIR = join(DATA_DIR, 'config');
export const EVOLUTION_DIR = join(DATA_DIR, 'evolution');
const TEAMS_DIR = join(DATA_DIR, 'teams');
const TASKS_DIR = join(DATA_DIR, 'tasks');
const SDK_CACHE_DIR = join(DATA_DIR, 'sdk-cache');
const CONFIG_FILE = join(CONFIG_DIR, 'server-config.json');
const MCP_SERVERS_FILE = join(CONFIG_DIR, 'mcp-servers.json');
const MODEL_CHANNELS_FILE = join(CONFIG_DIR, 'model-channels.json');

/** Resolve the path to the Claude Agent SDK's bundled cli.js for use as pathToClaudeCodeExecutable. */
export function getClaudeCodeExecutablePath(): string {
  // Sidecar/Tauri mode: SDK assets shipped alongside the binary
  const sdkAssetsDir = process.env.SDK_ASSETS_DIR;
  if (sdkAssetsDir) {
    const sidecarPath = join(sdkAssetsDir, 'cli.js');
    if (existsSync(sidecarPath)) return sidecarPath;
  }
  const sidecarPath = join(BRIDGE_ROOT, 'sdk-assets', 'cli.js');
  if (existsSync(sidecarPath)) return sidecarPath;

  try {
    const require = createRequire(join(BRIDGE_ROOT, 'package.json'));
    return require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
  } catch {
    // Fallback: resolve relative to BRIDGE_ROOT
    return join(BRIDGE_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  }
}

export interface ServerConfig {
  maxSessions: number;
  idleTimeoutMinutes: number;
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private saveDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Mutable server config (env vars as initial defaults, overridden by persisted file)
  private config: ServerConfig = {
    maxSessions: parseInt(process.env.MAX_SESSIONS ?? '10', 10),
    idleTimeoutMinutes: parseInt(process.env.SESSION_IDLE_TIMEOUT ?? '1440', 10),
    defaultModel: process.env.DEFAULT_MODEL ?? 'claude-sonnet-4-6',
    defaultPermissionMode: (process.env.DEFAULT_PERMISSION_MODE ?? 'acceptEdits') as PermissionMode,
  };

  constructor() {
    // Ensure data directories exist (Zone 3: runtime data)
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(UPLOADS_DIR, { recursive: true });
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(EVOLUTION_DIR, { recursive: true });
    mkdirSync(SDK_CACHE_DIR, { recursive: true });
    // Zone 2: knowledge content
    mkdirSync(MEMORY_DIR, { recursive: true });
    mkdirSync(join(KNOWLEDGE_DIR, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(KNOWLEDGE_DIR, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(KNOWLEDGE_DIR, 'agents'), { recursive: true });
    mkdirSync(join(KNOWLEDGE_DIR, 'rules'), { recursive: true });
    mkdirSync(join(KNOWLEDGE_DIR, 'contexts'), { recursive: true });

    // Load persisted server config (overrides env var defaults)
    this.loadConfig();

    // Load persisted sessions
    this.loadAll();

    // Clean orphan uploads/session files from crashes
    this.cleanOrphanedSessionData();

    // Periodically clean up idle sessions
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 60_000);
  }

  create(req: CreateSessionRequest = {}): Session {
    if (this.sessions.size >= this.config.maxSessions) {
      const oldest = this.findOldestIdle();
      if (oldest) {
        this.close(oldest.id);
      } else {
        throw new Error(`Max sessions (${this.config.maxSessions}) reached. Close an existing session first.`);
      }
    }

    const session: Session = {
      id: nanoid(12),
      name: req.name ?? `Session ${this.sessions.size + 1}`,
      cwd: req.cwd ?? DEFAULT_CWD,
      model: req.model ?? this.config.defaultModel,
      permissionMode: req.permissionMode ?? this.config.defaultPermissionMode,
      status: 'idle',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      queryCount: 0,
      totalCostUsd: 0,
      history: [],
      agentTeamsEnabled: req.enableAgentTeams ?? false,
      agents: req.agents,
      systemPrompt: req.systemPrompt,
      thinkingMode: req.thinkingMode,
      effort: req.effort,
      maxBudgetUsd: req.maxBudgetUsd,
      maxTurns: req.maxTurns,
      additionalDirectories: req.additionalDirectories,
      delegationMode: req.delegationMode ?? 'off',
      debateConfig: req.debateConfig,
      planFirst: false,
    };

    this.sessions.set(session.id, session);
    this.persistSession(session.id);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getOrThrow(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = 'closed';
      this.sessions.delete(id);
      // Cancel any pending debounced save
      const timer = this.saveDebounceTimers.get(id);
      if (timer) { clearTimeout(timer); this.saveDebounceTimers.delete(id); }
      this.deleteSessionFile(id);
      this.deleteSessionUploads(id);
      this.deleteSessionMemory(id);
      this.deleteSessionMessages(id);
      // Only delete ephemeral tasks, NOT teams (teams are persistent evolution assets)
      this.deleteSessionTasks(id);
    }
  }

  /**
   * Clean up orphaned tasks (not teams!) whose session no longer exists.
   * Teams are persistent evolution assets and are preserved.
   * Call cleanOrphanedAll() to also remove orphaned teams (explicit cleanup only).
   */
  cleanOrphanedTasks(): { removedTasks: string[] } {
    const removedTasks: string[] = [];
    try {
      if (existsSync(TASKS_DIR)) {
        for (const teamName of readdirSync(TASKS_DIR)) {
          // Check if the owning team still references an active session
          const configPath = join(TEAMS_DIR, teamName, 'config.json');
          let orphaned = false;
          if (existsSync(configPath)) {
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              if (config.leadSessionId && !this.sessions.has(config.leadSessionId)) {
                orphaned = true;
              }
            } catch { orphaned = true; }
          } else {
            // No matching team directory → definitely orphaned tasks
            orphaned = true;
          }
          if (orphaned) {
            rmSync(join(TASKS_DIR, teamName), { recursive: true, force: true });
            removedTasks.push(teamName);
          }
        }
      }
    } catch {}
    return { removedTasks };
  }

  /**
   * Explicit full cleanup: remove both orphaned teams AND tasks.
   * Only called via manual POST /api/cleanup or explicit user request.
   */
  cleanOrphanedAll(): { removedTeams: string[]; removedTasks: string[] } {
    const removedTeams: string[] = [];
    const removedTasks: string[] = [];
    try {
      if (existsSync(TEAMS_DIR)) {
        for (const teamName of readdirSync(TEAMS_DIR)) {
          const configPath = join(TEAMS_DIR, teamName, 'config.json');
          if (!existsSync(configPath)) continue;
          try {
            const config = JSON.parse(readFileSync(configPath, 'utf-8'));
            const leadSessionId = config.leadSessionId;
            if (leadSessionId && !this.sessions.has(leadSessionId)) {
              rmSync(join(TEAMS_DIR, teamName), { recursive: true, force: true });
              removedTeams.push(teamName);
              const tasksPath = join(TASKS_DIR, teamName);
              if (existsSync(tasksPath)) {
                rmSync(tasksPath, { recursive: true, force: true });
                removedTasks.push(teamName);
              }
            }
          } catch {}
        }
      }
    } catch {}
    // Also clean any task dirs without a matching team
    try {
      if (existsSync(TASKS_DIR)) {
        for (const name of readdirSync(TASKS_DIR)) {
          if (!existsSync(join(TEAMS_DIR, name))) {
            rmSync(join(TASKS_DIR, name), { recursive: true, force: true });
            if (!removedTasks.includes(name)) removedTasks.push(name);
          }
        }
      }
    } catch {}
    return { removedTeams, removedTasks };
  }

  markBusy(id: string): void {
    const session = this.getOrThrow(id);
    if (session.status === 'closed') throw new Error(`Session ${id} is closed`);
    session.status = 'busy';
    session.lastActiveAt = Date.now();
    // Don't persist busy status — it will be set back to idle on completion
  }

  markIdle(id: string): void {
    const session = this.sessions.get(id);
    if (session && session.status !== 'closed') {
      session.status = 'idle';
      session.lastActiveAt = Date.now();
      this.persistSession(id);
    }
  }

  setSdkSessionId(id: string, sdkSessionId: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.sdkSessionId = sdkSessionId;
      this.persistSessionDebounced(id);
    }
  }

  clearSdkSessionId(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.sdkSessionId = undefined;
      this.persistSession(id);
    }
  }

  /** Clear conversation context — equivalent to /clear in CLI */
  clearContext(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.sdkSessionId = undefined;
      session.history = [];
      session.totalCostUsd = 0;
      session.queryCount = 0;
      // Clean uploads accumulated during this context
      this.deleteSessionUploads(id);
      this.persistSession(id);
    }
  }

  addHistory(id: string, entry: HistoryEntry): void {
    const session = this.sessions.get(id);
    if (session) {
      session.history.push(entry);
      session.queryCount++;
      if (entry.costUsd) {
        session.totalCostUsd += entry.costUsd;
      }
      this.persistSessionDebounced(id);
    }
  }

  // ---- Persistence ----

  private persistSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      const filePath = join(SESSIONS_DIR, `${id}.json`);
      writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch (err) {
      console.error(`Failed to persist session ${id}:`, err);
    }
  }

  /** Debounced persist — avoids thrashing disk during rapid streaming updates */
  private persistSessionDebounced(id: string): void {
    const existing = this.saveDebounceTimers.get(id);
    if (existing) clearTimeout(existing);
    this.saveDebounceTimers.set(id, setTimeout(() => {
      this.saveDebounceTimers.delete(id);
      this.persistSession(id);
    }, 1000));
  }

  // ---- Frontend message persistence (survives WebView storage wipes) ----

  saveMessages(id: string, messages: unknown[]): void {
    if (!this.sessions.has(id)) return;
    try {
      const filePath = join(SESSIONS_DIR, `${id}.messages.json`);
      writeFileSync(filePath, JSON.stringify(messages), 'utf-8');
    } catch (err) {
      console.error(`Failed to save messages for session ${id}:`, err);
    }
  }

  private saveMessagesDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  saveMessagesDebounced(id: string, messages: unknown[]): void {
    const existing = this.saveMessagesDebounceTimers.get(id);
    if (existing) clearTimeout(existing);
    this.saveMessagesDebounceTimers.set(id, setTimeout(() => {
      this.saveMessagesDebounceTimers.delete(id);
      this.saveMessages(id, messages);
    }, 2000));
  }

  loadMessages(id: string): unknown[] | null {
    try {
      const filePath = join(SESSIONS_DIR, `${id}.messages.json`);
      if (!existsSync(filePath)) return null;
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  private deleteSessionMessages(id: string): void {
    try {
      const msgFile = join(SESSIONS_DIR, `${id}.messages.json`);
      if (existsSync(msgFile)) unlinkSync(msgFile);
    } catch {}
  }

  /** Get the upload directory for a session */
  getUploadDir(id: string): string {
    return join(UPLOADS_DIR, id);
  }

  private deleteSessionFile(id: string): void {
    try {
      const filePath = join(SESSIONS_DIR, `${id}.json`);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {}
  }

  private deleteSessionUploads(id: string): void {
    try {
      const uploadDir = join(UPLOADS_DIR, id);
      if (existsSync(uploadDir)) rmSync(uploadDir, { recursive: true, force: true });
    } catch {}
  }

  private deleteSessionMemory(id: string): void {
    try {
      const memFile = join(SESSIONS_DIR, `${id}.memory.md`);
      if (existsSync(memFile)) unlinkSync(memFile);
    } catch {}
  }

  /** Clean up tasks (NOT teams) whose leadSessionId matches this session */
  private deleteSessionTasks(id: string): void {
    try {
      if (!existsSync(TEAMS_DIR)) return;
      for (const teamName of readdirSync(TEAMS_DIR)) {
        const configPath = join(TEAMS_DIR, teamName, 'config.json');
        if (!existsSync(configPath)) continue;
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (config.leadSessionId === id) {
            // Only remove tasks, preserve teams as evolution assets
            const tasksPath = join(TASKS_DIR, teamName);
            if (existsSync(tasksPath)) {
              rmSync(tasksPath, { recursive: true, force: true });
            }
          }
        } catch {}
      }
    } catch {}
  }

  private loadAll(): void {
    try {
      const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
          const session: Session = JSON.parse(raw);
          // Reset status to idle on reload (server restarted, nothing is running)
          session.status = 'idle';
          // Migrate: ensure new fields have defaults for old sessions
          if (session.delegationMode === undefined) session.delegationMode = 'off';
          if (session.planFirst === undefined) session.planFirst = false;
          this.sessions.set(session.id, session);
        } catch {
          // Skip corrupted files
        }
      }
      if (this.sessions.size > 0) {
        console.log(`  Restored ${this.sessions.size} session(s) from disk`);
      }
    } catch {}
  }

  /** Persist all sessions before shutdown */
  persistAll(): void {
    for (const id of this.sessions.keys()) {
      this.persistSession(id);
    }
  }

  // ---- Cleanup ----

  /** Remove orphaned uploads/memory files from crashed sessions (startup reconciliation) */
  private cleanOrphanedSessionData(): void {
    let cleaned = 0;
    try {
      // Orphan uploads: upload dirs whose session ID no longer exists
      if (existsSync(UPLOADS_DIR)) {
        for (const dir of readdirSync(UPLOADS_DIR)) {
          if (!this.sessions.has(dir)) {
            rmSync(join(UPLOADS_DIR, dir), { recursive: true, force: true });
            cleaned++;
          }
        }
      }
      // Orphan session memory and messages files
      if (existsSync(SESSIONS_DIR)) {
        for (const file of readdirSync(SESSIONS_DIR)) {
          if (file.endsWith('.memory.md') || file.endsWith('.messages.json')) {
            const sessionId = file.replace(/\.(memory\.md|messages\.json)$/, '');
            if (!this.sessions.has(sessionId)) {
              try { unlinkSync(join(SESSIONS_DIR, file)); cleaned++; } catch {}
            }
          }
        }
      }
    } catch {}
    if (cleaned > 0) {
      console.log(`  Cleaned ${cleaned} orphaned session data item(s)`);
    }
  }

  private findOldestIdle(): Session | undefined {
    let oldest: Session | undefined;
    for (const session of this.sessions.values()) {
      if (session.status === 'idle') {
        if (!oldest || session.lastActiveAt < oldest.lastActiveAt) {
          oldest = session;
        }
      }
    }
    return oldest;
  }

  private cleanupIdleSessions(): void {
    if (this.config.idleTimeoutMinutes <= 0) return; // 0 = permanent, skip cleanup
    const now = Date.now();
    const timeoutMs = this.config.idleTimeoutMinutes * 60 * 1000;
    for (const session of this.sessions.values()) {
      if (session.status === 'idle' && now - session.lastActiveAt > timeoutMs) {
        this.close(session.id);
      }
    }
  }

  // ---- Server Config ----

  getConfig(): ServerConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<ServerConfig>): ServerConfig {
    if (partial.maxSessions !== undefined) this.config.maxSessions = partial.maxSessions;
    if (partial.idleTimeoutMinutes !== undefined) this.config.idleTimeoutMinutes = partial.idleTimeoutMinutes;
    if (partial.defaultModel !== undefined) this.config.defaultModel = partial.defaultModel;
    if (partial.defaultPermissionMode !== undefined) this.config.defaultPermissionMode = partial.defaultPermissionMode;
    this.persistConfig();
    return { ...this.config };
  }

  private loadConfig(): void {
    try {
      if (existsSync(CONFIG_FILE)) {
        const raw = readFileSync(CONFIG_FILE, 'utf-8');
        const saved = JSON.parse(raw) as Partial<ServerConfig>;
        if (saved.maxSessions !== undefined) this.config.maxSessions = saved.maxSessions;
        if (saved.idleTimeoutMinutes !== undefined) this.config.idleTimeoutMinutes = saved.idleTimeoutMinutes;
        if (saved.defaultModel !== undefined) this.config.defaultModel = saved.defaultModel;
        if (saved.defaultPermissionMode !== undefined) this.config.defaultPermissionMode = saved.defaultPermissionMode;
        console.log('  Loaded server config from disk');
      }
    } catch {
      // Use defaults if config file is corrupted
    }
  }

  private persistConfig(): void {
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist server config:', err);
    }
  }

  // ---- MCP Servers ----

  loadMcpServers(): McpServerEntry[] {
    try {
      if (existsSync(MCP_SERVERS_FILE)) {
        return JSON.parse(readFileSync(MCP_SERVERS_FILE, 'utf-8'));
      }
    } catch {}
    return [];
  }

  saveMcpServers(servers: McpServerEntry[]): void {
    try {
      writeFileSync(MCP_SERVERS_FILE, JSON.stringify(servers, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist MCP servers:', err);
    }
  }

  getMcpServer(name: string): McpServerEntry | undefined {
    return this.loadMcpServers().find(s => s.name === name);
  }

  addMcpServer(entry: McpServerEntry): void {
    const servers = this.loadMcpServers();
    if (servers.some(s => s.name === entry.name)) {
      throw new Error(`MCP server "${entry.name}" already exists`);
    }
    servers.push(entry);
    this.saveMcpServers(servers);
  }

  updateMcpServer(name: string, updates: Partial<McpServerEntry>): McpServerEntry | null {
    const servers = this.loadMcpServers();
    const idx = servers.findIndex(s => s.name === name);
    if (idx === -1) return null;
    // If name is being changed, check for conflicts
    if (updates.name && updates.name !== name && servers.some(s => s.name === updates.name)) {
      throw new Error(`MCP server "${updates.name}" already exists`);
    }
    servers[idx] = { ...servers[idx], ...updates };
    this.saveMcpServers(servers);
    return servers[idx];
  }

  deleteMcpServer(name: string): boolean {
    const servers = this.loadMcpServers();
    const idx = servers.findIndex(s => s.name === name);
    if (idx === -1) return false;
    servers.splice(idx, 1);
    this.saveMcpServers(servers);
    return true;
  }

  // ---- Model Channels ----

  loadModelChannels(): ModelChannel[] {
    try {
      if (existsSync(MODEL_CHANNELS_FILE)) {
        return JSON.parse(readFileSync(MODEL_CHANNELS_FILE, 'utf-8'));
      }
    } catch {}
    return [];
  }

  saveModelChannels(channels: ModelChannel[]): void {
    try {
      writeFileSync(MODEL_CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist model channels:', err);
    }
  }

  /** Resolve a model name to its channel (API key + base URL). Returns undefined for default Anthropic channel. */
  resolveModelChannel(model: string): { apiKey: string; baseUrl: string } | undefined {
    const channels = this.loadModelChannels();
    for (const ch of channels) {
      if (ch.enabled && ch.models.includes(model)) {
        return { apiKey: ch.apiKey, baseUrl: ch.baseUrl };
      }
    }
    return undefined; // Use default env vars (Anthropic)
  }

  addModelChannel(channel: ModelChannel): void {
    const channels = this.loadModelChannels();
    if (channels.some(c => c.id === channel.id)) {
      throw new Error(`Model channel "${channel.id}" already exists`);
    }
    channels.push(channel);
    this.saveModelChannels(channels);
  }

  updateModelChannel(id: string, updates: Partial<ModelChannel>): ModelChannel | null {
    const channels = this.loadModelChannels();
    const idx = channels.findIndex(c => c.id === id);
    if (idx === -1) return null;
    channels[idx] = { ...channels[idx], ...updates };
    this.saveModelChannels(channels);
    return channels[idx];
  }

  deleteModelChannel(id: string): boolean {
    const channels = this.loadModelChannels();
    const idx = channels.findIndex(c => c.id === id);
    if (idx === -1) return false;
    channels.splice(idx, 1);
    this.saveModelChannels(channels);
    return true;
  }

  destroy(): void {
    // Flush all debounced saves
    for (const timer of this.saveDebounceTimers.values()) clearTimeout(timer);
    this.saveDebounceTimers.clear();
    // Persist before shutdown
    this.persistAll();
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
  }
}
