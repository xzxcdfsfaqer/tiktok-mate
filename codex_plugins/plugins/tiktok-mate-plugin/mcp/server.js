/*
  TikTok Mate MCP Server (HTTP)
  ============================================================
  设计概览:
    本服务器是一个轻量级 MCP (Model Context Protocol) HTTP 服务，
    作为 IDE (Codex) 与 Chrome Extension 之间的中介桥梁。

  架构:
    ┌──────────┐   MCP/HTTP    ┌──────────────┐  轮询/HTTP   ┌──────────┐
    │  Codex   │ ──────────→   │  MCP Server   │ ──────────→  │  Ext    │
    │  (IDE)   │ ←──────────   │  (:33001)    │ ←──────────  │          │
    └──────────┘               └──────┬───────┘              └──────────┘
                                      │
                    ┌─────────────────┴──────────────────┐
                    │  内部状态                            │
                    │  ┌─────────────────────────────┐   │
                    │  │ Account Registry (Map):      │   │
                    │  │  {id, account (名称),       │   │
                    │  │   status, registeredAt,      │   │
                    │  │   lastHeartbeat}             │   │
                    │  ├─────────────────────────────┤   │
                    │  │ Job Queue (Array):           │   │
                    │  │  {id, name, args, account,   │   │
                    │  │   status, createdAt, data}   │   │
                    │  └─────────────────────────────┘   │
                    └────────────────────────────────────┘

  两套通讯协议:
    ── POST /mcp ──  MCP over HTTP，供 Codex/IDE 调用
       - 遵循 JSON-RPC 2.0 协议
       - tools/list → 暴露工具清单（alive, getJob, startJob）
       - tools/call → 执行工具
         - 本地工具 (alive, getJob): 同步返回结果
         - 异步工具 (startJob): 创建 Job 放入队列，立即返回 jobId

    ── POST /job ──  Chrome Extension 统一轮询接口
       - Extension 每秒轮询一次，提交已完成 job 的结果
       - 同时作为心跳信号，30s 无心跳则标记 offline
       - 服务端返回下一个待执行的 job（如有）

  核心数据流:
    1. Codex 调用 startJob → 创建 job，状态 "queued"
    2. Extension 轮询 /job → 拿到 job，状态 → "running"
    3. Extension 执行完毕，下次轮询带回结果 → "succeed" | "failed"
    4. Codex 调用 getJob 查询最终状态

  Job 生命周期:
    queued ─→ pending ─→ running ─→ succeed
                               └──→ failed (timeout / error)

  约束:
    心跳超时: 30s
    Job 超时: 120s
    Extension 轮询间隔: ~1s
*/

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

// ─── 配置 ────────────────────────────────────────────────────────────────────
const PORT = 33001;
const HEARTBEAT_TIMEOUT = 30_000; // 心跳超时（ms）
const JOB_TIMEOUT = 120_000; // Job 执行超时（ms）

// ─── Job Schema 定义 ─────────────────────────────────────────────────────────
// 通过 MCP Resource `schemas://job` 暴露给 Codex，一处定义多处引用
const JOB_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "schemas://job",
  title: "Job",
  description: "Async job object structure used by getJob / startJob",
  type: "object",
  required: ["id", "name", "args", "status", "createdAt", "updatedAt", "data"],
  properties: {
    id: {
      type: "string",
      format: "uuid",
      description: "Job UUID",
    },
    name: {
      type: "string",
      description: "Job name",
    },
    args: {
      type: "object",
      description: "Arguments for the job",
      additionalProperties: true,
    },
    account: {
      type: ["string", "null"],
      description: "Target TikTok account",
    },
    status: {
      type: "string",
      description: "Current job status",
      enum: ["queued", "running", "succeed", "failed"],
    },
    createdAt: {
      type: "integer",
      description: "Creation timestamp in Unix milliseconds",
    },
    updatedAt: {
      type: "integer",
      description: "Last update timestamp in Unix milliseconds",
    },
    data: {
      type: "object",
      description: "Result data on succeed, error info on failed",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
};

// ─── 日志 ────────────────────────────────────────────────────────────────────
function log(...args) {
  const msg = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.error(msg);
  fs.appendFileSync("server.log", msg + "\n");
}

// ─── HTTP 工具函数 ────────────────────────────────────────────────────────────
function json(res, status, data) {
  log(`← ${status}`, JSON.stringify(data));
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function mcpOk(res, id, result, wrap) {
  json(res, 200, { jsonrpc: "2.0", id, result });
}

function mcpOkCall(res, id, result) {
  if (typeof str == "string") {
    result = {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  } else {
    result = {
      structuredContent: result,
    };
  }
  json(res, 200, { jsonrpc: "2.0", id, result });
}

function mcpErr(res, id, code, message) {
  json(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

// ─── Account 注册表 ──────────────────────────────────────────────────────────
// 管理 Chrome Extension 的注册、心跳、超时剔除
const accounts = new Map();

function getOrCreateAccount(account) {
  let acc = accounts.get(account);
  let now = Date.now();
  if (!acc) {
    acc = {
      account,
      registeredAt: now,
      lastHeartbeat: now,
    };
    accounts.set(account, acc);
    log(`Account registered: ${account}`);
  } else {
    acc.lastHeartbeat = now;
  }
  return acc;
}

function getAvailableAccounts() {
  const now = Date.now();
  return [...accounts.values()].filter(
    (a) => now - a.lastHeartbeat < HEARTBEAT_TIMEOUT,
  );
}

// ═══════════════════════════════════════════════════════════
//  Async Job 引擎
// ═══════════════════════════════════════════════════════════

const jobs = [];

function createJob(name, args, account) {
  if (!name) return;
  const job = {
    id: crypto.randomUUID(),
    name,
    args,
    account,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    data: {},
  };
  jobs.push(job);
  log(`Job ${job.id} created: ${name}`);
  return job;
}

function findJob(id) {
  return jobs.find((j) => j.id === id);
}

function handleLocalJob(job) {
  const now = Date.now();
  switch (job.name) {
    default:
      break;
  }
  return job;
}

// ─── MCP 消息路由 (POST /mcp) ──────────────────────────────────────────────
async function handleMcp(res, payload) {
  const { id, method, params } = payload || {};

  // 通知类消息无需响应
  if (method === "notifications/initialized" && id == null) {
    json(res, 202, {});
    return;
  }
  if (id == null) {
    json(res, 400, { error: "Missing request id" });
    return;
  }

  switch (method) {
    case "initialize":
      mcpOk(res, id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "tiktok-mate-mcp", version: "1.0.0" },
      });
      break;

    case "tools/list":
      mcpOk(res, id, {
        tools: [
          {
            name: "alive",
            description:
              "Health check. Returns { uptime, availableAccounts (tiktok accounts), availableJobs (list of job names & descriptions that can execute) }.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "getJob",
            description:
              "Poll job status by jobId. Returns a Job object (see resource \`schemas://job\`).",
            inputSchema: {
              type: "object",
              properties: { jobId: { type: "string" } },
              required: ["jobId"],
            },
          },
          {
            name: "startJob",
            description:
              "Submit an async job to execute. Returns the Job object (see resource \`schemas://job\`). Use getJob to poll Job status.",
            inputSchema: {
              type: "object",
              properties: {
                jobName: {
                  type: "string",
                  description: "Job name to execute",
                },
                jobArgs: {
                  type: "object",
                  description: "Optional: Arguments for the job",
                },
                jobAccount: {
                  type: "string",
                  description: "Optional: target TikTok account name",
                },
              },
              required: ["jobName"],
            },
          },
        ],
      });
      break;

    case "tools/call": {
      const { name, arguments: toolArgs } = params || {};
      if (!name) {
        mcpErr(res, id, -32602, "Missing tool name");
        break;
      }

      if (name === "alive") {
        mcpOkCall(res, id, {
          uptime: process.uptime(),
          availableAccounts: getAvailableAccounts(),
          availableJobs: [
            {
              name: "getAccountInfo",
              description: "Get profile info (bio, followers, likes)",
            },
            {
              name: "getItemInfo",
              description:
                "Get current video details (plays, likes, comments, shares)",
            },
            { name: "gotoFeed", description: "Navigate to home page feed" },
            { name: "gotoNext", description: "Go to next video" },
            { name: "hitLike", description: "Like current video" },
            { name: "hitFav", description: "Favorite current video" },
            { name: "hitFollow", description: "Follow current creator" },
          ],
        });
      } else if (name === "getJob") {
        const job = findJob(toolArgs?.jobId);
        mcpOkCall(res, id, job);
      } else if (name === "startJob") {
        const { jobName, jobArgs, jobAccount } = toolArgs || {};
        let job = createJob(jobName, jobArgs, jobAccount);
        if (job) await handleLocalJob(job);
        mcpOkCall(res, id, job);
      } else {
        mcpErr(res, id, -32601, `Unknown tool: ${name}`);
      }
      break;
    }

    case "resources/list":
      mcpOk(res, id, {
        resources: [
          {
            uri: "schemas://job",
            name: "Job Schema",
            description: "Async job object structure used by getJob / startJob",
            mimeType: "application/json",
          },
        ],
      });
      break;
    case "resources/templates/list":
      mcpOk(res, id, { resourceTemplates: [] });
      break;
    case "resources/read": {
      const content =
        params?.uri === "schemas://job"
          ? {
              uri: "schemas://job",
              mimeType: "application/json",
              text: JSON.stringify(JOB_SCHEMA),
            }
          : null;
      if (content) {
        mcpOk(res, id, {
          contents: [content],
        });
      } else {
        mcpErr(res, id, -32602, "Unknown resource URI");
      }
      break;
    }
    case "ping":
      mcpOk(res, id, {});
      break;
    default:
      mcpErr(res, id, -32601, `Method not found: ${method}`);
  }
}

// ─── Extension 轮询接口 (POST /job) ────────────────────────────────────────
/*
  请求: { account?, job: { id, status, data } }   // job 为 null 表示纯心跳
  响应: { job: { id, name, args, account, status } | null }

  流程:
    1. 注册/心跳刷新
    2. 如果带了 job 结果 → 更新 job 状态
    3. 分配下一个待执行 job（如有）
*/
async function handleExtPoll(res, payload) {
  const { windowId, account, job } = payload || {};
  const acc = getOrCreateAccount(account);
  const now = Date.now();

  // 回传结果 → 更新 job
  if (job) {
    const j = findJob(job.id);
    if (j) {
      j.status = job.status;
      j.updatedAt = now;
      j.data = job.data;
      log(`Job ${j.id} ← ${j.status}`);
    }
  } else {
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (j.status === "queued" && j.account === account) {
        j.status = "running";
        j.updatedAt = now;
        json(res, 200, { job: j });
        return;
      }
    }
  }
  json(res, 200, {});
}

// ─── HTTP 服务 ────────────────────────────────────────────────────────────────
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  // 预检请求
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const payload = await parseBody(req);
  log(`→ ${req.url}`, JSON.stringify(payload));
  if (!payload) {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  switch (req.url) {
    case "/mcp":
      await handleMcp(res, payload);
      break;
    case "/job":
      await handleExtPoll(res, payload);
      break;
    default:
      json(res, 404, { error: "Not found" });
  }
});

server.listen(PORT, () => {
  log("╔══════════════════════════════════════════════════╗");
  log("║   TikTok Mate MCP Server (HTTP)                 ║");
  log(`║   IDE  → POST /mcp   :${PORT}                     ║`);
  log(`║   Ext  → POST /job   :${PORT} (轮询 1s)           ║`);
  log("╚══════════════════════════════════════════════════╝");
});
