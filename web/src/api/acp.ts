// ============================================
// ACP (Agent Client Protocol) adapter for grok
// Replaces OpenCodeUI's REST SDK with WebSocket JSON-RPC.
// ============================================

// ── JSON-RPC over WebSocket ──────────────────────────────────────────

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: unknown) => void;

const METHOD_NOT_FOUND = -32601;

// ACP 扩展方法在 wire 上带 "_" 前缀（如 "_x.ai/session/list"）；
// 解码器只把带前缀的自定义方法路由到 ext_method。对调用方隐藏此细节。
function addExtPrefix(method: string): string {
  return method.startsWith("_") ? method : `_${method}`;
}

function stripExtPrefix(method: string): string {
  return method.startsWith("_") ? method.slice(1) : method;
}

class JsonRpc {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private onSrvReq: ServerRequestHandler | null = null;
  private onNotif: NotificationHandler | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => this.handle(ev.data);
  }

  onServerRequest(h: ServerRequestHandler) { this.onSrvReq = h; }
  onNotification(h: NotificationHandler) { this.onNotif = h; }

  private handle(data: unknown) {
    let m: unknown;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (typeof m !== "object" || m === null) return;
    const msg = m as Record<string, unknown>;
    if (typeof msg.id === "number" && "method" in msg) {
      void this.dispatchSrvReq(msg as { id: number; method: string; params?: unknown });
    } else if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ("error" in msg && msg.error) {
        p.reject(new Error((msg.error as { message?: string })?.message ?? "rpc error"));
      } else {
        p.resolve(msg.result);
      }
    } else if (typeof msg.method === "string") {
      this.onNotif?.(msg.method, msg.params);
    }
  }

  private async dispatchSrvReq(msg: { id: number; method: string; params?: unknown }) {
    let result: unknown; let error: unknown;
    if (this.onSrvReq) {
      try { result = await this.onSrvReq(msg.method, msg.params); } catch (e) {
        error = { code: -32000, message: e instanceof Error ? e.message : String(e) };
      }
    } else {
      error = { code: METHOD_NOT_FOUND, message: "method not found" };
    }
    this.send({ jsonrpc: "2.0", id: msg.id, ...(error ? { error } : { result: result ?? null }) });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`WebSocket not open (readyState=${this.ws.readyState})`))
        return
      }
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  close() {
    for (const [, p] of this.pending) p.reject(new Error("closed"));
    this.pending.clear();
  }
}

// ── ACP Client ──────────────────────────────────────────────────────

export interface AcpCallbacks {
  onSessionUpdate: (params: Record<string, unknown>) => void;
  onRequestPermission: (params: Record<string, unknown>, respond: (r: Record<string, unknown>) => void) => void;
  onAskUserQuestion: (params: unknown, respond: (r: unknown) => void) => void;
  onExitPlanMode: (params: unknown, respond: (r: unknown) => void) => void;
  onExtNotification: (method: string, params: unknown) => void;
}

export class AcpClient {
  ws: WebSocket;
  rpc: JsonRpc;
  private cb: AcpCallbacks;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ws: WebSocket, cb: AcpCallbacks) {
    this.ws = ws;
    this.cb = cb;
    this.rpc = new JsonRpc(ws);
    this.rpc.onNotification((m, p) => {
      const method = stripExtPrefix(m);
      if (method === "session/update") this.cb.onSessionUpdate(p as Record<string, unknown>);
      else this.cb.onExtNotification(method, p);
    });
    this.rpc.onServerRequest((m, p) => {
      const method = stripExtPrefix(m);
      if (method === "session/request_permission")
        return new Promise((r) => this.cb.onRequestPermission(p as Record<string, unknown>, r));
      if (method === "x.ai/ask_user_question")
        return new Promise((r) => this.cb.onAskUserQuestion(p, r));
      if (method === "x.ai/exit_plan_mode")
        return new Promise((r) => this.cb.onExitPlanMode(p, r));
      return Promise.reject({ code: METHOD_NOT_FOUND, message: "not found" });
    });
    this.pingTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send("ping");
    }, 15_000);
  }

  static async connect(url: string, secret: string, cb: AcpCallbacks): Promise<AcpClient> {
    const u = new URL(url);
    u.searchParams.set("server-key", secret);
    const ws = new WebSocket(u.toString());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
    });
    return new AcpClient(ws, cb);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async initialize(): Promise<Record<string, unknown>> {
    return (await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      _meta: { clientType: "web", clientVersion: "0.1.0" },
    })) as Record<string, unknown>;
  }

  async authenticate(methodId: string): Promise<void> {
    await this.rpc.request("authenticate", { methodId });
  }

  async newSession(cwd: string): Promise<{ sessionId: string; models?: unknown }> {
    return (await this.rpc.request("session/new", {
      cwd, mcpServers: [],
    })) as { sessionId: string; models?: unknown };
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.rpc.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string; _meta?: unknown }> {
    return (await this.rpc.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason: string; _meta?: unknown };
  }

  async cancel(sessionId: string): Promise<void> {
    this.rpc.notify("session/cancel", { sessionId });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.rpc.request("session/set_model", { sessionId, modelId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.rpc.request("session/set_mode", { sessionId, modeId });
  }

  async extRequest(method: string, params?: unknown): Promise<unknown> {
    return await this.rpc.request(addExtPrefix(method), params ?? {});
  }

  extNotify(method: string, params?: unknown): void {
    this.rpc.notify(addExtPrefix(method), params ?? {});
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.rpc.close();
    this.ws.close();
  }
}

// ── Singleton ───────────────────────────────────────────────────────
// 连接单例与事件转译由 ./acpBridge.ts 管理（ensureAcp / acpPrompt / ...）

