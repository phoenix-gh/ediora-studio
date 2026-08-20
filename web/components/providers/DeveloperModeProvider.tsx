'use client'

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react'

const DeveloperModeContext = createContext(false)

interface DeveloperModeProviderProps {
  children: ReactNode
}

interface RuntimeConfig {
  developerMode?: boolean
}

export function DeveloperModeProvider({ children }: DeveloperModeProviderProps) {
  const [developerMode, setDeveloperMode] = useState(false)

  useEffect(() => {
    let active = true

    void fetch('/api/runtime-config', { cache: 'no-store' })
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to load runtime configuration')
        }
        return response.json() as Promise<RuntimeConfig>
      })
      .then(config => {
        if (active) {
          setDeveloperMode(config.developerMode === true)
        }
      })
      .catch(() => {
        if (active) {
          setDeveloperMode(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <DeveloperModeContext.Provider value={developerMode}>
      {children}
    </DeveloperModeContext.Provider>
  )
}

export function useDeveloperMode() {
  return useContext(DeveloperModeContext)
}
