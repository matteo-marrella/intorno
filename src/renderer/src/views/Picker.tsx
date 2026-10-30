import { useCallback, useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { ShareSource } from '../../../preload'

export default function Picker(): React.JSX.Element {
  const [sources, setSources] = useState<ShareSource[] | null>(null)
  const [denied, setDenied] = useState(false)
  const [tab, setTab] = useState<'screen' | 'window'>('screen')
  const [selected, setSelected] = useState<string | null>(null)
  const [granted, setGranted] = useState(true)
  const [leaving, setLeaving] = useState(false)
  const busy = useRef(false)

  // Chiude con un'animazione, poi esegue l'azione (annulla o conferma).
  const finish = useCallback((then: () => void) => {
    if (busy.current) return
    busy.current = true
    setLeaving(true)
    setTimeout(then, 150)
  }, [])
  const cancel = useCallback(() => finish(() => window.api.share.cancel()), [finish])
  const confirm = (id: string): void => finish(() => window.api.share.choose(id))

  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.api.share.sources().then((s) => {
        if (!alive) return
        setDenied(s === null)
        if (s) setSources(s)
      })
    }
    load()
    const t = setInterval(load, 3000) // le anteprime restano vive
    window.api.share.status().then((s) => setGranted(s === 'granted'))
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter' && selected) confirm(selected)
    }
    window.addEventListener('keydown', esc)
    const off = window.api.share.onClose(cancel)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('keydown', esc)
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, cancel])

  const list = (sources ?? []).filter((s) => s.screen === (tab === 'screen'))
  const count = (screen: boolean): number => (sources ?? []).filter((s) => s.screen === screen).length

  return (
    <div className={`pop ${leaving ? 'leaving' : ''}`}>
      <div className="pop-head">
        <h1>Condividi schermo</h1>
        <span>Gli altri lo vedono in una finestra a parte</span>
      </div>

      <div className={`tabs ${tab === 'window' ? 'win' : ''}`}>
        <button className={tab === 'screen' ? 'on' : ''} onClick={() => setTab('screen')}>
          Schermo intero{sources ? ` · ${count(true)}` : ''}
        </button>
        <button className={tab === 'window' ? 'on' : ''} onClick={() => setTab('window')}>
          Finestre{sources ? ` · ${count(false)}` : ''}
        </button>
      </div>

      {denied && (
        <div className="pop-denied">
          <strong>Serve il permesso Registrazione schermo</strong>
          <p>
            macOS non lascia vedere schermi e finestre. Abilita l’app nelle impostazioni, poi riavviala.
            In sviluppo l’app è <em>Terminal</em>.
          </p>
          <button className="btn primary" onClick={() => window.api.media.openPrivacy('ScreenCapture')}>
            Apri impostazioni
          </button>
        </div>
      )}
      {!granted && !denied && (
        <p className="pop-warn">
          Se vedi solo lo sfondo, manca il permesso <strong>Registrazione schermo</strong>.{' '}
          <button className="link" onClick={() => window.api.media.openPrivacy('ScreenCapture')}>
            Apri impostazioni
          </button>
        </p>
      )}

      <div className="pop-grid" key={tab}>
        {sources === null && !denied && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)}
        {sources !== null && !denied && list.length === 0 && (
          <p className="pop-empty">{tab === 'screen' ? 'Nessuno schermo trovato' : 'Nessuna finestra aperta'}</p>
        )}
        {list.map((s, i) => (
          <button
            key={s.id}
            className={`card ${selected === s.id ? 'sel' : ''}`}
            style={{ ['--i' as string]: i }}
            onClick={() => setSelected(s.id)}
            onDoubleClick={() => confirm(s.id)}
          >
            <img className="thumb" src={s.thumb} alt="" />
            <span className="label">
              {s.icon && <img src={s.icon} alt="" />}
              {s.name}
            </span>
            <span className="tick">
              <Check size={13} strokeWidth={3} />
            </span>
          </button>
        ))}
      </div>

      <div className="pop-foot">
        <span className="hint">Doppio click per condividere subito</span>
        <button className="btn" onClick={cancel}>
          Annulla
        </button>
        <button className="btn primary" disabled={!selected} onClick={() => selected && confirm(selected)}>
          Condividi
        </button>
      </div>
    </div>
  )
}
