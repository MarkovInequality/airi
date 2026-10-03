import type { BrowserWindow } from 'electron'

import type { I18n } from '../../../libs/i18n'
import type { ServerChannel } from '../../../services/airi/channel-server'
import type { GodotStageManager } from '../../../services/airi/godot-stage'
import type { IOTraceRecordingService } from '../../../services/airi/io-trace-recording'
import type { McpStdioManager } from '../../../services/airi/mcp-servers'
import type { AutoUpdater } from '../../../services/electron/auto-updater'
import type { GlobalShortcutService } from '../../../services/electron/global-shortcut'
import type { DevtoolsWindowManager } from '../../devtools'
import type { EditorWindowManager } from '../../editor'
import type { SpotlightWindowManager } from '../../spotlight'
import type { WidgetsWindowManager } from '../../widgets'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { ipcMain } from 'electron'

import {
  electronCenterMainWindow,
  electronOpenDevtoolsWindow,
  electronOpenEditor,
  electronOpenMainDevtools,
  electronOpenSettingsDevtools,
  electronSpotlightShortcutGet,
  electronSpotlightShortcutSet,
} from '../../../../shared/eventa'
import { createAuthService } from '../../../services/airi/auth'
import { createGodotStageService } from '../../../services/airi/godot-stage'
import { registerIOTraceRecording } from '../../../services/airi/io-trace-recording/register'
import { createMcpServersService } from '../../../services/airi/mcp-servers'
import { createWidgetsService } from '../../../services/airi/widgets'
import { createAutoUpdaterService } from '../../../services/electron'
import { centerWindowOnDisplay } from '../../shared/display'
import { setupBaseWindowElectronInvokes } from '../../shared/window'

export async function setupSettingsWindowInvokes(params: {
  settingsWindow: BrowserWindow
  widgetsManager: WidgetsWindowManager
  autoUpdater: AutoUpdater
  devtoolsWindow: DevtoolsWindowManager
  editorWindow: EditorWindowManager
  getMainWindow?: () => BrowserWindow | undefined
  serverChannel: ServerChannel
  godotStageManager: GodotStageManager
  mcpStdioManager: McpStdioManager
  i18n: I18n
  globalShortcut: GlobalShortcutService
  spotlightWindow: SpotlightWindowManager
  ioTraceRecording: IOTraceRecordingService
}) {
  // TODO: once we refactored eventa to support window-namespaced contexts,
  // we can remove the setMaxListeners call below since eventa will be able to dispatch and
  // manage events within eventa's context system.
  ipcMain.setMaxListeners(0)

  // `onlySameWindow` hears only this window and disposes with it. Without it, this channel
  // also runs requests from other windows, and each closed Settings window leaves its handlers.
  const { context } = createContext(ipcMain, params.settingsWindow, { onlySameWindow: true })

  await setupBaseWindowElectronInvokes({ context, window: params.settingsWindow, i18n: params.i18n, serverChannel: params.serverChannel })

  createWidgetsService({ context, widgetsManager: params.widgetsManager, window: params.settingsWindow })
  createAutoUpdaterService({ context, window: params.settingsWindow, service: params.autoUpdater })
  createMcpServersService({ context, manager: params.mcpStdioManager, window: params.settingsWindow })
  createGodotStageService({ context, manager: params.godotStageManager, window: params.settingsWindow })
  createAuthService({ context, window: params.settingsWindow })
  const stopIOTraceRecording = registerIOTraceRecording(context, params.ioTraceRecording)
  params.settingsWindow.once('closed', stopIOTraceRecording)

  // Register the global shortcut service for the settings window.
  params.globalShortcut.registerWindow({ context, window: params.settingsWindow })

  defineInvokeHandler(context, electronCenterMainWindow, () => centerWindowOnDisplay(params.getMainWindow?.()))
  defineInvokeHandler(context, electronSpotlightShortcutGet, () => params.spotlightWindow.getShortcutAccelerator())
  defineInvokeHandler(context, electronSpotlightShortcutSet, (payload) => {
    if (payload?.accelerator === undefined)
      throw new TypeError('electronSpotlightShortcutSet called with invalid payload')

    return params.spotlightWindow.updateShortcutAccelerator(payload.accelerator)
  })

  // The Developer settings page opens the devtools of the main window and the editor.
  defineInvokeHandler(context, electronOpenMainDevtools, () => params.getMainWindow?.()?.webContents.openDevTools({ mode: 'detach' }))
  defineInvokeHandler(context, electronOpenEditor, () => params.editorWindow.openWindow())
  defineInvokeHandler(context, electronOpenSettingsDevtools, async () => params.settingsWindow.webContents.openDevTools({ mode: 'detach' }))
  defineInvokeHandler(context, electronOpenDevtoolsWindow, async (payload) => {
    await params.devtoolsWindow.openWindow(payload)
  })

  return context
}
