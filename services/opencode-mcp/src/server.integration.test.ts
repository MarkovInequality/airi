import process from 'node:process'

import { resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { connectOpencode } from './opencode'
import { createOpencodeMcpServerFactory } from './server'

/**
 * Runs the tools against a real `opencode serve` that {@link connectOpencode} starts. It needs the
 * `opencode` binary on PATH, so it runs only with `OPENCODE_MCP_INTEGRATION=true`. It sends no
 * prompt, so it needs no model provider.
 */
describe.runIf(process.env.OPENCODE_MCP_INTEGRATION === 'true')('opencode MCP server with a real OpenCode server', () => {
  let close = () => {}
  let client: Client

  beforeAll(async () => {
    const connection = await connectOpencode({ directory: resolve(import.meta.dirname, '..') })
    close = connection.close

    const server = createOpencodeMcpServerFactory(connection)()
    client = new Client({ name: 'integration-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  }, 60_000)

  afterAll(async () => {
    await client?.close()
    close()
  })

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args })
    const [content] = result.content as Array<{ type: string, text: string }>
    expect(result.isError, content.text).toBeFalsy()
    return JSON.parse(content.text)
  }

  it('reads the project through the typed tools', async () => {
    const info = await callTool('opencode_project_info')
    expect(info.opencodeVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('reaches the full API through the spec of the server', async () => {
    const found = await callTool('opencode_api_search', { query: 'global.health' })
    expect(found.method).toBe('GET')

    const health = await callTool('opencode_api_call', { operationId: 'global.health' })
    expect(health.data.healthy).toBe(true)
  })

  it('deletes a session', async () => {
    // No tool only creates a session, and a prompt needs a model provider, so the API creates it.
    const created = await callTool('opencode_api_call', { operationId: 'session.create', body: { title: 'opencode-mcp integration test' } })
    expect(created.data.id).toMatch(/^ses/)

    const deleted = await callTool('opencode_session_delete', { sessionID: created.data.id })
    expect(deleted).toEqual({ deleted: true })
  })
})
