/*
  TikTok Mate MCP Server (Stdio Bridge — Stateless)
  ============================================================
  设计概览:
    server-stdio.js 是一个纯 MCP over stdio 的转发桥，本身不维护任何状态。
    它将 stdin 收到的 JSON-RPC 2.0 请求通过 HTTP POST 转发给常驻的
    server.js (HTTP MCP Server，端口 33001)，再将 HTTP 响应写回 stdout。

    如果 server.js 尚未启动，则自动以 detached 模式创建子进程。

  架构:
    ┌──────────┐ MCP/stdio   ┌──────────────┐  POST /mcp   ┌──────────────┐
    │  Codex   │ ──────────→ │  stdio Bridge │ ──────────→  │  server.js   │
    │  (IDE)   │ ←────────── │ (stateless)   │ ←──────────  │  (:33001)    │
    └──────────┘             └──────────────┘              └──────────────┘
                                    │
                              ┌─────┴─────┐
                              │  日志→stderr │
                              └───────────┘
*/

import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "server-stdio.log");

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {
  /* ignore */
}

// ─── 配置 ────────────────────────────────────────────────────────────────────
const SERVER_PORT = 33001;
const SERVER_HOST = "127.0.0.1";
const SERVER_SCRIPT = join(__dirname, "server.js");
const STARTUP_RETRIES = 50; // 最多等待 50 次 × 200ms = 10s
const STARTUP_INTERVAL = 200; // 每次轮询间隔
const REQUEST_TIMEOUT = 10_000; // HTTP 请求超时

// ─── 日志 ────────────────────────────────────────────────────────────────────
function log(...args) {
  try {
    const msg = `[${new Date().toLocaleString()}] [PID:${process.pid}] ${args.join(" ")}`;
    console.error(msg);
    fs.appendFileSync(LOG_FILE, msg + "\n");
  } catch (_) {
    /* ignore */
  }
}

log("Stdio bridge started");

// ─── 全局异常捕获 ──────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  log("FATAL: Uncaught exception —", err.message, err.stack);
  console.error("FATAL: Uncaught exception —", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log(
    "FATAL: Unhandled rejection —",
    reason?.message || reason,
    reason?.stack || "",
  );
  console.error("FATAL: Unhandled rejection —", reason);
  process.exit(1);
});

// ─── HTTP 转发 ────────────────────────────────────────────────────────────────
function forwardToServer(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: SERVER_HOST,
        port: SERVER_PORT,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      },
    );
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    req.write(body);
    req.end();
  });
}

// ─── Server 进程管理 ─────────────────────────────────────────────────────────
let serverProcess = null;

function spawnServer() {
  return new Promise((resolve, reject) => {
    log("Spawning server.js as detached process...");
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: "ignore",
      cwd: __dirname,
      env: { ...process.env },
    });
    child.unref();
    serverProcess = child;
    log(`server.js spawned (PID: ${child.pid})`);

    // 等待 server 就绪
    let retries = 0;
    const check = () => {
      retries++;
      const req = http.request(
        { hostname: SERVER_HOST, port: SERVER_PORT, path: "/mcp", method: "OPTIONS" },
        (res) => {
          res.resume();
          // 收到 204 即视为就绪
          log(`server.js ready after ~${retries * STARTUP_INTERVAL}ms`);
          resolve();
        },
      );
      req.on("error", () => {
        if (retries >= STARTUP_RETRIES) {
          reject(
            new Error(
              `server.js failed to start after ${STARTUP_RETRIES * STARTUP_INTERVAL}ms`,
            ),
          );
          return;
        }
        setTimeout(check, STARTUP_INTERVAL);
      });
      req.end();
    };
    check();
  });
}

function ensureServer() {
  // 先检查是否已可连接
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: SERVER_HOST, port: SERVER_PORT, path: "/mcp", method: "OPTIONS" },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => {
      // 未启动 →  spawn
      resolve(false);
    });
    req.end();
  }).then((alive) => {
    if (alive) {
      log("server.js already running");
      return;
    }
    return spawnServer();
  });
}

// ─── MCP over Stdio 主循环 ─────────────────────────────────────────────────
async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  log("→ stdin:", trimmed);

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (e) {
    const errResp = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error: invalid JSON" },
    };
    process.stdout.write(JSON.stringify(errResp) + "\n");
    log("← stdout: parse error");
    return;
  }

  // 通知类消息（无 id）无需转发，直接忽略
  if (payload.method === "notifications/initialized" && payload.id == null) {
    return;
  }

  try {
    const resp = await forwardToServer(payload);
    const line = JSON.stringify(resp) + "\n";
    process.stdout.write(line);
    log("← stdout:", line.trim());
  } catch (err) {
    log("Forward error:", err.message);
    // 如果转发失败，返回内部错误响应
    const errResp = {
      jsonrpc: "2.0",
      id: payload.id ?? null,
      error: { code: -32603, message: `Bridge error: ${err.message}` },
    };
    process.stdout.write(JSON.stringify(errResp) + "\n");
    log("← stdout: error response");
  }
}

// ─── 启动流程 ────────────────────────────────────────────────────────────────
async function main() {
  try {
    await ensureServer();
  } catch (err) {
    log("FATAL: Cannot start server.js —", err.message);
    console.error("FATAL: Cannot start server.js —", err.message);
    process.exit(1);
  }

  // 标准错误输出就绪提示（Codex 通过此信息解析 stdio 服务）
  console.error("MCP server ready (stdio mode)");

  // 逐行读取 stdin
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    await handleLine(line);
  }
}

main().catch((err) => {
  log("FATAL: main error —", err.message, err.stack);
  console.error("FATAL: main error —", err);
  process.exit(1);
});
