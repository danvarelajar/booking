import { randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { analyzeUntrustedText } from "./lab.js";
import { createSimpleBookingMcpServer } from "./simplebooking-mcp.js";
import { summarizeToolArgs } from "./booking-tools.js";

/**
 * SimpleBooking HTTP server: Streamable HTTP MCP at /mcp (spec-compliant via SDK),
 * plus lab and health routes.
 */

const PORT = Number(process.env.PORT || 8787);
const MCP_API_KEY_RAW = process.env.MCP_API_KEY || "";

const mcpRequestContext = new AsyncLocalStorage();

function parseBoolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(v)) return true;
  if (["false", "0", "no", "n", "off"].includes(v)) return false;
  return defaultValue;
}

const DEBUG = parseBoolEnv("SIMPLEBOOKING_DEBUG", true) || parseBoolEnv("DEBUG", false);
const DEBUG_LOG_BODIES = parseBoolEnv("SIMPLEBOOKING_DEBUG_BODIES", false);
const DEBUG_LOG_HEADERS = parseBoolEnv("SIMPLEBOOKING_DEBUG_HEADERS", false);
const LOG_FORMAT = String(process.env.SIMPLEBOOKING_LOG_FORMAT || "pretty").toLowerCase();
const LOG_MAX_FIELD_CHARS = Number(process.env.SIMPLEBOOKING_LOG_MAX_CHARS || 1200);

function makeRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.status(statusCode);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.send(payload);
}

function badRequest(res, message, extra) {
  json(res, 400, { error: message, ...(extra ? { extra } : {}) });
}

function emitLog(level, obj) {
  const time = new Date().toISOString();
  if (LOG_FORMAT === "pretty") {
    const event = obj?.event ? String(obj.event) : "-";
    const requestId = obj?.requestId ? ` requestId=${obj.requestId}` : "";
    const parts = [];
    const multiline = [];
    for (const [k, v] of Object.entries(obj || {})) {
      if (k === "event" || k === "requestId") continue;
      if (v === undefined) continue;
      const isObj = v && typeof v === "object";
      if (!isObj) {
        parts.push(`${k}=${String(v)}`);
        continue;
      }
      const rendered = JSON.stringify(v);
      if (rendered.length <= 160) {
        parts.push(`${k}=${rendered}`);
        continue;
      }
      const pretty = JSON.stringify(v, null, 2);
      const truncated =
        pretty.length > LOG_MAX_FIELD_CHARS ? `${pretty.slice(0, LOG_MAX_FIELD_CHARS)}\n  ... (truncated)` : pretty;
      multiline.push(`  ${k}=\n${truncated.split("\n").map((ln) => "  " + ln).join("\n")}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[${time}] ${level.toUpperCase()} ${event}${requestId}${parts.length ? " " + parts.join(" ") : ""}${
        multiline.length ? "\n" + multiline.join("\n") : ""
      }`
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ time, level, ...(obj || {}) }));
}

function debugLog(obj) {
  if (!DEBUG) return;
  emitLog("debug", obj);
}

function getHeader(req, name) {
  const key = name.toLowerCase();
  const v = req.headers[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (key === "x-api-key" || key === "authorization" || key === "cookie" || key === "set-cookie") {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function timingSafeEquals(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function normalizeApiKey(v) {
  let s = String(v ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function requireApiKey(req) {
  const expected = normalizeApiKey(MCP_API_KEY_RAW);
  if (!expected) return true;
  const providedRaw =
    getHeader(req, "x-api-key") || getHeader(req, "x-api_key") || getHeader(req, "X-API-Key");
  const provided = normalizeApiKey(providedRaw);
  if (!provided) return false;
  const ok = timingSafeEquals(provided, expected);
  debugLog({
    event: "auth_check",
    expectedLen: expected.length,
    providedLen: provided.length,
    ok
  });
  return ok;
}

function nowIso() {
  return new Date().toISOString();
}

/** @type {Record<string, StreamableHTTPServerTransport>} */
const transports = {};

const expressHost = process.env.SIMPLEBOOKING_EXPRESS_HOST || "0.0.0.0";
const app = createMcpExpressApp({ host: expressHost });

app.use((req, res, next) => {
  const requestId = makeRequestId();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  const redacted = redactHeaders(req.headers);
  const headerKeys = Object.keys(redacted);
  const headerSummary = {
    host: redacted.host,
    "user-agent": redacted["user-agent"],
    accept: redacted.accept,
    "content-type": redacted["content-type"],
    "content-length": redacted["content-length"],
    "mcp-protocol-version": redacted["mcp-protocol-version"],
    "mcp-session-id": redacted["mcp-session-id"]
  };
  debugLog({
    event: "http_request",
    requestId,
    method: req.method,
    path: req.path,
    query: req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : null,
    headerKeys,
    headers: DEBUG_LOG_HEADERS ? redacted : headerSummary
  });
  next();
});

function attachResponseHeaderDebug(req, res) {
  if (!DEBUG || !DEBUG_LOG_HEADERS) return;
  const requestId = req.requestId;
  const startedAt = Date.now();

  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = function patchedWriteHead(statusCode, statusMessage, headers) {
    const elapsedMs = Date.now() - startedAt;
    let resolvedHeaders = headers;
    let resolvedStatusMessage = statusMessage;

    if (typeof statusMessage === "object" && statusMessage !== null) {
      resolvedHeaders = statusMessage;
      resolvedStatusMessage = undefined;
    }

    debugLog({
      event: "http_response_write_head",
      requestId,
      path: req.path,
      method: req.method,
      elapsedMs,
      statusCode,
      statusMessage: resolvedStatusMessage,
      explicitHeaders: redactHeaders(resolvedHeaders),
      effectiveHeaders: redactHeaders(res.getHeaders())
    });

    return originalWriteHead(statusCode, statusMessage, headers);
  };
}

app.get("/health", (req, res) => {
  json(res, 200, { ok: true, time: nowIso() });
});

app.get("/lab/health", (req, res) => {
  json(res, 200, { ok: true, lab: true, time: nowIso() });
});

app.post("/lab/analyze", (req, res) => {
  const requestId = req.requestId;
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.includes("application/json")) return badRequest(res, "content-type must be application/json");
  const untrustedText = req.body?.untrustedText;
  if (typeof untrustedText !== "string") return badRequest(res, "untrustedText must be a string");
  if (DEBUG_LOG_BODIES) debugLog({ event: "lab_analyze", requestId, bytes: Buffer.byteLength(untrustedText) });
  json(res, 200, { requestId, ...analyzeUntrustedText(untrustedText) });
});

function mcpAuth(req, res, next) {
  if (!requireApiKey(req)) {
    debugLog({ event: "auth_failed", requestId: req.requestId, path: "/mcp" });
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

const mcpPostHandler = async (req, res) => {
  const requestId = req.requestId;
  const sessionId = req.headers["mcp-session-id"];
  try {
    attachResponseHeaderDebug(req, res);
    await mcpRequestContext.run({ requestId }, async () => {
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          }
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
            debugLog({ event: "mcp_transport_closed", requestId, sessionId: sid });
          }
        };
        const server = createSimpleBookingMcpServer({
          logToolCall: (tool, args) => {
            const rid = mcpRequestContext.getStore()?.requestId ?? requestId;
            emitLog("info", {
              event: "tool_call",
              requestId: rid,
              jsonrpcId: null,
              tool,
              args: summarizeToolArgs(tool, args)
            });
            if (DEBUG_LOG_BODIES) debugLog({ event: "tool_call_args", requestId: rid, tool, arguments: args });
          }
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided"
          },
          id: null
        });
        return;
      }
      if (DEBUG_LOG_BODIES) debugLog({ event: "mcp_body", requestId, sessionId, body: req.body });
      await transport.handleRequest(req, res, req.body);
    });
  } catch (err) {
    debugLog({
      event: "mcp_post_error",
      requestId,
      message: err?.message || String(err),
      stack: DEBUG ? err?.stack : undefined
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
};

const mcpGetHandler = async (req, res) => {
  const requestId = req.requestId;
  const sessionId = req.headers["mcp-session-id"];
  attachResponseHeaderDebug(req, res);
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid or missing session ID");
  }
  try {
    await mcpRequestContext.run({ requestId }, async () => {
      await transports[sessionId].handleRequest(req, res);
    });
  } catch (err) {
    debugLog({ event: "mcp_get_error", requestId, message: err?.message || String(err) });
    if (!res.headersSent) res.status(500).send("Error processing MCP GET");
  }
};

const mcpDeleteHandler = async (req, res) => {
  const requestId = req.requestId;
  const sessionId = req.headers["mcp-session-id"];
  attachResponseHeaderDebug(req, res);
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid or missing session ID");
  }
  try {
    await mcpRequestContext.run({ requestId }, async () => {
      await transports[sessionId].handleRequest(req, res);
    });
  } catch (err) {
    debugLog({ event: "mcp_delete_error", requestId, message: err?.message || String(err) });
    if (!res.headersSent) res.status(500).send("Error processing session termination");
  }
};

app.post("/mcp", mcpAuth, mcpPostHandler);
app.get("/mcp", mcpAuth, mcpGetHandler);
app.delete("/mcp", mcpAuth, mcpDeleteHandler);

app.use((req, res) => {
  json(res, 404, { error: "not found" });
});

app.use((err, req, res, next) => {
  void next;
  debugLog({
    event: "unhandled_error",
    requestId: req.requestId,
    message: err?.message || String(err),
    stack: DEBUG ? err?.stack : undefined
  });
  if (res.headersSent) return;
  json(res, 500, {
    error: "internal error",
    message: err?.message || String(err),
    ...(DEBUG ? { stack: err?.stack } : {})
  });
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[SimpleBooking] listening on http://localhost:${PORT}`);
  console.log(`- Streamable HTTP MCP: POST/GET/DELETE /mcp`);
  console.log(`- GET /health`);
});

server.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[SimpleBooking] Server error:", err?.message || err);
  if (err && typeof err === "object" && err.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.error("[SimpleBooking] Port already in use. Try a different PORT (e.g. PORT=0 for ephemeral).");
  }
  process.exitCode = 1;
});

process.on("SIGINT", async () => {
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
    } catch {
      /* ignore */
    }
    delete transports[sid];
  }
  server.close();
  process.exit(0);
});
