# mcp-k8s

An in-cluster Kubernetes observer [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that exposes read-only cluster visibility as MCP tools. Designed to be deployed inside a Kubernetes cluster and called by an external AI agent/orchestrator.

## Overview

The server exposes a set of read-only Kubernetes tools over an HTTP MCP endpoint. An AI agent running outside the cluster (e.g. on your local machine or in Docker) can query the server via `kubectl port-forward` to observe cluster state and generate reports without risking any mutations.

## Tools

| Tool | Description |
|------|-------------|
| `list_namespaces` | List all Kubernetes namespaces visible to the server |
| `list_pods` | List pods in a namespace or across all namespaces |
| `get_pod` | Get full details of a specific pod |
| `get_deployment` | Get full details of a specific deployment |
| `list_events` | List events in a namespace or across all namespaces |
| `get_logs` | Retrieve bounded logs from a pod container |

## Deploying to Kubernetes

### Prerequisites

- A Kubernetes cluster with `kubectl` configured
- `kustomize` (included in `kubectl` 1.14+)

### Apply manifests

```bash
kubectl apply -k k8s/mcp-k8s
```

This creates:
- `inferno` namespace
- `mcp-k8s` ServiceAccount
- `mcp-k8s-readonly` ClusterRole (read-only, no secrets)
- `mcp-k8s-readonly` ClusterRoleBinding
- `mcp-k8s` Deployment in the `inferno` namespace
- `mcp-k8s` ClusterIP Service

### Verify the deployment

```bash
kubectl -n inferno rollout status deployment/mcp-k8s
kubectl -n inferno get pods
```

### Health check

```bash
kubectl -n inferno exec -it <pod-name> -- wget -qO- http://localhost:8080/health
```

## Reaching the server from your local machine

The service is a `ClusterIP` (internal-only). Use `kubectl port-forward` to reach it locally:

```bash
kubectl -n inferno port-forward svc/mcp-k8s 8080:8080
```

Then point your MCP client at `http://localhost:8080/mcp`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port the server listens on |
| `ALLOWED_NAMESPACES` | `*` | Comma-separated namespace allow-list, or `*` for all |
| `LOG_TAIL_LINES` | `200` | Default number of log lines to tail |
| `REQUEST_TIMEOUT_SECONDS` | `10` | Kubernetes API call timeout in seconds |

## Security notes

### Read-only by design
The server enforces read-only behaviour at two layers:
1. **RBAC** — the `mcp-k8s-readonly` ClusterRole grants only `get/list/watch` verbs. No `create/update/patch/delete` are permitted.
2. **Application layer** — the server only implements read tools. Write operations are never attempted.

### Secrets are excluded
The ClusterRole does **not** grant access to `secrets`. The application-layer resource allow-list also excludes `secrets`.

### Log access
`get_logs` tails pod logs. Logs may contain sensitive application data. The default is 200 lines (max 1000). Limit access to the MCP endpoint using Kubernetes NetworkPolicy or an ingress with authentication if needed.

### Cluster-wide RBAC
The ClusterRoleBinding grants cluster-wide read access (all namespaces). Use the `ALLOWED_NAMESPACES` environment variable to restrict visibility at the application layer if you only need to observe specific namespaces.

### Container security
The container runs as non-root (UID 1000) with:
- `readOnlyRootFilesystem: true`
- `allowPrivilegeEscalation: false`
- All Linux capabilities dropped

## Building locally

```bash
cd mcp-k8s
npm install
npm run build
node dist/index.js
```

For development with hot reload:

```bash
cd mcp-k8s
npm run dev
```

## Container image

Two workflows publish images to GitHub Container Registry:

**`ci-mcp-k8s.yml`** — runs on every branch push, deploys to a temporary kind cluster, runs integration tests, and only pushes after tests pass:

| Git event | Image tag |
|-----------|-----------|
| Push to any branch | `:<branch-name>` (slashes become dashes, e.g. `feature-my-feat`) |

**`publish-mcp-k8s.yml`** — runs on pushes to `main` and version tags, builds multi-arch and publishes:

| Git event | Image tags |
|-----------|-----------|
| Push to `main` | `:main`, `:latest` |
| Push tag `v0.1.0` | `:0.1.0`, `:0.1` |

```bash
docker pull ghcr.io/h3ow3d/mcp-k8s:latest
```
