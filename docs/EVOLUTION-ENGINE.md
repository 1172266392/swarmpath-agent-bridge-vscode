# Plan: 自进化引擎 — Bridge Self-Evolution System

> 版本: v1.0 | 日期: 2026-03-04 | 状态: 待实施

## Context

**用户愿景**: Bridge 不是一个需要人工编码维护的静态工具，而是一个**可交付给客户的自进化智能体**。它能:
- 从每次执行中学习，越用越聪明
- 发现自身源码问题，提出改进方案（经性价比分析）
- 拥有后台进程管理和定时任务能力
- 主动向用户反馈发现和建议
- 用户确认后自主完成改进，无需二次开发

**架构评估**: 当前根基评分 **6/10 稳定性, 4/10 可扩展性**。核心代码精简 (~10K LOC)，Session 持久化和 SDK 桥接稳固，但缺少: 事件总线、指标收集、后台任务调度、插件系统。

**策略**: 分三个递进层实施，每层独立可交付，下层是上层的基础。

---

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    Web UI (web/index.html)                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │ System Panel  │ │ Findings     │ │ Rule Proposal Cards  │ │
│  │ (insights tab)│ │ Notification │ │ (approve/dismiss)    │ │
│  └──────────────┘ └──────────────┘ └──────────────────────┘ │
└─────────────────────────┬───────────────────────────────────┘
                          │ SSE events + REST API
┌─────────────────────────┴───────────────────────────────────┐
│                   Server (Fastify)                            │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  NEW: Evolution Engine (src/services/evolution-engine.ts)│ │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌────────────┐ │ │
│  │  │ EventBus │ │ Metrics  │ │ Scheduler │ │ Self-      │ │ │
│  │  │         │ │ Collector│ │ (cron)    │ │ Reflector  │ │ │
│  │  └────┬────┘ └────┬─────┘ └─────┬─────┘ └─────┬──────┘ │ │
│  │       │           │             │              │         │ │
│  │       └───────────┴─────────────┴──────────────┘         │ │
│  └─────────────────────────┬───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────┐  ┌───────┴─────┐  ┌───────────────────┐    │
│  │ SessionMgr  │  │ SdkBridge   │  │ Memory (3-layer)  │    │
│  │ (existing)  │  │ (existing)  │  │ CLAUDE/KNOWLEDGE  │    │
│  └─────────────┘  └─────────────┘  └───────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 修改文件

| 文件 | 改动 | LOC |
|------|------|-----|
| `src/services/evolution-engine.ts` | **新建** — 核心进化引擎 (EventBus + Metrics + Scheduler + Reflector) | ~300 |
| `src/routes/evolution.routes.ts` | **新建** — 进化系统 REST API | ~120 |
| `src/types.ts` | 扩展 Session + 新增 Finding/Metric 类型 | ~50 |
| `src/server.ts` | 注册进化路由 + 初始化引擎 | ~10 |
| `src/routes/stream.routes.ts` | 在查询管道中 emit 指标事件 | ~20 |
| `web/index.html` | System Insights 面板 + 发现通知 + 规则提议卡 | ~200 |
| `memory/CLAUDE.md` | 添加自进化规则段 | ~20 |

总计: ~720 LOC 新增/修改

---

## Layer 1: 基础设施 — EventBus + Metrics + Scheduler

### 1.1 新建 `src/services/evolution-engine.ts`

**EventBus** — 轻量级事件总线 (Node.js EventEmitter):

```typescript
import { EventEmitter } from 'events';

// 事件类型
type EvolutionEvent =
  | 'query:start'     // 查询开始
  | 'query:end'       // 查询结束 (含 metrics)
  | 'query:error'     // 查询出错
  | 'debate:end'      // 博弈结束 (含完整 metrics)
  | 'finding:new'     // 发现新问题
  | 'reflection:done' // 反思完成
  | 'rule:proposed';  // 规则提议生成

class EvolutionEngine extends EventEmitter {
  private metrics: QueryMetrics[] = [];
  private findings: Finding[] = [];
  private scheduledTasks: ScheduledTask[] = [];
  private reflectionCount = 0;
  // ...
}
```

**Metrics Collector** — 从 stream 管道收集查询指标:

```typescript
interface QueryMetrics {
  sessionId: string;
  timestamp: number;
  type: 'query' | 'debate';
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  toolCalls: number;
  toolErrors: number;
  agentCount: number;
  // 博弈特有
  protocol?: string;
  continuationRounds?: number;
  teamDeleted?: boolean;
  forceStop?: boolean;
  hasReport?: boolean;
}
```

收集点: `stream.routes.ts` 的 `runStreamQuery()` 函数 finally 块中 `emit('query:end', metrics)`。

**Scheduler** — 基于 setInterval 的轻量调度器 (不引入新依赖):

```typescript
interface ScheduledTask {
  name: string;
  intervalMs: number;
  lastRun: number;
  enabled: boolean;
  handler: () => Promise<void>;
}

// 内置任务:
// 1. 'metrics-digest' — 每 6 小时汇总查询指标，写入 KNOWLEDGE.md
// 2. 'health-check'   — 每 5 分钟检查内存/进程健康
// 3. 'self-reflect'   — 每 24 小时 (或每 10 次博弈) 触发自我分析
```

调度器在 `EvolutionEngine.start()` 中通过 `setInterval` 启动，`destroy()` 中清理。不引入 `node-cron` 等新依赖，保持零额外依赖。

**Findings** — 发现存储与通知:

```typescript
interface Finding {
  id: string;
  timestamp: number;
  type: 'performance' | 'quality' | 'cost' | 'bug' | 'optimization';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  suggestedAction?: string;
  costBenefit?: { benefit: string; cost: string; roi: string };
  status: 'new' | 'acknowledged' | 'resolved' | 'dismissed';
}
```

持久化到 `.claude-bridge-data/findings.json`。每次新发现通过 SSE 推送到前端。

### 1.2 stream.routes.ts 集成 (最小侵入)

在 `runStreamQuery()` 的 **现有** finally 块中添加 ~15 行 metrics emit:

```typescript
// finally 块末尾 (现有 execLog(QUERY_END) 之后):
if (evolutionEngine) {
  evolutionEngine.emit('query:end', {
    sessionId,
    timestamp: Date.now(),
    type: session.agentTeamsEnabled ? 'debate' : 'query',
    costUsd: totalCost,
    durationMs: Date.now() - queryStartTime,
    inputTokens, outputTokens, numTurns,
    toolCalls: toolCallCount,
    toolErrors: toolErrorCount,
    agentCount: agentStartCount,
    protocol: session.debateConfig?.protocol,
    continuationRounds: autoContinuationRound,
    teamDeleted, forceStop, hasReport,
  });
}
```

这些变量大部分已在现有代码中追踪 (`_agentStarts`, `_teamDeleted`, `totalCost` 等)，只需传递。

### 1.3 types.ts 扩展

```typescript
// Session 新增字段:
export interface Session {
  // ... 现有字段
  autoReflect?: boolean;        // 是否启用自动反思 (default: true)
  reflectionCount?: number;     // 博弈反思次数
}

// 新增类型 (上面已定义的 QueryMetrics, Finding, ScheduledTask)
```

---

## Layer 2: 自我反思引擎

### 2.1 反思触发机制

**触发条件** (任一满足):
1. 博弈结束且生成报告 → 自动触发 (如果 `session.autoReflect !== false`)
2. 用户点击报告卡片 👍/👎 → 立即触发 (附带用户评分)
3. 定时任务 (每 24h 或每累计 10 次博弈) → 汇总反思

**反思流程** (使用 Claude SDK 自身):

```typescript
async reflect(metrics: QueryMetrics, userFeedback?: string): Promise<ReflectionResult> {
  // 1. 读取当前 KNOWLEDGE.md 内容
  const knowledge = readFileSync(KNOWLEDGE_PATH, 'utf-8');

  // 2. 构建反思 prompt (纯分析，maxTurns: 1，不允许工具调用)
  const prompt = buildReflectionPrompt(metrics, knowledge, userFeedback);

  // 3. 调用 SDK (使用 haiku 模型降低成本，~$0.005/次)
  const result = await sdkQuery(prompt, {
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 1,
    systemPrompt: 'You are a self-analysis module...',
  });

  // 4. 解析结构化输出
  const reflection = parseReflection(result);

  // 5. 追加 KNOWLEDGE.md 条目
  appendToKnowledge(reflection.knowledgeEntry);

  // 6. 检查是否达到规则提议阈值 (每 5 次)
  this.reflectionCount++;
  if (this.reflectionCount % 5 === 0) {
    const proposal = await this.proposeRuleUpdate(reflection);
    if (proposal) this.emit('rule:proposed', proposal);
  }

  return reflection;
}
```

### 2.2 反思 Prompt 模板

```
[SELF-REFLECTION MODE — EvolutionEngine v1.0]

你是 Bridge 的自我分析模块。基于以下执行数据，输出结构化反思。

## 执行数据
- 类型: {type} | 协议: {protocol}
- 轮次: {rounds} | Agent 数: {agentCount}
- 耗时: {durationMs}ms | 花费: ${costUsd}
- 团队关闭: {teamDeleted} | 强制停止: {forceStop}
- 报告生成: {hasReport}
{userFeedback ? `用户反馈: ${userFeedback} | 评分: ${userRating}` : ''}

## 当前知识库摘要
{knowledge 最后 10 条博弈经验条目}

## 输出格式 (严格):
[REFLECTION]
grade: {A|B|C|D}
efficiency: {high|medium|low}
quality: {high|medium|low}
success_pattern: {一句话成功模式}
improvement: {一句话待改进}
knowledge_entry: ### 博弈经验 #{N} [{date}] ⚠️
{1-2行经验描述}
[/REFLECTION]
```

### 2.3 KNOWLEDGE.md 自动维护

反思后追加条目到 `## 博弈经验` 区域:

```markdown
## 博弈经验

### 博弈经验 #1 [2026-03-04] ✅
formal 协议 | 3 Agent | 4 轮 | $0.32 | 评分 A
→ 成功模式: 结构化阶段执行 + 独立分析先行
→ 改进: 交叉质询可减少至 2 轮提高效率

### 博弈经验 #2 [2026-03-04] ⚠️
quick 协议 | 2 Agent | 1 轮 | $0.08 | 评分 B
→ 用户要求更深入 → quick 不适合复杂议题
→ 改进: 检测到复杂关键词时自动升级为 formal
```

条目状态遵循现有标记系统 (⚠️→✅→✅常用→❌)。

### 2.4 CLAUDE.md 规则提议机制

每 5 次反思后，汇总经验，构建规则提议:

```typescript
async proposeRuleUpdate(recentReflections: Reflection[]): Promise<RuleProposal> {
  const prompt = `基于以下 5 次博弈反思，提议对 CLAUDE.md 的改进:
    ${recentReflections.map(r => r.summary).join('\n')}

    输出格式:
    [RULE_PROPOSAL]
    title: {提议标题}
    section: {CLAUDE.md 中的目标段落}
    reason: {为什么需要这条规则}
    rule: {具体规则文本}
    [/RULE_PROPOSAL]`;

  // 使用 haiku 降低成本
  return await sdkQuery(prompt, { model: 'claude-haiku-4-5-20251001', maxTurns: 1 });
}
```

提议通过 SSE 事件 `rule:proposed` 推送到前端，用户在 UI 中 **采纳** 或 **忽略**。

---

## Layer 3: API + UI

### 3.1 新建 `src/routes/evolution.routes.ts`

```typescript
export function registerEvolutionRoutes(app, engine, sessionManager) {
  // 获取系统洞察概览
  GET  /api/evolution/status
  → { metricsCount, findingsCount, reflectionCount, lastReflection, scheduledTasks }

  // 获取查询指标 (聚合)
  GET  /api/evolution/metrics?period=24h
  → { totalQueries, totalCost, avgDuration, successRate, debateCount, topProtocols }

  // 获取发现列表
  GET  /api/evolution/findings?status=new
  → Finding[]

  // 更新发现状态 (acknowledge/dismiss/resolve)
  PATCH /api/evolution/findings/:id
  → { status: 'acknowledged' | 'dismissed' | 'resolved' }

  // 手动触发反思
  POST /api/evolution/reflect
  Body: { sessionId, metrics?, userFeedback?, userRating? }
  → ReflectionResult

  // 获取规则提议
  GET  /api/evolution/proposals
  → RuleProposal[]

  // 采纳/忽略规则提议
  POST /api/evolution/proposals/:id/approve
  → 追加到 CLAUDE.md + 返回 { ok: true }

  POST /api/evolution/proposals/:id/dismiss
  → 标记忽略 + 返回 { ok: true }
}
```

### 3.2 server.ts 集成

```typescript
// 在 createServer() 中:
const evolutionEngine = new EvolutionEngine(sessionManager);

registerEvolutionRoutes(app, evolutionEngine, sessionManager);
registerStreamRoutes(app, bridge, sessionManager, evolutionEngine); // 传入引擎

// Graceful shutdown 中:
evolutionEngine.destroy();
```

### 3.3 前端 UI (`web/index.html`)

**3.3a. Header 通知徽章**

在现有 header-right-actions 中添加进化引擎状态指示:

```html
<button class="btn-icon" id="btn-evolution" title="系统洞察">
  &#x1F9E0; <span class="evolution-badge" id="evolution-badge" style="display:none">0</span>
</button>
```

未处理的 findings 数量显示为红色徽章。

**3.3b. System Insights 面板 (侧边抽屉)**

点击脑图标打开右侧抽屉面板:

```
┌──────────────────────────────┐
│  🧠 系统洞察                  │
├──────────────────────────────┤
│  📊 运行概览                  │
│  查询: 47 | 博弈: 12          │
│  总花费: $2.34 | 平均: $0.05  │
│  成功率: 94%                  │
├──────────────────────────────┤
│  📋 发现 (3 new)              │
│  ┌────────────────────────┐  │
│  │ ⚡ 博弈耗时偏高          │  │
│  │ 最近 5 次均 >45s        │  │
│  │ 建议: 减少交叉质询轮次   │  │
│  │ [处理] [忽略]           │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ 💡 规则改进建议 (#3)     │  │
│  │ 基于 5 次博弈经验        │  │
│  │ 建议: quick 协议自动...  │  │
│  │ [采纳] [忽略] [预览]    │  │
│  └────────────────────────┘  │
├──────────────────────────────┤
│  ⚙️ 自动反思: [ON]           │
│  反思次数: 12                 │
│  下次汇总: 2h 后              │
└──────────────────────────────┘
```

**3.3c. 报告迷你卡 — 添加反馈按钮**

在现有 `renderReportMiniCard()` 中添加 👍/👎:

```html
<span class="report-feedback-btns">
  <button onclick="rateReport('${msgId}','good')">👍</button>
  <button onclick="rateReport('${msgId}','bad')">👎</button>
</span>
```

点击后调用 `POST /api/evolution/reflect` 并在卡片下方显示反思摘要。

**3.3d. 规则提议卡 (SSE 推送)**

当 `rule:proposed` 事件到达时，在消息流中插入提议卡:

```html
<div class="rule-proposal-card">
  <h4>💡 规则改进建议</h4>
  <div class="proposal-reason">{reason}</div>
  <pre class="proposal-rule">{rule text}</pre>
  <div class="proposal-actions">
    <button onclick="approveProposal(id)">✅ 采纳写入 CLAUDE.md</button>
    <button onclick="dismissProposal(id)">❌ 忽略</button>
  </div>
</div>
```

---

## Layer 2.5: 自我诊断 (源码分析)

### 后台定时任务: 源码健康检查

EvolutionEngine 的定时任务 `code-health` (每 24h 运行一次):

```typescript
async runCodeHealthCheck(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const srcDir = join(BRIDGE_ROOT, 'src');

  // 1. 文件大小检测 — 超过 1000 行的文件标记为需重构
  for (const file of walkDir(srcDir)) {
    const lines = readFileSync(file, 'utf-8').split('\n').length;
    if (lines > 1000) {
      findings.push({
        type: 'quality',
        severity: 'medium',
        title: `${basename(file)} 超过 ${lines} 行`,
        description: '文件过长，建议拆分提高可维护性',
        costBenefit: { benefit: '可维护性+', cost: '重构工作', roi: '中长期' },
      });
    }
  }

  // 2. 同步 I/O 检测 — 扫描 readFileSync/writeFileSync
  for (const file of walkDir(srcDir)) {
    const content = readFileSync(file, 'utf-8');
    const syncCalls = (content.match(/readFileSync|writeFileSync|execSync/g) || []).length;
    if (syncCalls > 5) {
      findings.push({
        type: 'performance',
        severity: 'low',
        title: `${basename(file)} 有 ${syncCalls} 处同步 I/O`,
        suggestedAction: '迁移到 fs/promises 异步 API',
      });
    }
  }

  // 3. TypeScript 编译检查 — 运行 tsc --noEmit
  try {
    execSync('npx tsc --noEmit', { cwd: BRIDGE_ROOT, timeout: 30000 });
  } catch (err) {
    findings.push({
      type: 'bug',
      severity: 'high',
      title: 'TypeScript 编译错误',
      description: err.stderr?.toString() || 'tsc --noEmit failed',
    });
  }

  // 4. 依赖安全检查 — npm audit
  try {
    const auditResult = execSync('npm audit --json', { cwd: BRIDGE_ROOT, timeout: 30000 });
    const audit = JSON.parse(auditResult.toString());
    if (audit.metadata?.vulnerabilities?.high > 0 || audit.metadata?.vulnerabilities?.critical > 0) {
      findings.push({
        type: 'bug',
        severity: 'high',
        title: `${audit.metadata.vulnerabilities.high + audit.metadata.vulnerabilities.critical} 个高危依赖漏洞`,
        suggestedAction: 'npm audit fix',
      });
    }
  } catch {}

  return findings;
}
```

### 运行时指标分析

`metrics-digest` 定时任务分析已收集的 QueryMetrics:

```typescript
async runMetricsDigest(): Promise<Finding[]> {
  const recent = this.metrics.filter(m => Date.now() - m.timestamp < 6 * 3600_000); // 最近 6h
  if (recent.length < 3) return [];

  const findings: Finding[] = [];

  // 成本异常检测
  const avgCost = recent.reduce((s, m) => s + m.costUsd, 0) / recent.length;
  const expensive = recent.filter(m => m.costUsd > avgCost * 3);
  if (expensive.length > 0) {
    findings.push({
      type: 'cost',
      severity: 'medium',
      title: `${expensive.length} 次查询成本异常 (>${(avgCost * 3).toFixed(3)} USD)`,
      suggestedAction: '检查是否有不必要的工具调用循环',
    });
  }

  // 博弈效率分析
  const debates = recent.filter(m => m.type === 'debate');
  const forceStops = debates.filter(m => m.forceStop);
  if (forceStops.length > debates.length * 0.3 && debates.length >= 3) {
    findings.push({
      type: 'quality',
      severity: 'high',
      title: `${(forceStops.length / debates.length * 100).toFixed(0)}% 博弈被强制停止`,
      suggestedAction: '检查 MAX_AUTO_CONTINUATIONS 或博弈协议复杂度',
    });
  }

  return findings;
}
```

---

## 安全机制

### 铁律 (不可突破)

1. **只建议，不自动修改源码** — 所有代码改动必须经用户确认
2. **规则提议需用户采纳** — CLAUDE.md 修改必须用户点击"采纳"按钮
3. **KNOWLEDGE.md 可自动写入** — 但限制为追加模式，不删除已有内容
4. **反思使用 Haiku 模型** — 控制成本 (~$0.005/次)，不用 Opus/Sonnet
5. **定时任务有开关** — 用户可在设置面板关闭任何后台任务
6. **Findings 可忽略** — 用户可以 dismiss 任何发现，不会重复推送

### 成本控制

| 操作 | 预估成本 | 频率 |
|------|---------|------|
| 博弈反思 (Haiku) | ~$0.005 | 每次博弈后 |
| 规则提议 (Haiku) | ~$0.01 | 每 5 次反思 |
| 源码检查 (本地) | $0 | 每 24h |
| 指标分析 (本地) | $0 | 每 6h |
| **月成本上限** | **<$1** | 假设 30 次博弈/月 |

---

## 实施顺序

### Phase 1: 基础设施 (必须先做)
1. `src/types.ts` — 添加 QueryMetrics, Finding, RuleProposal, ScheduledTask 类型
2. `src/services/evolution-engine.ts` — EventBus + MetricsCollector + Scheduler + FindingsStore
3. `src/server.ts` — 初始化 EvolutionEngine，传入路由
4. `src/routes/stream.routes.ts` — 在 finally 块 emit 查询指标 (~15 行)

### Phase 2: 反思引擎
5. `src/services/evolution-engine.ts` — 添加 reflect() + proposeRuleUpdate()
6. `src/routes/evolution.routes.ts` — 新建所有 REST API 端点
7. `memory/CLAUDE.md` — 添加"自进化系统"规则段

### Phase 3: 前端 UI
8. `web/index.html` CSS — 进化面板 + 发现卡片 + 规则提议卡样式
9. `web/index.html` HTML — header 脑图标按钮 + System Insights 抽屉
10. `web/index.html` JS — 面板交互 + SSE 事件监听 + 反馈按钮 + 规则采纳

### Phase 4: 后台诊断
11. `src/services/evolution-engine.ts` — runCodeHealthCheck() + runMetricsDigest()
12. 编译 + 重启 + 端到端测试

---

## 验证

1. **指标收集**: 执行一次查询 → `GET /api/evolution/metrics` 返回该查询的指标
2. **博弈反思**: 执行一次博弈 → 报告卡片下方出现反思摘要 → KNOWLEDGE.md 新增条目
3. **用户反馈**: 点击 👍 → 触发反思 → 显示评分结果
4. **规则提议**: 执行 5 次博弈后 → 前端弹出规则提议卡 → 点击"采纳" → CLAUDE.md 更新
5. **源码检查**: 等待 24h 或手动触发 → `GET /api/evolution/findings` 返回发现列表
6. **成本控制**: 确认反思使用 Haiku 模型 → 单次 <$0.01
7. **开关控制**: 设置面板关闭"自动反思" → 博弈结束后不触发反思
8. **System Insights**: 点击 🧠 按钮 → 打开面板显示概览 + 发现列表 + 定时任务状态

---

## 附录: 架构稳定性评估

### 当前稳固的根基 ✅
- Session 文件持久化 (JSON，跨重启恢复)
- Graceful shutdown (SIGINT/SIGTERM → flush → close)
- 三层记忆系统 (SOUL/IDENTITY/STYLE/USER/CLAUDE/KNOWLEDGE + session)
- SDK Bridge 重试逻辑 (stale session 自动清除重连)
- 结构化执行日志 (LogPhase 17 种阶段)
- CORS + 路径遍历防护 + 安全边界白名单

### 已知脆弱点 ❌ (进化引擎不依赖这些，未来可渐进修复)
- 同步 I/O (`readFileSync`/`writeFileSync`) — 不阻塞进化引擎 (引擎用 async)
- Debounced saves 崩溃丢数据风险 — 进化引擎自己用即时写入
- 无分布式锁 — 单进程架构不需要
- SDK `"latest"` 版本 — 建议锁定但不阻塞进化引擎开发
- `killChildClaude` 用 `execSync` — 进化引擎不调用此函数

### 结论
当前架构根基**足够稳定**，可以直接在其上构建进化引擎。脆弱点都是独立的，不影响进化系统的核心流程。进化引擎本身也会成为发现和修复这些问题的工具。
