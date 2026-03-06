/**
 * Fastify server setup for Claude Agent Bridge.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, watch } from 'fs';
import { join, dirname, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { execFile } from 'child_process';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { SessionManager, UPLOADS_DIR, GLOBAL_SKILLS_DIR, MEMORY_DIR, SESSIONS_DIR, KNOWLEDGE_DIR, type ServerConfig } from './services/session-manager.js';
import { SdkBridge } from './services/sdk-bridge.js';
import { EvolutionEngine } from './services/evolution-engine.js';
import { BackgroundExecService } from './services/background-exec.js';
import { LaneQueue } from './services/lane-queue.js';
import { registerSessionRoutes } from './routes/session.routes.js';
import { registerStreamRoutes } from './routes/stream.routes.js';
import { registerEvolutionRoutes } from './routes/evolution.routes.js';
import { registerKnowledgeRoutes } from './routes/knowledge.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// MIME type lookup
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.md': 'text/markdown', '.py': 'text/plain', '.js': 'text/javascript',
  '.ts': 'text/plain', '.html': 'text/html', '.css': 'text/css',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xml': 'text/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.svg': 'image/svg+xml', '.sh': 'text/plain', '.bash': 'text/plain',
};

export async function createServer() {
  const app = Fastify({
    logger: true,
    bodyLimit: 20 * 1024 * 1024, // 20MB for base64 image attachments
  });

  // CORS — allow all origins for the bridge (API key protected)
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Services
  const sessionManager = new SessionManager();
  const bridge = new SdkBridge(sessionManager);
  const evolutionEngine = new EvolutionEngine();
  const backgroundExec = new BackgroundExecService();
  const laneQueue = new LaneQueue(4); // max 4 concurrent (aligned with OpenClaw)

  // Wire background exec exit events → evolution findings
  backgroundExec.on('process:exit', (proc: import('./types.js').BackgroundProcess) => {
    evolutionEngine.addFinding({
      type: proc.exitCode === 0 ? 'optimization' : 'bug',
      severity: proc.exitCode === 0 ? 'low' : 'medium',
      title: `[后台] ${proc.command.slice(0, 40)}: ${proc.exitCode === 0 ? '执行完成' : '执行失败 (code ' + proc.exitCode + ')'}`,
      description: proc.output.slice(-5).join('\n').slice(0, 500),
    });
  });

  // Routes
  registerSessionRoutes(app, sessionManager, evolutionEngine);
  registerStreamRoutes(app, bridge, sessionManager, evolutionEngine);
  registerEvolutionRoutes(app, evolutionEngine, sessionManager, backgroundExec, laneQueue);
  registerKnowledgeRoutes(app);

  // Server config API
  app.get('/api/config', async () => ({
    ...sessionManager.getConfig(),
    knowledgeDir: KNOWLEDGE_DIR,
    globalSkillsDir: GLOBAL_SKILLS_DIR, // legacy alias, same as knowledgeDir
  }));
  app.patch<{ Body: Partial<ServerConfig> }>('/api/config', async (request) => {
    return sessionManager.updateConfig(request.body);
  });

  // ---- .env Configuration API ----
  const ENV_PATH = join(__dirname, '..', '.env');

  function parseEnvFile(): { key: string; value: string; commented: boolean }[] {
    if (!existsSync(ENV_PATH)) return [];
    const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
    const entries: { key: string; value: string; commented: boolean }[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || (trimmed.startsWith('#') && !trimmed.match(/^#\s*\w+=.*/))) continue;
      const commented = trimmed.startsWith('#');
      const raw = commented ? trimmed.replace(/^#\s*/, '') : trimmed;
      const eqIdx = raw.indexOf('=');
      if (eqIdx === -1) continue;
      entries.push({ key: raw.slice(0, eqIdx), value: raw.slice(eqIdx + 1), commented });
    }
    return entries;
  }

  function maskApiKey(val: string): string {
    if (val.length <= 8) return '****';
    return val.slice(0, 3) + '***' + val.slice(-4);
  }

  app.get('/api/env', async () => {
    const entries = parseEnvFile();
    return {
      entries: entries.map(e => ({
        ...e,
        value: e.key === 'ANTHROPIC_API_KEY' ? maskApiKey(e.value) : e.value,
      })),
    };
  });

  app.put<{ Body: { entries: { key: string; value: string; commented: boolean }[] } }>(
    '/api/env',
    async (request, reply) => {
      const { entries } = request.body ?? {};
      if (!Array.isArray(entries)) {
        return reply.code(400).send({ error: 'entries array is required' });
      }
      // Read original to preserve masked API key
      const original = parseEnvFile();
      const origMap = new Map(original.map(e => [e.key, e.value]));

      const lines = ['# Claude Agent Bridge Configuration', ''];
      for (const e of entries) {
        let val = e.value;
        // If API key contains mask, preserve original
        if (e.key === 'ANTHROPIC_API_KEY' && val.includes('***')) {
          val = origMap.get('ANTHROPIC_API_KEY') || val;
        }
        const prefix = e.commented ? '#' : '';
        lines.push(`${prefix}${e.key}=${val}`);
      }
      lines.push(''); // trailing newline
      writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
      return { ok: true, restart: true };
    },
  );

  // ---- Memory API ----
  const ALLOWED_MEMORY_FILES = ['SOUL.md', 'IDENTITY.md', 'STYLE.md', 'USER.md', 'CLAUDE.md', 'KNOWLEDGE.md'];

  // List all global memory files with status
  app.get('/api/memory', async () => {
    return ALLOWED_MEMORY_FILES.map(filename => {
      const filePath = join(MEMORY_DIR, filename);
      const exists = existsSync(filePath);
      let size = 0;
      if (exists) {
        try { size = statSync(filePath).size; } catch {}
      }
      return { filename, exists, size };
    });
  });

  // Read a single global memory file
  app.get<{ Params: { filename: string } }>('/api/memory/:filename', async (request, reply) => {
    const { filename } = request.params;
    if (!ALLOWED_MEMORY_FILES.includes(filename)) {
      return reply.code(400).send({ error: `Not allowed: ${filename}` });
    }
    const filePath = join(MEMORY_DIR, filename);
    if (!existsSync(filePath)) {
      return { filename, content: '', exists: false };
    }
    const content = readFileSync(filePath, 'utf-8');
    return { filename, content, exists: true };
  });

  // Write a global memory file
  app.put<{ Params: { filename: string }; Body: { content: string } }>(
    '/api/memory/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      if (!ALLOWED_MEMORY_FILES.includes(filename)) {
        return reply.code(400).send({ error: `Not allowed: ${filename}` });
      }
      const { content } = request.body ?? {};
      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'content is required' });
      }
      const filePath = join(MEMORY_DIR, filename);
      writeFileSync(filePath, content, 'utf-8');
      return { filename, size: Buffer.byteLength(content, 'utf-8'), ok: true };
    },
  );

  // Read session memory
  app.get<{ Params: { sessionId: string } }>(
    '/api/memory/session/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const session = sessionManager.get(sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const memPath = join(SESSIONS_DIR, `${sessionId}.memory.md`);
      if (!existsSync(memPath)) {
        return { sessionId, content: '', exists: false };
      }
      const content = readFileSync(memPath, 'utf-8');
      return { sessionId, content, exists: true };
    },
  );

  // ---- MCP Servers API ----
  app.get('/api/mcp-servers', async () => {
    return sessionManager.loadMcpServers();
  });

  app.post<{ Body: import('./types.js').McpServerEntry }>('/api/mcp-servers', async (request, reply) => {
    const entry = request.body;
    if (!entry?.name || !entry?.transport) {
      return reply.code(400).send({ error: 'name and transport are required' });
    }
    entry.createdAt = entry.createdAt || Date.now();
    if (entry.enabled === undefined) entry.enabled = true;
    try {
      sessionManager.addMcpServer(entry);
      return entry;
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : 'Conflict' });
    }
  });

  app.put<{ Params: { name: string }; Body: Partial<import('./types.js').McpServerEntry> }>(
    '/api/mcp-servers/:name',
    async (request, reply) => {
      const { name } = request.params;
      try {
        const updated = sessionManager.updateMcpServer(name, request.body);
        if (!updated) return reply.code(404).send({ error: `MCP server "${name}" not found` });
        return updated;
      } catch (err) {
        return reply.code(409).send({ error: err instanceof Error ? err.message : 'Conflict' });
      }
    },
  );

  app.delete<{ Params: { name: string } }>('/api/mcp-servers/:name', async (request, reply) => {
    const ok = sessionManager.deleteMcpServer(request.params.name);
    if (!ok) return reply.code(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // Clean orphaned tasks on startup (teams are preserved as evolution assets)
  const orphaned = sessionManager.cleanOrphanedTasks();
  if (orphaned.removedTasks.length > 0) {
    console.log(`  Cleaned ${orphaned.removedTasks.length} orphaned task group(s): ${orphaned.removedTasks.join(', ')}`);
  }

  // Manual cleanup API — explicit request cleans BOTH teams and tasks
  app.post('/api/cleanup', async () => {
    const result = sessionManager.cleanOrphanedAll();
    return { ok: true, ...result };
  });

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    service: 'swarmpath-agent-bridge',
    sessions: sessionManager.list().length,
    timestamp: new Date().toISOString(),
  }));

  // Native directory picker (macOS)
  app.get('/api/browse-directory', async (_request, reply) => {
    try {
      const selected = await new Promise<string>((resolve, reject) => {
        execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择授权目录")'],
          { timeout: 60000 },
          (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim().replace(/\/$/, ''));  // remove trailing slash
          });
      });
      return reply.send({ path: selected });
    } catch {
      return reply.code(400).send({ error: 'cancelled' });
    }
  });

  // Serve uploaded files: GET /api/uploads/:sessionId/:filename
  app.get<{ Params: { sessionId: string; filename: string } }>(
    '/api/uploads/:sessionId/:filename',
    async (request, reply) => {
      const { sessionId, filename } = request.params;
      // Prevent path traversal
      if (filename.includes('..') || filename.includes('/')) {
        return reply.code(400).send({ error: 'Invalid filename' });
      }
      const filePath = join(UPLOADS_DIR, sessionId, filename);
      if (!existsSync(filePath)) {
        return reply.code(404).send({ error: 'File not found' });
      }
      const ext = extname(filename).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const data = readFileSync(filePath);
      return reply
        .header('Content-Type', mime)
        .header('Cache-Control', 'public, max-age=86400')
        .send(data);
    },
  );

  // Serve generated files from session working directory
  // Supports: GET /api/files/:sessionId/*  (wildcard path)
  //           GET /api/files/:sessionId?path=...  (query param for absolute paths)
  const fileHandler = async (request: any, reply: any) => {
    const { sessionId } = request.params;
    const pathFromWildcard = request.params['*'] || '';
    const pathFromQuery = (request.query as any)?.path || '';
    const filePath = pathFromQuery || pathFromWildcard;
    if (!filePath) return reply.code(400).send({ error: 'No path specified' });

    const session = sessionManager.get(sessionId);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    // Resolve: relative paths resolve against cwd; absolute paths resolve as-is
    let fullPath = resolve(session.cwd, filePath);
    // Fallback: if file not found and path looks like a stripped absolute path, try prepending /
    if (!existsSync(fullPath) && !filePath.startsWith('/')) {
      const absAttempt = '/' + filePath;
      if (existsSync(absAttempt)) fullPath = absAttempt;
    }

    if (filePath.includes('..')) {
      return reply.code(403).send({ error: 'Access denied' });
    }
    const allowed = [session.cwd, ...(session.additionalDirectories || []), GLOBAL_SKILLS_DIR];
    const isAllowed = allowed.some(dir => fullPath.startsWith(resolve(dir)));
    if (!isAllowed) {
      return reply.code(403).send({ error: 'Access denied' });
    }

    if (!existsSync(fullPath)) return reply.code(404).send({ error: 'File not found' });

    const ext = extname(fullPath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const data = readFileSync(fullPath);
    return reply
      .header('Content-Type', mime)
      .header('Cache-Control', 'no-cache')
      .send(data);
  };
  app.get<{ Params: { sessionId: string; '*': string } }>('/api/files/:sessionId/*', fileHandler);
  app.get<{ Params: { sessionId: string }; Querystring: { path?: string } }>('/api/files/:sessionId', fileHandler);

  // List directory contents (ls -ltra style)
  app.get<{ Params: { sessionId: string }; Querystring: { path?: string } }>(
    '/api/ls/:sessionId',
    async (request, reply) => {
      const session = sessionManager.get(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: 'Session not found' });

      const targetDir = request.query.path
        ? resolve(session.cwd, request.query.path)
        : session.cwd;

      // Security: must be within session cwd or additional dirs
      const allowed = [session.cwd, ...(session.additionalDirectories || [])];
      if (!allowed.some(d => targetDir.startsWith(resolve(d)))) {
        return reply.code(403).send({ error: 'Access denied' });
      }
      if (!existsSync(targetDir)) return reply.code(404).send({ error: 'Directory not found' });

      try {
        const entries = readdirSync(targetDir, { withFileTypes: true });
        const items = entries.map(e => {
          const fullPath = join(targetDir, e.name);
          try {
            const st = statSync(fullPath);
            return {
              name: e.name,
              isDir: e.isDirectory(),
              isSymlink: e.isSymbolicLink(),
              size: st.size,
              mtime: st.mtime.toISOString(),
              mode: st.mode,
              nlink: st.nlink,
              uid: st.uid,
              gid: st.gid,
            };
          } catch {
            return { name: e.name, isDir: e.isDirectory(), isSymlink: false, size: 0, mtime: '', mode: 0, nlink: 1, uid: 0, gid: 0 };
          }
        });
        // Sort by mtime ascending (oldest first, like ls -ltra)
        items.sort((a, b) => (a.mtime || '').localeCompare(b.mtime || ''));
        return { cwd: targetDir, items };
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : 'ls failed' });
      }
    },
  );

  // ---- File Explorer API ----
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache', '.turbo', 'coverage']);
  const LANG_MAP: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.json': 'json', '.md': 'markdown', '.yaml': 'yaml', '.yml': 'yaml',
    '.xml': 'xml', '.svg': 'xml', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.sql': 'sql', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
    '.h': 'c', '.hpp': 'cpp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.toml': 'toml', '.ini': 'ini', '.env': 'plaintext',
    '.txt': 'plaintext', '.log': 'plaintext', '.csv': 'plaintext',
    '.dockerfile': 'dockerfile', '.vue': 'html', '.svelte': 'html',
  };
  const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
    '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.exe', '.dll', '.so', '.dylib', '.o', '.a',
    '.sqlite', '.db', '.wasm']);

  type TreeNode = { name: string; path: string; isDir: boolean; size: number; children?: TreeNode[] };

  function buildTree(dir: string, basePath: string, depth: number, skipSet: Set<string>): TreeNode[] {
    if (depth <= 0) return [];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const result: TreeNode[] = [];
    // Sort: dirs first, then alphabetical
    entries.sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1;
      const bDir = b.isDirectory() ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue; // skip hidden except .env
      const relPath = basePath ? basePath + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (skipSet.has(e.name)) continue;
        const children = buildTree(join(dir, e.name), relPath, depth - 1, skipSet);
        result.push({ name: e.name, path: relPath, isDir: true, size: 0, children });
      } else {
        let size = 0;
        try { size = statSync(join(dir, e.name)).size; } catch {}
        result.push({ name: e.name, path: relPath, isDir: false, size });
      }
    }
    return result;
  }

  // GET /api/tree/:sessionId?depth=3&skip=node_modules,.git
  app.get<{ Params: { sessionId: string }; Querystring: { depth?: string; skip?: string } }>(
    '/api/tree/:sessionId',
    async (request, reply) => {
      const session = sessionManager.get(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      const depth = Math.min(parseInt(request.query.depth || '3') || 3, 10);
      const skipSet = request.query.skip
        ? new Set(request.query.skip.split(',').map(s => s.trim()))
        : new Set(SKIP_DIRS);
      const tree = buildTree(session.cwd, '', depth, skipSet);
      return { cwd: session.cwd, tree };
    },
  );

  // GET /api/file-content/:sessionId?path=relative/path
  app.get<{ Params: { sessionId: string }; Querystring: { path: string } }>(
    '/api/file-content/:sessionId',
    async (request, reply) => {
      const session = sessionManager.get(request.params.sessionId);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      const relPath = request.query.path;
      if (!relPath) return reply.code(400).send({ error: 'path is required' });

      const fullPath = resolve(session.cwd, relPath);
      // Security: must be within session cwd or additional dirs
      const allowed = [session.cwd, ...(session.additionalDirectories || [])];
      if (!allowed.some(d => fullPath.startsWith(resolve(d)))) {
        return reply.code(403).send({ error: 'Access denied' });
      }
      if (relPath.includes('..')) return reply.code(403).send({ error: 'Access denied' });
      if (!existsSync(fullPath)) return reply.code(404).send({ error: 'File not found' });

      const ext = extname(fullPath).toLowerCase();
      // Binary detection
      if (BINARY_EXTS.has(ext)) {
        return { path: relPath, binary: true, size: statSync(fullPath).size, language: '' };
      }

      const st = statSync(fullPath);
      const MAX_SIZE = 500 * 1024; // 500KB
      let content: string;
      let truncated = false;
      try {
        if (st.size > MAX_SIZE) {
          // Read only first MAX_SIZE bytes for large files
          const fullContent = readFileSync(fullPath, 'utf-8');
          content = fullContent.slice(0, MAX_SIZE);
          truncated = true;
        } else {
          content = readFileSync(fullPath, 'utf-8');
        }
      } catch {
        return { path: relPath, binary: true, size: st.size, language: '' };
      }

      const language = LANG_MAP[ext] || '';
      // Detect if file name matches known config patterns
      const baseName = relPath.split('/').pop() || '';
      const langOverride = baseName === 'Dockerfile' ? 'dockerfile'
        : baseName === 'Makefile' ? 'makefile'
        : baseName === '.gitignore' ? 'plaintext'
        : '';

      return { path: relPath, content, language: langOverride || language, size: st.size, truncated };
    },
  );

  // Serve the web terminal UI with live reload
  const htmlPath = join(__dirname, '..', 'web', 'index.html');
  const LIVE_RELOAD_SCRIPT = `<script>(function(){var ws,retry=0;function connect(){ws=new WebSocket('ws://'+location.host+'/__lr');ws.onmessage=function(e){if(e.data==='reload')location.reload()};ws.onopen=function(){retry=0};ws.onclose=function(){setTimeout(connect,Math.min(1000*Math.pow(2,retry++),5000))}};connect()})()</script>`;

  app.get('/', async (_request, reply) => {
    try {
      let html = readFileSync(htmlPath, 'utf-8');
      html = html.replace('</body>', LIVE_RELOAD_SCRIPT + '</body>');
      return reply.type('text/html').header('Cache-Control', 'no-cache, no-store, must-revalidate').send(html);
    } catch {
      return reply.code(404).send('Web UI not found');
    }
  });

  // Live reload: WebSocket server + file watcher + ping/pong heartbeat
  const wss = new WebSocketServer({ noServer: true });
  app.server.on('upgrade', (req, socket, head) => {
    if (req.url === '/__lr') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    } else {
      socket.destroy();
    }
  });
  watch(join(__dirname, '..', 'web'), { recursive: true }, () => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send('reload');
    }
  });
  // Ping/pong to detect half-open WebSocket connections (every 30s)
  const wsPingTimer = setInterval(() => {
    for (const client of wss.clients) {
      if ((client as any).__pongMissed) {
        client.terminate();
        continue;
      }
      (client as any).__pongMissed = true;
      client.ping();
    }
  }, 30_000);
  wss.on('connection', (ws) => {
    (ws as any).__pongMissed = false;
    ws.on('pong', () => { (ws as any).__pongMissed = false; });
  });

  // Start evolution engine
  evolutionEngine.start();

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(wsPingTimer);
    wss.close();
    backgroundExec.destroy();
    evolutionEngine.destroy();
    sessionManager.destroy();
    await app.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}
