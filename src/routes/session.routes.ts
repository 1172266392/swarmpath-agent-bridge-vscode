/**
 * Session management REST API routes.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { execFile } from 'child_process';
import type { FastifyInstance } from 'fastify';
import { GLOBAL_SKILLS_DIR, type SessionManager } from '../services/session-manager.js';
import type { EvolutionEngine } from '../services/evolution-engine.js';
import { aggregateSessionObservations } from './stream.routes.js';
import type { CreateSessionRequest, Session, ModelChannel } from '../types.js';

interface SkillInfo {
  name: string;
  path: string;
  scope: 'global' | 'project';
  type: 'skill' | 'command';
  description: string;
}

/** Extract description from YAML frontmatter (--- ... ---) */
function extractDescription(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/description:\s*"?([^"\n]+)"?/);
      if (descMatch) return descMatch[1].trim();
    }
    // Fallback: first non-empty, non-heading line
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, 120);
    }
  } catch {}
  return '';
}

/** Scan .claude/skills under a base directory (commands excluded from skills listing) */
function listSkillFiles(baseDir: string, scope: 'global' | 'project'): SkillInfo[] {
  const skills: SkillInfo[] = [];

  // .claude/skills/*/SKILL.md only
  const skillsDir = join(baseDir, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    try {
      for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
        if (d.isDirectory()) {
          const skillFile = join(skillsDir, d.name, 'SKILL.md');
          if (existsSync(skillFile)) {
            skills.push({ name: d.name, path: skillFile, scope, type: 'skill', description: extractDescription(skillFile) });
          }
        }
      }
    } catch {}
  }

  return skills;
}

export function registerSessionRoutes(app: FastifyInstance, sessionManager: SessionManager, evolutionEngine?: EvolutionEngine) {
  /** Create a new session */
  app.post<{ Body: CreateSessionRequest }>('/api/session', async (request, reply) => {
    try {
      const session = sessionManager.create(request.body ?? {});
      return reply.code(201).send(session);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : 'Failed to create session',
      });
    }
  });

  /** List all sessions */
  app.get('/api/session', async (_request, reply) => {
    const sessions = sessionManager.list();
    return reply.send(sessions);
  });

  /** Get a specific session */
  app.get<{ Params: { id: string } }>('/api/session/:id', async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return reply.send(session);
  });

  /** Update session settings */
  app.patch<{
    Params: { id: string };
    Body: Partial<CreateSessionRequest> & { [key: string]: unknown };
  }>('/api/session/:id', async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    const body = request.body;
    if (body.name) session.name = body.name as string;
    if (body.cwd) session.cwd = body.cwd;
    if (body.model) session.model = body.model;
    if (body.permissionMode) session.permissionMode = body.permissionMode;
    if (body.enableAgentTeams !== undefined) session.agentTeamsEnabled = body.enableAgentTeams;
    if (body.agents) session.agents = body.agents;
    if (body.systemPrompt !== undefined) {
      session.systemPrompt = body.systemPrompt || undefined;
      // System prompt change invalidates the SDK conversation — start fresh
      session.sdkSessionId = undefined;
    }
    if (body.thinkingMode !== undefined) session.thinkingMode = body.thinkingMode || undefined;
    if (body.effort !== undefined) session.effort = body.effort || undefined;
    if (body.maxBudgetUsd !== undefined) session.maxBudgetUsd = body.maxBudgetUsd;
    if (body.maxTurns !== undefined) session.maxTurns = (body.maxTurns as number) || undefined;
    if (body.additionalDirectories) session.additionalDirectories = body.additionalDirectories;
    if ((body as Record<string, unknown>).delegationMode !== undefined) {
      session.delegationMode = (body as Record<string, unknown>).delegationMode as Session['delegationMode'];
    }
    if ((body as Record<string, unknown>).debateConfig !== undefined) {
      session.debateConfig = (body as Record<string, unknown>).debateConfig as Session['debateConfig'];
    }
    if ((body as Record<string, unknown>).planFirst !== undefined) {
      session.planFirst = !!(body as Record<string, unknown>).planFirst;
    }
    if ((body as Record<string, unknown>).clearSdkSession) {
      session.sdkSessionId = undefined;
    }

    return reply.send(session);
  });

  /** Clear session context (equivalent to /clear in Claude Code CLI) */
  app.post<{ Params: { id: string } }>('/api/session/:id/clear', async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    if (session.status === 'busy') {
      return reply.code(409).send({ error: 'Cannot clear while session is busy' });
    }
    sessionManager.clearContext(request.params.id);
    return reply.send({ ok: true, message: 'Session context cleared' });
  });

  /** Close (delete) a session */
  app.delete<{ Params: { id: string } }>('/api/session/:id', async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    // Aggregate tool observations → Evolution finding before cleanup
    if (evolutionEngine) {
      const stats = aggregateSessionObservations(request.params.id);
      if (stats && stats.totalCalls > 0) {
        evolutionEngine.addFinding({
          type: 'optimization',
          severity: stats.errorCount > 3 ? 'medium' : 'low',
          title: `[观察] ${stats.summary}`,
          description: `工具频次: ${JSON.stringify(stats.toolFrequency)}`,
        });
      }
    }
    sessionManager.close(request.params.id);
    return reply.code(204).send();
  });

  /** List installed skills (global + project-level) */
  app.get<{ Querystring: { sessionId?: string } }>('/api/skills', async (request, reply) => {
    const globalSkills = listSkillFiles(GLOBAL_SKILLS_DIR, 'global');
    let projectSkills: SkillInfo[] = [];
    if (request.query.sessionId) {
      const session = sessionManager.get(request.query.sessionId);
      if (session) {
        projectSkills = listSkillFiles(session.cwd, 'project');
      }
    }
    return reply.send({ global: globalSkills, project: projectSkills });
  });

  /** Install skills from a GitHub repo — backend-driven, no SDK needed */
  app.post<{
    Body: { repoUrl: string; scope?: 'global' | 'project'; sessionId?: string };
  }>('/api/skills/install', async (request, reply) => {
    const { repoUrl, scope = 'global', sessionId } = request.body;
    if (!repoUrl) return reply.code(400).send({ error: 'repoUrl is required' });

    // Determine target base directory
    let targetBase: string;
    if (scope === 'project' && sessionId) {
      const session = sessionManager.get(sessionId);
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      targetBase = session.cwd;
    } else {
      targetBase = GLOBAL_SKILLS_DIR;
    }
    const targetCommands = join(targetBase, '.claude', 'commands');
    const targetSkills = join(targetBase, '.claude', 'skills');
    mkdirSync(targetCommands, { recursive: true });
    mkdirSync(targetSkills, { recursive: true });

    // Normalize repo URL → git clone URL
    const gitUrl = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '') + '.git';
    const tmpDir = join('/tmp', `_skill_install_${Date.now()}`);

    try {
      // Step 1: git clone --depth=1
      await new Promise<void>((resolve, reject) => {
        execFile('git', ['clone', '--depth=1', gitUrl, tmpDir], { timeout: 30000 }, (err) => {
          if (err) return reject(new Error(`git clone failed: ${err.message}`));
          resolve();
        });
      });

      // Step 2: Auto-detect repo structure and copy files
      const installed: { name: string; type: 'command' | 'skill'; path: string }[] = [];

      // Extract repo name from URL for fallback skill directory name
      const repoName = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '').split('/').pop() || 'unknown-skill';

      // Pattern A: commands/*.md (flat command files)
      const repoCommandsDir = join(tmpDir, 'commands');
      if (existsSync(repoCommandsDir)) {
        for (const f of readdirSync(repoCommandsDir)) {
          if (f.endsWith('.md')) {
            cpSync(join(repoCommandsDir, f), join(targetCommands, f));
            installed.push({ name: basename(f, '.md'), type: 'command', path: join(targetCommands, f) });
          }
        }
      }

      // Pattern B: skills/*/SKILL.md (skill directories)
      const repoSkillsDir = join(tmpDir, 'skills');
      if (existsSync(repoSkillsDir)) {
        for (const d of readdirSync(repoSkillsDir, { withFileTypes: true })) {
          if (d.isDirectory()) {
            const skillMd = join(repoSkillsDir, d.name, 'SKILL.md');
            if (existsSync(skillMd)) {
              const dest = join(targetSkills, d.name);
              mkdirSync(dest, { recursive: true });
              cpSync(join(repoSkillsDir, d.name), dest, { recursive: true });
              installed.push({ name: d.name, type: 'skill', path: join(dest, 'SKILL.md') });
            }
          }
        }
      }

      // Pattern D: repo has .claude/ directory (SDK-native structure) → merge directly
      const repoDotClaude = join(tmpDir, '.claude');
      if (installed.length === 0 && existsSync(repoDotClaude)) {
        const dcSkills = join(repoDotClaude, 'skills');
        if (existsSync(dcSkills)) {
          for (const d of readdirSync(dcSkills, { withFileTypes: true })) {
            if (d.isDirectory()) {
              const dest = join(targetSkills, d.name);
              mkdirSync(dest, { recursive: true });
              cpSync(join(dcSkills, d.name), dest, { recursive: true });
              const skillFile = join(dest, 'SKILL.md');
              installed.push({ name: d.name, type: 'skill', path: existsSync(skillFile) ? skillFile : dest });
            }
          }
        }
        const dcCommands = join(repoDotClaude, 'commands');
        if (existsSync(dcCommands)) {
          for (const f of readdirSync(dcCommands)) {
            if (f.endsWith('.md')) {
              cpSync(join(dcCommands, f), join(targetCommands, f));
              installed.push({ name: basename(f, '.md'), type: 'command', path: join(targetCommands, f) });
            }
          }
        }
      }

      // Pattern E: root-level SKILL.md → treat entire repo as a skill
      if (installed.length === 0 && existsSync(join(tmpDir, 'SKILL.md'))) {
        const skillName = repoName.replace(/-skill$/, '');
        const dest = join(targetSkills, skillName);
        mkdirSync(dest, { recursive: true });
        // Copy entire repo content (excluding .git)
        for (const entry of readdirSync(tmpDir, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const src = join(tmpDir, entry.name);
          cpSync(src, join(dest, entry.name), { recursive: true });
        }
        installed.push({ name: skillName, type: 'skill', path: join(dest, 'SKILL.md') });
      }

      // Pattern F: root .md (non-README) + has src/scripts/assets → treat as skill (with resources)
      if (installed.length === 0) {
        const hasResources = ['src', 'scripts', 'assets', 'lib', 'templates'].some(
          d => existsSync(join(tmpDir, d))
        );
        const rootMds = readdirSync(tmpDir).filter(
          f => f.endsWith('.md') && !['README.md', 'LICENSE.md', 'CHANGELOG.md', 'CONTRIBUTING.md'].includes(f)
        );
        if (hasResources && rootMds.length > 0) {
          // This repo has supporting files → install as a skill directory
          const skillName = repoName.replace(/-skill$/, '');
          const dest = join(targetSkills, skillName);
          mkdirSync(dest, { recursive: true });
          for (const entry of readdirSync(tmpDir, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            cpSync(join(tmpDir, entry.name), join(dest, entry.name), { recursive: true });
          }
          // Rename main .md to SKILL.md if not already named that
          const mainMd = rootMds.find(f => f === 'CLAUDE.md') || rootMds[0];
          const destSkillMd = join(dest, 'SKILL.md');
          if (mainMd && !existsSync(destSkillMd)) {
            cpSync(join(dest, mainMd), destSkillMd);
          }
          installed.push({ name: skillName, type: 'skill', path: destSkillMd });
        }
      }

      // Pattern G (final fallback): root-level .md files only → command
      if (installed.length === 0) {
        for (const f of readdirSync(tmpDir)) {
          if (f.endsWith('.md') && !['README.md', 'LICENSE.md', 'CHANGELOG.md', 'CONTRIBUTING.md'].includes(f)) {
            cpSync(join(tmpDir, f), join(targetCommands, f));
            installed.push({ name: basename(f, '.md'), type: 'command', path: join(targetCommands, f) });
          }
        }
      }

      // Step 3: Auto-install npm dependencies referenced in SKILL.md files
      const npmDeps = new Set<string>();
      for (const item of installed) {
        if (item.type === 'skill') {
          try {
            const { readFileSync } = await import('fs');
            const content = readFileSync(item.path, 'utf-8');
            // Match "npm install -g <pkg>" or "npm install <pkg>" patterns
            const npmMatches = content.matchAll(/npm\s+install\s+(?:-g\s+)?(\S+)/g);
            for (const m of npmMatches) {
              const pkg = m[1];
              if (pkg && !pkg.startsWith('-')) npmDeps.add(pkg);
            }
          } catch {}
        }
      }
      const depsInstalled: string[] = [];
      for (const dep of npmDeps) {
        try {
          await new Promise<void>((resolve, reject) => {
            execFile('npm', ['install', '-g', dep], { timeout: 60000 }, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
          depsInstalled.push(dep);
        } catch {}
      }

      return reply.send({
        ok: true,
        scope,
        targetBase,
        installed,
        depsInstalled,
        message: `Installed ${installed.length} skill(s) from ${repoUrl}` +
          (depsInstalled.length > 0 ? ` + npm: ${depsInstalled.join(', ')}` : ''),
      });
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : 'Install failed',
      });
    } finally {
      // Cleanup temp directory
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ---- Model Channels API ----

  /** List all model channels */
  app.get('/api/model-channels', async (_request, reply) => {
    const channels = sessionManager.loadModelChannels();
    // Mask API keys in response (show last 8 chars only)
    const masked = channels.map(c => ({
      ...c,
      apiKey: c.apiKey.length > 8 ? '***' + c.apiKey.slice(-8) : '***',
    }));
    return reply.send(masked);
  });

  /** Add a new model channel */
  app.post<{ Body: ModelChannel }>('/api/model-channels', async (request, reply) => {
    const body = request.body as ModelChannel;
    if (!body.id || !body.name || !body.apiKey || !body.baseUrl || !body.models?.length) {
      return reply.code(400).send({ error: 'Missing required fields: id, name, apiKey, baseUrl, models' });
    }
    try {
      sessionManager.addModelChannel({
        id: body.id,
        name: body.name,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        models: body.models,
        enabled: body.enabled ?? true,
      });
      return reply.code(201).send({ ok: true });
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Update a model channel */
  app.patch<{ Params: { id: string }; Body: Partial<ModelChannel> }>('/api/model-channels/:id', async (request, reply) => {
    const result = sessionManager.updateModelChannel(request.params.id, request.body as Partial<ModelChannel>);
    if (!result) return reply.code(404).send({ error: 'Channel not found' });
    return reply.send(result);
  });

  /** Delete a model channel */
  app.delete<{ Params: { id: string } }>('/api/model-channels/:id', async (request, reply) => {
    const ok = sessionManager.deleteModelChannel(request.params.id);
    if (!ok) return reply.code(404).send({ error: 'Channel not found' });
    return reply.send({ ok: true });
  });

  /** Fetch models from a provider's /v1/models endpoint — also serves as connection test */
  app.post<{ Body: { apiKey: string; baseUrl: string } }>('/api/test-channel', async (request, reply) => {
    const { apiKey, baseUrl } = request.body as { apiKey: string; baseUrl: string };
    if (!apiKey || !baseUrl) return reply.code(400).send({ error: 'apiKey and baseUrl required' });

    const url = baseUrl.replace(/\/+$/, '') + '/v1/models';
    const start = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000),
      });
      const latency = Date.now() - start;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return reply.send({ ok: false, latency, status: res.status, error: text || res.statusText });
      }
      const data = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
      const models = (data.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));
      return reply.send({ ok: true, latency, models });
    } catch (err) {
      return reply.send({ ok: false, latency: Date.now() - start, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
