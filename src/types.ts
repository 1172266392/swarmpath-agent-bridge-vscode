/**
 * Core type definitions for Claude Agent Bridge.
 * Covers ALL SDK message types and capabilities.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  /** SDK session ID (returned by first query, used for resume) */
  sdkSessionId?: string;
  /** Display name */
  name: string;
  /** Working directory */
  cwd: string;
  /** Model in use */
  model: string;
  /** Permission mode */
  permissionMode: PermissionMode;
  /** Session state */
  status: 'idle' | 'busy' | 'closed';
  /** Creation time */
  createdAt: number;
  /** Last activity time */
  lastActiveAt: number;
  /** Total queries in this session */
  queryCount: number;
  /** Accumulated cost */
  totalCostUsd: number;
  /** Conversation history (prompt + summary pairs) */
  history: HistoryEntry[];
  /** Whether Agent Teams is enabled for this session */
  agentTeamsEnabled?: boolean;
  /** Custom agent definitions for this session */
  agents?: Record<string, AgentDefinition>;
  /** Custom system prompt */
  systemPrompt?: string;
  /** Thinking mode */
  thinkingMode?: ThinkingMode;
  /** Effort level */
  effort?: EffortLevel;
  /** Max budget in USD (0 = unlimited) */
  maxBudgetUsd?: number;
  /** Max turns per query */
  maxTurns?: number;
  /** Additional directories for the session */
  additionalDirectories?: string[];
  /** Delegation mode for Agent Teams (off/soft/strict) */
  delegationMode?: DelegationMode;
  /** Debate configuration for multi-agent debates */
  debateConfig?: DebateConfig;
  /** Whether to use plan-first mode (generate plan → user approves → execute) */
  planFirst?: boolean;
}

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  costUsd?: number;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';
export type DelegationMode = 'off' | 'soft' | 'strict';

export interface DebateConfig {
  // backward compat
  rounds?: number;

  // v2.0 — AI adaptive parameters
  minRounds?: number;        // cross-exam minimum rounds (default: 1)
  maxRounds?: number;        // hard upper limit (default: 5)
  dynamicRounds?: boolean;   // adjust based on convergence (default: true)
  enableMetaAgent?: boolean; // meta-agent verdict (default: true)
  metaAgentRole?: 'impartial-judge' | 'domain-expert' | 'devils-advocate' | 'consensus-builder';
  enableAwakening?: boolean; // awakening check (default: true)
  requireSynthesis?: boolean;
  requireConsensusMap?: boolean;
  protocol?: DebateProtocol; // auto = AI decides
  topic?: string;
}

export type DebateProtocol =
  | 'auto'           // AI decides
  | 'formal'         // formal debate (all phases)
  | 'quick'          // quick compare (OPENING + META-VERDICT)
  | 'deep'           // deep research (all phases + awakening)
  | 'red-blue'       // red-blue adversarial
  | 'swot'           // SWOT four-dimension analysis
  | 'investment'     // investment review
  | 'stakeholder'    // stakeholder analysis
  | 'decision-tree'  // decision tree analysis
  | 'brainstorm';    // brainstorming

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface McpServerEntry {
  name: string;
  transport: McpTransportType;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse / http
  url?: string;
  headers?: Record<string, string>;
  // meta
  enabled: boolean;
  description?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Agent Definition
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Attachment (image / file upload)
// ---------------------------------------------------------------------------

export interface Attachment {
  /** Content type: image or file */
  type: 'image' | 'file';
  /** MIME type */
  mediaType: string;
  /** Base64-encoded content (without data URL prefix) */
  base64: string;
  /** Original filename */
  filename: string;
}

// ---------------------------------------------------------------------------
// Model Channels — multi-provider API routing
// ---------------------------------------------------------------------------

export interface ModelChannel {
  /** Unique channel ID */
  id: string;
  /** Display name (e.g. "Claude Official", "DeepSeek") */
  name: string;
  /** API key for this channel */
  apiKey: string;
  /** Base URL for this channel's API */
  baseUrl: string;
  /** Models available on this channel */
  models: string[];
  /** Whether this channel is enabled */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Session Create / Query Requests
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  name?: string;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  enableAgentTeams?: boolean;
  agents?: Record<string, AgentDefinition>;
  systemPrompt?: string;
  thinkingMode?: ThinkingMode;
  effort?: EffortLevel;
  maxBudgetUsd?: number;
  maxTurns?: number;
  additionalDirectories?: string[];
  delegationMode?: DelegationMode;
  debateConfig?: DebateConfig;
}

export interface QueryRequest {
  sessionId: string;
  prompt: string;
  /** File/image attachments (base64-encoded) */
  attachments?: Attachment[];
  options?: {
    maxTurns?: number;
    model?: string;
    permissionMode?: PermissionMode;
    allowedTools?: string[];
    disallowedTools?: string[];
    enableAgentTeams?: boolean;
    agents?: Record<string, AgentDefinition>;
    systemPrompt?: string;
    thinkingMode?: ThinkingMode;
    effort?: EffortLevel;
    maxBudgetUsd?: number;
    delegationMode?: DelegationMode;
    debateConfig?: DebateConfig;
    /** Marks this query as approved plan execution (used by plan-first mode) */
    planApproved?: boolean;
  };
}

// ---------------------------------------------------------------------------
// SSE Event Types (sent to frontend)
// ---------------------------------------------------------------------------

export type SSEEventType =
  | 'session_init'
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'stream_delta'
  | 'result'
  | 'error'
  | 'agent_status'
  | 'tool_progress'
  | 'tool_summary'
  | 'task_started'
  | 'task_progress'
  | 'task_notification'
  | 'status'
  | 'rate_limit'
  | 'prompt_suggestion'
  | 'hook_status'
  | 'compact_boundary'
  | 'local_command'
  | 'auth_status'
  | 'subagent_lifecycle'
  | 'p2p_message'
  | 'delegation_violation'
  | 'plan_approval_request'
  | 'plan_approval_response'
  | 'plan_submitted'
  | 'plan_ready';

export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Event Data Interfaces
// ---------------------------------------------------------------------------

export interface TextEvent { text: string; }
export interface ThinkingEvent { thinking: string; }
export interface ToolUseEvent { toolId: string; toolName: string; toolInput: Record<string, unknown>; }
export interface ToolResultEvent {
  toolId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
  images?: Array<{ data: string; mimeType: string }>;
}
export interface StreamDeltaEvent { delta: string; blockType?: string; blockIndex?: number; }

export interface ResultEvent {
  subtype: string;
  result?: string;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  sessionId?: string;
  isError?: boolean;
  errors?: string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export interface AgentStatusEvent {
  action: 'subagent_start' | 'subagent_stop' | 'teammate_idle' | 'task_completed';
  agentId?: string;
  agentType?: string;
  description?: string;
  teammateName?: string;
  teamName?: string;
  taskId?: string;
  taskSubject?: string;
  lastMessage?: string;
  availableAgents?: string[];
  isBackground?: boolean;
}

export interface ToolProgressEvent {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
  taskId?: string;
}

export interface ToolSummaryEvent {
  summary: string;
  toolUseIds: string[];
}

export interface TaskStartedEvent {
  taskId: string;
  description: string;
  taskType?: string;
}

export interface TaskProgressEvent {
  taskId: string;
  description: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  lastToolName?: string;
}

export interface TaskNotificationEvent {
  taskId: string;
  status: 'completed' | 'failed' | 'stopped';
  summary: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

export interface StatusEvent {
  status: string | null;
  permissionMode?: PermissionMode;
}

export interface RateLimitEvent {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

export interface PromptSuggestionEvent {
  suggestion: string;
}

export interface HookStatusEvent {
  hookId: string;
  hookName: string;
  hookEvent: string;
  phase: 'started' | 'progress' | 'response';
  output?: string;
  exitCode?: number;
  outcome?: 'success' | 'error' | 'cancelled';
}

export interface CompactBoundaryEvent {
  trigger: 'manual' | 'auto';
  preTokens: number;
}

export interface LocalCommandEvent {
  content: string;
}

export interface AuthStatusEvent {
  isAuthenticating: boolean;
  output: string[];
  error?: string;
}

export interface P2PMessageEvent {
  fromAgent: string;
  toAgent: string;
  messageType: 'message' | 'broadcast';
  contentPreview: string;
}

// ---------------------------------------------------------------------------
// SDK Message Types (internal, from Claude Agent SDK)
// ---------------------------------------------------------------------------

export interface RawSDKMessage {
  type: string;
  session_id?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  subtype?: string;
  // assistant message fields
  message?: { content?: RawContentBlock[]; [key: string]: unknown };
  error?: string;
  // result fields
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  errors?: string[];
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  stop_reason?: string | null;
  // system init fields
  agents?: string[];
  tools?: string[];
  model?: string;
  cwd?: string;
  claude_code_version?: string;
  permissionMode?: string;
  mcp_servers?: Array<{ name: string; status: string }>;
  slash_commands?: string[];
  skills?: string[];
  // stream_event fields
  event?: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
    content_block?: { type: string; id?: string; name?: string };
    [key: string]: unknown;
  };
  // tool_progress fields
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
  task_id?: string;
  // task fields
  description?: string;
  task_type?: string;
  status?: string;
  output_file?: string;
  summary?: string;
  // hook fields
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  stdout?: string;
  stderr?: string;
  output?: string;
  exit_code?: number;
  outcome?: string;
  // compact fields
  compact_metadata?: { trigger: string; pre_tokens: number };
  // local command
  content?: string;
  // auth status
  isAuthenticating?: boolean;
  // rate limit
  rate_limit_info?: Record<string, unknown>;
  // prompt suggestion
  suggestion?: string;
  // tool use summary
  preceding_tool_use_ids?: string[];
  // catch-all
  [key: string]: unknown;
}

export interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}

// ---------------------------------------------------------------------------
// Evolution Engine Types
// ---------------------------------------------------------------------------

export interface QueryMetrics {
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
  protocol?: string;
  continuationRounds?: number;
  teamDeleted?: boolean;
  forceStop?: boolean;
  hasReport?: boolean;
}

export interface Finding {
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

export interface RuleProposal {
  id: string;
  timestamp: number;
  title: string;
  section: string;
  reason: string;
  rule: string;
  status: 'pending' | 'approved' | 'dismissed';
}

export interface ReflectionResult {
  grade: 'A' | 'B' | 'C' | 'D';
  efficiency: 'high' | 'medium' | 'low';
  quality: 'high' | 'medium' | 'low';
  successPattern: string;
  improvement: string;
  knowledgeEntry: string;
}

export interface ScheduledTask {
  name: string;
  intervalMs: number;
  lastRun: number;
  enabled: boolean;
  handler: () => Promise<void>;
}

export interface CronJob {
  id: string;                     // "cj-{timestamp}-{rand}"
  name: string;                   // 用户可读名称
  expression: string;             // 简单间隔: "5m" "2h" "1d" | 一次性: "@once:30m" "@at:2024-01-01T09:00:00Z"
  command: string;                // Shell 命令
  nextRun: number;                // 下次执行时间戳
  lastRun: number;                // 上次执行时间戳
  lastStatus: 'ok' | 'error' | null;
  lastOutput: string;             // 上次输出 (截断 500 字符)
  paused: boolean;
  oneShot: boolean;               // 一次性任务执行后自动删除
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Background Execution Types (aligned with OpenClaw exec/process tools)
// ---------------------------------------------------------------------------

export interface BackgroundProcess {
  id: string;                     // "bp-{timestamp}-{rand}"
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'error';
  pid: number;
  exitCode: number | null;
  output: string[];               // ring buffer, last N lines
  startedAt: number;
  endedAt: number | null;
  notifyOnExit: boolean;          // aligned with OpenClaw tools.exec.notifyOnExit
}

// ---------------------------------------------------------------------------
// Heartbeat Types (aligned with OpenClaw Heartbeat engine)
// ---------------------------------------------------------------------------

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;             // default 30 min (1800000)
  lastRun: number;
  lastStatus: 'ok' | 'action-needed' | 'error' | null;
  lastOutput: string;
  consecutiveOk: number;          // track stable runs
}

export interface HeartbeatCheck {
  type: 'process' | 'file' | 'api' | 'command' | 'disk' | 'port';
  name: string;
  target: string;                 // process name, file path, URL, command, mount point, port number
  condition?: string;             // threshold or expected value
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Webhook Types (aligned with OpenClaw webhook trigger)
// ---------------------------------------------------------------------------

export interface WebhookConfig {
  id: string;                     // "wh-{rand}"
  name: string;
  token: string;                  // auth token for security
  enabled: boolean;
  sessionTemplate?: string;       // optional: route to specific session
  lastTriggered: number;
  triggerCount: number;
}

// ---------------------------------------------------------------------------
// Lane Queue Types (aligned with OpenClaw two-level queue)
// ---------------------------------------------------------------------------

export interface LaneQueueStatus {
  sessionLanes: Array<{ key: string; pending: number }>;
  globalLane: { running: number; max: number; queued: number };
}

