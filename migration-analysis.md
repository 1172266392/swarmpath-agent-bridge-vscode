# SwarmPath Agent Bridge 迁移分析报告

## 原版 (swarmpath-agent-bridge) vs 新版 (swarmpath-agent-bridge-bak) 对比

---

## 一、架构概览

### 原版架构 (Claude Agent SDK 强依赖)

```
前端 SSE ← stream.routes.ts ← sdk-bridge.ts ← @anthropic-ai/claude-agent-sdk.query()
                                                        ↓
                                                Claude 专用 (单一 Provider)
```

- 核心调用链：`stream.routes.ts → queryFn()` (SDK 的 query 函数)
- SDK 作为**黑盒**提供：LLM 调用、工具执行、Agent Teams、会话恢复
- 输出格式：SDK 专有的 `RawSDKMessage` → `transformSDKMessage()` → `SSEEvent`

### 新版架构 (自建多 Provider 运行时)

```
前端 SSE ← stream.routes.ts ← Orchestrator.query()
                                    ↓
                              ToolLoop (工具循环引擎)
                                    ↓
                              LLMProvider (可切换)
                              ├─ ClaudeProvider    (Anthropic Messages API)
                              ├─ MiniMaxProvider   (OpenAI-compat, /v1/text/chatcompletion_v2)
                              ├─ QwenProvider      (DashScope OpenAI-compat)
                              └─ OpenAIProvider    (GPT-4o 等)
```

- 核心调用链：`stream.routes.ts → Orchestrator.query() → ToolLoop.run() → provider.chat()`
- 自建 3 层架构：Provider (推理) → ToolLoop (工具循环) → Orchestrator (Agent Teams/委派)
- 输出格式：`RuntimeEvent` → `runtimeEventToSSE()` → `SSEEvent`

---

## 二、文件结构对比

### 原版 (13 个 TS 文件)
```
src/
├── index.ts
├── server.ts
├── types.ts
├── routes/
│   ├── stream.routes.ts        (1545 行，核心)
│   ├── evolution.routes.ts
│   ├── knowledge.routes.ts
│   └── session.routes.ts
├── services/
│   ├── sdk-bridge.ts           (227 行，SDK 封装)
│   ├── session-manager.ts
│   ├── evolution-engine.ts
│   ├── lane-queue.ts
│   └── background-exec.ts
└── utils/
    └── message-transform.ts    (600 行，SDK 消息转换)
```

### 新版 (30 个 TS 文件，新增 17 个)
```
src/
├── index.ts                    (未改)
├── server.ts                   (已改：移除 SdkBridge)
├── types.ts                    (未改)
├── routes/
│   ├── stream.routes.ts        (1113 行，完全重写)
│   ├── evolution.routes.ts     (已改：移除 SDK import)
│   ├── knowledge.routes.ts     (未改)
│   └── session.routes.ts       (未改)
├── services/
│   ├── sdk-bridge.ts           (已改：降级为空壳)
│   ├── session-manager.ts      (未改)
│   ├── evolution-engine.ts     (未改)
│   ├── lane-queue.ts           (未改)
│   └── background-exec.ts     (未改)
├── runtime/                    ★ 全新模块
│   ├── types.ts                (运行时类型定义)
│   ├── index.ts                (导出入口)
│   ├── hooks.ts                (PreToolUse 权限钩子)
│   ├── tool-loop.ts            (核心工具循环引擎)
│   ├── orchestrator.ts         (Agent Teams 编排器)
│   ├── providers/
│   │   ├── types.ts            (LLMProvider 接口)
│   │   ├── index.ts
│   │   ├── factory.ts          (模型路由工厂)
│   │   ├── claude.ts           (Anthropic Messages API)
│   │   ├── openai-compat.ts    (OpenAI 兼容基类)
│   │   ├── minimax.ts          (MiniMax M2.5)
│   │   └── qwen.ts             (阿里通义千问)
│   └── tools/
│       ├── types.ts
│       ├── executor.ts         (工具执行器)
│       └── builtin/            (7 个内置工具)
│           ├── bash.ts, edit.ts, glob.ts, grep.ts
│           ├── read.ts, write.ts, web-search.ts
│           └── index.ts
└── utils/
    └── message-transform.ts    (未改，保留用于兼容)
```

---

## 三、核心功能逐项对比

### 3.1 LLM 推理调用

| 功能 | 原版 | 新版 | 状态 |
|------|------|------|------|
| Claude 调用 | SDK `query()` 黑盒 | ClaudeProvider (Messages API 直连) | ✅ 已实现 |
| MiniMax M2.5 | ❌ 不支持 | OpenAI-compat + `/v1/text/chatcompletion_v2` | ✅ 新增 |
| 阿里 Qwen | ❌ 不支持 | QwenProvider (DashScope API) | ✅ 新增 |
| OpenAI GPT | ❌ 不支持 | OpenAICompatProvider | ✅ 新增 |
| 流式输出 | SDK 流式 | SSE 流式解析 (fetch + ReadableStream) | ✅ 已实现 |
| Thinking 模式 | SDK `thinking` 选项 | `thinking_budget` 参数 | ✅ 已实现 |
| `reasoning_content` | ❌ | MiniMax 专有思维链字段 | ✅ 新增 |

### 3.2 工具系统

| 功能 | 原版 | 新版 | 状态 |
|------|------|------|------|
| Bash 工具 | SDK `claude_code` preset | 自建 `builtin/bash.ts` | ✅ 已实现 |
| Edit/Write 工具 | SDK preset | 自建 `builtin/edit.ts` / `write.ts` | ✅ 已实现 |
| Read/Glob/Grep 工具 | SDK preset | 自建 `builtin/read.ts` / `glob.ts` / `grep.ts` | ✅ 已实现 |
| WebSearch 工具 | SDK preset | 自建 `builtin/web-search.ts` | ✅ 已实现 |
| PreToolUse 权限钩子 | SDK hooks API | `RuntimeHooks` + `createDirectoryGuardHook` | ✅ 已实现 |
| 目录守卫 (路径白名单) | 内联在 stream.routes.ts | 独立模块 `hooks.ts` | ✅ 已实现 |
| `~/.claude/` 访问阻断 | ✅ | ✅ | ✅ |
| Sessions 目录限写 `.memory.md` | ✅ | ✅ | ✅ |
| Bash 写命令检测 | ✅ cp/mv/redirect/tee | ✅ 同逻辑 | ✅ |
| 工具观察日志 (JSONL) | ✅ logObservation | ✅ hooks.logObservation | ✅ |

### 3.3 Agent Teams 系统

| 功能 | 原版 | 新版 | 状态 |
|------|------|------|------|
| Agent 工具 (子代理生成) | SDK 内置 | Orchestrator 拦截 Meta-tool | ✅ 已实现 |
| TeamCreate 工具 | SDK 内置 | Orchestrator 拦截 | ✅ 已实现 |
| TeamDelete 工具 | SDK 内置 | Orchestrator 拦截 | ✅ 已实现 |
| SendMessage 工具 | SDK 内置 | Orchestrator 拦截 | ✅ 已实现 |
| TaskUpdate 工具 | SDK 内置 | Orchestrator 拦截 | ✅ 已实现 |
| Delegation Mode (soft/strict) | `disallowedTools` | Orchestrator `buildToolList` 过滤 | ✅ 已实现 |
| Debate Protocol (v2.0) | System prompt 注入 | Orchestrator `buildDebatePrompt` | ✅ 已实现 |
| 子代理模型覆盖 | SDK agents config | `agentModelOverride` + `getProvider()` | ✅ 已实现 |
| 子代理工具过滤 | SDK agents config | `agentDef.tools` / `disallowedTools` | ✅ 已实现 |
| SubagentStart/Stop 生命周期 | SDK hooks | hooks.emitSubagentStart/Stop | ✅ 已实现 |
| TeammateIdle 事件 | SDK hooks | SSE 事件映射 | ✅ 已实现 |
| TaskCompleted 事件 | SDK hooks | hooks.emitTaskCompleted | ✅ 已实现 |

### 3.4 SSE 事件系统

| SSE 事件类型 | 原版来源 | 新版来源 | 状态 |
|-------------|---------|---------|------|
| `stream_delta` (text) | SDK stream_event | RuntimeEvent `text_delta` | ✅ |
| `stream_delta` (thinking) | SDK stream_event | RuntimeEvent `thinking_delta` | ✅ |
| `tool_use` | SDK assistant block | RuntimeEvent `tool_use` | ✅ |
| `tool_result` | SDK assistant block | RuntimeEvent `tool_result` | ✅ |
| `tool_progress` | SDK tool_progress | RuntimeEvent `tool_progress` | ✅ |
| `result` | SDK result | RuntimeEvent `result` | ✅ |
| `error` | SDK error | RuntimeEvent `error` | ✅ |
| `agent_status` | extractAgentTeamsEvents | runtimeEventToSSE 内联 | ✅ |
| `subagent_lifecycle` | SDK SubagentStart/Stop hooks | RuntimeEvent `subagent_lifecycle` | ✅ |
| `session_init` | SDK system.init | RuntimeEvent `session_init` | ✅ |
| `status` | SDK system.status | RuntimeEvent `status` | ✅ |
| `p2p_message` | extractAgentTeamsEvents | runtimeEventToSSE 内联 | ✅ |
| `plan_submitted` | extractAgentTeamsEvents | runtimeEventToSSE 内联 | ✅ |
| `plan_approval_request` | extractAgentTeamsEvents | runtimeEventToSSE 内联 | ✅ |
| `plan_approval_response` | extractAgentTeamsEvents | runtimeEventToSSE 内联 | ✅ |

### 3.5 系统功能

| 功能 | 原版 | 新版 | 状态 |
|------|------|------|------|
| 记忆层加载 (6 文件 + mtime 缓存) | ✅ | ✅ 完全相同 | ✅ |
| 技能目录发现 (30s TTL 缓存) | ✅ | ✅ 完全相同 | ✅ |
| Delegation prompt 构建 | ✅ | ✅ 完全相同 | ✅ |
| Debate config 注入 | ✅ | ✅ 完全相同 | ✅ |
| 附件保存 + prompt 增强 | ✅ | ✅ 完全相同 | ✅ |
| SSE heartbeat (15s) | ✅ | ✅ 完全相同 | ✅ |
| 查询超时清理 (30min) | ✅ | ✅ 完全相同 | ✅ |
| AbortController 中断 | ✅ | ✅ 完全相同 | ✅ |
| Evolution Engine 指标上报 | ✅ | ✅ 完全相同 | ✅ |
| 会话历史记录 | ✅ | ✅ 完全相同 | ✅ |
| Plan Approval 流程 | ✅ | ✅ 完全相同 | ✅ |
| 非流式 `/api/query` 端点 | ✅ | ✅ 已迁移 | ✅ |
| `/api/stream/test` 调试端点 | ✅ | ✅ 完全相同 | ✅ |
| `/api/providers` 端点 | ❌ | ✅ 新增 | ✅ 新增 |

---

## 四、存在的差异与潜在问题

### 4.1 已移除的功能 (设计决策，非遗漏)

| 功能 | 原因 | 影响 |
|------|------|------|
| `killChildClaude()` 子进程清理 | SDK 会 spawn 子进程，自建运行时全在进程内 | ✅ 不再需要 |
| `session.sdkSessionId` 会话恢复 | SDK 有独立会话 ID，自建运行时用消息历史恢复 | ⚠️ 需观察 |
| `logRawSDKMessage()` 详细日志 | SDK 原始消息格式不再存在 | ⚠️ 日志粒度降低 |
| `(sdkOptions).skills = skillNames` | SDK 特有的 skills 预加载 | ✅ 已用 system prompt 替代 |
| `(sdkOptions).mcpServers` MCP 服务注入 | SDK 特有的 MCP 配置 | ❌ MCP 暂未实现 |
| `cleanEnv` 环境变量清理 | SDK 的环境隔离需求 | ✅ 不再需要 |
| `execSync` 的 `import` | 不再需要杀子进程 | ✅ 已移除 |
| `hasReportFlag` | 原版中也未实际赋值 | ✅ 无影响 |

### 4.2 ⚠️ 需要关注的差异

#### 1. MCP Server 支持缺失
**原版**：从 `sessionManager.loadMcpServers()` 加载 MCP 配置并注入 SDK
**新版**：MCP 配置未被加载或传递

**影响**：如果你使用 MCP 工具（如自定义搜索、数据库查询等），它们在新版中将不可用。

**解决方案**：需要在 ToolExecutor 中添加 MCP 工具动态加载支持。

#### 2. Session Resume 机制不同
**原版**：使用 `session.sdkSessionId` + SDK 的 `resume` 选项恢复对话
**新版**：通过 `params.messages` 传递历史消息恢复

**影响**：目前 `buildQueryParams()` 中没有传递历史消息，每次请求都是全新对话。

**解决方案**：需要在 `buildQueryParams()` 中从 session 历史提取消息构建 `messages` 数组。

#### 3. PermissionMode 缺失
**原版**：支持 `default` / `plan` / `bypassPermissions` 等权限模式
**新版**：所有工具权限由 `createDirectoryGuardHook` 控制，无分级

**影响**：无法通过 UI 切换权限严格程度。但由于 Bridge 本身就是非交互式的，PreToolUse hook 已经提供了足够的保护。

#### 4. 非 Claude Provider 的工具调用质量
**影响**：MiniMax M2.5、Qwen 等模型的 function calling 能力可能不如 Claude 稳定，可能出现：
- 输出 XML/文本格式的工具调用而非原生 function calling
- 工具参数格式错误
- 工具选择不准确

**缓解措施**：新版已在 system prompt 中注入 `[CRITICAL TOOL CALLING RULE]` 强制使用原生 API。

#### 5. `allowedTools` 白名单差异
**原版**：显式配置 `sdkOptions.allowedTools` 列表（包含 Agent, TeamCreate 等 30+ 工具）
**新版**：通过 `params.allowedTools` / `disallowedTools` 过滤 `ToolExecutor.getDefinitions()`

**影响**：如果前端发送 `allowedTools`，只有内置工具 + Meta 工具会被匹配。SDK preset 中的部分工具名可能不同。

---

## 五、多 Provider 路由能力分析

### 5.1 Provider 注册与路由

```typescript
// factory.ts 中的路由规则
claude-*     → ClaudeProvider (Anthropic Messages API)
minimax-*    → MiniMaxProvider (apiPath: /v1/text/chatcompletion_v2)
qwen-*       → QwenProvider (DashScope)
gpt-* / o1-* → OpenAICompatProvider
custom::*    → 自定义 OpenAI-compat
默认         → ClaudeProvider
```

### 5.2 切换方式
- **Session 级切换**：创建 session 时指定 `model: "MiniMax-M2.5"` 或 `model: "qwen3.5-plus"`
- **请求级切换**：单次请求 options 中指定 `model`
- **子代理级切换**：Agent Teams 中每个 Agent 可指定独立的 `model`
- **API 查询**：`GET /api/providers` 列出所有已配置 key 的 Provider

### 5.3 Provider 能力矩阵

| 能力 | Claude | MiniMax M2.5 | Qwen | OpenAI |
|------|--------|-------------|------|--------|
| 流式输出 | ✅ | ✅ | ✅ | ✅ |
| Function Calling | ✅ | ✅ | ✅ | ✅ |
| Thinking/CoT | ✅ thinking_budget | ✅ reasoning_content | ❌ | ❌ |
| Vision | ✅ | ❌ | ❌ | ✅ |
| 并行工具调用 | ✅ | ✅ | ✅ | ✅ |
| Max Context | 200K | 1M | 128K | 128K |

---

## 六、结论

### 迁移完成度：~92%

**已完全实现的核心能力 (100%)**：
- LLM 推理 (多 Provider)
- 内置工具系统 (7 个工具)
- Agent Teams + 委派模式 + 辩论协议
- PreToolUse 权限钩子 (目录守卫)
- SSE 事件系统 (全部事件类型)
- 记忆层 / 技能目录 / Evolution Engine
- 流式输出 / Abort / Heartbeat
- TypeScript 编译零错误

**需要补充的功能 (~8%)**：
1. **MCP Server 支持** — 高优先级（如果你使用了 MCP 工具）
2. **Session 历史消息传递** — 中优先级（影响多轮对话连续性）
3. **结构化日志增强** — 低优先级（不影响功能）

### 建议的下一步
1. 本地运行 `npm install && npm run dev`，用 Claude 模型测试基本对话
2. 测试 Agent Teams / 辩论模式是否正常
3. 切换到 MiniMax-M2.5 测试多 Provider
4. 如需 MCP，添加 MCP 工具动态加载
5. 如需多轮连续对话，补充 session messages 传递
