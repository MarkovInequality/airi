import type { Tool } from '@xsai/shared-chat'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  })),
  listMcpInstructions: vi.fn(async () => [{
    serverName: 'opencode',
    instructions: 'Call opencode_session_prompt, then opencode_session_wait.',
  }]),
  listMcpTools: vi.fn(async () => [{
    serverName: 'filesystem',
    name: 'filesystem::search',
    toolName: 'search',
    description: 'Search files.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  }]),
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:list-tools-receive')
      return invokeMocks.listMcpTools
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:call-tool-receive')
      return invokeMocks.callMcpTool
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:list-instructions-receive')
      return invokeMocks.listMcpInstructions

    throw new Error(`Unexpected eventa invoke: ${JSON.stringify(event)}`)
  },
}))

describe('useTamagotchiMcpToolsStore', async () => {
  const { useTamagotchiMcpToolsStore } = await import('./mcp')

  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMocks.listMcpTools.mockClear()
    invokeMocks.callMcpTool.mockClear()
    invokeMocks.listMcpInstructions.mockClear()
  })

  it('loads MCP tools, proxies execution, and clears them from the shared llm-tools store', async () => {
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiMcpToolsStore()
    const toolOptions = {} as Parameters<Tool['execute']>[1]

    await store.refresh()

    const mcpDefinitions = llmToolsStore.tools.filter(tool => tool.id.startsWith('mcp:'))
    const listTools = llmToolsStore.activeTools.find(tool => tool.function.name === 'builtIn_mcpListTools')
    const callTool = llmToolsStore.activeTools.find(tool => tool.function.name === 'builtIn_mcpCallTool')

    expect(mcpDefinitions).toEqual([
      expect.objectContaining({
        id: 'mcp:builtIn_mcpListTools',
        function: expect.objectContaining({ name: 'builtIn_mcpListTools' }),
      }),
      expect.objectContaining({
        id: 'mcp:builtIn_mcpCallTool',
        function: expect.objectContaining({ name: 'builtIn_mcpCallTool' }),
      }),
    ])
    expect(JSON.stringify(llmToolsStore.$state)).not.toContain('execute')

    const listResult = await listTools?.execute({}, toolOptions)
    const callResult = await callTool?.execute({
      name: 'filesystem::search',
      arguments: JSON.stringify({ query: 'hello', limit: 10 }),
    }, toolOptions)

    expect(invokeMocks.listMcpTools).toHaveBeenCalledTimes(1)
    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith({
      name: 'filesystem::search',
      arguments: { query: 'hello', limit: 10 },
    })
    expect(listResult).toEqual([{
      serverName: 'filesystem',
      name: 'filesystem::search',
      toolName: 'search',
      description: 'Search files.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    }])
    expect(callResult).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })

    store.dispose()

    expect(llmToolsStore.tools.filter(tool => tool.id.startsWith('mcp:'))).toEqual([])
  })

  it('adds the instructions of the running MCP servers to the system prompt until dispose', async () => {
    const toolsetPrompts = useLlmToolsetPromptsStore()
    const store = useTamagotchiMcpToolsStore()

    await store.refresh()

    expect(toolsetPrompts.activeToolsetPrompt).toContain('### MCP server "opencode"')
    expect(toolsetPrompts.activeToolsetPrompt).toContain('call builtIn_mcpCallTool with the name "opencode::<tool name>"')
    expect(toolsetPrompts.activeToolsetPrompt).toContain('Call opencode_session_prompt, then opencode_session_wait.')

    store.dispose()

    expect(toolsetPrompts.activeToolsetPrompt).toBe('')
  })

  it('cuts long server instructions in the system prompt', async () => {
    invokeMocks.listMcpInstructions.mockResolvedValueOnce([{ serverName: 'verbose', instructions: 'x'.repeat(5_000) }])
    const toolsetPrompts = useLlmToolsetPromptsStore()
    const store = useTamagotchiMcpToolsStore()

    await store.refresh()

    expect(toolsetPrompts.activeToolsetPrompt).toContain(`${'x'.repeat(4_000)}\n[The server instructions are longer. The rest is not shown.]`)
    expect(toolsetPrompts.activeToolsetPrompt).not.toContain('x'.repeat(4_001))
  })
})
