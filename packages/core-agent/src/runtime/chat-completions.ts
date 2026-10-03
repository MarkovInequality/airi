import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CompletionStep, Message, Tool } from '@xsai/shared-chat'

import type { Conversation } from '../messages/types'
import type { StreamEvent, StreamOptions } from '../types/llm'
import type { ResolvedStep } from './request-context'

import { streamText } from '@xsai/stream-text'

import { chatContentToString, chatMessagesToProjectionEntries, conversationToChatMessages } from '../messages/chat-completions'
import { createGeneration } from './generation'
import { createContinuationScope, mergeRequestHeaders, removedToolImageNote, replaceProviderConfig, supportsContentArray, supportsTools } from './request-context'
import { RequestSwitch } from './request-switch'
import { toAiriStreamEvent } from './xsai-events'

/**
 * Keeps the newest `keep` images in tool messages and replaces older ones with a note. Without `keep`, every image stays.
 * The SDK passes each step a copy of its messages, so the generated turn keeps every image.
 */
function replaceOlderToolImages(messages: Message[], keep: number | undefined) {
  if (keep == null)
    return
  let remaining = keep
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'tool' || typeof message.content === 'string' || !message.content.some(part => part.type === 'image_url'))
      continue
    const content = [...message.content]
    for (let part = content.length - 1; part >= 0; part--) {
      if (content[part].type !== 'image_url')
        continue
      if (remaining > 0)
        remaining -= 1
      else
        content[part] = { type: 'text', text: removedToolImageNote }
    }
    messages[index] = { ...message, content }
  }
}

/** Projects one context snapshot and returns only the newly generated turn. */
export function streamChatCompletions(input: {
  config: ReturnType<ChatProvider['chat']>
  scope: string
  conversation: Conversation
  supportsContentArray: boolean
  options?: StreamOptions
  tools?: Tool[]
  initialStep?: ResolvedStep
  onEvent: (event: StreamEvent) => Promise<void>
}) {
  const messages = conversationToChatMessages(input.conversation, input.supportsContentArray, input.scope)
  const scopes: string[] = []
  const generation = createGeneration({
    turnId: input.options?.requestCorrelation?.turnId ?? input.options?.generationTurnId,
    runId: input.options?.requestCorrelation?.runId,
    model: input.config.model,
    roundOffset: input.options?.generationRoundOffset,
    maxSteps: input.options?.maxSteps,
    continuation: (data: Message[], index) => ({ protocol: 'chat-completions' as const, scope: scopes[index] ?? input.scope, data }),
    project: item => chatMessagesToProjectionEntries([item]),
  })
  let providerConfigKeys = Object.keys(input.config)
  const requestOptions: Parameters<typeof streamText>[0] = {
    ...input.config,
    prepareStep: ({ input: current, steps, stepNumber }: { input: Message[], steps: CompletionStep[], stepNumber: number }) => {
      const resolveStep = input.options?.resolveStep
      if (!resolveStep) {
        scopes.push(input.scope)
        replaceOlderToolImages(current, input.options?.maxToolImages)
        return { ...generation.prepareStep({ input: current, stepNumber, hasTools: Boolean(requestOptions.tools?.length) }), input: current }
      }
      return (async () => {
        const firstStep = scopes.length === 0 && input.initialStep
        const next = firstStep || await resolveStep()

        const nextRequest = firstStep
          ? { protocol: 'chat-completions' as const, config: input.config }
          : next.chatProvider.generation(next.model)
        const nextScope = createContinuationScope(nextRequest.config, { ...input.options, providerId: next.providerId })
        if (nextRequest.protocol !== 'chat-completions' || nextScope !== input.scope) {
          const partialTurn = await generation.complete(Promise.resolve(current), Promise.resolve(steps))
          throw new RequestSwitch(next, partialTurn)
        }

        // NOTICE:
        // xsAI 0.5 prepareStep returns only input, model, and toolChoice.
        // It reads other options afterward but snapshots toolChoice beforehand.
        // Source: @xsai/stream-text 0.5 doStream and @xsai/shared-chat resolvePrepareStep.
        // Remove this mutation when xsAI supports typed provider options for each step.
        const toolsSupported = supportsTools(next.model, nextRequest, input.options)
        providerConfigKeys = replaceProviderConfig(requestOptions, providerConfigKeys, nextRequest.config)
        Object.assign(requestOptions, {
          apiKey: nextRequest.config.apiKey,
          fetch: nextRequest.config.fetch,
          temperature: next.temperature,
          topP: next.topP,
          headers: mergeRequestHeaders(nextRequest.config.headers, next.headers),
          tools: toolsSupported && next.tools?.length ? next.tools : undefined,
          toolChoice: undefined,
        })
        // A protocol change above stores `current` as the partial turn, so trim images only after it.
        replaceOlderToolImages(current, input.options?.maxToolImages)
        const { toolChoice: lastStepToolChoice } = generation.prepareStep({ input: current, model: next.model, stepNumber, hasTools: Boolean(requestOptions.tools?.length) })
        const contentArraySupported = supportsContentArray(next.model, nextRequest, input.options)
        scopes.push(nextScope)
        if (!contentArraySupported) {
          for (const [index, message] of current.entries()) {
            if (!Array.isArray(message.content))
              continue
            current[index] = {
              ...message,
              content: chatContentToString(message.content),
            } as Message
          }
        }
        const systemIndex = current.findIndex(message => message.role === 'system')
        const systemMessage = current[systemIndex]
        if (systemMessage?.role === 'system')
          current[systemIndex] = { ...systemMessage, content: next.systemPrompt }
        else if (next.systemPrompt)
          current.unshift({ role: 'system', content: next.systemPrompt })

        return { input: current, model: next.model, toolChoice: toolsSupported ? lastStepToolChoice ?? input.options?.toolChoice : undefined }
      })()
    },
    abortSignal: input.options?.abortSignal,
    temperature: input.options?.temperature,
    topP: input.options?.topP,
    messages,
    headers: mergeRequestHeaders(input.config.headers, input.options?.headers),
    streamOptions: { includeUsage: true },
    stopWhen: generation.stopWhen,
    tools: input.tools,
    toolChoice: input.options?.resolveStep ? undefined : input.options?.toolChoice,
    onEvent: async (event) => {
      const mapped = toAiriStreamEvent(event)
      if (mapped)
        await input.onEvent(mapped)
    },
  }
  const result = streamText(requestOptions)
  const generatedTurn = generation.complete(result.messages, result.steps)
  return { ...result, generatedTurn }
}
