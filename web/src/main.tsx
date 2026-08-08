import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installClientLogs, reactErrorHandlers } from '@/lib/clientLogs'

// **画面を作る前に据える**（設計§12-1）。描き始めてから据えると、最初の1描画で
// 起きたエラーだけが誰にも拾われない
installClientLogs()

createRoot(document.getElementById('root')!, reactErrorHandlers()).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
