import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { OpencodeConnection } from '../opencode'

import { z } from 'zod'

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

  server.registerTool('opencode_find_text', {
    description: 'Search the text of the project files with a regular expression (ripgrep syntax).',
    inputSchema: {
      pattern: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional().describe('Most matches to return. Default 50.'),
    },
  }, async ({ pattern, limit }) => respond(async () => {
    const { data } = await client.find.text({ pattern }, strict)
    const maxMatches = limit ?? 50
    return {
      matchCount: data.length,
      matches: data.slice(0, maxMatches).map(match => `${match.path.text}:${match.line_number}: ${truncate(match.lines.text.trim(), 200)}`),
    }
  }))

  server.registerTool('opencode_find_files', {
    description: 'Find project files or directories by a fuzzy name search.',
    inputSchema: {
      query: z.string().min(1),
      type: z.enum(['file', 'directory']).optional().describe('Default: both.'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
    },
  }, async ({ query, type, limit }) => respond(async () => {
    const { data } = await client.find.files({ query, type, limit: limit ?? 50 }, strict)
    return data
  }))

  server.registerTool('opencode_file_read', {
    description: 'Read a text file of the project. Use startLine and endLine to read a long file in parts.',
    inputSchema: {
      path: z.string().min(1).describe('Path relative to the project directory.'),
      startLine: z.number().int().min(1).optional().describe('First line to return, from 1.'),
      endLine: z.number().int().min(1).optional().describe('Last line to return.'),
    },
  }, async ({ path, startLine, endLine }) => respond(async () => {
    const { data } = await client.file.read({ path }, strict)
    if (data.type === 'binary') {
      return { path, type: 'binary', mimeType: data.mimeType }
    }

    const lines = data.content.split('\n')
    const first = startLine ?? 1
    const last = Math.min(endLine ?? lines.length, lines.length)
    return {
      path,
      totalLines: lines.length,
      startLine: first,
      endLine: last,
      content: lines.slice(first - 1, last).join('\n'),
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
