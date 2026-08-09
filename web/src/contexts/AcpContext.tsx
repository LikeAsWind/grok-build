// ACP connection provider — 基于 acpBridge 的连接状态封装
import React, { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import {
  ensureAcp,
  disconnectAcpBridge,
  getAcpStatus,
  getAcpStatusError,
  getServerCwd,
  hasAcpSecret,
  subscribeAcpStatus,
  type AcpStatus,
} from '../api/acpBridge'

interface AcpContextValue {
  status: AcpStatus
  error: string | null
  cwd: string | null
  connect: () => Promise<void>
  disconnect: () => void
}

const AcpCtx = createContext<AcpContextValue>({
  status: 'disconnected',
  error: null,
  cwd: null,
  connect: async () => {},
  disconnect: () => {},
})

export function useAcp() {
  return useContext(AcpCtx)
}

async function connect() {
  await ensureAcp()
}

export function AcpProvider({ children }: { children: React.ReactNode }) {
  const status = useSyncExternalStore(subscribeAcpStatus, getAcpStatus)
  const error = useSyncExternalStore(subscribeAcpStatus, getAcpStatusError)

  // 有密钥就自动连接（URL #key、sessionStorage 或服务器面板配置的密钥）
  useEffect(() => {
    if (hasAcpSecret() && getAcpStatus() === 'disconnected') {
      void ensureAcp().catch(() => {
        // 状态已在 acpBridge 内置为 error，界面通过 status 呈现
      })
    }
  }, [])

  return (
    <AcpCtx.Provider
      value={{
        status,
        error,
        cwd: getServerCwd() || null,
        connect,
        disconnect: disconnectAcpBridge,
      }}
    >
      {children}
    </AcpCtx.Provider>
  )
}
