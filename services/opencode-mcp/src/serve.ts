import type { AddressInfo } from 'node:net'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import process from 'node:process'

import { createServer } from 'node:http'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Serves one MCP server over stdin and stdout. The returned promise resolves when the client
 * closes stdin, which is how an MCP client stops a stdio server.
 */
export async function serveStdio(createMcpServer: () => McpServer) {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())

  // The SDK transport does not close when stdin ends, so this process watches stdin itself.
  await new Promise<void>(resolve => process.stdin.once('end', resolve))
  await server.close()
}

/** Options for {@link serveHttp}. */
export interface ServeHttpOptions {
  /** @default '127.0.0.1' */
  host?: string
  /** Port to listen on. 0 selects a free port. */
  port: number
}

/**
 * Serves MCP over Streamable HTTP at `/mcp`, in stateless mode.
 *
 * Each POST gets a new MCP server from `createMcpServer` and a new transport, which close when
 * the response ends. GET and DELETE return 405. This tells clients that the server has no
 * standalone event stream and no session to end.
 *
 * On a loopback host, the transport accepts only requests whose `Host` header names this server.
 * This blocks DNS rebinding, where a web page sends requests to a local port through its own domain.
 * On another host, any client that can reach the port controls OpenCode.
 */
export async function serveHttp(createMcpServer: () => McpServer, options: ServeHttpOptions) {
  const host = options.host ?? '127.0.0.1'
  let allowedHosts: string[] | undefined

  const httpServer = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }

    const server = createMcpServer()
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: allowedHosts !== undefined,
      allowedHosts,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    }
    catch (error) {
      console.error('Failed to handle an MCP request:', error)
      if (!res.headersSent) {
        res.writeHead(500).end()
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  // The port is known only after `listen`, when port 0 selects one. No request arrives before this line runs.
  const { port } = httpServer.address() as AddressInfo
  if (loopbackHosts.has(host)) {
    allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  }

  const urlHost = host.includes(':') ? `[${host}]` : host
  return {
    url: `http://${urlHost}:${port}/mcp`,
    close: () => new Promise<void>((resolve) => {
      httpServer.closeAllConnections()
      httpServer.close(() => resolve())
    }),
  }
}
