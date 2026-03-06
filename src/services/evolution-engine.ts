/**
 * Evolution Engine — Self-evolving intelligence for Bridge.
 *
 * Layer 1: EventBus + Metrics Collector + Scheduler + Findings Store
 * Layer 2: Self-Reflection (added later)
 */

import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync, mkdirSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { execSync } from 'child_process';
import { EVOLUTION_DIR, BRIDGE_ROOT, MEMORY_DIR } from './session-manager.js';
import type { QueryMetrics, Finding, RuleProposal, ReflectionResult, ScheduledTask, CronJob, HeartbeatConfig, HeartbeatCheck, WebhookConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Persistence paths (Zone 3: data/evolution/)
// ---------------------------------------------------------------------------
const FINDINGS_PATH = join(EVOLUTION_DIR, 'findings.json');
const METRICS_PATH = join(EVOLUTION_DIR, 'metrics.json');
const PROPOSALS_PATH = join(EVOLUTION_DIR, 'proposals.json');
const KNOWLEDGE_PATH = join(MEMORY_DIR, 'KNOWLEDGE.md');
const CLAUDE_MD_PATH = join(MEMORY_DIR, 'CLAUDE.md');
const CRON_JOBS_PATH = join(EVOLUTION_DIR, 'cron-jobs.json');
const HEARTBEAT_PATH = join(MEMORY_DIR, 'HEARTBEAT.md');
const HEARTBEAT_CONFIG_PATH = join(EVOLUTION_DIR, 'heartbeat.json');
const WEBHOOKS_PATH = join(EVOLUTION_DIR, 'webhooks.json');
const OBSERVATIONS_DIR = join(EVOLUTION_DIR, 'observations');
const INSTINCTS_DIR = join(EVOLUTION_DIR, 'instincts');
const INSTINCTS_INDEX_PATH = join(INSTINCTS_DIR, 'index.json');

// ---------------------------------------------------------------------------
// CronJob expression helpers (aligned with ZeroClaw scheduler.rs)
// ---------------------------------------------------------------------------

function parseInterval(expr: string): number {
  const m = expr.match(/^(\d+)(m|h|d)$/);
  if (!m) return 3600_000; // fallback 1h
  const n = parseInt(m[1]);
  if (m[2] === 'm') return n * 60_000;
  if (m[2] === 'h') return n * 3600_000;
  return n * 86400_000;
}

function calcNextRun(expr: string): { nextRun: number; oneShot: boolean } {
  if (expr.startsWith('@once:')) {
    return { nextRun: Date.now() + parseInterval(expr.slice(6)), oneShot: true };
  }
  if (expr.startsWith('@at:')) {
    return { nextRun: new Date(expr.slice(4)).getTime(), oneShot: true };
  }
  return { nextRun: Date.now() + parseInterval(expr), oneShot: false };
}

// ---------------------------------------------------------------------------
// Evolution Engine
// ---------------------------------------------------------------------------
export class EvolutionEngine extends EventEmitter {
  private metrics: QueryMetrics[] = [];
  private findings: Finding[] = [];
  private proposals: RuleProposal[] = [];
  private scheduledTasks: ScheduledTask[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private reflectionCount = 0;
  private started = false;
  private cronJobs: CronJob[] = [];
  private cronPollTimer: ReturnType<typeof setInterval> | null = null;

  // Heartbeat (aligned with OpenClaw)
  private heartbeatConfig: HeartbeatConfig = {
    enabled: false,
    intervalMs: 30 * 60_000, // 30 minutes default
    lastRun: 0,
    lastStatus: null,
    lastOutput: '',
    consecutiveOk: 0,
  };
  private heartbeatChecks: HeartbeatCheck[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Webhooks (aligned with OpenClaw)
  private webhooks: WebhookConfig[] = [];

  constructor() {
    super();
    this.loadState();
    this.setupEventHandlers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    if (this.started) return;
    this.started = true;

    // Register scheduled tasks
    this.scheduledTasks = [
      {
        name: 'metrics-digest',
        intervalMs: 6 * 3600_000, // 6 hours
        lastRun: 0,
        enabled: true,
        handler: () => this.runMetricsDigest(),
      },
      {
        name: 'health-check',
        intervalMs: 5 * 60_000, // 5 minutes
        lastRun: 0,
        enabled: true,
        handler: () => this.runHealthCheck(),
      },
      {
        name: 'code-health',
        intervalMs: 24 * 3600_000, // 24 hours
        lastRun: 0,
        enabled: true,
        handler: () => this.runCodeHealthCheck(),
      },
      {
        name: 'instinct-extraction',
        intervalMs: 2 * 3600_000, // 2 hours
        lastRun: 0,
        enabled: true,
        handler: async () => this.runInstinctExtraction(),
      },
    ];

    // Start scheduler
    for (const task of this.scheduledTasks) {
      const timer = setInterval(async () => {
        if (!task.enabled) return;
        task.lastRun = Date.now();
        try {
          await task.handler();
        } catch (err) {
          console.error(`[EvolutionEngine] Scheduled task "${task.name}" error:`, err);
        }
      }, task.intervalMs);
      this.timers.push(timer);
    }

    // Start cron job scheduler (15s polling, aligned with ZeroClaw)
    this.cronPollTimer = setInterval(() => this.pollCronJobs(), 15_000);

    // Start heartbeat if enabled (aligned with OpenClaw)
    this.startHeartbeat();

    console.log(`[EvolutionEngine] Started with ${this.metrics.length} metrics, ${this.findings.length} findings, ${this.cronJobs.length} cron jobs, heartbeat ${this.heartbeatConfig.enabled ? 'ON' : 'OFF'}`);
  }

  destroy() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.cronPollTimer) { clearInterval(this.cronPollTimer); this.cronPollTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.saveState();
    this.saveCronJobs();
    this.saveHeartbeatConfig();
    this.saveWebhooks();
    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  private setupEventHandlers() {
    this.on('query:end', (metrics: QueryMetrics) => {
      this.metrics.push(metrics);
      // Keep max 500 metrics in memory
      if (this.metrics.length > 500) this.metrics = this.metrics.slice(-500);
      this.saveMetrics();

      // Check for debate-specific reflection trigger
      if (metrics.type === 'debate' && metrics.hasReport) {
        this.reflectionCount++;
        // Auto-trigger reflection every 5 debates
        if (this.reflectionCount % 5 === 0) {
          this.emit('reflection:trigger', metrics);
        }
      }
    });

    this.on('query:error', (data: { sessionId: string; error: string }) => {
      this.addFinding({
        type: 'bug',
        severity: 'medium',
        title: `会话 ${data.sessionId.slice(0, 8)} 查询出错`,
        description: data.error.slice(0, 500),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  getMetrics(periodMs?: number): QueryMetrics[] {
    if (!periodMs) return this.metrics;
    const cutoff = Date.now() - periodMs;
    return this.metrics.filter(m => m.timestamp > cutoff);
  }

  getMetricsSummary(periodMs: number = 24 * 3600_000) {
    const recent = this.getMetrics(periodMs);
    if (recent.length === 0) {
      return { totalQueries: 0, totalCost: 0, avgDuration: 0, successRate: 0, debateCount: 0, topProtocols: [] };
    }
    const debates = recent.filter(m => m.type === 'debate');
    const totalCost = recent.reduce((s, m) => s + m.costUsd, 0);
    const avgDuration = recent.reduce((s, m) => s + m.durationMs, 0) / recent.length;
    const errors = recent.filter(m => m.toolErrors > 0);
    const protocols = debates.reduce((acc, m) => {
      if (m.protocol) acc[m.protocol] = (acc[m.protocol] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topProtocols = Object.entries(protocols).sort((a, b) => b[1] - a[1]).slice(0, 5);

    return {
      totalQueries: recent.length,
      totalCost: Math.round(totalCost * 1000) / 1000,
      avgDuration: Math.round(avgDuration),
      successRate: Math.round((1 - errors.length / recent.length) * 100),
      debateCount: debates.length,
      topProtocols,
    };
  }

  // -------------------------------------------------------------------------
  // Findings
  // -------------------------------------------------------------------------

  getFindings(status?: Finding['status']): Finding[] {
    if (!status) return this.findings;
    return this.findings.filter(f => f.status === status);
  }

  addFinding(partial: Omit<Finding, 'id' | 'timestamp' | 'status'>) {
    // Deduplicate: skip if same title exists in last 24h
    const cutoff = Date.now() - 24 * 3600_000;
    if (this.findings.some(f => f.title === partial.title && f.timestamp > cutoff)) return;

    const finding: Finding = {
      id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      status: 'new',
      ...partial,
    };
    this.findings.push(finding);
    // Cap findings to prevent unbounded memory growth
    if (this.findings.length > 500) {
      this.findings = this.findings.slice(-500);
    }
    this.saveFindings();
    this.emit('finding:new', finding);
  }

  updateFinding(id: string, status: Finding['status']): Finding | null {
    const finding = this.findings.find(f => f.id === id);
    if (!finding) return null;
    finding.status = status;
    this.saveFindings();
    return finding;
  }

  // -------------------------------------------------------------------------
  // Rule Proposals
  // -------------------------------------------------------------------------

  getProposals(status?: RuleProposal['status']): RuleProposal[] {
    if (!status) return this.proposals;
    return this.proposals.filter(p => p.status === status);
  }

  getInstincts(): Record<string, { confidence: number; count: number; lastSeen: number; description: string }> {
    if (!existsSync(INSTINCTS_INDEX_PATH)) return {};
    try { return JSON.parse(readFileSync(INSTINCTS_INDEX_PATH, 'utf-8')); } catch { return {}; }
  }

  addProposal(partial: Omit<RuleProposal, 'id' | 'timestamp' | 'status'>) {
    const proposal: RuleProposal = {
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      status: 'pending',
      ...partial,
    };
    this.proposals.push(proposal);
    // Cap proposals to prevent unbounded disk growth
    if (this.proposals.length > 500) {
      this.proposals = this.proposals.slice(-500);
    }
    this.saveProposals();
    this.emit('rule:proposed', proposal);
    return proposal;
  }

  approveProposal(id: string): boolean {
    const proposal = this.proposals.find(p => p.id === id);
    if (!proposal || proposal.status !== 'pending') return false;
    proposal.status = 'approved';

    // Append to CLAUDE.md
    try {
      let content = existsSync(CLAUDE_MD_PATH) ? readFileSync(CLAUDE_MD_PATH, 'utf-8') : '';
      content += `\n\n### ${proposal.title}\n${proposal.rule}\n`;
      writeFileSync(CLAUDE_MD_PATH, content, 'utf-8');
    } catch (err) {
      console.error('[EvolutionEngine] Failed to append to CLAUDE.md:', err);
      return false;
    }

    this.saveProposals();
    return true;
  }

  dismissProposal(id: string): boolean {
    const proposal = this.proposals.find(p => p.id === id);
    if (!proposal || proposal.status !== 'pending') return false;
    proposal.status = 'dismissed';
    this.saveProposals();
    return true;
  }

  // -------------------------------------------------------------------------
  // Scheduled Tasks: Metrics Digest
  // -------------------------------------------------------------------------

  private async runMetricsDigest(): Promise<void> {
    const recent = this.getMetrics(6 * 3600_000); // last 6h
    if (recent.length < 3) return;

    // Cost anomaly detection
    const avgCost = recent.reduce((s, m) => s + m.costUsd, 0) / recent.length;
    const expensive = recent.filter(m => m.costUsd > avgCost * 3);
    if (expensive.length > 0) {
      this.addFinding({
        type: 'cost',
        severity: 'medium',
        title: `${expensive.length} 次查询费用异常 (>$${(avgCost * 3).toFixed(3)})`,
        description: `平均费用: $${avgCost.toFixed(4)}，${expensive.length} 次查询超出平均值 3 倍`,
        suggestedAction: '检查是否存在不必要的工具调用循环',
      });
    }

    // Debate efficiency: force stop rate
    const debates = recent.filter(m => m.type === 'debate');
    const forceStops = debates.filter(m => m.forceStop);
    if (forceStops.length > debates.length * 0.3 && debates.length >= 3) {
      this.addFinding({
        type: 'quality',
        severity: 'high',
        title: `${Math.round(forceStops.length / debates.length * 100)}% 的博弈被强制终止`,
        description: `${forceStops.length}/${debates.length} 次博弈被强制终止`,
        suggestedAction: '检查 MAX_AUTO_CONTINUATIONS 或博弈协议复杂度',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Scheduled Tasks: Health Check
  // -------------------------------------------------------------------------

  private async runHealthCheck(): Promise<void> {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (heapMB > 500) {
      this.addFinding({
        type: 'performance',
        severity: 'high',
        title: `内存占用过高: 堆内存 ${heapMB}MB`,
        description: `进程堆内存 ${heapMB}MB，RSS ${Math.round(mem.rss / 1024 / 1024)}MB`,
        suggestedAction: '排查内存泄漏或减少缓存数据',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Scheduled Tasks: Code Health Check
  // -------------------------------------------------------------------------

  private async runCodeHealthCheck(): Promise<void> {
    const srcDir = join(BRIDGE_ROOT, 'src');
    if (!existsSync(srcDir)) return;

    // 1. File size detection — files over 1000 lines
    const files = this.walkDir(srcDir);
    for (const file of files) {
      try {
        const lines = readFileSync(file, 'utf-8').split('\n').length;
        if (lines > 1000) {
          this.addFinding({
            type: 'quality',
            severity: 'medium',
            title: `${basename(file)} 超过 ${lines} 行`,
            description: '文件过长，建议拆分以提高可维护性',
            costBenefit: { benefit: '可维护性提升', cost: '重构工作量', roi: '中期回报' },
          });
        }
      } catch {}
    }

    // 2. Sync I/O detection
    for (const file of files) {
      try {
        const content = readFileSync(file, 'utf-8');
        const syncCalls = (content.match(/readFileSync|writeFileSync|execSync/g) || []).length;
        if (syncCalls > 5) {
          this.addFinding({
            type: 'performance',
            severity: 'low',
            title: `${basename(file)} 有 ${syncCalls} 个同步 I/O 调用`,
            description: '同步 I/O 会阻塞事件循环，影响并发性能',
            suggestedAction: '迁移到 fs/promises 异步 API',
          });
        }
      } catch {}
    }

    // 3. npm audit (security)
    try {
      const auditResult = execSync('npm audit --json 2>/dev/null', { cwd: BRIDGE_ROOT, timeout: 30000 });
      const audit = JSON.parse(auditResult.toString());
      const highVulns = (audit.metadata?.vulnerabilities?.high || 0) + (audit.metadata?.vulnerabilities?.critical || 0);
      if (highVulns > 0) {
        this.addFinding({
          type: 'bug',
          severity: 'high',
          title: `${highVulns} 个高危/严重依赖漏洞`,
          description: '运行 npm audit 查看详情',
          suggestedAction: '执行 npm audit fix 修复',
        });
      }
    } catch {}
  }

  // -------------------------------------------------------------------------
  // Instinct Extraction — rule-based pattern detection from observations
  // -------------------------------------------------------------------------

  private runInstinctExtraction() {
    if (!existsSync(OBSERVATIONS_DIR)) return;
    mkdirSync(INSTINCTS_DIR, { recursive: true });

    // Load existing instincts index
    let instincts: Record<string, { confidence: number; count: number; lastSeen: number; description: string }> = {};
    if (existsSync(INSTINCTS_INDEX_PATH)) {
      try { instincts = JSON.parse(readFileSync(INSTINCTS_INDEX_PATH, 'utf-8')); } catch {}
    }

    // Read all observation files (including active sessions)
    const allObs: Array<{ tool: string; decision: string; error?: boolean; ts: number }> = [];
    try {
      for (const file of readdirSync(OBSERVATIONS_DIR)) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const lines = readFileSync(join(OBSERVATIONS_DIR, file), 'utf-8').trim().split('\n');
          for (const line of lines) {
            if (line) {
              try { allObs.push(JSON.parse(line)); } catch {}
            }
          }
        } catch {}
      }
    } catch {}

    if (allObs.length < 10) return; // need minimum data

    // --- Rule 1: Frequently denied tools → instinct ---
    const denials: Record<string, number> = {};
    for (const obs of allObs) {
      if (obs.decision === 'deny') {
        denials[obs.tool] = (denials[obs.tool] || 0) + 1;
      }
    }
    for (const [tool, count] of Object.entries(denials)) {
      if (count >= 3) {
        const id = `deny-pattern-${tool.toLowerCase()}`;
        const prev = instincts[id];
        const confidence = Math.min(0.9, 0.3 + count * 0.1);
        instincts[id] = {
          confidence,
          count,
          lastSeen: Date.now(),
          description: `${tool} 被拒绝 ${count} 次 — 检查路径权限或禁止此操作`,
        };
        if (!prev) {
          this.addFinding({
            type: 'optimization',
            severity: count >= 5 ? 'medium' : 'low',
            title: `[Instinct] ${tool} 频繁被拒绝 (${count}次)`,
            description: `工具 ${tool} 被权限系统拒绝 ${count} 次，可能需要调整 allowedDirs 或存在 prompt 问题`,
            suggestedAction: '检查会话授权目录配置',
          });
        }
      }
    }

    // --- Rule 2: Frequent tool errors → instinct ---
    const errors: Record<string, number> = {};
    for (const obs of allObs) {
      if (obs.error) {
        errors[obs.tool] = (errors[obs.tool] || 0) + 1;
      }
    }
    for (const [tool, count] of Object.entries(errors)) {
      if (count >= 3) {
        const id = `error-pattern-${tool.toLowerCase()}`;
        const confidence = Math.min(0.9, 0.3 + count * 0.1);
        instincts[id] = {
          confidence,
          count,
          lastSeen: Date.now(),
          description: `${tool} 出错 ${count} 次 — 可能存在系统性问题`,
        };
      }
    }

    // --- Rule 3: Tool usage frequency → top patterns ---
    const freq: Record<string, number> = {};
    for (const obs of allObs) {
      if (obs.decision === 'allow') {
        freq[obs.tool] = (freq[obs.tool] || 0) + 1;
      }
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 3) {
      const top3 = sorted.slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ');
      instincts['tool-preference'] = {
        confidence: 0.6,
        count: allObs.length,
        lastSeen: Date.now(),
        description: `最常用工具: ${top3} — 共 ${allObs.length} 次调用`,
      };
    }

    // --- Rule 4: High deny rate → security instinct ---
    const totalAllowed = allObs.filter(o => o.decision === 'allow').length;
    const totalDenied = allObs.filter(o => o.decision === 'deny').length;
    if (totalDenied > 0 && totalDenied / allObs.length > 0.1) {
      instincts['high-deny-rate'] = {
        confidence: 0.7,
        count: totalDenied,
        lastSeen: Date.now(),
        description: `拒绝率 ${Math.round(totalDenied / allObs.length * 100)}% (${totalDenied}/${allObs.length}) — 可能需要扩展授权目录`,
      };
    }

    // Save instincts index
    writeFileSync(INSTINCTS_INDEX_PATH, JSON.stringify(instincts, null, 2));

    // Clean up old observation files (>7 days) to prevent unbounded growth
    const cutoff = Date.now() - 7 * 86400_000;
    try {
      for (const file of readdirSync(OBSERVATIONS_DIR)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(OBSERVATIONS_DIR, file);
        try {
          if (statSync(filePath).mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch {}
      }
    } catch {}
  }

  private walkDir(dir: string, visited = new Set<string>()): string[] {
    const results: string[] = [];
    try {
      // Resolve real path to detect symlink cycles
      let realDir: string;
      try { realDir = realpathSync(dir); } catch { return results; }
      if (visited.has(realDir)) return results; // cycle detected
      visited.add(realDir);

      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          results.push(...this.walkDir(full, visited));
        } else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
          results.push(full);
        }
      }
    } catch {}
    return results;
  }

  // -------------------------------------------------------------------------
  // Self-Reflection (Layer 2)
  // -------------------------------------------------------------------------

  async reflect(
    metrics: QueryMetrics,
    sdkQueryFn: (prompt: string) => Promise<string>,
    userFeedback?: string,
    userRating?: string,
  ): Promise<ReflectionResult | null> {
    try {
      // 1. Read current KNOWLEDGE.md
      const knowledge = existsSync(KNOWLEDGE_PATH)
        ? readFileSync(KNOWLEDGE_PATH, 'utf-8').slice(-3000) // last 3000 chars
        : '';

      // 2. Build reflection prompt
      const prompt = this.buildReflectionPrompt(metrics, knowledge, userFeedback, userRating);

      // 3. Call SDK (haiku model, single turn)
      const resultText = await sdkQueryFn(prompt);

      // 4. Parse structured output
      const reflection = this.parseReflection(resultText);
      if (!reflection) return null;

      // 5. Append to KNOWLEDGE.md
      if (reflection.knowledgeEntry) {
        this.appendToKnowledge(reflection.knowledgeEntry);
      }

      // 6. Check if rule proposal threshold reached
      this.reflectionCount++;
      this.emit('reflection:done', reflection);

      return reflection;
    } catch (err) {
      console.error('[EvolutionEngine] Reflection error:', err);
      return null;
    }
  }

  private buildReflectionPrompt(
    metrics: QueryMetrics,
    knowledge: string,
    userFeedback?: string,
    userRating?: string,
  ): string {
    return `[SELF-REFLECTION MODE — EvolutionEngine v1.0]

你是 Bridge 的自我分析模块。基于以下执行数据，输出结构化反思。

## 执行数据
- 类型: ${metrics.type} | 协议: ${metrics.protocol ?? 'N/A'}
- 轮次: ${metrics.numTurns} | Agent 数: ${metrics.agentCount}
- 耗时: ${metrics.durationMs}ms | 花费: $${metrics.costUsd.toFixed(4)}
- 工具调用: ${metrics.toolCalls} | 错误: ${metrics.toolErrors}
- 团队关闭: ${metrics.teamDeleted ?? 'N/A'} | 强制停止: ${metrics.forceStop ?? false}
- 报告生成: ${metrics.hasReport ?? false}
${userFeedback ? `- 用户反馈: ${userFeedback} | 评分: ${userRating ?? 'N/A'}` : ''}

## 当前知识库摘要
${knowledge || '(空)'}

## 输出格式 (严格遵循):
[REFLECTION]
grade: {A|B|C|D}
efficiency: {high|medium|low}
quality: {high|medium|low}
success_pattern: {一句话成功模式}
improvement: {一句话待改进}
knowledge_entry: ### 博弈经验 #${this.reflectionCount + 1} [${new Date().toISOString().split('T')[0]}]
{1-2行经验描述}
[/REFLECTION]`;
  }

  private parseReflection(text: string): ReflectionResult | null {
    const match = text.match(/\[REFLECTION\]([\s\S]*?)\[\/REFLECTION\]/);
    if (!match) return null;
    const block = match[1];

    const get = (key: string) => {
      const m = block.match(new RegExp(`${key}:\\s*(.+)`));
      return m ? m[1].trim() : '';
    };

    const knowledgeMatch = block.match(/knowledge_entry:\s*([\s\S]*?)$/);

    return {
      grade: (get('grade') || 'C') as ReflectionResult['grade'],
      efficiency: (get('efficiency') || 'medium') as ReflectionResult['efficiency'],
      quality: (get('quality') || 'medium') as ReflectionResult['quality'],
      successPattern: get('success_pattern'),
      improvement: get('improvement'),
      knowledgeEntry: knowledgeMatch ? knowledgeMatch[1].trim() : '',
    };
  }

  private appendToKnowledge(entry: string) {
    try {
      let content = existsSync(KNOWLEDGE_PATH) ? readFileSync(KNOWLEDGE_PATH, 'utf-8') : '# Knowledge Base\n';
      // Find or create debate experience section
      const sectionHeader = '## 博弈经验';
      if (!content.includes(sectionHeader)) {
        content += `\n\n${sectionHeader}\n`;
      }
      content += `\n${entry}\n`;
      writeFileSync(KNOWLEDGE_PATH, content, 'utf-8');
    } catch (err) {
      console.error('[EvolutionEngine] Failed to append to KNOWLEDGE.md:', err);
    }
  }

  // -------------------------------------------------------------------------
  // CronJob Scheduler (aligned with ZeroClaw scheduler.rs)
  // -------------------------------------------------------------------------

  private async pollCronJobs() {
    const now = Date.now();
    const dueJobs = this.cronJobs.filter(j => !j.paused && j.nextRun <= now);
    // Max 4 concurrent (aligned with ZeroClaw max_concurrent)
    for (const job of dueJobs.slice(0, 4)) {
      await this.executeCronJob(job);
    }
  }

  private async executeCronJob(job: CronJob) {
    try {
      const output = execSync(job.command, {
        timeout: 30_000,
        cwd: BRIDGE_ROOT,
        encoding: 'utf-8',
      });
      job.lastStatus = 'ok';
      job.lastOutput = (output || '(无输出)').slice(0, 500);
    } catch (err: any) {
      job.lastStatus = 'error';
      job.lastOutput = (err.stderr || err.message || String(err)).slice(0, 500);
    }
    job.lastRun = Date.now();

    if (job.oneShot) {
      this.cronJobs = this.cronJobs.filter(j => j.id !== job.id);
    } else {
      job.nextRun = job.lastRun + parseInterval(job.expression);
    }
    this.saveCronJobs();

    this.addFinding({
      type: job.lastStatus === 'ok' ? 'optimization' : 'bug',
      severity: job.lastStatus === 'ok' ? 'low' : 'medium',
      title: `[定时] ${job.name}: ${job.lastStatus === 'ok' ? '执行成功' : '执行失败'}`,
      description: job.lastOutput,
    });
  }

  // -------------------------------------------------------------------------
  // CronJob CRUD
  // -------------------------------------------------------------------------

  addCronJob(name: string, expression: string, command: string): CronJob {
    const { nextRun, oneShot } = calcNextRun(expression);
    const job: CronJob = {
      id: `cj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      expression,
      command,
      nextRun,
      lastRun: 0,
      lastStatus: null,
      lastOutput: '',
      paused: false,
      oneShot,
      createdAt: Date.now(),
    };
    this.cronJobs.push(job);
    this.saveCronJobs();
    return job;
  }

  removeCronJob(id: string): boolean {
    const idx = this.cronJobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    this.cronJobs.splice(idx, 1);
    this.saveCronJobs();
    return true;
  }

  pauseCronJob(id: string): boolean {
    const job = this.cronJobs.find(j => j.id === id);
    if (!job) return false;
    job.paused = true;
    this.saveCronJobs();
    return true;
  }

  resumeCronJob(id: string): boolean {
    const job = this.cronJobs.find(j => j.id === id);
    if (!job) return false;
    job.paused = false;
    // Recalculate nextRun from now for periodic tasks
    if (!job.oneShot) {
      job.nextRun = Date.now() + parseInterval(job.expression);
    }
    this.saveCronJobs();
    return true;
  }

  getCronJobs(): CronJob[] {
    return this.cronJobs;
  }

  getCronJob(id: string): CronJob | null {
    return this.cronJobs.find(j => j.id === id) || null;
  }

  async runCronJobNow(id: string): Promise<CronJob | null> {
    const job = this.cronJobs.find(j => j.id === id);
    if (!job) return null;
    await this.executeCronJob(job);
    return job;
  }

  // -------------------------------------------------------------------------
  // Heartbeat System (aligned with OpenClaw Heartbeat engine)
  // -------------------------------------------------------------------------

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!this.heartbeatConfig.enabled) return;
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), this.heartbeatConfig.intervalMs);
  }

  async runHeartbeat(): Promise<{ status: HeartbeatConfig['lastStatus']; output: string }> {
    // Load checklist from HEARTBEAT.md if exists
    const checks = this.heartbeatChecks.length > 0
      ? this.heartbeatChecks.filter(c => c.enabled)
      : this.loadHeartbeatMd();

    const results: string[] = [];
    let actionNeeded = false;

    // Layer 1: Cheap deterministic checks (no LLM cost)
    for (const check of checks) {
      try {
        const result = await this.runHeartbeatCheck(check);
        results.push(`[${result.ok ? 'OK' : 'FAIL'}] ${check.name}: ${result.message}`);
        if (!result.ok) actionNeeded = true;
      } catch (err: any) {
        results.push(`[ERROR] ${check.name}: ${err.message}`);
        actionNeeded = true;
      }
    }

    const output = results.join('\n') || 'HEARTBEAT_OK';

    this.heartbeatConfig.lastRun = Date.now();
    this.heartbeatConfig.lastOutput = output.slice(0, 2000);

    if (actionNeeded) {
      this.heartbeatConfig.lastStatus = 'action-needed';
      this.heartbeatConfig.consecutiveOk = 0;
      this.addFinding({
        type: 'performance',
        severity: 'medium',
        title: '心跳检查: 需要关注',
        description: output.slice(0, 500),
        suggestedAction: '查看心跳详情并处理异常项',
      });
    } else {
      this.heartbeatConfig.lastStatus = 'ok';
      this.heartbeatConfig.consecutiveOk++;
    }

    this.saveHeartbeatConfig();
    this.emit('heartbeat:done', { status: this.heartbeatConfig.lastStatus, output });
    return { status: this.heartbeatConfig.lastStatus, output };
  }

  private async runHeartbeatCheck(check: HeartbeatCheck): Promise<{ ok: boolean; message: string }> {
    switch (check.type) {
      case 'process': {
        try {
          const out = execSync(`pgrep -f "${check.target}" 2>/dev/null || true`, { encoding: 'utf-8', timeout: 5000 }).trim();
          const running = out.length > 0;
          return { ok: running, message: running ? `进程运行中 (PID: ${out.split('\n')[0]})` : '进程未找到' };
        } catch { return { ok: false, message: '检测失败' }; }
      }
      case 'file': {
        const exists = existsSync(check.target);
        if (!exists) return { ok: false, message: '文件不存在' };
        const stat = statSync(check.target);
        const ageSec = (Date.now() - stat.mtimeMs) / 1000;
        const threshold = parseInt(check.condition || '3600');
        if (check.condition && ageSec > threshold) {
          return { ok: false, message: `文件过旧 (${Math.round(ageSec / 60)} 分钟前)` };
        }
        return { ok: true, message: `存在, ${Math.round(stat.size / 1024)}KB` };
      }
      case 'api': {
        try {
          const start = Date.now();
          const res = await fetch(check.target, { signal: AbortSignal.timeout(10000) });
          const ms = Date.now() - start;
          const ok = res.ok;
          return { ok, message: `${res.status} (${ms}ms)` };
        } catch (err: any) {
          return { ok: false, message: err.message || '请求失败' };
        }
      }
      case 'command': {
        try {
          const out = execSync(check.target, { encoding: 'utf-8', timeout: 10000 }).trim();
          const ok = check.condition ? out.includes(check.condition) : true;
          return { ok, message: out.slice(0, 200) || '(无输出)' };
        } catch (err: any) {
          return { ok: false, message: (err.stderr || err.message || '').slice(0, 200) };
        }
      }
      case 'disk': {
        try {
          const out = execSync(`df -h "${check.target}" 2>/dev/null | tail -1`, { encoding: 'utf-8', timeout: 5000 }).trim();
          const parts = out.split(/\s+/);
          const usePercent = parseInt(parts[4]) || 0;
          const threshold = parseInt(check.condition || '90');
          return { ok: usePercent < threshold, message: `${parts[4]} 已用 (${parts[3]} 可用)` };
        } catch { return { ok: false, message: '检测失败' }; }
      }
      case 'port': {
        try {
          const out = execSync(`lsof -i :${check.target} -sTCP:LISTEN 2>/dev/null | head -2 || true`, { encoding: 'utf-8', timeout: 5000 }).trim();
          const listening = out.includes('LISTEN');
          return { ok: listening, message: listening ? '端口监听中' : '端口未监听' };
        } catch { return { ok: false, message: '检测失败' }; }
      }
      default:
        return { ok: true, message: '未知检查类型' };
    }
  }

  private loadHeartbeatMd(): HeartbeatCheck[] {
    if (!existsSync(HEARTBEAT_PATH)) return [];
    try {
      const content = readFileSync(HEARTBEAT_PATH, 'utf-8');
      const checks: HeartbeatCheck[] = [];
      // Parse simple markdown checklist:
      // - [x] process: nginx (检查 nginx 进程)
      // - [x] port: 3300 (检查端口监听)
      // - [x] api: http://localhost:3300/health (检查 API 响应)
      // - [x] disk: / >90% (检查磁盘使用)
      // - [x] command: echo ok (执行命令)
      for (const line of content.split('\n')) {
        const m = line.match(/^-\s*\[([x ])\]\s*(process|file|api|command|disk|port):\s*(.+)/i);
        if (!m) continue;
        const enabled = m[1].toLowerCase() === 'x';
        const type = m[2].toLowerCase() as HeartbeatCheck['type'];
        const rest = m[3].trim();
        // Extract condition after > or | separator
        const condMatch = rest.match(/^(.+?)\s*(?:>|[|])\s*(.+)$/);
        const target = condMatch ? condMatch[1].trim() : rest.replace(/\s*\(.+\)$/, '').trim();
        const condition = condMatch ? condMatch[2].trim() : undefined;
        const nameMatch = rest.match(/\((.+?)\)/);
        const name = nameMatch ? nameMatch[1] : `${type}: ${target}`;
        checks.push({ type, name, target, condition, enabled });
      }
      return checks;
    } catch { return []; }
  }

  // Heartbeat config accessors
  getHeartbeatConfig(): HeartbeatConfig { return this.heartbeatConfig; }
  getHeartbeatChecks(): HeartbeatCheck[] {
    return this.heartbeatChecks.length > 0 ? this.heartbeatChecks : this.loadHeartbeatMd();
  }

  setHeartbeatEnabled(enabled: boolean) {
    this.heartbeatConfig.enabled = enabled;
    this.saveHeartbeatConfig();
    if (enabled) this.startHeartbeat();
    else if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  setHeartbeatInterval(ms: number) {
    this.heartbeatConfig.intervalMs = Math.max(60_000, ms); // min 1 minute
    this.saveHeartbeatConfig();
    if (this.heartbeatConfig.enabled) this.startHeartbeat(); // restart with new interval
  }

  addHeartbeatCheck(check: Omit<HeartbeatCheck, 'enabled'>): HeartbeatCheck {
    const full: HeartbeatCheck = { ...check, enabled: true };
    this.heartbeatChecks.push(full);
    this.saveHeartbeatConfig();
    return full;
  }

  removeHeartbeatCheck(index: number): boolean {
    if (index < 0 || index >= this.heartbeatChecks.length) return false;
    this.heartbeatChecks.splice(index, 1);
    this.saveHeartbeatConfig();
    return true;
  }

  toggleHeartbeatCheck(index: number): boolean {
    if (index < 0 || index >= this.heartbeatChecks.length) return false;
    this.heartbeatChecks[index].enabled = !this.heartbeatChecks[index].enabled;
    this.saveHeartbeatConfig();
    return true;
  }

  // -------------------------------------------------------------------------
  // Webhook System (aligned with OpenClaw webhook trigger)
  // -------------------------------------------------------------------------

  getWebhooks(): WebhookConfig[] { return this.webhooks; }

  addWebhook(name: string, sessionTemplate?: string): WebhookConfig {
    const token = Array.from({ length: 32 }, () => Math.random().toString(36).charAt(2)).join('');
    const wh: WebhookConfig = {
      id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      token,
      enabled: true,
      sessionTemplate,
      lastTriggered: 0,
      triggerCount: 0,
    };
    this.webhooks.push(wh);
    this.saveWebhooks();
    return wh;
  }

  removeWebhook(id: string): boolean {
    const idx = this.webhooks.findIndex(w => w.id === id);
    if (idx === -1) return false;
    this.webhooks.splice(idx, 1);
    this.saveWebhooks();
    return true;
  }

  toggleWebhook(id: string): boolean {
    const wh = this.webhooks.find(w => w.id === id);
    if (!wh) return false;
    wh.enabled = !wh.enabled;
    this.saveWebhooks();
    return true;
  }

  validateWebhookToken(token: string): WebhookConfig | null {
    const wh = this.webhooks.find(w => w.token === token && w.enabled);
    if (!wh) return null;
    wh.lastTriggered = Date.now();
    wh.triggerCount++;
    this.saveWebhooks();
    return wh;
  }

  // -------------------------------------------------------------------------
  // Status (for API)
  // -------------------------------------------------------------------------

  getStatus() {
    return {
      started: this.started,
      metricsCount: this.metrics.length,
      findingsCount: this.findings.filter(f => f.status === 'new').length,
      totalFindings: this.findings.length,
      reflectionCount: this.reflectionCount,
      proposalsCount: this.proposals.filter(p => p.status === 'pending').length,
      scheduledTasks: this.scheduledTasks.map(t => ({
        name: t.name,
        intervalMs: t.intervalMs,
        lastRun: t.lastRun,
        enabled: t.enabled,
      })),
      cronJobCount: this.cronJobs.length,
      heartbeat: {
        enabled: this.heartbeatConfig.enabled,
        intervalMs: this.heartbeatConfig.intervalMs,
        lastRun: this.heartbeatConfig.lastRun,
        lastStatus: this.heartbeatConfig.lastStatus,
        consecutiveOk: this.heartbeatConfig.consecutiveOk,
      },
      webhookCount: this.webhooks.length,
    };
  }

  setTaskEnabled(name: string, enabled: boolean): boolean {
    const task = this.scheduledTasks.find(t => t.name === name);
    if (!task) return false;
    task.enabled = enabled;
    return true;
  }

  async runTask(name: string): Promise<boolean> {
    const task = this.scheduledTasks.find(t => t.name === name);
    if (!task) return false;
    task.lastRun = Date.now();
    await task.handler();
    return true;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private loadState() {
    const MAX_ENTRIES = 500;
    try {
      if (existsSync(METRICS_PATH)) {
        const raw = JSON.parse(readFileSync(METRICS_PATH, 'utf-8'));
        this.metrics = Array.isArray(raw) ? raw.slice(-MAX_ENTRIES) : [];
      }
    } catch {}
    try {
      if (existsSync(FINDINGS_PATH)) {
        const raw = JSON.parse(readFileSync(FINDINGS_PATH, 'utf-8'));
        this.findings = Array.isArray(raw) ? raw.slice(-MAX_ENTRIES) : [];
      }
    } catch {}
    try {
      if (existsSync(PROPOSALS_PATH)) {
        const raw = JSON.parse(readFileSync(PROPOSALS_PATH, 'utf-8'));
        this.proposals = Array.isArray(raw) ? raw.slice(-MAX_ENTRIES) : [];
      }
    } catch {}
    try {
      if (existsSync(CRON_JOBS_PATH)) {
        this.cronJobs = JSON.parse(readFileSync(CRON_JOBS_PATH, 'utf-8'));
      }
    } catch {}
    try {
      if (existsSync(HEARTBEAT_CONFIG_PATH)) {
        const data = JSON.parse(readFileSync(HEARTBEAT_CONFIG_PATH, 'utf-8'));
        if (data.config) this.heartbeatConfig = { ...this.heartbeatConfig, ...data.config };
        if (data.checks) this.heartbeatChecks = data.checks;
      }
    } catch {}
    try {
      if (existsSync(WEBHOOKS_PATH)) {
        this.webhooks = JSON.parse(readFileSync(WEBHOOKS_PATH, 'utf-8'));
      }
    } catch {}
  }

  private saveState() {
    this.saveMetrics();
    this.saveFindings();
    this.saveProposals();
  }

  /** Ensure evolution directory exists before writing */
  private ensureEvolutionDir() {
    try { mkdirSync(EVOLUTION_DIR, { recursive: true }); } catch {}
  }

  private saveMetrics() {
    try { this.ensureEvolutionDir(); writeFileSync(METRICS_PATH, JSON.stringify(this.metrics, null, 2), 'utf-8'); } catch {}
  }

  private saveFindings() {
    try { this.ensureEvolutionDir(); writeFileSync(FINDINGS_PATH, JSON.stringify(this.findings, null, 2), 'utf-8'); } catch {}
  }

  private saveProposals() {
    try { this.ensureEvolutionDir(); writeFileSync(PROPOSALS_PATH, JSON.stringify(this.proposals, null, 2), 'utf-8'); } catch {}
  }

  private saveCronJobs() {
    try { this.ensureEvolutionDir(); writeFileSync(CRON_JOBS_PATH, JSON.stringify(this.cronJobs, null, 2), 'utf-8'); } catch {}
  }

  private saveHeartbeatConfig() {
    try {
      this.ensureEvolutionDir();
      writeFileSync(HEARTBEAT_CONFIG_PATH, JSON.stringify({
        config: this.heartbeatConfig,
        checks: this.heartbeatChecks,
      }, null, 2), 'utf-8');
    } catch {}
  }

  private saveWebhooks() {
    try { this.ensureEvolutionDir(); writeFileSync(WEBHOOKS_PATH, JSON.stringify(this.webhooks, null, 2), 'utf-8'); } catch {}
  }
}
