import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { OpencodeConnection } from '../opencode'

import { z } from 'zod'

import { respond, strict, truncate } from './result'

/**
 * Permission requests and questions that OpenCode waits for.
 *
 * An agent stops when a tool needs permission (for example a shell command that the agent
 * config marks as "ask"), or when the agent asks the user a question. The session stays busy
 * until a client replies with opencode_permission_reply or opencode_question_reply.
 */
export interface PendingRequests {
  permissions: Array<{
    requestID: string
    sessionID: string
    permission: string
    patterns: string[]
    /** Patterns that the "always" reply allows for the rest of the session. */
    always: string[]
    /** Tool-specific details, for example the command or the diff. Cut to keep the result small. */
    details?: string
  }>
  questions: Array<{
    requestID: string
    sessionID: string
    questions: Array<{
      question: string
      options: string[]
      multiple?: boolean
      /** Copied from OpenCode. When true, an answer can be free text instead of an option label. */
      custom?: boolean
    }>
  }>
}

/** Lists pending permission requests and questions. With `sessionID`, lists only those of that session. */
export async function listPendingRequests(connection: OpencodeConnection, sessionID?: string): Promise<PendingRequests> {
  const [permissions, questions] = await Promise.all([
    connection.client.permission.list(undefined, strict),
    connection.client.question.list(undefined, strict),
  ])

  const isSelected = (request: { sessionID: string }) => !sessionID || request.sessionID === sessionID

  return {
    permissions: permissions.data.filter(isSelected).map(request => ({
      requestID: request.id,
      sessionID: request.sessionID,
      permission: request.permission,
      patterns: request.patterns,
      always: request.always,
      details: Object.keys(request.metadata).length ? truncate(JSON.stringify(request.metadata), 1_000) : undefined,
    })),
    questions: questions.data.filter(isSelected).map(request => ({
      requestID: request.id,
      sessionID: request.sessionID,
      questions: request.questions.map(info => ({
        question: info.question,
        options: info.options.map(option => option.label),
        multiple: info.multiple,
        custom: info.custom,
      })),
    })),
  }
}

export function registerRequestTools(server: McpServer, connection: OpencodeConnection) {
  server.registerTool('opencode_pending_requests', {
    description: 'List the permission requests and questions that OpenCode waits for. An agent stops until you reply to them.',
    inputSchema: {
      sessionID: z.string().optional().describe('Only list the requests of this session.'),
    },
  }, async ({ sessionID }) => respond(() => listPendingRequests(connection, sessionID)))

  server.registerTool('opencode_permission_reply', {
    description: 'Reply to a permission request from opencode_pending_requests.',
    inputSchema: {
      requestID: z.string(),
      reply: z.enum(['once', 'always', 'reject']).describe('"once" allows this call. "always" also allows the listed patterns for this session. "reject" refuses.'),
      message: z.string().optional().describe('For "reject": tells the agent what to do instead.'),
    },
  }, async ({ requestID, reply, message }) => respond(async () => {
    const { data } = await connection.client.permission.reply({ requestID, reply, message }, strict)
    return { replied: data }
  }))

  server.registerTool('opencode_question_reply', {
    description: 'Answer a question from opencode_pending_requests, or reject it.',
    inputSchema: {
      requestID: z.string(),
      answers: z.array(z.array(z.string())).optional().describe('One list of answers for each question, in order. Use option labels, or your own text when the question allows it.'),
      reject: z.boolean().optional().describe('Set to true to dismiss the question without an answer.'),
    },
  }, async ({ requestID, answers, reject }) => respond(async () => {
    if (reject) {
      const { data } = await connection.client.question.reject({ requestID }, strict)
      return { rejected: data }
    }

    if (!answers) {
      throw new Error('Give "answers", or set "reject" to true.')
    }

    const { data } = await connection.client.question.reply({ requestID, answers }, strict)
    return { replied: data }
  }))
}
