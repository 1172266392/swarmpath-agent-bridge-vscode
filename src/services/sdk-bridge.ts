/**
 * Core bridge between Claude Agent SDK and the SSE streaming layer.
 * Supports ALL SDK options and capabilities.
 */

import type { Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import type { SSEEvent, RawSDKMessage, PermissionMode, AgentDefinition, ThinkingMode, EffortLevel } from '../types.js';
import { transformSDKMessage, formatSSE, formatSSEDone } from '../utils/message-transform.js';
import type { SessionManager } from './session-manager.js';
import { DATA_DIR, getClaudeCodeExecutablePath } from './session-manager.js';

export interface BridgeQueryOptions {
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
}

export class SdkBridge {
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Execute a query against the Claude Agent SDK and yield SSE events.
   */
  async *executeQuery(
    sessionId: string,
    prompt: string,
    opts: BridgeQueryOptions = {},
  ): AsyncIterable<SSEEvent> {
    const session = this.sessionManager.getOrThrow(sessionId);

    if (session.status === 'busy') {
      throw new Error(`Session ${sessionId} is busy. Wait for the current query to finish.`);
    }

    let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      queryFn = sdk.query;
    } catch {
      throw new Error(
        'Failed to load @anthropic-ai/claude-agent-sdk. Run: npm install @anthropic-ai/claude-agent-sdk',
      );
    }

    this.sessionManager.markBusy(sessionId);
    this.sessionManager.addHistory(sessionId, {
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
    // Redirect SDK config dir to bridge data directory (teams, tasks, etc.)
    cleanEnv.CLAUDE_CONFIG_DIR = DATA_DIR;

    // Model channel routing — override API key/base URL for non-default providers
    const effectiveModel = opts.model ?? session.model;
    const modelChannel = this.sessionManager.resolveModelChannel(effectiveModel);
    if (modelChannel) {
      cleanEnv.ANTHROPIC_API_KEY = modelChannel.apiKey;
      cleanEnv.ANTHROPIC_BASE_URL = modelChannel.baseUrl;
    }

    const useAgentTeams = opts.enableAgentTeams ?? session.agentTeamsEnabled;
    if (useAgentTeams) {
      cleanEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }

    const queryOptions: SDKOptions = {
      permissionMode: (opts.permissionMode ?? session.permissionMode) as SDKOptions['permissionMode'],
      cwd: session.cwd,
      maxTurns: opts.maxTurns ?? 30,
      includePartialMessages: true,
      model: opts.model ?? session.model,
      env: cleanEnv,
      tools: { type: 'preset', preset: 'claude_code' },
      pathToClaudeCodeExecutable: getClaudeCodeExecutablePath(),
    };

    // System prompt
    const sysPrompt = opts.systemPrompt ?? session.systemPrompt;
    if (sysPrompt) {
      queryOptions.systemPrompt = { type: 'preset', preset: 'claude_code', append: sysPrompt };
    }

    // Thinking mode
    const thinkingMode = opts.thinkingMode ?? session.thinkingMode;
    if (thinkingMode) {
      switch (thinkingMode) {
        case 'adaptive': queryOptions.thinking = { type: 'adaptive' }; break;
        case 'enabled': queryOptions.thinking = { type: 'enabled' }; break;
        case 'disabled': queryOptions.thinking = { type: 'disabled' }; break;
      }
    }

    // Effort
    const effort = opts.effort ?? session.effort;
    if (effort) queryOptions.effort = effort as SDKOptions['effort'];

    // Budget
    const maxBudget = opts.maxBudgetUsd ?? session.maxBudgetUsd;
    if (maxBudget && maxBudget > 0) queryOptions.maxBudgetUsd = maxBudget;

    // Additional directories
    if (session.additionalDirectories?.length) {
      queryOptions.additionalDirectories = session.additionalDirectories;
    }

    if (opts.allowedTools?.length) queryOptions.allowedTools = opts.allowedTools;
    if (opts.disallowedTools?.length) queryOptions.disallowedTools = opts.disallowedTools;

    const agentDefs = opts.agents ?? session.agents;
    if (useAgentTeams && agentDefs && Object.keys(agentDefs).length > 0) {
      queryOptions.agents = agentDefs as SDKOptions['agents'];
    }

    if (session.sdkSessionId) {
      queryOptions.resume = session.sdkSessionId as SDKOptions['resume'];
    }

    let resultText = '';
    let costUsd = 0;

    try {
      let q: AsyncIterable<unknown>;
      try {
        q = queryFn({ prompt, options: queryOptions });
        // Attempt to read first message to detect resume failure early
        const iter = (q as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        const first = await iter.next();

        // Process first message
        if (!first.done) {
          const raw = first.value as RawSDKMessage;
          if (raw.session_id && !session.sdkSessionId) {
            this.sessionManager.setSdkSessionId(sessionId, raw.session_id);
          }
          const events = transformSDKMessage(raw);
          for (const event of events) {
            if (event.type === 'result') {
              const data = event.data as { result?: string; costUsd?: number };
              resultText = data.result ?? '';
              costUsd = data.costUsd ?? 0;
            }
            yield event;
          }
        }

        // Process remaining messages
        for await (const rawMsg of { [Symbol.asyncIterator]: () => iter }) {
          const raw = rawMsg as unknown as RawSDKMessage;
          if (raw.session_id && !session.sdkSessionId) {
            this.sessionManager.setSdkSessionId(sessionId, raw.session_id);
          }
          const events = transformSDKMessage(raw);
          for (const event of events) {
            if (event.type === 'result') {
              const data = event.data as { result?: string; costUsd?: number };
              resultText = data.result ?? '';
              costUsd = data.costUsd ?? 0;
            }
            yield event;
          }
        }
      } catch (resumeErr) {
        const errMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        // If resume failed (stale session), clear sdkSessionId and retry fresh
        if (session.sdkSessionId && /no conversation found|session.*not found|invalid session/i.test(errMsg)) {
          console.log(`[SdkBridge] Resume failed for session ${sessionId}, retrying fresh...`);
          this.sessionManager.clearSdkSessionId(sessionId);
          delete queryOptions.resume;

          q = queryFn({ prompt, options: queryOptions });
          for await (const rawMsg of q) {
            const raw = rawMsg as unknown as RawSDKMessage;
            if (raw.session_id && !session.sdkSessionId) {
              this.sessionManager.setSdkSessionId(sessionId, raw.session_id);
            }
            const events = transformSDKMessage(raw);
            for (const event of events) {
              if (event.type === 'result') {
                const data = event.data as { result?: string; costUsd?: number };
                resultText = data.result ?? '';
                costUsd = data.costUsd ?? 0;
              }
              yield event;
            }
          }
        } else {
          throw resumeErr;
        }
      }
    } catch (err) {
      const errorEvent: SSEEvent = {
        type: 'error',
        data: { message: err instanceof Error ? err.message : String(err) },
        timestamp: Date.now(),
      };
      yield errorEvent;
    } finally {
      this.sessionManager.addHistory(sessionId, {
        role: 'assistant',
        content: resultText || '(no text result)',
        timestamp: Date.now(),
        costUsd,
      });
      this.sessionManager.markIdle(sessionId);
    }
  }

  async *streamSSE(
    sessionId: string,
    prompt: string,
    opts: BridgeQueryOptions = {},
  ): AsyncIterable<string> {
    for await (const event of this.executeQuery(sessionId, prompt, opts)) {
      yield formatSSE(event);
    }
    yield formatSSEDone();
  }
}
