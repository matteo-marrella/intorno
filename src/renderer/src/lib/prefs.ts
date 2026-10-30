import { useEffect, useState } from 'react'

export interface Prefs {
  size: 'S' | 'M' | 'L'
  compact: boolean
  confirmLeave: boolean
}
const KEY = 'intorno.prefs'
const DEFAULTS: Prefs = { size: 'M', compact: false, confirmLeave: true }

function read(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

/** Preferenze condivise tra lobby e finestra bolle (stesso origin → evento `storage`). */
export function usePrefs(): [Prefs, (p: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>(read)
  useEffect(() => {
    const h = (e: StorageEvent): void => {
      if (e.key === KEY) setPrefs(read())
    }
    window.addEventListener('storage', h)
    return () => window.removeEventListener('storage', h)
  }, [])
  const update = (p: Partial<Prefs>): void => {
    const next = { ...read(), ...p }
    localStorage.setItem(KEY, JSON.stringify(next))
    setPrefs(next)
  }
  return [prefs, update]
}

export const BUBBLE_PX = { S: 96, M: 132, L: 184 } as const
