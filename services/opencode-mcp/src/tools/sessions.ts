import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AssistantMessage, Message, Part, Session, ToolPart } from '@opencode-ai/sdk/v2/types'

import type { OpencodeConnection } from '../opencode'

import { errorCauseFrom, sleep } from '@moeru/std'
import { z } from 'zod'

import { listPendingRequests } from './requests'
import { describeError, respond, strict, truncate } from './result'

interface MessageWithParts {
  info: Message
  parts: Part[]
}

/**
 * What a client does next with a session, as reported by `opencode_session_wait`.
 *
 * - `done`: the agent finished. `reply` holds the complete answer.
 * - `working`: the agent still runs. Call `opencode_session_wait` again.
 * - `needs-input`: the agent waits for a permission reply or an answer to a question.
 * - `retrying`: a provider request failed, and OpenCode tries again later.
 */
type SessionState = 'done' | 'working' | 'needs-input' | 'retrying'

/** How often `opencode_session_wait` reads the session status while it waits. */
const waitPollIntervalMsec = 1_000

/**
 * Number of latest messages that `opencode_session_wait` reads to build the reply. One prompt makes
 * one assistant message for each model step, so a long task needs many messages.
 */
const replyMessageLimit = 50

/** A reply lists only its latest tool calls, so that a long task does not fill the result. */
const replyToolLimit = 20

/** Node `fetch` rejects with `TypeError('fetch failed')` and keeps the undici error, with its `code`, in `cause`. */
function isHeadersTimeout(error: unknown) {
  const cause = errorCauseFrom(error)
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'UND_ERR_HEADERS_TIMEOUT'
}

/**
 * Tracks the `session.command` requests that run in the background.
 *
 * `session.command` returns only when the agent finishes, which can take minutes. Some MCP
 * clients end a tool call after about 10 seconds (AIRI uses 10 to 15 seconds). So
 * `opencode_session_command` starts the request and returns at once. `opencode_session_wait` reads
 * this state: a session with a running command is working, and a failed command reports its error
 * one time, after the session is idle.
 *
 * The state lives as long as the process. A new command for a session replaces the entry of the
 * previous one.
 */
export function createCommandTracker() {
  const running = new Map<string, Promise<void>>()
  const failures = new Map<string, string>()

  return {
    start(sessionID: string, request: Promise<unknown>) {
      failures.delete(sessionID)
      const tracked: Promise<void> = request
        .then(() => {}, (error: unknown) => {
          // NOTICE:
          // Node `fetch` ends a request that receives no response headers in 300 seconds
          // (undici `headersTimeout`, error code `UND_ERR_HEADERS_TIMEOUT`). OpenCode sends the
          // headers of `session.command` only when the command finishes, so a long command ends
          // its request while OpenCode continues the command. The outcome is unknown, so no failure
          // is recorded, and the session status and the reply show the result.
          // Remove this check when the SDK client sends requests without a headers timeout.
          if (!isHeadersTimeout(error)) {
            failures.set(sessionID, describeError(error))
          }
        })
        .finally(() => {
          if (running.get(sessionID) === tracked) {
            running.delete(sessionID)
          }
        })
      running.set(sessionID, tracked)
    },
    isRunning(sessionID: string) {
      return running.has(sessionID)
    },
    takeFailure(sessionID: string) {
      const failure = failures.get(sessionID)
      failures.delete(sessionID)
      return failure
    },
  }
}

export type CommandTracker = ReturnType<typeof createCommandTracker>

/**
 * Splits a model reference in the format of `opencode run --model`. Only the first slash
 * separates the provider, because model IDs can contain slashes.
 *
 * @example
 * parseModelReference('openrouter/anthropic/claude-sonnet-4')
 * // => { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' }
 */
function parseModelReference(reference: string) {
  const separatorIndex = reference.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex === reference.length - 1) {
    throw new Error(`The model must have the form "providerID/modelID", for example "anthropic/claude-sonnet-4". Received: ${reference}`)
  }

  return {
    providerID: reference.slice(0, separatorIndex),
    modelID: reference.slice(separatorIndex + 1),
  }
}

function summarizeSession(session: Session) {
  return {
    id: session.id,
    title: session.title,
    parentID: session.parentID,
    updated: new Date(session.time.updated).toISOString(),
    changes: session.summary
      ? { files: session.summary.files, additions: session.summary.additions, deletions: session.summary.deletions }
      : undefined,
    revertedFromMessageID: session.revert?.messageID,
  }
}

function describeMessageError(error: NonNullable<AssistantMessage['error']>) {
  const message = 'message' in error.data ? error.data.message : undefined
  return typeof message === 'string' ? `${error.name}: ${message}` : error.name
}

/** Joins the visible text of a message. Synthetic and ignored parts are context that OpenCode adds, not text from the agent. */
function messageText(parts: Part[]) {
  return parts
    .flatMap(part => part.type === 'text' && !part.synthetic && !part.ignored ? [part.text] : [])
    .join('')
    .trim()
}

function formatToolPart(part: ToolPart, includeOutput: boolean) {
  const { state } = part
  return {
    tool: part.tool,
    status: state.status,
    title: 'title' in state ? state.title : undefined,
    error: state.status === 'error' ? state.error : undefined,
    output: includeOutput && state.status === 'completed' ? truncate(state.output, 2_000) : undefined,
  }
}

function toolParts(parts: Part[]) {
  return parts.filter((part): part is ToolPart => part.type === 'tool')
}

function formatMessage({ info, parts }: MessageWithParts, includeToolOutput: boolean) {
  const tools = toolParts(parts).map(part => formatToolPart(part, includeToolOutput))
  return {
    id: info.id,
    role: info.role,
    agent: info.agent,
    text: messageText(parts),
    tools: tools.length ? tools : undefined,
    error: info.role === 'assistant' && info.error ? describeMessageError(info.error) : undefined,
  }
}

/**
 * Builds the reply to the latest user message from the assistant messages after it.
 *
 * When the messages do not include a user message (the task made more than
 * {@link replyMessageLimit} messages), all of them count as the reply.
 */
function buildReply(messages: MessageWithParts[]) {
  const lastUserIndex = messages.findLastIndex(message => message.info.role === 'user')
  const replyMessages = messages.slice(lastUserIndex + 1)
  const lastInfo = replyMessages.at(-1)?.info
  if (!lastInfo) {
    return undefined
  }

  const tools = replyMessages.flatMap(message => toolParts(message.parts)).map(part => formatToolPart(part, false))

  return {
    promptMessageID: messages[lastUserIndex]?.info.id,
    text: replyMessages.map(message => messageText(message.parts)).filter(Boolean).join('\n\n'),
    toolCallCount: tools.length,
    latestToolCalls: tools.length ? tools.slice(-replyToolLimit) : undefined,
    error: lastInfo.role === 'assistant' && lastInfo.error ? describeMessageError(lastInfo.error) : undefined,
  }
}

async function waitForSession(connection: OpencodeConnection, commands: CommandTracker, sessionID: string, timeoutMsec: number) {
  const { client } = connection
  const deadline = Date.now() + timeoutMsec

  for (;;) {
    const [statuses, pending] = await Promise.all([
      client.session.status(undefined, strict),
      listPendingRequests(connection, sessionID),
    ])

    // The status map holds only sessions that are not idle.
    const status = statuses.data[sessionID] ?? { type: 'idle' as const }
    const needsInput = pending.permissions.length > 0 || pending.questions.length > 0
    const isBusy = status.type !== 'idle' || commands.isRunning(sessionID)
    const remainingMsec = deadline - Date.now()

    if (isBusy && !needsInput && remainingMsec > 0) {
      await sleep(Math.min(waitPollIntervalMsec, remainingMsec))
      continue
    }

    let state: SessionState = 'done'
    if (needsInput) {
      state = 'needs-input'
    }
    else if (status.type === 'retry') {
      state = 'retrying'
    }
    else if (isBusy) {
      state = 'working'
    }

    const messages = await client.session.messages({ sessionID, limit: replyMessageLimit }, strict)

    return {
      sessionID,
      state,
      retry: status.type === 'retry' ? { attempt: status.attempt, message: status.message } : undefined,
      pending: needsInput ? pending : undefined,
      reply: buildReply(messages.data),
      // A command failure is final only when the session is idle. While the session is busy,
      // OpenCode can still run the command after the HTTP request failed.
      commandError: state === 'done' ? commands.takeFailure(sessionID) : undefined,
    }
  }
}

export function registerSessionTools(server: McpServer, connection: OpencodeConnection, commands: CommandTracker) {
  const { client } = connection

  server.registerTool('opencode_session_list', {
    description: 'List the OpenCode sessions of the project, newest first.',
    inputSchema: {
      search: z.string().optional().describe('Only list sessions whose title contains this text.'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
    },
  }, async ({ search, limit }) => respond(async () => {
    const { data } = await client.session.list({ search, limit: limit ?? 20, roots: true }, strict)
    return data.map(summarizeSession)
  }))

  server.registerTool('opencode_session_create', {
    description: 'Create an empty OpenCode session. opencode_session_prompt can also create one.',
    inputSchema: {
      title: z.string().optional(),
    },
  }, async ({ title }) => respond(async () => {
    const { data } = await client.session.create({ title }, strict)
    return summarizeSession(data)
  }))

  server.registerTool('opencode_session_delete', {
    description: 'Delete an OpenCode session and its messages. This cannot be undone.',
    inputSchema: {
      sessionID: z.string(),
    },
  }, async ({ sessionID }) => respond(async () => {
    const { data } = await client.session.delete({ sessionID }, strict)
    return { deleted: data }
  }))

  server.registerTool('opencode_session_prompt', {
    description: 'Send a task or message to the OpenCode agent. Returns at once. Then call opencode_session_wait with the sessionID to get the reply.',
    inputSchema: {
      text: z.string().min(1).describe('The message for the agent.'),
      sessionID: z.string().optional().describe('Session to continue. Omit to start a new session.'),
      agent: z.string().optional().describe('Agent name, for example "build" or "plan". See opencode_prompt_options.'),
      model: z.string().optional().describe('Model as "providerID/modelID". Omit to use the default model.'),
    },
  }, async ({ text, sessionID, agent, model }) => respond(async () => {
    const targetSessionID = sessionID ?? (await client.session.create(undefined, strict)).data.id
    // `prompt_async` saves the user message and marks the session busy before it returns,
    // so an immediate opencode_session_wait cannot read the reply to the previous message.
    await client.session.promptAsync({
      sessionID: targetSessionID,
      agent,
      model: model ? parseModelReference(model) : undefined,
      parts: [{ type: 'text', text }],
    }, strict)

    return { sessionID: targetSessionID, state: 'working' satisfies SessionState }
  }))

  server.registerTool('opencode_session_command', {
    description: 'Run a slash command, for example "init" or "review", in a session. Returns at once. Then call opencode_session_wait. See opencode_prompt_options for the commands.',
    inputSchema: {
      command: z.string().min(1).describe('Command name without the slash.'),
      arguments: z.string().optional().describe('Text after the command name.'),
      sessionID: z.string().optional().describe('Session to run in. Omit to start a new session.'),
      agent: z.string().optional(),
      model: z.string().optional().describe('Model as "providerID/modelID".'),
    },
  }, async ({ command, arguments: commandArguments, sessionID, agent, model }) => respond(async () => {
    const targetSessionID = sessionID ?? (await client.session.create(undefined, strict)).data.id
    commands.start(targetSessionID, client.session.command({
      sessionID: targetSessionID,
      command,
      arguments: commandArguments ?? '',
      agent,
      model,
    }, strict))

    return { sessionID: targetSessionID, state: 'working' satisfies SessionState }
  }))

  server.registerTool('opencode_session_wait', {
    description: 'Wait for a session, then return its state and the reply to the latest message. state "done": the reply is complete. "working": call again. "needs-input": reply with opencode_permission_reply or opencode_question_reply. "retrying": OpenCode retries after a provider error.',
    inputSchema: {
      sessionID: z.string(),
      timeoutSeconds: z.number().min(0).max(600).optional().describe('Longest time to wait for the agent to finish. Default 5. Some MCP clients end a tool call after 10 seconds.'),
    },
  }, async ({ sessionID, timeoutSeconds }) => respond(() => waitForSession(connection, commands, sessionID, (timeoutSeconds ?? 5) * 1_000)))

  server.registerTool('opencode_session_messages', {
    description: 'Read the latest messages of a session.',
    inputSchema: {
      sessionID: z.string(),
      limit: z.number().int().min(1).max(100).optional().describe('Number of latest messages. Default 10.'),
      includeToolOutput: z.boolean().optional().describe('Include the output of each tool call, cut to 2000 characters.'),
    },
  }, async ({ sessionID, limit, includeToolOutput }) => respond(async () => {
    const { data } = await client.session.messages({ sessionID, limit: limit ?? 10 }, strict)
    return data.map(message => formatMessage(message, includeToolOutput ?? false))
  }))

  server.registerTool('opencode_session_abort', {
    description: 'Stop the agent that runs in a session.',
    inputSchema: {
      sessionID: z.string(),
    },
  }, async ({ sessionID }) => respond(async () => {
    const { data } = await client.session.abort({ sessionID }, strict)
    return { aborted: data }
  }))

  server.registerTool('opencode_session_diff', {
    description: 'List the files that a session changed.',
    inputSchema: {
      sessionID: z.string(),
      messageID: z.string().optional().describe('Only the changes of this message.'),
      includePatch: z.boolean().optional().describe('Include each patch, cut to 4000 characters.'),
    },
  }, async ({ sessionID, messageID, includePatch }) => respond(async () => {
    const { data } = await client.session.diff({ sessionID, messageID }, strict)
    return data.map(diff => ({
      file: diff.file,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      patch: includePatch && diff.patch ? truncate(diff.patch, 4_000) : undefined,
    }))
  }))

  server.registerTool('opencode_session_revert', {
    description: 'Undo a message and all messages after it, and restore the files to the state before it. opencode_session_unrevert restores them.',
    inputSchema: {
      sessionID: z.string(),
      messageID: z.string().describe('First message to undo, for example promptMessageID from opencode_session_wait.'),
    },
  }, async ({ sessionID, messageID }) => respond(async () => {
    const { data } = await client.session.revert({ sessionID, messageID }, strict)
    return summarizeSession(data)
  }))

  server.registerTool('opencode_session_unrevert', {
    description: 'Restore the messages and files that opencode_session_revert undid.',
    inputSchema: {
      sessionID: z.string(),
    },
  }, async ({ sessionID }) => respond(async () => {
    const { data } = await client.session.unrevert({ sessionID }, strict)
    return summarizeSession(data)
  }))
}
