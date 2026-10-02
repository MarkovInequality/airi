import type { AddressInfo } from 'node:net'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createMcpServerManager } from './index'

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(),
}))

vi.mock('electron', () => ({
  app: appMock,
  shell: { showItemInFolder: vi.fn() },
}))

/**
 * Starts a real Streamable HTTP MCP server on a free local port. It has one `echo` tool and
 * records the `Authorization` header of each request.
 *
 * The server is stateless: each POST gets a new MCP server, as in the SDK stateless example.
 * It answers GET with 405, which tells the client that the server has no standalone SSE stream.
 */
async function startEchoServer() {
  const authorizationHeaders: Array<string | undefined> = []

  const httpServer = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    authorizationHeaders.push(req.headers.authorization)

    const server = new McpServer({ name: 'echo-server', version: '1.0.0' })
    server.registerTool('echo', {
      description: 'Returns the text that it receives.',
      inputSchema: { text: z.string() },
    }, async ({ text }) => ({ content: [{ type: 'text', text }] }))

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res)
  })

  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authorizationHeaders,
    close: () => new Promise<void>((resolve) => {
      httpServer.closeAllConnections()
      httpServer.close(() => resolve())
    }),
  }
}

describe('createMcpServerManager with HTTP servers', () => {
  let userDataDir: string
  let echoServer: Awaited<ReturnType<typeof startEchoServer>>
  let manager: ReturnType<typeof createMcpServerManager>

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'airi-mcp-http-'))
    appMock.getPath.mockReturnValue(userDataDir)
    appMock.getVersion.mockReturnValue('0.0.0-test')
    echoServer = await startEchoServer()
    manager = createMcpServerManager()
  })

  afterEach(async () => {
    await manager.stopAll()
    await echoServer.close()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('connects to an HTTP server from mcp.json and calls its tools', async () => {
    await writeFile(join(userDataDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        remote: {
          type: 'http',
          url: echoServer.url,
          headers: { Authorization: 'Bearer test-token' },
        },
      },
    }))

    const applyResult = await manager.applyAndRestart()
    expect(applyResult.started).toEqual([{ name: 'remote' }])
    expect(applyResult.failed).toEqual([])

    expect(manager.getRuntimeStatus().servers).toEqual([
      { name: 'remote', state: 'running', target: echoServer.url, pid: null },
    ])

    const tools = await manager.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['remote::echo'])

    const callResult = await manager.callTool({ name: 'remote::echo', arguments: { text: 'hello' } })
    expect(callResult.content).toEqual([{ type: 'text', text: 'hello' }])

    expect(echoServer.authorizationHeaders.length).toBeGreaterThan(0)
    expect(new Set(echoServer.authorizationHeaders)).toEqual(new Set(['Bearer test-token']))
  })

  it('lists the tools of an HTTP server in a connection test', async () => {
    const result = await manager.testServer({
      name: 'remote',
      config: { type: 'http', url: echoServer.url },
    })

    expect(result.ok).toBe(true)
    expect(result.tools).toEqual(['echo'])
  })

  it('includes the network cause when an HTTP server is not reachable', async () => {
    // Close the server first, so that its port refuses connections.
    await echoServer.close()

    const result = await manager.testServer({
      name: 'offline',
      config: { type: 'http', url: echoServer.url },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('fetch failed')
    expect(result.error).toContain('ECONNREFUSED')
  })
})
