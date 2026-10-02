import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { LlmToolsetPromptContribution } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'

import type { ElectronMcpServerInstructions } from '../../../shared/eventa'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { createMcpTools } from '@proj-airi/stage-ui/tools/mcp'
import { defineStore } from 'pinia'

import { electronMcpCallTool, electronMcpListInstructions, electronMcpListTools } from '../../../shared/eventa'

/**
 * Longest instructions text of one server in the system prompt. The text goes into every
 * chat request, and a server controls its length, so a long text is cut.
 */
const maxInstructionsChars = 4_000

/**
 * Builds the system prompt section for the instructions of one MCP server.
 *
 * Servers write instructions for clients that expose each MCP tool by its own name. AIRI exposes
 * only `builtIn_mcpListTools` and `builtIn_mcpCallTool`, so the section first tells the model how a
 * tool name in the instructions maps to a call.
 */
function createInstructionsPrompt({ serverName, instructions }: ElectronMcpServerInstructions): LlmToolsetPromptContribution {
  const text = instructions.length > maxInstructionsChars
    ? `${instructions.slice(0, maxInstructionsChars)}\n[The server instructions are longer. The rest is not shown.]`
    : instructions

  return {
    id: `mcp:${serverName}`,
    title: `MCP server "${serverName}"`,
    content: [
      `The MCP server "${serverName}" gave these instructions. To call a tool that they name, call builtIn_mcpCallTool with the name "${serverName}::<tool name>". builtIn_mcpListTools lists the tools and their arguments.`,
      '',
      text,
    ].join('\n'),
  }
}

export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const toolsetPromptsStore = useLlmToolsetPromptsStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const listMcpInstructions = useElectronEventaInvoke(electronMcpListInstructions)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
  const toolIdPrefix = 'mcp:'
  const toolsetPromptProvider = 'mcp'

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  /**
   * Registers the MCP proxy tools and the instructions of the running servers.
   *
   * Runs in the leader renderer, which also sends the chat requests. The toolset prompt store is
   * not synchronized, so the instructions exist only in the renderer that composes the system prompt.
   */
  async function refresh() {
    const tools = await Promise.all(createMcpTools({
      listTools: () => listMcpTools(),
      callTool: payload => callMcpTool(payload),
    }))

    llmToolsStore.removeToolsByIds(...registeredToolIds())
    llmToolsStore.addTools(...tools.map(tool => ({
      ...tool,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)))

    const instructions = await listMcpInstructions()
    toolsetPromptsStore.registerToolsetPrompts(toolsetPromptProvider, instructions.map(createInstructionsPrompt))
  }

  function dispose() {
    llmToolsStore.removeToolsByIds(...registeredToolIds())
    toolsetPromptsStore.clearToolsetPrompts(toolsetPromptProvider)
  }

  return {
    dispose,
    refresh,
  }
}, {
  synced: {
    actions: ['dispose', 'refresh'],
    state: false,
  },
})
