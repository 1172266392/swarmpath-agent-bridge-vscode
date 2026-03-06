/**
 * Knowledge content CRUD API routes.
 * Provides access to agents, rules, contexts, skills, commands in the knowledge/ directory.
 */

import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { KNOWLEDGE_DIR } from '../services/session-manager.js';

const AGENTS_DIR = join(KNOWLEDGE_DIR, 'agents');
const RULES_DIR = join(KNOWLEDGE_DIR, 'rules');
const CONTEXTS_DIR = join(KNOWLEDGE_DIR, 'contexts');
const HOOKS_DIR = join(KNOWLEDGE_DIR, 'hooks');
const SKILLS_DIR = join(KNOWLEDGE_DIR, '.claude', 'skills');
const COMMANDS_DIR = join(KNOWLEDGE_DIR, '.claude', 'commands');
const MCP_CONFIGS_DIR = join(KNOWLEDGE_DIR, 'mcp-configs');

/** Recursively list .md files in a directory */
function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(entry.name);
      }
    }
  } catch {}
  return results.sort();
}

/** List subdirectories (for skills which are dirs with SKILL.md inside) */
function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch { return []; }
}

/** Extract YAML frontmatter fields from a markdown file */
function extractFrontmatter(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};
    const fields: Record<string, string> = {};
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*"?([^"\n]+)"?\s*$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    return fields;
  } catch { return {}; }
}

/** Extract first meaningful line as description fallback */
function extractFirstLine(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    // Skip frontmatter
    const body = content.replace(/^---[\s\S]*?---\s*/, '');
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.length > 10) return t.slice(0, 120);
    }
  } catch {}
  return '';
}

/** Recursively count .md files including subdirs */
function countMdRecursive(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.md')) count++;
      else if (entry.isDirectory()) count += countMdRecursive(full);
    }
  } catch {}
  return count;
}

/** Sanitize a user-supplied name to prevent path traversal */
function safeName(name: string): string {
  // Strip directory components and path traversal sequences
  return basename(name).replace(/\.\./g, '');
}

export function registerKnowledgeRoutes(app: FastifyInstance) {
  // ---- Stats overview ----
  app.get('/api/knowledge/stats', async () => {
    return {
      agents: listMdFiles(AGENTS_DIR).length,
      skills: listSubdirs(SKILLS_DIR).length,
      commands: listMdFiles(COMMANDS_DIR).length,
      rules: countMdRecursive(RULES_DIR),
      contexts: listMdFiles(CONTEXTS_DIR).length,
      hooks: existsSync(join(HOOKS_DIR, 'hooks.json')) ? 1 : 0,
      mcpConfigs: existsSync(MCP_CONFIGS_DIR) ? readdirSync(MCP_CONFIGS_DIR).filter(f => f.endsWith('.json')).length : 0,
    };
  });

  // ==================================================================
  // Agents CRUD
  // ==================================================================

  app.get('/api/knowledge/agents', async () => {
    return listMdFiles(AGENTS_DIR).map(name => {
      const filePath = join(AGENTS_DIR, name);
      const fm = extractFrontmatter(filePath);
      return {
        name: name.replace('.md', ''),
        filename: name,
        description: fm.description || '',
        model: fm.model || '',
      };
    });
  });

  app.get<{ Params: { name: string } }>('/api/knowledge/agents/:name', async (request, reply) => {
    const name = safeName(request.params.name);
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = join(AGENTS_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Agent not found' });
    return { name, content: readFileSync(filePath, 'utf-8') };
  });

  app.put<{ Params: { name: string }; Body: { content: string } }>(
    '/api/knowledge/agents/:name',
    async (request, reply) => {
      const { content } = request.body ?? {};
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content is required' });
      const name = safeName(request.params.name);
      const filename = name.endsWith('.md') ? name : `${name}.md`;
      writeFileSync(join(AGENTS_DIR, filename), content, 'utf-8');
      return { ok: true, name };
    },
  );

  app.delete<{ Params: { name: string } }>('/api/knowledge/agents/:name', async (request, reply) => {
    const name = safeName(request.params.name);
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = join(AGENTS_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Agent not found' });
    unlinkSync(filePath);
    return { ok: true };
  });

  // ==================================================================
  // Rules (read-only listing + individual read)
  // ==================================================================

  app.get('/api/knowledge/rules', async () => {
    const results: { category: string; name: string; filename: string }[] = [];
    if (!existsSync(RULES_DIR)) return results;
    for (const entry of readdirSync(RULES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const file of listMdFiles(join(RULES_DIR, entry.name))) {
          results.push({ category: entry.name, name: file.replace('.md', ''), filename: `${entry.name}/${file}` });
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push({ category: '', name: entry.name.replace('.md', ''), filename: entry.name });
      }
    }
    return results;
  });

  app.get<{ Params: { '*': string } }>('/api/knowledge/rules/*', async (request, reply) => {
    const relPath = request.params['*'];
    if (!relPath || relPath.includes('..')) return reply.code(400).send({ error: 'Invalid path' });
    const filePath = join(RULES_DIR, relPath.endsWith('.md') ? relPath : `${relPath}.md`);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Rule not found' });
    return { path: relPath, content: readFileSync(filePath, 'utf-8') };
  });

  // ==================================================================
  // Contexts
  // ==================================================================

  app.get('/api/knowledge/contexts', async () => {
    return listMdFiles(CONTEXTS_DIR).map(name => ({
      name: name.replace('.md', ''),
      filename: name,
      size: statSync(join(CONTEXTS_DIR, name)).size,
    }));
  });

  app.get<{ Params: { name: string } }>('/api/knowledge/contexts/:name', async (request, reply) => {
    const name = safeName(request.params.name);
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = join(CONTEXTS_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Context not found' });
    return { name, content: readFileSync(filePath, 'utf-8') };
  });

  // ==================================================================
  // Skills (list dirs + read SKILL.md)
  // ==================================================================

  app.get('/api/knowledge/skills', async () => {
    return listSubdirs(SKILLS_DIR).map(name => {
      const skillFile = join(SKILLS_DIR, name, 'SKILL.md');
      const hasSkillMd = existsSync(skillFile);
      let description = '';
      if (hasSkillMd) {
        const fm = extractFrontmatter(skillFile);
        description = fm.description ? fm.description.slice(0, 80) : '';
      }
      return { name, hasSkillMd, description };
    });
  });

  app.get<{ Params: { name: string } }>('/api/knowledge/skills/:name', async (request, reply) => {
    const name = safeName(request.params.name);
    const dir = join(SKILLS_DIR, name);
    if (!existsSync(dir)) return reply.code(404).send({ error: 'Skill not found' });
    const skillFile = join(dir, 'SKILL.md');
    const content = existsSync(skillFile) ? readFileSync(skillFile, 'utf-8') : '';
    const files = readdirSync(dir).sort();
    return { name, content, files };
  });

  // ==================================================================
  // Commands (list + read)
  // ==================================================================

  app.get('/api/knowledge/commands', async () => {
    return listMdFiles(COMMANDS_DIR).map(name => {
      const filePath = join(COMMANDS_DIR, name);
      const fm = extractFrontmatter(filePath);
      const desc = fm.description || extractFirstLine(filePath);
      return {
        name: name.replace('.md', ''),
        filename: name,
        description: desc.slice(0, 80),
      };
    });
  });

  app.get<{ Params: { name: string } }>('/api/knowledge/commands/:name', async (request, reply) => {
    const name = safeName(request.params.name);
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = join(COMMANDS_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Command not found' });
    return { name, content: readFileSync(filePath, 'utf-8') };
  });

  // ==================================================================
  // Hooks
  // ==================================================================

  app.get('/api/knowledge/hooks', async () => {
    const filePath = join(HOOKS_DIR, 'hooks.json');
    if (!existsSync(filePath)) return { hooks: [] };
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch { return { hooks: [] }; }
  });

  // ==================================================================
  // MCP config templates
  // ==================================================================

  app.get('/api/knowledge/mcp-configs', async () => {
    if (!existsSync(MCP_CONFIGS_DIR)) return [];
    return readdirSync(MCP_CONFIGS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(name => ({
        name: name.replace('.json', ''),
        filename: name,
        size: statSync(join(MCP_CONFIGS_DIR, name)).size,
      }));
  });

  app.get<{ Params: { name: string } }>('/api/knowledge/mcp-configs/:name', async (request, reply) => {
    const name = safeName(request.params.name);
    const filename = name.endsWith('.json') ? name : `${name}.json`;
    const filePath = join(MCP_CONFIGS_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'MCP config not found' });
    try {
      return { name, config: JSON.parse(readFileSync(filePath, 'utf-8')) };
    } catch { return reply.code(500).send({ error: 'Failed to parse config' }); }
  });
}
