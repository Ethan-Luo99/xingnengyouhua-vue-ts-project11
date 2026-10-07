import { AnalysisPanel } from './ui/AnalysisPanel'

// 自测钩子仅进 dev 包（生产构建由 DEV 常量静态剔除）
if (import.meta.env.DEV) {
  void import('./test/selfTest')
}

function App() {
  return <AnalysisPanel />
}

export default App
