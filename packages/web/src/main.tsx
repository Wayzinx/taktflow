import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 全局样式先于组件样式加载，组件里的同级选择器才能覆盖 base.css
import './styles/tokens.css'
import './styles/base.css'
import './styles/motion.css'
import { App } from './app'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
