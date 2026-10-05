import type { CloneableParams, HandlerId, TaskResult } from '../tasks/registry'

export type WorkerRequest =
  | { type: 'run'; batchId: number; ordinal: number; taskId: string; handlerId: HandlerId; params: CloneableParams }

export type WorkerResponse =
  | { type: 'result'; batchId: number; ordinal: number; taskId: string; durationMs: number; result: TaskResult }
  | { type: 'error'; batchId: number; ordinal: number; taskId: string; message: string }
