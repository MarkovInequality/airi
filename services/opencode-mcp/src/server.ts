import type { OpencodeConnection } from './opencode'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import packageJson from '../package.json' with { type: 'json' }

import { createApiCatalogLoader, registerApiTools } from './tools/api'
import { registerProjectTools } from './tools/project'
import { registerRequestTools } from './tools/requests'
import { createCommandTracker, registerSessionTools } from './tools/sessions'

/**
 * Sent to MCP clients when they connect. Some clients add it to the system prompt of the model,
 * so it explains the order of tool calls that one task needs.
 */
const instructions = [
  'These tools control OpenCode, a coding agent, in one project.',
  'To give OpenCode a task, call opencode_session_prompt. Then call opencode_session_wait until its state is "done", and read the reply.',
  'If the state is "needs-input", reply with opencode_permission_reply or opencode_question_reply, then wait again.',
  'For an operation that no other tool covers, find it with opencode_api_search and run it with opencode_api_call.',
].join(' ')

/**
 * Creates the factory of MCP servers for one OpenCode connection.
 *
 * State that must live longer than one MCP server belongs to the factory: the slash commands that
 * run in the background, and the cached API catalog. Stdio mode calls the factory one time. HTTP
 * mode calls it for each request, because each stateless request gets its own MCP server.
 */
export function createOpencodeMcpServerFactory(connection: OpencodeConnection) {
  const commands = createCommandTracker()
  const loadApiCatalog = createApiCatalogLoader(connection)

  return () => {
    const server = new McpServer({ name: 'opencode', version: packageJson.version }, { instructions })
    registerSessionTools(server, connection, commands)
    registerRequestTools(server, connection)
    registerProjectTools(server, connection)
    registerApiTools(server, connection, loadApiCatalog)
    return server
  }
}
