import type { JsonSchema } from 'xsschema'

import type { McpCallToolResult } from './mcp'

import { describe, expect, it } from 'vitest'

import { createMcpTools, mcp } from './mcp'

async function callTool(result: McpCallToolResult) {
  const tools = await Promise.all(createMcpTools({
    listTools: async () => [],
    callTool: async () => result,
  }))
  const callTool = tools.find(entry => entry.function.name === 'builtIn_mcpCallTool')
  return await callTool?.execute({ name: 'windows-mcp::Screenshot', arguments: '{}' }, { messages: [], toolCallId: 'call-1' })
}

describe('tools mcp schema', () => {
  it('emits strict parameter objects', async () => {
    const tools = await mcp()
    for (const name of ['builtIn_mcpListTools', 'builtIn_mcpCallTool']) {
      const t = tools.find(entry => entry.function.name === name)
      expect(t, `missing tool: ${name}`).toBeDefined()
      expect(t?.function.parameters.additionalProperties).toBe(false)
    }
  })

  it('builtIn_mcpCallTool uses flat name+arguments schema', async () => {
    const tools = await mcp()
    const callTool = tools.find(entry => entry.function.name === 'builtIn_mcpCallTool')
    expect(callTool).toBeDefined()

    const props = (callTool!.function.parameters as JsonSchema).properties!
    expect((props.name as JsonSchema).type).toBe('string')
    expect((props.arguments as JsonSchema).type).toBe('string')
  })
})

describe('builtIn_mcpCallTool results', () => {
  it('sends MCP images as image parts next to the tool text', async () => {
    const result = await callTool({
      content: [
        { type: 'text', text: 'Cursor Position: (812, 440)' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///shot.png', name: 'shot.png' },
      ],
    })

    expect(result).toEqual([
      { type: 'text', text: 'Cursor Position: (812, 440)' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'text', text: '{"type":"resource_link","uri":"file:///shot.png","name":"shot.png"}' },
    ])
  })

  it('keeps the failure visible when a tool returns an image with an error', async () => {
    const result = await callTool({
      isError: true,
      content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    })

    expect(result).toEqual([
      { type: 'text', text: 'The MCP tool reported an error.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ])
  })

  it('leaves a result without images unchanged', async () => {
    const original = { content: [{ type: 'text', text: 'Clicked.' }], structuredContent: { ok: true } }

    const result = await callTool(original)

    expect(result).toEqual(original)
  })
})
