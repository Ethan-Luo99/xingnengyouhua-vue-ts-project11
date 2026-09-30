import { useSyncExternalStore } from 'react'
import { getSnapshot, subscribe } from './analysisStore'
import type { AnalysisSnapshot } from './analysisStore'

export function useAnalysisSnapshot(): AnalysisSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
