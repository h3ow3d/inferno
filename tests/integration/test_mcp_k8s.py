"""Integration tests for the mcp-k8s HTTP server.

Expects the server to be reachable at MCP_BASE_URL (default: http://localhost:8080).
The CI workflow handles starting the server (via kubectl port-forward) before
running these tests.

All MCP POST requests include ``Accept: application/json, text/event-stream``
as required by the StreamableHTTPServerTransport (it rejects requests that do
not declare willingness to accept both content types).  Responses may arrive as
Server-Sent Events (SSE) with ``Content-Type: text/event-stream``, so we parse
the ``data:`` lines to extract the JSON payload.
"""

import json
import os

import requests

BASE_URL = os.environ.get("MCP_BASE_URL", "http://localhost:8080").rstrip("/")
TIMEOUT = 10  # seconds


def parse_mcp_response(resp: requests.Response) -> dict:
    """Parse an MCP response that may be plain JSON or SSE (text/event-stream).

    The StreamableHTTPServerTransport always wraps responses in SSE format::

        event: message
        data: {"jsonrpc": "2.0", ...}

    This helper extracts the first ``data:`` payload and returns it as a dict.
    Falls back to ``resp.json()`` when the response is plain JSON.
    """
    content_type = resp.headers.get("Content-Type", "")
    if "text/event-stream" in content_type or resp.text.startswith("event:"):
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[len("data:"):].strip())
        raise ValueError(f"No data: line found in SSE response: {resp.text!r}")
    return resp.json()


# ── Test 1: health endpoint ──────────────────────────────────────────────────

def test_health_check():
    """GET /health returns status ok and expected fields."""
    resp = requests.get(f"{BASE_URL}/health", timeout=TIMEOUT)
    assert resp.status_code == 200, f"Unexpected status: {resp.status_code}\n{resp.text}"

    body = resp.json()
    assert body.get("status") == "ok", f"Expected status=ok, got: {body}"
    assert body.get("service") == "mcp-k8s", f"Unexpected service field: {body}"
    assert "allowedKinds" in body, f"Missing allowedKinds in response: {body}"
    assert "allowedNamespaces" in body, f"Missing allowedNamespaces in response: {body}"


# ── Test 2: MCP initialize ───────────────────────────────────────────────────

def test_mcp_initialize():
    """POST /mcp with jsonrpc initialize returns a valid protocol version."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "ci-test", "version": "0.0.1"},
        },
    }
    resp = requests.post(
        f"{BASE_URL}/mcp",
        json=payload,
        headers={"Accept": "application/json, text/event-stream"},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 200, f"Unexpected status: {resp.status_code}\n{resp.text}"

    body = parse_mcp_response(resp)
    assert "result" in body, f"Missing result in response: {body}"
    assert "protocolVersion" in body["result"], (
        f"Missing protocolVersion in result: {body['result']}"
    )


# ── Test 3: list_namespaces tool call ────────────────────────────────────────

def test_list_namespaces_contains_default():
    """POST /mcp tools/call list_namespaces includes the 'default' namespace."""
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": "list_namespaces", "arguments": {}},
    }
    resp = requests.post(
        f"{BASE_URL}/mcp",
        json=payload,
        headers={"Accept": "application/json, text/event-stream"},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 200, f"Unexpected status: {resp.status_code}\n{resp.text}"

    body = parse_mcp_response(resp)
    assert "result" in body, f"Missing result in response: {body}"

    content = body["result"].get("content", [])
    assert content, f"Empty content in result: {body['result']}"

    # The tool returns a JSON-encoded list of namespace names in content[0].text
    namespaces = json.loads(content[0]["text"])
    assert "default" in namespaces, (
        f"'default' namespace not found in list: {namespaces}"
    )
