import type { CompletionStep } from '@xsai/shared-chat'

import type { ProjectionEntry } from '../messages/turns'
import type { AssistantTurn, GenerationRound, ProviderContinuation } from '../messages/types'

import { errorMessageFrom } from '@moeru/std'
import { stepCountAtLeast } from '@xsai/shared-chat'
import { nanoid } from 'nanoid'

import { readRound } from '../messages/turns'

/**
 * Step budget of one reply when the caller sets no `maxSteps`.
 * Stage chat passes the value from the consciousness settings, which start at this value.
 */
export const defaultMaxSteps = 30

/** A generation is owned by its caller's turn; anonymous callers receive an independent identity. */
function createAssistantTurn(turnId?: string, runId?: string): AssistantTurn {
  return { type: 'assistant', id: turnId ?? nanoid(), runId, status: 'completed', rounds: [] }
}

/**
 * Saves the native step even when its portable content is unknown. A later protocol change reports
 * projectionIssues instead of silently omitting data. SDK tool failures stay attached to their call.
 */
function recordRound<Native extends ProviderContinuation>(turn: AssistantTurn, native: Native, step: CompletionStep, model: string, roundOffset: number, decode: (item: Native['data'][number]) => ProjectionEntry[]): GenerationRound {
  const id = `${turn.id}/${roundOffset + turn.rounds.length}`
  const entries: ProjectionEntry[] = []
  const issues: string[] = []
  for (const item of native.data) {
    try {
      entries.push(...decode(item))
    }
    catch (error) {
      issues.push(errorMessageFrom(error) ?? 'Unknown native content')
    }
  }
  const round = readRound(id, entries)
  round.projectionIssues.push(...issues)
  round.modelCall = { model, finishReason: step.finishReason, usage: step.usage }
  round.continuation = native
  for (const result of step.toolResults) {
    const invocation = round.toolInvocations.find(call => call.callId === result.toolCallId)
    if (invocation && result.isError && invocation.execution.status === 'succeeded')
      invocation.execution = { ...invocation.execution, status: 'failed' }
  }
  turn.rounds.push(round)
  return round
}

/**
 * Owns step boundaries and produces a turn only after all model and tool steps settle.
 * Each adapter supplies its native envelope and portable projection policy.
 */
export function createGeneration<Native extends ProviderContinuation>(input: {
  turnId?: string
  runId?: string
  model: string
  roundOffset?: number
  maxSteps?: number
  continuation: (items: Native['data'][number][], index: number) => Native
  project: (item: Native['data'][number]) => ProjectionEntry[]
}) {
  const starts: number[] = []
  const models: string[] = []
  const roundOffset = input.roundOffset ?? 0
  const maxSteps = input.maxSteps ?? defaultMaxSteps
  // Rounds from before a protocol change count against the budget of the reply.
  // The SDK request after the change gets only the steps that remain.
  const stopWhen = stepCountAtLeast(maxSteps - roundOffset)

  /**
   * SDK snapshots mark step starts; only offsets remain owned by this generation.
   *
   * The SDK does not run tool calls from the last step of the budget. When that step
   * has tools, the result sets `toolChoice: 'none'`, so the reply ends with text.
   */
  function prepareStep({ input: current, model, stepNumber, hasTools }: { input: readonly unknown[], model?: string, stepNumber: number, hasTools: boolean }): { toolChoice?: 'none' } {
    starts.push(current.length)
    models.push(model ?? input.model)
    if (hasTools && roundOffset + stepNumber >= maxSteps - 1)
      return { toolChoice: 'none' }
    return {}
  }

  async function complete(items: Promise<Native['data'][number][]>, steps: Promise<CompletionStep[]>) {
    const [final, completedSteps] = await Promise.all([items, steps])
    const turn = createAssistantTurn(input.turnId, input.runId)
    for (const [index, step] of completedSteps.entries()) {
      const start = starts[index]
      if (start === undefined)
        throw new Error('Missing SDK model step boundary')
      const output = final.slice(start, starts[index + 1] ?? final.length)
      recordRound(turn, input.continuation(output, index), step, models[index] ?? input.model, roundOffset, input.project)
    }
    const lastStep = completedSteps.at(-1)
    // A provider that ignores `toolChoice: 'none'` can still return calls on the last step.
    // The SDK did not run them, so a stored turn would hold calls without results.
    if ((lastStep?.finishReason === 'tool-calls' || lastStep?.finishReason === 'tool_calls') && lastStep.toolCalls.length > 0 && lastStep.toolResults.length === 0)
      throw new Error('Generation tool step limit reached')
    return turn
  }

  return { prepareStep, complete, stopWhen }
}
