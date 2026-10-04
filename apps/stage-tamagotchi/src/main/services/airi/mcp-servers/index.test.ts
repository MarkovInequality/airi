import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@moeru/eventa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { electronMcpServersChanged } from '../../../../shared/eventa'

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(),
}))

const shellMock = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  getInstructions: vi.fn(),
  listTools: vi.fn(),
}))

vi.mock('electron', () => ({
  app: appMock,
  shell: shellMock,
}))

vi.mock('@guiiai/logg', () => ({
  useLogg: vi.fn(() => ({
    useGlobalConfig: () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      withError: vi.fn(() => ({ warn: vi.fn() })),
      withFields: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn() })),
    }),
  })),
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    callTool = clientMocks.callTool
    close = clientMocks.close
    connect = clientMocks.connect
    getInstructions = clientMocks.getInstructions
    listTools = clientMocks.listTools
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async () => {
  const { PassThrough } = await import('node:stream')

  return {
    StdioClientTransport: class {
      stderr = new PassThrough()

      constructor(readonly server: unknown) {}

      close = vi.fn(async () => undefined)
    },
  }
})

describe('createMcpStdioManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appMock.getPath.mockReturnValue('/tmp/airi-user-data')
    appMock.getVersion.mockReturnValue('0.10.0')
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.listTools.mockResolvedValue({ tools: [] })
  })

  it('includes stderr captured during connect failures in MCP server test results', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()

    clientMocks.connect.mockImplementationOnce(async (transport: { stderr: NodeJS.WritableStream }) => {
      transport.stderr.write('Missing required environment variable: API_KEY\n')
      throw new Error('connect failed')
    })

    const result = await manager.testServer({
      name: 'broken-server',
      config: {
        command: 'broken-mcp-server',
      },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('connect failed')
    expect(result.error).toContain('Missing required environment variable: API_KEY')
  })

  describe('running servers', () => {
    let userDataDir: string

    beforeEach(async () => {
      userDataDir = await mkdtemp(join(tmpdir(), 'airi-mcp-running-servers-'))
      appMock.getPath.mockReturnValue(userDataDir)
      clientMocks.connect.mockResolvedValue(undefined)
    })

    afterEach(async () => {
      await rm(userDataDir, { recursive: true, force: true })
    })

    async function writeConfig(mcpServers: Record<string, { command: string }>) {
      await writeFile(join(userDataDir, 'mcp.json'), JSON.stringify({ mcpServers }))
    }

    it('lists the instructions that the running servers sent', async () => {
      const { createMcpStdioManager } = await import('./index')
      const manager = createMcpStdioManager()
      await writeConfig({ opencode: { command: 'opencode-mcp' }, filesystem: { command: 'filesystem-mcp' } })
      clientMocks.getInstructions
        .mockReturnValueOnce('  Call opencode_session_prompt, then opencode_session_wait.\n')
        .mockReturnValueOnce(undefined)

      await manager.applyAndRestart()

      expect(manager.listInstructions()).toEqual([
        { serverName: 'opencode', instructions: 'Call opencode_session_prompt, then opencode_session_wait.' },
      ])
    })

    it('sends a servers-changed event to a window after each restart until the window closes', async () => {
      const { createMcpServersService, createMcpStdioManager } = await import('./index')
      const manager = createMcpStdioManager()
      await writeConfig({})
      const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
      const receivedEvents = vi.fn()
      context.on(electronMcpServersChanged, receivedEvents)

      // NOTICE:
      // The service uses only the 'closed' event of the window. An EventEmitter gives that
      // event, and the cast through `unknown` passes it where the full BrowserWindow type is required.
      const window = new EventEmitter()
      createMcpServersService({ context, manager, window: window as unknown as BrowserWindow })

      await manager.applyAndRestart()
      await vi.waitFor(() => expect(receivedEvents).toHaveBeenCalledTimes(1))

      window.emit('closed')
      await manager.applyAndRestart()

      expect(receivedEvents).toHaveBeenCalledTimes(1)
    })

    it('restarts the timeout of a tool call on each progress notification, with no total limit', async () => {
      const { createMcpStdioManager } = await import('./index')
      const manager = createMcpStdioManager()
      await writeConfig({ opencode: { command: 'opencode-mcp' } })
      clientMocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: '{"state":"done"}' }] })
      await manager.applyAndRestart()

      const result = await manager.callTool({ name: 'opencode::opencode_session_wait', arguments: { sessionID: 'ses_1' } })

      expect(result.content).toEqual([{ type: 'text', text: '{"state":"done"}' }])
      expect(clientMocks.callTool).toHaveBeenCalledWith(
        { name: 'opencode_session_wait', arguments: { sessionID: 'ses_1' } },
        undefined,
        { timeout: 10_000, resetTimeoutOnProgress: true, onprogress: expect.any(Function) },
      )
    })
  })
})
