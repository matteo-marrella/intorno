import { useCallback, useEffect, useRef, useState } from 'react'
import { LogOut, PhoneOff, Plus, Settings, Trash2 } from 'lucide-react'
import { configured, supabase } from '../lib/supabase'
import { consumeAuthUrl, useMe, type Me } from '../lib/session'
import { usePrefs } from '../lib/prefs'
import logo from '../../../../brand/logo_crowdplus.svg'

interface Room {
  id: string
  name: string
  is_default?: boolean
}
type Occupants = Record<string, { id: string; name: string }[]>

export default function Lobby(): React.JSX.Element {
  const { me, loading } = useMe()
  const [update, setUpdate] = useState<{ version: string; auto: boolean } | null>(null)

  useEffect(() => window.api.auth.onUrl((url) => consumeAuthUrl(url)), [])
  useEffect(() => {
    const offs = [
      window.api.update.onReady((version) => setUpdate({ version, auto: true })),
      window.api.update.onAvailable((version) => setUpdate({ version, auto: false }))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  return (
    <div className="lobby">
      <div className="titlebar" />
      <header className="brand">
        <span className="wordmark">Intorno</span>
      </header>
      {update && (
        <div className="update">
          <span>
            {update.auto
              ? `Nuova versione ${update.version} pronta.`
              : `Nuova versione ${update.version} disponibile.`}
          </span>
          <button
            className="btn primary"
            onClick={() => (update.auto ? window.api.update.install() : window.api.update.download())}
          >
            {update.auto ? 'Riavvia' : 'Scarica'}
          </button>
        </div>
      )}
      {!configured ? (
        <Notice title="Configurazione mancante">
          Copia <code>.env.example</code> in <code>.env</code> con URL e chiave del progetto Supabase,
          poi riavvia.
        </Notice>
      ) : loading ? null : me ? (
        <Rooms me={me} />
      ) : (
        <Login />
      )}
      <footer className="byline">
        <span>un progetto di</span>
        <img src={logo} alt="Crowd Plus" />
      </footer>
    </div>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="notice">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  )
}

function Login(): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setBusy(false)
    if (error) {
      setError(
        /invalid login/i.test(error.message)
          ? 'Email o password non corrette.'
          : /fetch|network/i.test(error.message)
            ? 'Nessuna connessione al server. Controlla la rete.'
            : error.message
      )
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1>Ciao 👋</h1>
      <p className="soft">Entra con la tua email di lavoro e la password che ti hanno dato.</p>
      <input
        className="field"
        type="email"
        required
        autoFocus
        placeholder="nome@crowdplus.it"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        className="field"
        type="password"
        required
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
      <button className="btn primary" disabled={busy}>
        Entra
      </button>
    </form>
  )
}

function ChangePassword(): React.JSX.Element {
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (pw.length < 8) return setMsg({ ok: false, text: 'Almeno 8 caratteri.' })
    setBusy(true)
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) setMsg({ ok: false, text: error.message })
    else {
      setPw('')
      setMsg({ ok: true, text: 'Password cambiata.' })
    }
  }

  return (
    <form className="pwform" onSubmit={save}>
      <span>Cambia password</span>
      <div className="row">
        <input
          className="field"
          type="password"
          placeholder="Nuova password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <button className="btn" disabled={busy || !pw}>
          Salva
        </button>
      </div>
      {msg && <small className={msg.ok ? 'ok' : 'error'}>{msg.text}</small>}
    </form>
  )
}

function Rooms({ me }: { me: Me }): React.JSX.Element {
  const [rooms, setRooms] = useState<Room[]>([])
  const [occupants, setOccupants] = useState<Occupants>({})
  const [active, setActive] = useState<Room | null>(null)
  const [prefs, setPrefs] = usePrefs()
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [version, setVersion] = useState('')
  const [updateMsg, setUpdateMsg] = useState('')
  const [mediaMsg, setMediaMsg] = useState('')
  const [roomsError, setRoomsError] = useState('')
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState('')
  const channels = useRef<ReturnType<typeof supabase.channel>[]>([])

  // Elenco stanze condiviso: si aggiorna in tempo reale quando qualcuno ne crea o elimina una.
  const loadRooms = useCallback(() => {
    supabase
      .from('rooms')
      .select('id,name,is_default')
      .order('sort')
      .order('created_at')
      .then(({ data, error }) => {
        if (error) {
          console.warn('rooms', error)
          setRoomsError(error.message)
          // Sessione non più valida: si torna al login
          if (/jwt|expired|invalid/i.test(error.message)) supabase.auth.signOut()
          return
        }
        setRoomsError('')
        const next = data ?? []
        // Stesso elenco: non toccare lo stato, altrimenti si rifanno le sottoscrizioni alla presenza
        setRooms((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
      })
  }, [])

  useEffect(() => {
    loadRooms()
    const ch = supabase
      .channel('rooms-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, loadRooms)
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [loadRooms])

  useEffect(() => {
    window.api.call.current().then(setActive)
    window.api.settings.get().then((s) => setAutoLaunch(s.autoLaunch))
    window.api.update.version().then(setVersion)
    const offs = [
      window.api.call.onStarted(setActive),
      window.api.call.onEnded(() => setActive(null))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Ascolto (senza tracciarmi) la presenza di ogni stanza.
  useEffect(() => {
    channels.current.forEach((c) => supabase.removeChannel(c))
    channels.current = rooms.map((r) => {
      const ch = supabase.channel(`call:${r.id}`)
      ch.on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState<{ id: string; userId?: string; name: string }>()
        const all = Object.values(state).flatMap((m) => m[0] ?? [])
        // La stessa persona su due computer conta una volta sola
        const list = [...new Map(all.map((p) => [p.userId ?? p.id, p])).values()]
        setOccupants((o) => ({ ...o, [r.id]: list }))
      }).subscribe()
      return ch
    })
    return () => channels.current.forEach((c) => supabase.removeChannel(c))
  }, [rooms])

  const createRoom = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    const { error } = await supabase.from('rooms').insert({ name })
    if (error) {
      setCreateError(/duplicate|unique/i.test(error.message) ? 'Esiste già una stanza con questo nome.' : error.message)
      return
    }
    setNewName('')
    setCreateError('')
    setAdding(false)
    loadRooms()
  }

  const deleteRoom = async (room: Room): Promise<void> => {
    if (!window.confirm(`Eliminare la stanza “${room.name}” per tutto il team?`)) return
    const { error } = await supabase.from('rooms').delete().eq('id', room.id)
    if (error) setRoomsError(error.message)
    else loadRooms()
  }

  const join = async (room: Room): Promise<void> => {
    const ok = await window.api.media.ensure()
    if (!ok.microphone) {
      setMediaMsg('Microfono bloccato: abilitalo nelle impostazioni di sistema.')
      window.api.media.openPrivacy('Microphone')
      return
    }
    setMediaMsg(ok.camera ? '' : 'Camera bloccata: entrerai solo con l’audio.')
    window.api.call.join(room)
  }

  return (
    <main className="rooms">
      <div className="hello">
        <span>
          Ciao <strong>{me.name}</strong>
        </span>
        <div className="row">
          <button className="icon" title="Impostazioni" onClick={() => setShowSettings((s) => !s)}>
            <Settings size={16} />
          </button>
          <button className="icon" title="Esci" onClick={() => supabase.auth.signOut()}>
            <LogOut size={16} />
          </button>
        </div>
      </div>

      {showSettings && (
        <section className="settings">
          <label>
            Dimensione bolle
            <div className="seg">
              {(['S', 'M', 'L'] as const).map((s) => (
                <button key={s} className={prefs.size === s ? 'on' : ''} onClick={() => setPrefs({ size: s, px: undefined })}>
                  {s}
                </button>
              ))}
            </div>
          </label>
          <label className="check">
            <input type="checkbox" checked={prefs.compact} onChange={(e) => setPrefs({ compact: e.target.checked })} />
            Modalità compatta (solo bolle)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={prefs.confirmLeave}
              onChange={(e) => setPrefs({ confirmLeave: e.target.checked })}
            />
            Chiedi conferma prima di uscire
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={autoLaunch}
              onChange={(e) => window.api.settings.setAutoLaunch(e.target.checked).then(setAutoLaunch)}
            />
            Avvia con il computer
          </label>
          <p className="soft">Mute rapido: ⌘/Ctrl + Maiusc + M</p>
          <div className="pwform">
            <span>Versione {version}</span>
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  setUpdateMsg('Controllo…')
                  window.api.update.check().then(setUpdateMsg)
                }}
              >
                Controlla aggiornamenti
              </button>
            </div>
            {updateMsg && <small>{updateMsg}</small>}
          </div>
          <ChangePassword />
        </section>
      )}

      {mediaMsg && <p className="error">{mediaMsg}</p>}
      {roomsError && (
        <p className="error">
          Non riesco a caricare le stanze ({roomsError}).{' '}
          <button className="link" onClick={() => supabase.auth.signOut()}>
            Esci e rientra
          </button>
        </p>
      )}
      {!roomsError && rooms.length === 0 && (
        <p className="soft">
          Nessuna stanza visibile. Se l’email non è nel team, chiedi di aggiungerla.{' '}
          <button className="link" onClick={() => supabase.auth.signOut()}>
            Esci
          </button>
        </p>
      )}

      <ul>
        {rooms.map((r) => {
          const people = occupants[r.id] ?? []
          const isActive = active?.id === r.id
          return (
            <li key={r.id} className={isActive ? 'room live' : 'room'}>
              <div className="room-head">
                <span className="room-name">{r.name}</span>
                {!r.is_default && !isActive && people.length === 0 && (
                  <button className="icon trash" title="Elimina stanza" onClick={() => deleteRoom(r)}>
                    <Trash2 size={14} />
                  </button>
                )}
                {isActive ? (
                  <button className="btn" onClick={() => window.api.call.leave()}>
                    <PhoneOff size={14} /> Esci
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => join(r)}>
                    Entra
                  </button>
                )}
              </div>
              <div className="faces">
                {people.length === 0 && <span className="soft">Nessuno</span>}
                {people.map((p) => (
                  <span key={p.id} className="face" title={p.name}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </div>
            </li>
          )
        })}
      </ul>

      {adding ? (
        <form className="newroom" onSubmit={createRoom}>
          <input
            className="field"
            autoFocus
            maxLength={40}
            placeholder="Nome della stanza"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
          />
          <button className="btn primary" disabled={!newName.trim()}>
            Crea
          </button>
          {createError && <small className="error">{createError}</small>}
        </form>
      ) : (
        <button className="btn addroom" onClick={() => setAdding(true)}>
          <Plus size={14} /> Nuova stanza
        </button>
      )}
    </main>
  )
}
