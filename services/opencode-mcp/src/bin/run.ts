#!/usr/bin/env node
import process from 'node:process'

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { connectOpencode } from '../opencode'
import { serveHttp, serveStdio } from '../serve'
import { createOpencodeMcpServerFactory } from '../server'

function parsePort(value: string) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--http-port must be a port number from 0 to 65535. Received: ${value}`)
  }

  return port
}

/**
 * CLI entry of the OpenCode MCP server.
 *
 * Usage: `opencode-mcp [--url <opencode-url>] [--directory <path>] [--http-port <port> [--http-host <host>]]`
 *
 * Without `--url`, it starts `opencode serve` as a child process and stops it on exit.
 * Without `--http-port`, it serves MCP over stdio, so stdout carries only MCP messages and
 * all logs go to stderr. `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` give the
 * credentials of a password-protected OpenCode server.
 *
 * Call stack:
 *
 * main
 *   -> {@link connectOpencode}
 *   -> {@link createOpencodeMcpServerFactory}
 *   -> {@link serveStdio} or {@link serveHttp}
 */
async function main() {
  const { values } = parseArgs({
    options: {
      'url': { type: 'string' },
      'directory': { type: 'string' },
      'http-port': { type: 'string' },
      'http-host': { type: 'string' },
    },
  })

  const httpPort = values['http-port'] === undefined ? undefined : parsePort(values['http-port'])
  const connection = await connectOpencode({
    url: values.url,
    directory: values.directory ? resolve(values.directory) : undefined,
    password: process.env.OPENCODE_SERVER_PASSWORD,
    username: process.env.OPENCODE_SERVER_USERNAME,
  })

  // An OpenCode server that `connectOpencode` started must stop with this process.
  const shutdown = () => {
    connection.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  const createMcpServer = createOpencodeMcpServerFactory(connection)

  if (httpPort !== undefined) {
    const { url } = await serveHttp(createMcpServer, { host: values['http-host'], port: httpPort })
    console.error(`OpenCode MCP server: ${url} (OpenCode server: ${connection.url}, project: ${connection.directory})`)
    return
  }

  await serveStdio(createMcpServer)
  shutdown()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
