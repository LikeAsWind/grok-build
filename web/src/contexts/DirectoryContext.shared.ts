import { createContext } from 'react'
import type { ApiPath } from '../api'

export interface DirectoryContextValue {
  currentDirectory: string | undefined
  setCurrentDirectory: (directory: string | undefined) => void
  recentProjects: Record<string, number>
  touchDirectory: (path: string) => void
  pathInfo: ApiPath | null
  sidebarExpanded: boolean
  setSidebarExpanded: (expanded: boolean) => void
}

export const DirectoryContext = createContext<DirectoryContextValue | null>(null)