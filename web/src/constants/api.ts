/** grok 后端基础地址 - 优先环境变量；默认同源（grok web 单二进制托管 / vite dev 走 proxy） */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:2420')
