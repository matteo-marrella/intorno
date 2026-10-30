import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export interface Me {
  id: string
  email: string
  name: string
  /** il profilo è stato letto: il nome è quello definitivo */
  ready: boolean
}

/** Sessione + profilo. Le due finestre condividono il localStorage, quindi la stessa sessione. */
export function useMe(): { session: Session | null; me: Me | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [profileDone, setProfileDone] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const uid = session?.user.id
  useEffect(() => {
    setProfileDone(false)
    if (!uid) return setName(null)
    supabase
      .from('profiles')
      .select('display_name')
      .eq('id', uid)
      .maybeSingle()
      .then(({ data }) => {
        setName(data?.display_name ?? null)
        setProfileDone(true)
      })
  }, [uid])

  const email = session?.user.email ?? ''
  const me = session
    ? { id: session.user.id, email, name: name ?? email.split('@')[0], ready: profileDone }
    : null
  return { session, me, loading }
}

/** Accetta il link magico (intorno://auth#access_token=...&refresh_token=...). */
export async function consumeAuthUrl(url: string): Promise<string | null> {
  const frag = new URLSearchParams(url.split('#')[1] ?? url.split('?')[1] ?? url)
  const access_token = frag.get('access_token')
  const refresh_token = frag.get('refresh_token')
  if (!access_token || !refresh_token) return frag.get('error_description') ?? 'Link non valido'
  const { error } = await supabase.auth.setSession({ access_token, refresh_token })
  return error?.message ?? null
}
