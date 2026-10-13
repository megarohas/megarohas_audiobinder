import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'
import * as actions from './actions.ts'
import * as player from './player.ts'
import * as chapters from '../../core/chapters.ts'
import { useStore } from './store.ts'

// Hook for the headless smoke run (see src/main/smoke.ts).
if (new URLSearchParams(location.search).has('smoke')) {
  Object.assign(window, { __ab: { store: useStore, actions, player, chapters } })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
