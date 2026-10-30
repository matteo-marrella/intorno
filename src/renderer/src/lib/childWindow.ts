import { useEffect, useState } from 'react'

/**
 * Apre una finestra figlia normale (window.open) con gli stessi stili dell'app e ci permette di
 * disegnarci dentro con un portal React: gli stream restano nella stessa pagina che gestisce la chiamata.
 */
export function useChildWindow(
  open: boolean,
  name: string,
  features: string,
  title: string,
  onClosed: () => void
): Window | null {
  const [win, setWin] = useState<Window | null>(null)
  useEffect(() => {
    if (!open) return
    const w = window.open('', name, features)
    if (!w) {
      onClosed()
      return
    }
    w.document.title = title
    document
      .querySelectorAll('style, link[rel="stylesheet"]')
      .forEach((n) => w.document.head.appendChild(n.cloneNode(true)))
    const onHide = (): void => onClosed()
    w.addEventListener('pagehide', onHide)
    setWin(w)
    return () => {
      w.removeEventListener('pagehide', onHide)
      w.close()
      setWin(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return win
}
