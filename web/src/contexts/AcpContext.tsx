// ACP connection provider — wraps the WebSocket lifecycle
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { AcpClient, connectAcp, disconnectAcp, getAcp } from "../api/acp";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface AcpContextValue {
  status: ConnectionStatus;
  error: string | null;
  sessionId: string | null;
  cwd: string | null;
  connect: (secret: string) => Promise<void>;
  disconnect: () => void;
  client: AcpClient | null;
}

const AcpCtx = createContext<AcpContextValue>({
  status: "disconnected",
  error: null,
  sessionId: null,
  cwd: null,
  connect: async () => {},
  disconnect: () => {},
  client: null,
});

export function useAcp() {
  return useContext(AcpCtx);
}

// Read secret from URL fragment (#key=...) and store in sessionStorage
function readSecret(): string | null {
  const hash = window.location.hash;
  if (!hash) return sessionStorage.getItem("grok-secret");
  const params = new URLSearchParams(hash.slice(1));
  const key = params.get("key");
  if (key) {
    sessionStorage.setItem("grok-secret", key);
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
  }
  return key ?? sessionStorage.getItem("grok-secret");
}

export function AcpProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const clientRef = useRef<AcpClient | null>(null);

  const connect = useCallback(async (secret: string) => {
    setStatus("connecting");
    setError(null);
    try {
      const c = await connectAcp(secret);
      clientRef.current = c;
      setSessionId((c as any)._sessionId ?? null); // stored after newSession
      setCwd((c as any)._cwd ?? null);
      setStatus("connected");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const disconnect = useCallback(() => {
    disconnectAcp();
    clientRef.current = null;
    setStatus("disconnected");
    setSessionId(null);
  }, []);

  // Auto-connect if secret is present in URL
  useEffect(() => {
    const secret = readSecret();
    if (secret && status === "disconnected") {
      void connect(secret);
    }
  }, []);

  return (
    <AcpCtx.Provider
      value={{
        status,
        error,
        sessionId,
        cwd,
        connect,
        disconnect,
        client: clientRef.current,
      }}
    >
      {children}
    </AcpCtx.Provider>
  );
}
