import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// walletConfig must be imported before App so AppKit is initialised before hooks run
import './walletConfig'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
