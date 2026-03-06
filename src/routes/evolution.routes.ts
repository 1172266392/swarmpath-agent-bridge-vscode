/**
 * Evolution Engine REST API routes.
 */

import type { FastifyInstance } from 'fastify';
import type { EvolutionEngine } from '../services/evolution-engine.js';
import type { SessionManager } from '../services/session-manager.js';
import type { BackgroundExecService } from '../services/background-exec.js';
import type { LaneQueue } from '../services/lane-queue.js';
import type { Finding, QueryMetrics, CronJob, HeartbeatCheck } from '../types.js';

export function registerEvolutionRoutes(
  app: FastifyInstance,
  engine: EvolutionEngine,
  sessionManager: SessionManager,
  backgroundExec?: BackgroundExecService,
  laneQueue?: LaneQueue,
) {
  // ---- Status overview ----
  app.get('/api/evolution/status', async () => {
    return engine.getStatus();
  });

  // ---- Metrics (aggregated) ----
  app.get<{ Querystring: { period?: string } }>('/api/evolution/metrics', async (request) => {
    const periodH = parseInt(request.query.period ?? '24', 10);
    const periodMs = periodH * 3600_000;
    return engine.getMetricsSummary(periodMs);
  });

  // ---- Raw metrics list ----
  app.get<{ Querystring: { period?: string; limit?: string } }>('/api/evolution/metrics/raw', async (request) => {
    const periodH = parseInt(request.query.period ?? '24', 10);
    const limit = parseInt(request.query.limit ?? '50', 10);
    return engine.getMetrics(periodH * 3600_000).slice(-limit);
  });

  // ---- Findings ----
  app.get<{ Querystring: { status?: string } }>('/api/evolution/findings', async (request) => {
    const status = request.query.status as Finding['status'] | undefined;
    return engine.getFindings(status);
  });

  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/api/evolution/findings/:id',
    async (request, reply) => {
      const { id } = request.params;
      const status = request.body?.status as Finding['status'];
      if (!status || !['acknowledged', 'dismissed', 'resolved'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status' });
      }
      const finding = engine.updateFinding(id, status);
      if (!finding) return reply.code(404).send({ error: 'Finding not found' });
      return finding;
    },
  );

  // ---- Manual reflection trigger ----
  app.post<{ Body: { sessionId?: string; metrics?: QueryMetrics; userFeedback?: string; userRating?: string } }>(
    '/api/evolution/reflect',
    async (request, reply) => {
      const { metrics, userFeedback, userRating } = request.body ?? {};

      if (!metrics) {
        return reply.code(400).send({ error: 'metrics is required' });
      }

      // Simple SDK query function using haiku for low cost
      const sdkQueryFn = async (prompt: string): Promise<string> => {
        try {
          const sdk = await import('@anthropic-ai/claude-agent-sdk');
          let resultText = '';
          const q = sdk.query({
            prompt,
            options: {
              model: 'claude-haiku-4-5-20251001',
              maxTurns: 1,
              permissionMode: 'default',
              systemPrompt: 'You are a self-analysis module for an AI agent bridge. Output structured reflections only.',
            },
          });
          for await (const msg of q) {
            const raw = msg as unknown as { type: string; result?: string };
            if (raw.type === 'result' && raw.result) {
              resultText = raw.result;
            }
          }
          return resultText;
        } catch (err) {
          throw new Error(`SDK query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const result = await engine.reflect(metrics, sdkQueryFn, userFeedback, userRating);
      if (!result) {
        return reply.code(500).send({ error: 'Reflection failed to produce results' });
      }
      return result;
    },
  );

  // ---- Rule Proposals ----
  app.get('/api/evolution/proposals', async () => {
    return engine.getProposals();
  });

  app.post<{ Params: { id: string } }>(
    '/api/evolution/proposals/:id/approve',
    async (request, reply) => {
      const ok = engine.approveProposal(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Proposal not found or already processed' });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/evolution/proposals/:id/dismiss',
    async (request, reply) => {
      const ok = engine.dismissProposal(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Proposal not found or already processed' });
      return { ok: true };
    },
  );

  // ---- Instincts (learned patterns) ----
  app.get('/api/evolution/instincts', async () => {
    return engine.getInstincts();
  });

  // ---- Scheduled task control ----
  app.patch<{ Params: { name: string }; Body: { enabled: boolean } }>(
    '/api/evolution/tasks/:name',
    async (request, reply) => {
      const ok = engine.setTaskEnabled(request.params.name, request.body?.enabled ?? true);
      if (!ok) return reply.code(404).send({ error: 'Task not found' });
      return { ok: true };
    },
  );

  // ---- Manual trigger for any scheduled task ----
  app.post<{ Params: { name: string } }>(
    '/api/evolution/tasks/:name/run',
    async (request, reply) => {
      const ok = await engine.runTask(request.params.name);
      if (!ok) return reply.code(404).send({ error: 'Task not found' });
      return { ok: true, findings: engine.getFindings('new') };
    },
  );

  // ==================================================================
  // CronJob API (aligned with ZeroClaw cron system)
  // ==================================================================

  // ---- List all cron jobs ----
  app.get('/api/cron', async () => {
    return engine.getCronJobs();
  });

  // ---- Create cron job ----
  app.post<{ Body: { name: string; expression: string; command: string } }>(
    '/api/cron',
    async (request, reply) => {
      const { name, expression, command } = request.body ?? {};
      if (!name || !expression || !command) {
        return reply.code(400).send({ error: 'name, expression, and command are required' });
      }
      const job = engine.addCronJob(name, expression, command);
      return job;
    },
  );

  // ---- Delete cron job ----
  app.delete<{ Params: { id: string } }>(
    '/api/cron/:id',
    async (request, reply) => {
      const ok = engine.removeCronJob(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Cron job not found' });
      return { ok: true };
    },
  );

  // ---- Pause cron job ----
  app.post<{ Params: { id: string } }>(
    '/api/cron/:id/pause',
    async (request, reply) => {
      const ok = engine.pauseCronJob(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Cron job not found' });
      return { ok: true };
    },
  );

  // ---- Resume cron job ----
  app.post<{ Params: { id: string } }>(
    '/api/cron/:id/resume',
    async (request, reply) => {
      const ok = engine.resumeCronJob(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Cron job not found' });
      return { ok: true };
    },
  );

  // ---- Run cron job immediately ----
  app.post<{ Params: { id: string } }>(
    '/api/cron/:id/run',
    async (request, reply) => {
      const job = await engine.runCronJobNow(request.params.id);
      if (!job) return reply.code(404).send({ error: 'Cron job not found' });
      return job;
    },
  );

  // ==================================================================
  // Background Execution API (aligned with OpenClaw exec/process tools)
  // ==================================================================

  if (backgroundExec) {
    // ---- Execute foreground command ----
    app.post<{ Body: { command: string; cwd?: string; timeout?: number } }>(
      '/api/exec',
      async (request, reply) => {
        const { command, cwd, timeout } = request.body ?? {};
        if (!command) return reply.code(400).send({ error: 'command is required' });
        const result = await backgroundExec.execForeground(command, cwd, timeout ?? 30000);
        return result;
      },
    );

    // ---- Execute background command ----
    app.post<{ Body: { command: string; cwd?: string; notifyOnExit?: boolean } }>(
      '/api/exec/background',
      async (request, reply) => {
        const { command, cwd, notifyOnExit } = request.body ?? {};
        if (!command) return reply.code(400).send({ error: 'command is required' });
        const proc = backgroundExec.execBackground(command, cwd, notifyOnExit ?? true);
        return { status: 'running', id: proc.id, pid: proc.pid };
      },
    );

    // ---- List all background processes ----
    app.get('/api/exec/processes', async () => {
      return backgroundExec.list();
    });

    // ---- Get process details + output ----
    app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
      '/api/exec/processes/:id',
      async (request, reply) => {
        const proc = backgroundExec.get(request.params.id);
        if (!proc) return reply.code(404).send({ error: 'Process not found' });
        const lines = parseInt(request.query.lines ?? '50', 10);
        return { ...proc, output: backgroundExec.getOutput(request.params.id, lines) };
      },
    );

    // ---- Kill a running process ----
    app.post<{ Params: { id: string } }>(
      '/api/exec/processes/:id/kill',
      async (request, reply) => {
        const ok = backgroundExec.kill(request.params.id);
        if (!ok) return reply.code(404).send({ error: 'Process not found or not running' });
        return { ok: true };
      },
    );

    // ---- Remove a completed process ----
    app.delete<{ Params: { id: string } }>(
      '/api/exec/processes/:id',
      async (request, reply) => {
        const ok = backgroundExec.remove(request.params.id);
        if (!ok) return reply.code(404).send({ error: 'Process not found' });
        return { ok: true };
      },
    );

    // ---- Process stats ----
    app.get('/api/exec/stats', async () => {
      return backgroundExec.getStats();
    });
  }

  // ==================================================================
  // Heartbeat API (aligned with OpenClaw Heartbeat engine)
  // ==================================================================

  // ---- Get heartbeat status ----
  app.get('/api/heartbeat', async () => {
    return {
      config: engine.getHeartbeatConfig(),
      checks: engine.getHeartbeatChecks(),
    };
  });

  // ---- Update heartbeat config ----
  app.patch<{ Body: { enabled?: boolean; intervalMs?: number } }>(
    '/api/heartbeat',
    async (request) => {
      const { enabled, intervalMs } = request.body ?? {};
      if (typeof enabled === 'boolean') engine.setHeartbeatEnabled(enabled);
      if (typeof intervalMs === 'number') engine.setHeartbeatInterval(intervalMs);
      return engine.getHeartbeatConfig();
    },
  );

  // ---- Run heartbeat now ----
  app.post('/api/heartbeat/run', async () => {
    return engine.runHeartbeat();
  });

  // ---- Add heartbeat check ----
  app.post<{ Body: { type: string; name: string; target: string; condition?: string } }>(
    '/api/heartbeat/checks',
    async (request, reply) => {
      const { type, name, target, condition } = request.body ?? {};
      if (!type || !name || !target) {
        return reply.code(400).send({ error: 'type, name, and target are required' });
      }
      return engine.addHeartbeatCheck({
        type: type as HeartbeatCheck['type'],
        name,
        target,
        condition,
      });
    },
  );

  // ---- Remove heartbeat check ----
  app.delete<{ Params: { index: string } }>(
    '/api/heartbeat/checks/:index',
    async (request, reply) => {
      const idx = parseInt(request.params.index, 10);
      const ok = engine.removeHeartbeatCheck(idx);
      if (!ok) return reply.code(404).send({ error: 'Check not found' });
      return { ok: true };
    },
  );

  // ---- Toggle heartbeat check ----
  app.post<{ Params: { index: string } }>(
    '/api/heartbeat/checks/:index/toggle',
    async (request, reply) => {
      const idx = parseInt(request.params.index, 10);
      const ok = engine.toggleHeartbeatCheck(idx);
      if (!ok) return reply.code(404).send({ error: 'Check not found' });
      return { ok: true };
    },
  );

  // ==================================================================
  // Webhook API (aligned with OpenClaw webhook trigger)
  // ==================================================================

  // ---- List webhooks ----
  app.get('/api/webhooks', async () => {
    return engine.getWebhooks();
  });

  // ---- Create webhook ----
  app.post<{ Body: { name: string; sessionTemplate?: string } }>(
    '/api/webhooks',
    async (request, reply) => {
      const { name, sessionTemplate } = request.body ?? {};
      if (!name) return reply.code(400).send({ error: 'name is required' });
      return engine.addWebhook(name, sessionTemplate);
    },
  );

  // ---- Delete webhook ----
  app.delete<{ Params: { id: string } }>(
    '/api/webhooks/:id',
    async (request, reply) => {
      const ok = engine.removeWebhook(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Webhook not found' });
      return { ok: true };
    },
  );

  // ---- Toggle webhook ----
  app.post<{ Params: { id: string } }>(
    '/api/webhooks/:id/toggle',
    async (request, reply) => {
      const ok = engine.toggleWebhook(request.params.id);
      if (!ok) return reply.code(404).send({ error: 'Webhook not found' });
      return { ok: true };
    },
  );

  // ---- Webhook trigger endpoint (external callers use this) ----
  app.post<{ Params: { token: string }; Body: { payload?: unknown } }>(
    '/api/webhook/:token',
    async (request, reply) => {
      const wh = engine.validateWebhookToken(request.params.token);
      if (!wh) return reply.code(403).send({ error: 'Invalid or disabled webhook' });

      const payload = request.body?.payload;

      // Emit event for other systems to handle
      engine.emit('webhook:trigger', { webhook: wh, payload });

      engine.addFinding({
        type: 'optimization',
        severity: 'low',
        title: `[Webhook] ${wh.name} 被触发`,
        description: `Payload: ${JSON.stringify(payload || {}).slice(0, 300)}`,
      });

      return { ok: true, webhookId: wh.id, name: wh.name, triggerCount: wh.triggerCount };
    },
  );

  // ==================================================================
  // Lane Queue API (aligned with OpenClaw two-level queue)
  // ==================================================================

  if (laneQueue) {
    app.get('/api/queue/status', async () => {
      return laneQueue.getStatus();
    });

    app.patch<{ Body: { maxConcurrent?: number } }>(
      '/api/queue/config',
      async (request) => {
        const { maxConcurrent } = request.body ?? {};
        if (typeof maxConcurrent === 'number') {
          laneQueue.setMaxConcurrent(maxConcurrent);
        }
        return { maxConcurrent: laneQueue.getMaxConcurrent() };
      },
    );
  }
}
