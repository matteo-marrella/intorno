# Intorno

Videochiamate a bolle fluttuanti per il team (max 5 persone). Electron + React + TypeScript, WebRTC mesh, Supabase. Identità visiva Crowd Plus (token in `src/renderer/src/tokens.css`).

## Setup sviluppo

1. Crea un progetto Supabase `intorno` (piano free).
2. SQL editor → esegui `supabase/migrations/0001_init.sql`, poi inserisci le email del team:
   `insert into allowed_emails (email) values ('nome@dominio.it');`
3. Authentication → Email templates → *Magic link*: includi sia `{{ .ConfirmationURL }}` sia il codice `{{ .Token }}`.
   Authentication → URL configuration → Redirect URLs: aggiungi `intorno://auth`.
4. `cp .env.example .env` e compila URL, anon key e (opzionale) TURN.
5. `npm install && npm run dev`

Il login funziona con il link magico (apre l'app via `intorno://`) oppure incollando il codice a 6 cifre.

## Build

```bash
npm run build:mac   # dmg universal
npm run build:win   # installer nsis
```

Niente firma del codice: al primo avvio su **Mac** tasto destro → *Apri*; su **Windows** SmartScreen → *Ulteriori informazioni* → *Esegui comunque*.

## Trasferimento a Crowd Plus

1. GitHub: Settings → Transfer ownership del repo all'organizzazione Crowd Plus.
2. Supabase: Project settings → General → Transfer project all'organizzazione Crowd Plus.
3. Aggiorna `.env` (URL/chiave non cambiano col trasferimento; cambiano solo se si ricrea il progetto) e rifai la build.

Nel codice non c'è nessun riferimento ad Audio Bottega. Se cambia il proprietario del repo, aggiorna `owner` in `electron-builder.yml` e `RELEASES` in `src/main/index.ts`.

## Aggiornamenti

Le release stanno su GitHub Releases. Windows si aggiorna da solo (electron-updater); su Mac, senza firma del codice, l'app avvisa e apre il download del `.dmg`.

```bash
npm run release   # alza la versione patch e costruisce Windows + Mac in dist/
gh release create vX.Y.Z dist/intorno-X.Y.Z-setup.exe dist/intorno-X.Y.Z-setup.exe.blockmap dist/latest.yml dist/intorno-X.Y.Z-mac.dmg
```

## Struttura

- `src/main` — finestre (lobby, bolle trasparenti always-on-top), IPC, deep link, scorciatoia mute globale
- `src/renderer/src/lib/mesh.ts` — WebRTC mesh con perfect negotiation, segnalazione su Supabase Broadcast/Presence
- `src/renderer/src/views` — `Lobby` (login, stanze) e `Bubbles` (la chiamata)
- `supabase/migrations` — schema, RLS, team chiuso
