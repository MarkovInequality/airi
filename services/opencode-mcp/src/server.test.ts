import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectOpencode } from './opencode'
import { createOpencodeMcpServerFactory } from './server'

interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: unknown
}

interface FakeResponse {
  status?: number
  body?: unknown
}

type Route = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>

const projectDirectory = '/projects/demo app'

/**
 * Starts a local HTTP server that stands in for `opencode serve`. Routes are keyed by
 * `"<METHOD> <path>"`. An unknown route answers 404 in the error format of OpenCode.
 */
async function startFakeOpencode(routes: Record<string, Route>) {
  const requests: RecordedRequest[] = []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }

    const rawBody = Buffer.concat(chunks).toString('utf8')
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    }
    requests.push(request)

    const route = routes[`${request.method} ${request.path}`]
    const response = route
      ? await route(request)
      : { status: 404, body: { name: 'NotFoundError', data: { message: `No route: ${request.method} ${request.path}` } } }

    if (response.body === undefined) {
      res.writeHead(response.status ?? 204).end()
      return
    }

    res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(response.body))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

/** Connects an MCP client to the OpenCode MCP server, which talks to a fake OpenCode server with `routes`. */
async function connectTools(routes: Record<string, Route>) {
  const opencode = await startFakeOpencode(routes)
  cleanups.push(opencode.close)

  const connection = await connectOpencode({ url: opencode.url, directory: projectDirectory })
  const server = createOpencodeMcpServerFactory(connection)()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanups.push(() => client.close())

  async function callTool(name: string, args: Record<string, unknown> = {}, options?: RequestOptions) {
    const result = await client.callTool({ name, arguments: args }, undefined, options)
    const [content] = result.content as Array<{ type: string, text: string }>
    return {
      isError: result.isError === true,
      text: content.text,
      json: () => JSON.parse(content.text),
    }
  }

  return { callTool, requests: opencode.requests }
}

const idleSessionRoutes: Record<string, Route> = {
  'GET /session/status': () => ({ body: {} }),
  'GET /permission': () => ({ body: [] }),
  'GET /question': () => ({ body: [] }),
  'GET /session/ses_1/message': () => ({ body: [] }),
}

function textPart(text: string) {
  return { id: `prt_${text}`, sessionID: 'ses_1', messageID: 'msg', type: 'text', text }
}

describe('opencode MCP server', () => {
  it('starts a new session and sends the prompt without waiting for the reply', async () => {
    const { callTool, requests } = await connectTools({
      'POST /session': () => ({ body: { id: 'ses_new', title: 'New session', time: { created: 0, updated: 0 } } }),
      'POST /session/ses_new/prompt_async': () => ({ status: 204 }),
    })

    const result = await callTool('opencode_session_prompt', {
      text: 'Fix the build',
      agent: 'plan',
      model: 'openrouter/anthropic/claude-sonnet-4',
    })

    expect(result.json()).toEqual({ sessionID: 'ses_new', state: 'working' })
    const promptRequest = requests.find(request => request.path === '/session/ses_new/prompt_async')
    expect(promptRequest?.body).toEqual({
      agent: 'plan',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
      parts: [{ type: 'text', text: 'Fix the build' }],
    })
    expect(promptRequest?.headers['x-opencode-directory']).toBe(encodeURIComponent(projectDirectory))
  })

  it('returns the reply to the latest prompt when the session is idle', async () => {
    const { callTool } = await connectTools({
      ...idleSessionRoutes,
      'GET /session/ses_1/message': () => ({
        body: [
          { info: { id: 'msg_u1', role: 'user', agent: 'build' }, parts: [textPart('old question')] },
          { info: { id: 'msg_a1', role: 'assistant', agent: 'build' }, parts: [textPart('old answer')] },
          { info: { id: 'msg_u2', role: 'user', agent: 'build' }, parts: [textPart('new question')] },
          {
            info: { id: 'msg_a2', role: 'assistant', agent: 'build' },
            parts: [
              textPart('step one'),
              { id: 'prt_tool', sessionID: 'ses_1', messageID: 'msg_a2', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: {}, output: 'ok', title: 'Run tests', metadata: {}, time: { start: 0, end: 1 } } },
            ],
          },
          { info: { id: 'msg_a3', role: 'assistant', agent: 'build' }, parts: [textPart('step two')] },
        ],
      }),
    })

    const result = await callTool('opencode_session_wait', { sessionID: 'ses_1' })

    expect(result.json()).toEqual({
      sessionID: 'ses_1',
      state: 'done',
      reply: {
        promptMessageID: 'msg_u2',
        text: 'step one\n\nstep two',
        toolCallCount: 1,
        latestToolCalls: [{ tool: 'bash', status: 'completed', title: 'Run tests' }],
      },
    })
  })

  it('stops waiting when the agent needs a permission reply', async () => {
    const { callTool } = await connectTools({
      ...idleSessionRoutes,
      'GET /session/status': () => ({ body: { ses_1: { type: 'busy' } } }),
      'GET /permission': () => ({
        body: [
          { id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['rm -rf dist'], metadata: {}, always: ['rm *'] },
          { id: 'per_2', sessionID: 'ses_other', permission: 'edit', patterns: ['a.ts'], metadata: {}, always: [] },
        ],
      }),
    })

    const startedAt = Date.now()
    const result = await callTool('opencode_session_wait', { sessionID: 'ses_1' })

    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(result.json().state).toBe('needs-input')
    expect(result.json().pending.permissions).toEqual([
      { requestID: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['rm -rf dist'], always: ['rm *'] },
    ])
  })

  it('waits while the agent works, and reports progress after each status check', async () => {
    let statusChecks = 0
    const { callTool } = await connectTools({
      ...idleSessionRoutes,
      'GET /session/status': () => {
        statusChecks += 1
        return { body: statusChecks <= 2 ? { ses_1: { type: 'busy' } } : {} }
      },
    })

    const progress: Array<{ progress: number, message?: string }> = []
    const result = await callTool('opencode_session_wait', { sessionID: 'ses_1' }, {
      onprogress: ({ progress: value, message }) => progress.push({ progress: value, message }),
    })

    expect(result.json().state).toBe('done')
    expect(progress.map(update => update.progress)).toEqual([1, 2])
    expect(progress[0]?.message).toMatch(/^OpenCode is working \(\d+ s\)$/)
  })

  it('stops checking the session when the client cancels the wait', async () => {
    let statusChecks = 0
    const { callTool } = await connectTools({
      ...idleSessionRoutes,
      'GET /session/status': () => {
        statusChecks += 1
        return { body: { ses_1: { type: 'busy' } } }
      },
    })

    const controller = new AbortController()
    const waiting = callTool('opencode_session_wait', { sessionID: 'ses_1' }, { signal: controller.signal })
    await vi.waitFor(() => expect(statusChecks).toBeGreaterThan(0))
    controller.abort()
    await expect(waiting).rejects.toThrow()

    // A check that started before the cancellation arrived can still finish.
    const checksAtCancel = statusChecks
    await sleep(2_500)
    expect(statusChecks).toBeLessThanOrEqual(checksAtCancel + 1)
  })

  it('runs a slash command in the background and reports its failure one time', async () => {
    let failCommand = () => {}
    const commandFailed = new Promise<void>((resolve) => {
      failCommand = resolve
    })

    const { callTool, requests } = await connectTools({
      ...idleSessionRoutes,
      'POST /session/ses_1/command': async () => {
        await commandFailed
        return { status: 400, body: { name: 'UnknownError', data: { message: 'Command not found: nope' } } }
      },
    })

    const started = await callTool('opencode_session_command', { sessionID: 'ses_1', command: 'nope', arguments: 'now' })
    expect(started.json()).toEqual({ sessionID: 'ses_1', state: 'working' })

    // OpenCode reports the session as idle, but the command request is still open, so the wait goes on.
    let waitEnded = false
    const waiting = callTool('opencode_session_wait', { sessionID: 'ses_1' }).finally(() => {
      waitEnded = true
    })
    await sleep(1_500)
    expect(waitEnded).toBe(false)

    failCommand()
    const afterFailure = await waiting
    expect(afterFailure.json().state).toBe('done')
    expect(afterFailure.json().commandError).toBe('OpenCode returned HTTP 400: Command not found: nope')
    // The tool returned before its request reached OpenCode, so the request is checked only now.
    expect(requests.find(request => request.path === '/session/ses_1/command')?.body).toEqual({ command: 'nope', arguments: 'now' })

    const later = await callTool('opencode_session_wait', { sessionID: 'ses_1' })
    expect(later.json().commandError).toBeUndefined()
  })

  it('turns a failed request into a tool error with the HTTP status', async () => {
    const { callTool } = await connectTools({
      'GET /session/ses_missing/message': () => ({ status: 404, body: { name: 'NotFoundError', data: { message: 'Session not found: ses_missing' } } }),
    })

    const result = await callTool('opencode_session_messages', { sessionID: 'ses_missing' })

    expect(result.isError).toBe(true)
    expect(result.text).toBe('OpenCode returned HTTP 404: Session not found: ses_missing')
  })

  it('sends permission replies to OpenCode', async () => {
    const { callTool, requests } = await connectTools({
      'POST /permission/per_1/reply': () => ({ body: true }),
    })

    const result = await callTool('opencode_permission_reply', { requestID: 'per_1', reply: 'reject', message: 'Use the test script instead.' })

    expect(result.json()).toEqual({ replied: true })
    expect(requests[0]?.body).toEqual({ reply: 'reject', message: 'Use the test script instead.' })
  })
})

describe('opencode API tools', () => {
  const spec = {
    openapi: '3.1.0',
    paths: {
      '/session/{sessionID}/fork': {
        post: {
          operationId: 'session.fork',
          summary: 'Fork session',
          parameters: [
            { name: 'sessionID', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'directory', in: 'query', schema: { type: 'string' } },
          ],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ForkInput' } } } },
          responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/event': {
        get: {
          operationId: 'event.subscribe',
          summary: 'Subscribe to events',
          responses: { 200: { content: { 'text/event-stream': { schema: { type: 'object' } } } } },
        },
      },
      '/pty/{ptyID}/connect': {
        get: {
          operationId: 'pty.connect',
          summary: 'Connect to PTY session',
          parameters: [{ name: 'ptyID', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { content: { 'application/json': { schema: { type: 'boolean' } } } } },
        },
      },
    },
    components: {
      schemas: {
        ForkInput: { type: 'object', properties: { messageID: { type: 'string' } } },
      },
    },
  }

  const specRoutes: Record<string, Route> = {
    'GET /doc': () => ({ body: spec }),
  }

  it('finds operations by words and describes one by its operationId', async () => {
    const { callTool } = await connectTools(specRoutes)

    const found = await callTool('opencode_api_search', { query: 'fork session' })
    expect(found.json()).toEqual([{
      operationId: 'session.fork',
      method: 'POST',
      path: '/session/{sessionID}/fork',
      summary: 'Fork session',
      parameters: ['sessionID (path, required)'],
      hasBody: true,
    }])

    const described = await callTool('opencode_api_search', { query: 'session.fork' })
    expect(described.json().body).toEqual({ type: 'object', properties: { messageID: { type: 'string' } } })
    expect(described.json().parameters.map((parameter: { name: string }) => parameter.name)).toEqual(['sessionID'])

    const stream = await callTool('opencode_api_search', { query: 'event.subscribe' })
    expect(stream.json()).toEqual({ operationId: 'event.subscribe', callable: false, reason: 'It is a server-sent event stream.' })

    const streamWords = await callTool('opencode_api_search', { query: 'subscribe events' })
    expect(streamWords.json()).toEqual([])
  })

  it('calls an operation with path parameters and a body', async () => {
    const { callTool, requests } = await connectTools({
      ...specRoutes,
      'POST /session/ses_1/fork': request => ({ body: { id: 'ses_fork', received: request.body } }),
    })

    const result = await callTool('opencode_api_call', {
      operationId: 'session.fork',
      path: { sessionID: 'ses_1' },
      body: { messageID: 'msg_1' },
    })

    expect(result.json()).toEqual({ status: 200, data: { id: 'ses_fork', received: { messageID: 'msg_1' } } })
    const forkRequest = requests.find(request => request.path === '/session/ses_1/fork')
    expect(forkRequest?.headers['content-type']).toContain('application/json')
    expect(forkRequest?.headers['x-opencode-directory']).toBe(encodeURIComponent(projectDirectory))
  })

  it('refuses calls that cannot work, and returns OpenCode errors as tool errors', async () => {
    const { callTool } = await connectTools({
      ...specRoutes,
      'POST /session/ses_gone/fork': () => ({ status: 404, body: { name: 'NotFoundError', data: { message: 'Session not found' } } }),
    })

    const missingPath = await callTool('opencode_api_call', { operationId: 'session.fork' })
    expect(missingPath.isError).toBe(true)
    expect(missingPath.text).toBe('session.fork needs the path parameters: sessionID.')

    const websocket = await callTool('opencode_api_call', { operationId: 'pty.connect', path: { ptyID: 'pty_1' } })
    expect(websocket.isError).toBe(true)
    expect(websocket.text).toBe('pty.connect cannot run as a tool call. It opens a WebSocket terminal connection.')

    const unknown = await callTool('opencode_api_call', { operationId: 'session.nothing' })
    expect(unknown.text).toBe('Unknown operationId "session.nothing". Find operations with opencode_api_search.')

    const notFound = await callTool('opencode_api_call', { operationId: 'session.fork', path: { sessionID: 'ses_gone' } })
    expect(notFound.isError).toBe(true)
    expect(notFound.text).toBe('OpenCode returned HTTP 404 for session.fork: {"name":"NotFoundError","data":{"message":"Session not found"}}')
  })
})
