import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import './styles.css'

// Updates land silently on the next launch: interrupting someone mid-grid to ask
// about a new version would be worse than a one-launch delay.
registerSW({ immediate: true })

const container = document.getElementById('root')
if (!container) throw new Error('#root introuvable')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
