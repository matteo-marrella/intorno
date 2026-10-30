import '@fontsource-variable/inter'
import './tokens.css'
import './base.css'
import './app.css'
import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import Lobby from './views/Lobby'
import Bubbles from './views/Bubbles'
import Picker from './views/Picker'
import { ShareFrame } from './views/ShareFrame'

const isBubbles = location.hash.startsWith('#/bubbles')
const isPicker = location.hash.startsWith('#/picker')
const isFrame = location.hash.startsWith('#/frame')
if (isBubbles || isPicker || isFrame) document.body.classList.add('transparent')

/** Se una vista va in errore non resta una finestra vuota: messaggio e via d'uscita. */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: Error): { error: string } {
    return { error: e.message }
  }
  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="toast" data-hit style={{ margin: 12 }}>
        Qualcosa è andato storto ({this.state.error}).
        <button className="btn" onClick={() => (isBubbles ? window.api.call.leave() : location.reload())}>
          {isBubbles ? 'Esci' : 'Ricarica'}
        </button>
      </div>
    )
  }
}

// Niente StrictMode: il doppio mount aprirebbe due volte la chiamata WebRTC.
createRoot(document.getElementById('root')!).render(
  <Boundary>{isBubbles ? <Bubbles /> : isPicker ? <Picker /> : isFrame ? <ShareFrame /> : <Lobby />}</Boundary>
)
