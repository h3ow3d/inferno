import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import rateLimit from 'express-rate-limit';

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const LOG_TAIL_LINES = parseInt(process.env.LOG_TAIL_LINES ?? '200', 10);
const REQUEST_TIMEOUT_MS =
  parseInt(process.env.REQUEST_TIMEOUT_SECONDS ?? '10', 10) * 1000;
const ALLOWED_NAMESPACES_ENV = process.env.ALLOWED_NAMESPACES ?? '*';
const ALLOWED_NAMESPACES: Set<string> | null =
  ALLOWED_NAMESPACES_ENV === '*'
    ? null
    : new Set(
        ALLOWED_NAMESPACES_ENV.split(',')
          .map(s => s.trim())
          .filter(Boolean),
      );

// Read-only resource allow-list (secrets are intentionally excluded)
const ALLOWED_KINDS = new Set([
  'pods',
  'deployments',
  'replicasets',
  'statefulsets',
  'daemonsets',
  'services',
  'endpoints',
  'events',
  'namespaces',
  'nodes',
  'configmaps',
]);

// ─── Kubernetes Client ──────────────────────────────────────────────────────

const kc = new k8s.KubeConfig();
try {
  kc.loadFromCluster();
  console.log('Loaded in-cluster Kubernetes config');
} catch {
  kc.loadFromDefault();
  console.log('Loaded default Kubernetes config (development mode)');
}

const coreApi = kc.makeApiClient(k8s.CoreV1Api);
const appsApi = kc.makeApiClient(k8s.AppsV1Api);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isNamespaceAllowed(ns: string): boolean {
  return ALLOWED_NAMESPACES === null || ALLOWED_NAMESPACES.has(ns);
}

function assertNamespaceAllowed(ns: string): void {
  if (!isNamespaceAllowed(ns)) {
    throw new Error(
      `Namespace '${ns}' is not in the allowed list. ` +
        `Set ALLOWED_NAMESPACES='*' to allow all namespaces.`,
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Request timed out after ${ms}ms`)),
      ms,
    );
    // Don't keep the process alive solely for this timer
    if (typeof (t as NodeJS.Timeout).unref === 'function') {
      (t as NodeJS.Timeout).unref();
    }
  });
  return Promise.race([promise, timeout]);
}

function toText(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// ─── MCP Server Factory ─────────────────────────────────────────────────────
// A new McpServer instance is created per request (stateless HTTP mode).

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-k8s',
    version: '0.1.0',
  });

  // ── list_namespaces ──────────────────────────────────────────────────────
  server.tool(
    'list_namespaces',
    'List all Kubernetes namespaces visible to this server',
    {},
    async () => {
      const list = await withTimeout(
        coreApi.listNamespace(),
        REQUEST_TIMEOUT_MS,
      );
      const names = (list.items ?? [])
        .map(ns => ns.metadata?.name)
        .filter((name): name is string => !!name && isNamespaceAllowed(name));
      return { content: [{ type: 'text', text: JSON.stringify(names, null, 2) }] };
    },
  );

  // ── list_pods ────────────────────────────────────────────────────────────
  server.tool(
    'list_pods',
    'List pods in a namespace or across all allowed namespaces',
    {
      namespace: z
        .string()
        .optional()
        .describe('Target namespace (omit for all namespaces)'),
      labelSelector: z
        .string()
        .optional()
        .describe('Kubernetes label selector, e.g. "app=nginx"'),
    },
    async ({ namespace, labelSelector }) => {
      if (namespace) assertNamespaceAllowed(namespace);
      const list = namespace
        ? await withTimeout(
            coreApi.listNamespacedPod({ namespace, labelSelector }),
            REQUEST_TIMEOUT_MS,
          )
        : await withTimeout(
            coreApi.listPodForAllNamespaces({ labelSelector }),
            REQUEST_TIMEOUT_MS,
          );
      const pods = (list.items ?? [])
        .filter(
          p =>
            !p.metadata?.namespace ||
            isNamespaceAllowed(p.metadata.namespace),
        )
        .map(p => ({
          name: p.metadata?.name,
          namespace: p.metadata?.namespace,
          phase: p.status?.phase,
          ready:
            p.status?.containerStatuses?.every(cs => cs.ready) ?? false,
          restarts:
            p.status?.containerStatuses?.reduce(
              (s, cs) => s + cs.restartCount,
              0,
            ) ?? 0,
          node: p.spec?.nodeName,
          createdAt: p.metadata?.creationTimestamp,
        }));
      return { content: [{ type: 'text', text: JSON.stringify(pods, null, 2) }] };
    },
  );

  // ── get_pod ──────────────────────────────────────────────────────────────
  server.tool(
    'get_pod',
    'Get full details of a specific pod',
    {
      namespace: z.string().describe('Namespace of the pod'),
      name: z.string().describe('Name of the pod'),
    },
    async ({ namespace, name }) => {
      assertNamespaceAllowed(namespace);
      const pod = await withTimeout(
        coreApi.readNamespacedPod({ name, namespace }),
        REQUEST_TIMEOUT_MS,
      );
      return { content: [{ type: 'text', text: toText(pod) }] };
    },
  );

  // ── get_deployment ───────────────────────────────────────────────────────
  server.tool(
    'get_deployment',
    'Get full details of a specific deployment',
    {
      namespace: z.string().describe('Namespace of the deployment'),
      name: z.string().describe('Name of the deployment'),
    },
    async ({ namespace, name }) => {
      assertNamespaceAllowed(namespace);
      const dep = await withTimeout(
        appsApi.readNamespacedDeployment({ name, namespace }),
        REQUEST_TIMEOUT_MS,
      );
      return { content: [{ type: 'text', text: toText(dep) }] };
    },
  );

  // ── list_events ──────────────────────────────────────────────────────────
  server.tool(
    'list_events',
    'List Kubernetes events in a namespace or across all allowed namespaces',
    {
      namespace: z
        .string()
        .optional()
        .describe('Target namespace (omit for all namespaces)'),
      fieldSelector: z
        .string()
        .optional()
        .describe(
          'Field selector, e.g. "involvedObject.name=my-pod,type=Warning"',
        ),
    },
    async ({ namespace, fieldSelector }) => {
      if (namespace) assertNamespaceAllowed(namespace);
      const list = namespace
        ? await withTimeout(
            coreApi.listNamespacedEvent({ namespace, fieldSelector }),
            REQUEST_TIMEOUT_MS,
          )
        : await withTimeout(
            coreApi.listEventForAllNamespaces({ fieldSelector }),
            REQUEST_TIMEOUT_MS,
          );
      const events = (list.items ?? [])
        .filter(
          e =>
            !e.metadata?.namespace ||
            isNamespaceAllowed(e.metadata.namespace),
        )
        .map(e => ({
          namespace: e.metadata?.namespace,
          type: e.type,
          reason: e.reason,
          message: e.message,
          involvedObject: e.involvedObject,
          count: e.count,
          firstTime: e.firstTimestamp,
          lastTime: e.lastTimestamp,
        }));
      return { content: [{ type: 'text', text: JSON.stringify(events, null, 2) }] };
    },
  );

  // ── get_logs ─────────────────────────────────────────────────────────────
  server.tool(
    'get_logs',
    `Retrieve logs from a pod container. Bounded to at most 1000 lines (default ${LOG_TAIL_LINES}).`,
    {
      namespace: z.string().describe('Namespace of the pod'),
      pod: z.string().describe('Pod name'),
      container: z
        .string()
        .optional()
        .describe('Container name (omit for first/only container)'),
      tailLines: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe(`Lines to tail (default ${LOG_TAIL_LINES}, max 1000)`),
    },
    async ({ namespace, pod, container, tailLines }) => {
      assertNamespaceAllowed(namespace);
      const lines = Math.min(tailLines ?? LOG_TAIL_LINES, 1000);
      const log = await withTimeout(
        coreApi.readNamespacedPodLog({
          name: pod,
          namespace,
          container,
          follow: false,
          previous: false,
          tailLines: lines,
        }),
        REQUEST_TIMEOUT_MS,
      );
      return {
        content: [
          { type: 'text', text: typeof log === 'string' ? log : toText(log) },
        ],
      };
    },
  );

  return server;
}

// ─── Express Application ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

// 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Health check (unauthenticated, no rate-limit needed for liveness probes)
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'mcp-k8s',
    version: '0.1.0',
    allowedKinds: Array.from(ALLOWED_KINDS),
    allowedNamespaces: ALLOWED_NAMESPACES_ENV,
  });
});

// MCP endpoint (stateless Streamable HTTP transport)
app.post('/mcp', limiter, async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no persistent sessions
    });
    res.on('finish', () => {
      server.close().catch(err => console.error('server.close error:', err));
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// SSE stream endpoint — not required in stateless mode
app.get('/mcp', limiter, (_req: Request, res: Response) => {
  res
    .status(405)
    .json({ error: 'SSE sessions are not supported in stateless mode. Use POST.' });
});

// Session teardown — not applicable in stateless mode
app.delete('/mcp', limiter, (_req: Request, res: Response) => {
  res.status(405).json({ error: 'Session management not supported in stateless mode.' });
});

app.listen(PORT, () => {
  console.log(`mcp-k8s server listening on :${PORT}`);
  console.log(`Allowed namespaces : ${ALLOWED_NAMESPACES_ENV}`);
  console.log(`Log tail default   : ${LOG_TAIL_LINES} lines`);
  console.log(`Request timeout    : ${REQUEST_TIMEOUT_MS}ms`);
});
