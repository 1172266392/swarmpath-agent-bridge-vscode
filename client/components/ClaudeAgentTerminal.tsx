/**
 * ClaudeAgentTerminal — Full-featured Claude Code terminal in the browser.
 *
 * Renders a chat-style interface showing:
 * - User prompts
 * - Claude's text responses (markdown)
 * - Thinking/reasoning process (collapsible)
 * - Tool executions (Read, Edit, Bash, etc.) with inputs/outputs
 * - Cost & duration metadata
 * - Session management bar
 *
 * Drop this component into any React app and point it at the bridge server.
 *
 * Usage:
 *   <ClaudeAgentTerminal bridgeUrl="http://localhost:3200" />
 */

import React, { useState, useRef, useEffect } from 'react';
import { useClaudeAgent } from '../hooks/useClaudeAgent.js';
import type { DisplayMessage, DisplayBlock, PermissionMode } from '../types.js';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ClaudeAgentTerminalProps {
  /** Bridge server URL */
  bridgeUrl?: string;
  /** Default working directory */
  cwd?: string;
  /** Default model */
  model?: string;
  /** Permission mode */
  permissionMode?: PermissionMode;
  /** CSS class for the root container */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ClaudeAgentTerminal({
  bridgeUrl = 'http://localhost:3200',
  cwd,
  model,
  permissionMode = 'acceptEdits',
  className = '',
}: ClaudeAgentTerminalProps) {
  const { messages, session, isStreaming, send, createSession, closeSession, clearMessages, error } =
    useClaudeAgent({
      bridgeUrl,
      defaultSessionOptions: { cwd, model, permissionMode },
    });

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || isStreaming) return;
    setInput('');
    await send(prompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className={`cab-terminal ${className}`} style={styles.container}>
      {/* Session Bar */}
      <div style={styles.sessionBar}>
        <div style={styles.sessionInfo}>
          {session ? (
            <>
              <span style={styles.sessionDot(session.status)} />
              <span style={styles.sessionName}>{session.name}</span>
              <span style={styles.sessionMeta}>
                {session.model} | {session.cwd} | ${session.totalCostUsd.toFixed(4)}
              </span>
            </>
          ) : (
            <span style={styles.sessionMeta}>No active session</span>
          )}
        </div>
        <div style={styles.sessionActions}>
          {session ? (
            <>
              <button style={styles.btn} onClick={clearMessages}>
                Clear
              </button>
              <button style={styles.btnDanger} onClick={closeSession}>
                Close
              </button>
            </>
          ) : (
            <button style={styles.btnPrimary} onClick={() => createSession()}>
              New Session
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            <div style={styles.emptyTitle}>Claude Agent Terminal</div>
            <div style={styles.emptyDesc}>
              Full Claude Code capabilities in the browser.
              <br />
              Type a prompt to start — Claude can read, edit, run commands, and more.
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageView key={msg.id} message={msg} />
        ))}
        {isStreaming && <StreamingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {error && <div style={styles.errorBar}>{error}</div>}

      {/* Input */}
      <form onSubmit={handleSubmit} style={styles.inputForm}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Claude is working...' : 'Type a prompt... (Enter to send, Shift+Enter for newline)'}
          disabled={isStreaming}
          rows={2}
          style={styles.input}
        />
        <button type="submit" disabled={isStreaming || !input.trim()} style={styles.sendBtn}>
          {isStreaming ? '...' : 'Send'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MessageView({ message }: { message: DisplayMessage }) {
  const isUser = message.role === 'user';

  return (
    <div style={styles.message(isUser)}>
      <div style={styles.messageHeader}>
        <span style={styles.roleLabel(isUser)}>{isUser ? 'You' : 'Claude'}</span>
        <span style={styles.timestamp}>{new Date(message.timestamp).toLocaleTimeString()}</span>
        {message.costUsd != null && (
          <span style={styles.cost}>${message.costUsd.toFixed(4)}</span>
        )}
        {message.durationMs != null && (
          <span style={styles.cost}>{(message.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      <div style={styles.messageBody}>
        {message.blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: DisplayBlock }) {
  switch (block.type) {
    case 'text':
      return <div style={styles.textBlock}>{block.text}</div>;

    case 'thinking':
      return <ThinkingBlock thinking={block.thinking} />;

    case 'tool_use':
      return <ToolUseBlock toolName={block.toolName} toolInput={block.toolInput} />;

    case 'tool_result':
      return <ToolResultBlock content={block.content} isError={block.isError} />;

    case 'error':
      return <div style={styles.errorBlock}>{block.message}</div>;

    default:
      return null;
  }
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div style={styles.thinkingBlock}>
      <div style={styles.thinkingHeader} onClick={() => setCollapsed(!collapsed)}>
        <span>{collapsed ? '>' : 'v'} Thinking</span>
        <span style={styles.thinkingLength}>{thinking.length} chars</span>
      </div>
      {!collapsed && <pre style={styles.thinkingContent}>{thinking}</pre>}
    </div>
  );
}

function ToolUseBlock({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
}) {
  const [collapsed, setCollapsed] = useState(false);

  // Format tool display based on tool name
  const summary = formatToolSummary(toolName, toolInput);

  return (
    <div style={styles.toolBlock}>
      <div style={styles.toolHeader} onClick={() => setCollapsed(!collapsed)}>
        <span style={styles.toolIcon}>{getToolIcon(toolName)}</span>
        <span style={styles.toolName}>{toolName}</span>
        <span style={styles.toolSummary}>{summary}</span>
      </div>
      {!collapsed && (
        <pre style={styles.toolInput}>{JSON.stringify(toolInput, null, 2)}</pre>
      )}
    </div>
  );
}

function ToolResultBlock({ content, isError }: { content: string; isError?: boolean }) {
  const [collapsed, setCollapsed] = useState(content.length > 500);
  const preview = content.length > 200 ? content.slice(0, 200) + '...' : content;

  return (
    <div style={styles.toolResultBlock(isError)}>
      <div style={styles.toolResultHeader} onClick={() => setCollapsed(!collapsed)}>
        <span>{isError ? 'Error' : 'Result'}</span>
        <span style={styles.thinkingLength}>{content.length} chars</span>
      </div>
      <pre style={styles.toolResultContent}>{collapsed ? preview : content}</pre>
    </div>
  );
}

function StreamingIndicator() {
  return (
    <div style={styles.streaming}>
      <span style={styles.streamingDot} />
      <span>Claude is working...</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    Read: '[R]',
    Edit: '[E]',
    Write: '[W]',
    Bash: '[$]',
    Glob: '[G]',
    Grep: '[S]',
    WebFetch: '[W]',
    WebSearch: '[Q]',
    Agent: '[A]',
  };
  return icons[name] ?? '[T]';
}

function formatToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return String(input.file_path ?? '');
    case 'Edit':
      return String(input.file_path ?? '');
    case 'Write':
      return String(input.file_path ?? '');
    case 'Bash':
      return String(input.command ?? '').slice(0, 80);
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Grep':
      return String(input.pattern ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Inline styles (for portability — no CSS deps)
// ---------------------------------------------------------------------------

const colors = {
  bg: '#1a1b26',
  surface: '#24283b',
  border: '#3b4261',
  text: '#c0caf5',
  textMuted: '#565f89',
  accent: '#7aa2f7',
  green: '#9ece6a',
  red: '#f7768e',
  yellow: '#e0af68',
  purple: '#bb9af7',
};

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    minHeight: '400px',
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: '13px',
    borderRadius: '8px',
    overflow: 'hidden',
    border: `1px solid ${colors.border}`,
  },
  sessionBar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: colors.surface,
    borderBottom: `1px solid ${colors.border}`,
  },
  sessionInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  sessionDot: (status: string) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: status === 'busy' ? colors.yellow : status === 'idle' ? colors.green : colors.textMuted,
  }),
  sessionName: {
    fontWeight: 600,
    color: colors.text,
  },
  sessionMeta: {
    color: colors.textMuted,
    fontSize: '11px',
  },
  sessionActions: {
    display: 'flex',
    gap: '6px',
  },
  btn: {
    padding: '4px 10px',
    borderRadius: '4px',
    border: `1px solid ${colors.border}`,
    backgroundColor: 'transparent',
    color: colors.text,
    cursor: 'pointer',
    fontSize: '11px',
  },
  btnPrimary: {
    padding: '4px 10px',
    borderRadius: '4px',
    border: 'none',
    backgroundColor: colors.accent,
    color: '#1a1b26',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
  },
  btnDanger: {
    padding: '4px 10px',
    borderRadius: '4px',
    border: `1px solid ${colors.red}`,
    backgroundColor: 'transparent',
    color: colors.red,
    cursor: 'pointer',
    fontSize: '11px',
  },
  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: '8px',
  },
  emptyTitle: {
    fontSize: '18px',
    fontWeight: 700,
    color: colors.accent,
  },
  emptyDesc: {
    color: colors.textMuted,
    textAlign: 'center' as const,
    lineHeight: 1.6,
  },
  message: (isUser: boolean) => ({
    marginBottom: '16px',
    padding: '10px 12px',
    borderRadius: '6px',
    backgroundColor: isUser ? 'transparent' : colors.surface,
    borderLeft: isUser ? `3px solid ${colors.accent}` : `3px solid ${colors.green}`,
  }),
  messageHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '6px',
  },
  roleLabel: (isUser: boolean) => ({
    fontWeight: 700,
    color: isUser ? colors.accent : colors.green,
    fontSize: '12px',
    textTransform: 'uppercase' as const,
  }),
  timestamp: {
    color: colors.textMuted,
    fontSize: '10px',
  },
  cost: {
    color: colors.yellow,
    fontSize: '10px',
    marginLeft: 'auto',
  },
  messageBody: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  textBlock: {
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    lineHeight: 1.6,
  },
  thinkingBlock: {
    borderRadius: '4px',
    border: `1px solid ${colors.border}`,
    overflow: 'hidden',
  },
  thinkingHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 10px',
    backgroundColor: colors.surface,
    cursor: 'pointer',
    color: colors.purple,
    fontSize: '11px',
    fontWeight: 600,
  },
  thinkingLength: {
    color: colors.textMuted,
    fontSize: '10px',
  },
  thinkingContent: {
    padding: '8px 10px',
    margin: 0,
    fontSize: '12px',
    color: colors.textMuted,
    whiteSpace: 'pre-wrap' as const,
    maxHeight: '300px',
    overflowY: 'auto' as const,
  },
  toolBlock: {
    borderRadius: '4px',
    border: `1px solid ${colors.border}`,
    overflow: 'hidden',
  },
  toolHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 10px',
    backgroundColor: colors.surface,
    cursor: 'pointer',
    fontSize: '12px',
  },
  toolIcon: {
    color: colors.yellow,
    fontWeight: 700,
    fontSize: '11px',
  },
  toolName: {
    color: colors.accent,
    fontWeight: 600,
  },
  toolSummary: {
    color: colors.textMuted,
    fontSize: '11px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  },
  toolInput: {
    padding: '8px 10px',
    margin: 0,
    fontSize: '11px',
    color: colors.textMuted,
    whiteSpace: 'pre-wrap' as const,
    maxHeight: '200px',
    overflowY: 'auto' as const,
    borderTop: `1px solid ${colors.border}`,
  },
  toolResultBlock: (isError?: boolean) => ({
    borderRadius: '4px',
    border: `1px solid ${isError ? colors.red : colors.border}`,
    overflow: 'hidden',
  }),
  toolResultHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 10px',
    backgroundColor: colors.surface,
    cursor: 'pointer',
    fontSize: '11px',
    color: colors.textMuted,
  },
  toolResultContent: {
    padding: '8px 10px',
    margin: 0,
    fontSize: '11px',
    color: colors.textMuted,
    whiteSpace: 'pre-wrap' as const,
    maxHeight: '300px',
    overflowY: 'auto' as const,
  },
  errorBlock: {
    padding: '8px 10px',
    borderRadius: '4px',
    backgroundColor: `${colors.red}15`,
    border: `1px solid ${colors.red}`,
    color: colors.red,
  },
  errorBar: {
    padding: '6px 12px',
    backgroundColor: `${colors.red}15`,
    color: colors.red,
    fontSize: '12px',
    borderTop: `1px solid ${colors.red}`,
  },
  streaming: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    color: colors.textMuted,
    fontSize: '12px',
  },
  streamingDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: colors.accent,
    animation: 'pulse 1s infinite',
  },
  inputForm: {
    display: 'flex',
    gap: '8px',
    padding: '8px 12px',
    borderTop: `1px solid ${colors.border}`,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: 'inherit',
    fontSize: '13px',
    resize: 'none' as const,
    outline: 'none',
  },
  sendBtn: {
    padding: '8px 16px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: colors.accent,
    color: '#1a1b26',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: '13px',
    alignSelf: 'flex-end',
  },
};
