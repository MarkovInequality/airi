import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { OpencodeConnection } from '../opencode'

import { respond, strict, truncate } from './result'

export function registerProjectTools(server: McpServer, connection: OpencodeConnection) {
  const { client } = connection

  server.registerTool('opencode_project_info', {
    description: 'Show the OpenCode version, the project directory, and the git branch.',
    inputSchema: {},
  }, async () => respond(async () => {
    const [health, path, project, vcs] = await Promise.all([
      client.global.health(strict),
      client.path.get(undefined, strict),
      client.project.current(undefined, strict),
      client.vcs.get(undefined, strict),
    ])

    return {
      opencodeVersion: health.data.version,
      projectID: project.data.id,
      directory: path.data.directory,
      worktree: path.data.worktree,
      branch: vcs.data.branch,
      defaultBranch: vcs.data.default_branch,
    }
  }))

  server.registerTool('opencode_prompt_options', {
    description: 'List the agents, slash commands, and models that opencode_session_prompt and opencode_session_command accept.',
    inputSchema: {},
  }, async () => respond(async () => {
    const [agents, commands, providers, config] = await Promise.all([
      client.app.agents(undefined, strict),
      client.command.list(undefined, strict),
      client.config.providers(undefined, strict),
      client.config.get(undefined, strict),
    ])

    return {
      agents: agents.data
        .filter(agent => !agent.hidden)
        .map(agent => ({
          name: agent.name,
          mode: agent.mode,
          description: agent.description ? truncate(agent.description, 150) : undefined,
        })),
      commands: commands.data.map(command => ({
        name: command.name,
        description: command.description ? truncate(command.description, 120) : undefined,
      })),
      defaultModel: config.data.model,
      // Only model IDs: provider entries also hold API keys and endpoint options.
      modelsByProvider: Object.fromEntries(providers.data.providers.map(provider => [provider.id, Object.keys(provider.models)])),
    }
  }))

  server.registerTool('opencode_vcs_status', {
    description: 'Show the git branch and the changed files of the project.',
    inputSchema: {},
  }, async () => respond(async () => {
    const [vcs, files] = await Promise.all([
      client.vcs.get(undefined, strict),
      client.vcs.status(undefined, strict),
    ])

    return {
      branch: vcs.data.branch,
      files: files.data,
    }
  }))
}
