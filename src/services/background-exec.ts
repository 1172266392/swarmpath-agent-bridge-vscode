/**
 * Background Execution Service — aligned with OpenClaw exec/process tools.
 *
 * Provides:
 * - Background command execution with output tracking
 * - Process lifecycle management (list, poll, kill)
 * - Notify-on-exit → findings integration
 * - Per-process output ring buffer (last 200 lines)
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { BRIDGE_ROOT } from './session-manager.js';
import type { BackgroundProcess } from '../types.js';

const MAX_OUTPUT_LINES = 200;
const DEFAULT_TIMEOUT = 0; // 0 = no timeout

export class BackgroundExecService extends EventEmitter {
  private processes = new Map<string, { proc: BackgroundProcess; child: ChildProcess }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    super();
    // Auto-clean completed processes every 10 minutes (retain for 1 hour)
    this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60_000);
  }

  /**
   * Execute a command in the foreground (wait for completion).
   * Returns output directly. Times out after `timeout` ms.
   */
  async execForeground(command: string, cwd?: string, timeout = 30_000): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-lc', command], {
        cwd: cwd || BRIDGE_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      const timer = timeout > 0 ? setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ exitCode: -1, output: output + '\n[TIMEOUT after ' + timeout + 'ms]' });
      }, timeout) : null;

      child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code ?? -1, output });
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: -1, output: err.message });
      });
    });
  }

  /**
   * Execute a command in the background (return immediately).
   * Aligned with OpenClaw: returns status "running" + sessionId + tail output.
   */
  execBackground(command: string, cwd?: string, notifyOnExit = true): BackgroundProcess {
    const id = `bp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const child = spawn('sh', ['-lc', command], {
      cwd: cwd || BRIDGE_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const proc: BackgroundProcess = {
      id,
      command,
      cwd: cwd || BRIDGE_ROOT,
      status: 'running',
      pid: child.pid || 0,
      exitCode: null,
      output: [],
      startedAt: Date.now(),
      endedAt: null,
      notifyOnExit,
    };

    // Ring buffer for output
    const appendOutput = (data: Buffer) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line) {
          proc.output.push(line);
          if (proc.output.length > MAX_OUTPUT_LINES) {
            proc.output.shift();
          }
        }
      }
    };

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    child.on('close', (code) => {
      proc.status = code === 0 ? 'exited' : 'error';
      proc.exitCode = code;
      proc.endedAt = Date.now();
      if (notifyOnExit) {
        this.emit('process:exit', proc);
      }
    });

    child.on('error', (err) => {
      proc.status = 'error';
      proc.exitCode = -1;
      proc.endedAt = Date.now();
      proc.output.push(`[ERROR] ${err.message}`);
      if (notifyOnExit) {
        this.emit('process:exit', proc);
      }
    });

    this.processes.set(id, { proc, child });
    return proc;
  }

  /**
   * List all tracked background processes.
   */
  list(): BackgroundProcess[] {
    return Array.from(this.processes.values()).map(e => e.proc);
  }

  /**
   * Get a single process by ID.
   */
  get(id: string): BackgroundProcess | null {
    return this.processes.get(id)?.proc || null;
  }

  /**
   * Get tail output of a process (last N lines).
   */
  getOutput(id: string, lines = 50): string[] {
    const entry = this.processes.get(id);
    if (!entry) return [];
    return entry.proc.output.slice(-lines);
  }

  /**
   * Kill a running process.
   */
  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const entry = this.processes.get(id);
    if (!entry || entry.proc.status !== 'running') return false;
    entry.child.kill(signal);
    return true;
  }

  /**
   * Remove a completed/errored process from tracking.
   */
  remove(id: string): boolean {
    const entry = this.processes.get(id);
    if (!entry) return false;
    if (entry.proc.status === 'running') {
      entry.child.kill('SIGKILL');
    }
    this.processes.delete(id);
    return true;
  }

  /**
   * Clean up all completed processes older than `maxAge` ms.
   */
  cleanup(maxAgeMs = 3600_000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, entry] of this.processes) {
      if (entry.proc.status !== 'running' && (entry.proc.endedAt || 0) < cutoff) {
        this.processes.delete(id);
      }
    }
  }

  /**
   * Get summary stats.
   */
  getStats() {
    const all = this.list();
    return {
      total: all.length,
      running: all.filter(p => p.status === 'running').length,
      exited: all.filter(p => p.status === 'exited').length,
      errored: all.filter(p => p.status === 'error').length,
    };
  }

  /**
   * Destroy all processes on shutdown.
   */
  destroy() {
    clearInterval(this.cleanupTimer);
    for (const [, entry] of this.processes) {
      if (entry.proc.status === 'running') {
        entry.child.kill('SIGKILL');
      }
    }
    this.processes.clear();
  }
}
