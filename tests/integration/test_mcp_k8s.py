"""Integration tests for the mcp-k8s HTTP server.

Expects the server to be reachable at MCP_BASE_URL (default: http://localhost:8080).
The CI workflow handles starting the server (via kubectl port-forward) before
running these tests.

All MCP POST requests include ``Accept: application/json, text/event-stream``
as required by the StreamableHTTPServerTransport (it rejects requests that do
not declare willingness to accept both content types).  Responses arrive as
plain JSON when the server decides a single round-trip is sufficient.
"""

import json
import os

import pytest
import requests

BASE_URL = os.environ.get("MCP_BASE_URL", "http://localhost:8080").rstrip("/")
TIMEOUT = 10  # seconds


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

    body = resp.json()
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

    body = resp.json()
    assert "result" in body, f"Missing result in response: {body}"

    content = body["result"].get("content", [])
    assert content, f"Empty content in result: {body['result']}"

    # The tool returns a JSON-encoded list of namespace names in content[0].text
    namespaces = json.loads(content[0]["text"])
    assert "default" in namespaces, (
        f"'default' namespace not found in list: {namespaces}"
    )
