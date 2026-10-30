import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const configured = Boolean(url && key)

// Solo la lobby rinnova il token: se lo facessero entrambe le finestre, una invaliderebbe la sessione dell'altra.
const isBubbles = location.hash.startsWith('#/bubbles')

// Il segnale WebRTC genera raffiche di messaggi ICE: alziamo il limite client.
export const supabase = createClient(url ?? 'http://localhost', key ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: !isBubbles, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 40 } }
})

export function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
  const urls = (import.meta.env.VITE_TURN_URLS as string | undefined)
    ?.split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  if (urls?.length) {
    servers.push({
      urls,
      username: import.meta.env.VITE_TURN_USERNAME as string,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string
    })
  }
  return servers
}

/** La finestra delle bolle riprende dal localStorage il token rinnovato dalla lobby. */
if (isBubbles) {
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith('sb-') || !e.key.endsWith('-auth-token') || !e.newValue) return
    try {
      const { access_token, refresh_token } = JSON.parse(e.newValue)
      if (access_token && refresh_token) {
        supabase.auth.setSession({ access_token, refresh_token })
        supabase.realtime.setAuth(access_token)
      }
    } catch {
      /* valore non valido */
    }
  })
}
