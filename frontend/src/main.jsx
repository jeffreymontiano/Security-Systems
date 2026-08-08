import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Bootstrap 5.3 as a CSS/utility layer only — the JS bundle is deliberately NOT
// imported. Bootstrap's imperative components (data-bs-toggle, modal instances)
// fight React's render cycle; every dialog, toast and dropdown in CSOMS is a
// React component driven by state instead.
//
// Import ORDER matters. Bootstrap first, the app's own stylesheet second, so
// that where the two define the same class the app wins on equal specificity.
// index.css ends with a compatibility shim that neutralises the handful of
// collisions the app cannot win by ordering alone.
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap-icons/font/bootstrap-icons.css'
import './index.css'

import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
