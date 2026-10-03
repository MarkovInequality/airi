import type { BrowserWindow } from 'electron'

import type { I18n } from '../../../libs/i18n'
import type { ServerChannel } from '../../../services/airi/channel-server'
import type { GodotStageManager } from '../../../services/airi/godot-stage'
import type { IOTraceRecordingService } from '../../../services/airi/io-trace-recording'
import type { McpStdioManager } from '../../../services/airi/mcp-servers'
import type { AutoUpdater } from '../../../services/electron/auto-updater'
import type { GlobalShortcutService } from '../../../services/electron/global-shortcut'
import type { ChatWindowManager } from '../../chat'
import type { DevtoolsWindowManager } from '../../devtools'
import type { EditorWindowManager } from '../../editor'
import type { NoticeWindowManager } from '../../notice'
import type { OnboardingWindowManager } from '../../onboarding'
import type { SettingsWindowManager } from '../../settings'
import type { SpotlightWindowManager } from '../../spotlight'
import type { WidgetsWindowManager } from '../../widgets'

import { EventEmitter } from 'node:events'

import { defineInvoke } from '@moeru/eventa'
import { createContext as createRendererContext } from '@moeru/eventa/adapters/electron/renderer'
import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { electronMcpApplyAndRestart, electronMcpCallTool, electronOpenEditor, electronOpenMainDevtools } from '../../../../shared/eventa'
import { setupMainWindowElectronInvokes } from '../../main/rpc/index.electron'
import { setupSettingsWindowInvokes } from './index.electron'

// Electron IPC is the boundary under test, so a plain EventEmitter carries the messages.
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})

// These services do not take part in request routing between windows.
vi.mock('../../shared/window', () => ({ setupBaseWindowElectronInvokes: vi.fn() }))
vi.mock('../../shared/display', () => ({ centerWindowOnDisplay: vi.fn() }))
vi.mock('../../../services/airi/auth', () => ({ createAuthService: vi.fn() }))
vi.mock('../../../services/airi/godot-stage', () => ({ createGodotStageService: vi.fn() }))
vi.mock('../../../services/airi/io-trace-recording/register', () => ({ registerIOTraceRecording: vi.fn(() => vi.fn()) }))
vi.mock('../../../services/airi/onboarding', () => ({ createOnboardingService: vi.fn() }))
vi.mock('../../../services/airi/widgets', () => ({ createWidgetsService: vi.fn() }))
vi.mock('../../../services/electron', () => ({ createAutoUpdaterService: vi.fn() }))

/**
 * One renderer and its window. The window's webContents receives main-to-renderer messages,
 * and the renderer's ipcRenderer sends messages to the shared ipcMain with that webContents as sender.
 */
function createRendererWindow(id: number) {
  const inbox = new EventEmitter()
  const webContents = {
    id,
    isDestroyed: () => false,
    openDevTools: vi.fn(),
    send: (channel: string, payload: unknown) => inbox.emit(channel, {}, payload),
  }
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false })
  const ipcRenderer: Parameters<typeof createRendererContext>[0] = {
    send: (channel, ...args) => {
      ipcMain.emit(channel, { sender: webContents }, ...args)
    },
    on: (channel, listener) => {
      inbox.on(channel, listener)
      return () => inbox.off(channel, listener)
    },
    once: (channel, listener) => {
      inbox.once(channel, listener)
      return () => inbox.off(channel, listener)
    },
    removeAllListeners: (channel) => {
      inbox.removeAllListeners(channel)
    },
    removeListener(channel, listener) {
      inbox.removeListener(channel, listener)
      return this
    },
    invoke: vi.fn(),
    postMessage: vi.fn(),
    sendSync: vi.fn(),
    sendTo: vi.fn(),
    sendToHost: vi.fn(),
  }
  return {
    // NOTICE:
    // The channels use only the events, `isDestroyed`, and the webContents fields above.
    // The cast through `unknown` passes this object where the full BrowserWindow type is required.
    window: window as unknown as BrowserWindow,
    webContents,
    context: createRendererContext(ipcRenderer).context,
    close: () => window.emit('closed'),
  }
}

function createEditorWindow() {
  return { getWindow: vi.fn(), openWindow: vi.fn(async () => {}) } satisfies EditorWindowManager
}

function createMcpManager() {
  return {
    ensureConfigFile: vi.fn(),
    openConfigFile: vi.fn(),
    applyAndRestart: vi.fn(async () => ({ path: 'mcp.json', started: [], failed: [], skipped: [] })),
    listTools: vi.fn(async () => []),
    listInstructions: vi.fn(() => []),
    onServersChanged: vi.fn(() => vi.fn()),
    callTool: vi.fn(async () => ({ content: [] })),
    stopAll: vi.fn(),
    getRuntimeStatus: vi.fn(),
    readConfigText: vi.fn(),
    writeConfigText: vi.fn(),
    testServer: vi.fn(),
  } satisfies McpStdioManager
}

function setupMainChannel(mainWindow: BrowserWindow, mcpStdioManager: McpStdioManager) {
  return setupMainWindowElectronInvokes({
    window: mainWindow,
    editorWindow: createEditorWindow(),
    settingsWindow: {} as SettingsWindowManager,
    chatWindow: { open: vi.fn(), toggle: vi.fn(), getButtonState: vi.fn(), onButtonStateChange: () => vi.fn() } satisfies ChatWindowManager,
    widgetsManager: {} as WidgetsWindowManager,
    noticeWindow: {} as NoticeWindowManager,
    autoUpdater: {} as AutoUpdater,
    serverChannel: {} as ServerChannel,
    godotStageManager: {} as GodotStageManager,
    mcpStdioManager,
    i18n: {} as I18n,
    onboardingWindowManager: {} as OnboardingWindowManager,
    ioTraceRecording: {} as IOTraceRecordingService,
  })
}

function setupSettingsChannel(settingsWindow: BrowserWindow, options: {
  mcpStdioManager: McpStdioManager
  editorWindow?: EditorWindowManager
  getMainWindow?: () => BrowserWindow | undefined
}) {
  return setupSettingsWindowInvokes({
    settingsWindow,
    widgetsManager: {} as WidgetsWindowManager,
    autoUpdater: {} as AutoUpdater,
    devtoolsWindow: {} as DevtoolsWindowManager,
    editorWindow: options.editorWindow ?? createEditorWindow(),
    getMainWindow: options.getMainWindow,
    serverChannel: {} as ServerChannel,
    godotStageManager: {} as GodotStageManager,
    mcpStdioManager: options.mcpStdioManager,
    i18n: {} as I18n,
    globalShortcut: { registerWindow: vi.fn(), registerMainShortcut: vi.fn(), dispose: vi.fn() } satisfies GlobalShortcutService,
    spotlightWindow: {} as SpotlightWindowManager,
    ioTraceRecording: {} as IOTraceRecordingService,
  })
}

/** Lets handlers that other channels started for the same message settle. */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('settings window channel', () => {
  beforeEach(() => {
    ipcMain.removeAllListeners()
  })

  // ROOT CAUSE:
  //
  // One Paint request opened two Paint windows. Each window channel ran every window's requests.
  //
  // createContext(ipcMain, params.settingsWindow)
  //
  // We fixed this with `onlySameWindow`, which also disposes the channel with its window.
  // createContext(ipcMain, params.settingsWindow, { onlySameWindow: true })
  it('runs a tool call from the main window once while Settings is open', async () => {
    const mcpStdioManager = createMcpManager()
    const main = createRendererWindow(1)
    const settings = createRendererWindow(2)
    await setupMainChannel(main.window, mcpStdioManager)
    await setupSettingsChannel(settings.window, { mcpStdioManager })

    await defineInvoke(main.context, electronMcpCallTool)({ name: 'windows-mcp::App', arguments: { mode: 'launch', name: 'Paint' } })
    await settle()

    expect(mcpStdioManager.callTool).toHaveBeenCalledTimes(1)
  })

  it('restarts the MCP servers once per click after Settings was closed and opened again', async () => {
    const mcpStdioManager = createMcpManager()
    const main = createRendererWindow(1)
    const closedSettings = createRendererWindow(2)
    const settings = createRendererWindow(3)
    await setupMainChannel(main.window, mcpStdioManager)
    await setupSettingsChannel(closedSettings.window, { mcpStdioManager })
    closedSettings.close()
    await setupSettingsChannel(settings.window, { mcpStdioManager })

    await defineInvoke(settings.context, electronMcpApplyAndRestart)()
    await settle()

    expect(mcpStdioManager.applyAndRestart).toHaveBeenCalledTimes(1)
  })

  it('opens the editor from the Settings window', async () => {
    const editorWindow = createEditorWindow()
    const settings = createRendererWindow(2)
    await setupSettingsChannel(settings.window, { mcpStdioManager: createMcpManager(), editorWindow })

    await defineInvoke(settings.context, electronOpenEditor)()

    expect(editorWindow.openWindow).toHaveBeenCalledTimes(1)
  })

  it('opens the devtools of the main window from the Settings window', async () => {
    const main = createRendererWindow(1)
    const settings = createRendererWindow(2)
    await setupSettingsChannel(settings.window, { mcpStdioManager: createMcpManager(), getMainWindow: () => main.window })

    await defineInvoke(settings.context, electronOpenMainDevtools)()

    expect(main.webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
    expect(settings.webContents.openDevTools).not.toHaveBeenCalled()
  })
})
