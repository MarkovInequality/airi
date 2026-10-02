import type { OpencodeClient } from '@opencode-ai/sdk/v2/client'
import type { Client } from '@opencode-ai/sdk/v2/gen/client'

import process from 'node:process'

import { Buffer } from 'node:buffer'

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'
import { createClient } from '@opencode-ai/sdk/v2/gen/client'
import { createOpencodeServer } from '@opencode-ai/sdk/v2/server'

/** Options for {@link connectOpencode}. */
export interface ConnectOpencodeOptions {
  /**
   * URL of an OpenCode server that already runs, for example `http://127.0.0.1:4096`.
   * When it is not set, {@link connectOpencode} starts `opencode serve` on a free local port.
   */
  url?: string
  /**
   * Project directory for every request. OpenCode selects the project, its sessions,
   * and its config from this directory.
   *
   * @default process.cwd()
   */
  directory?: string
  /** Password of a server that runs with `OPENCODE_SERVER_PASSWORD`. Sent as HTTP basic auth. */
  password?: string
  /** @default 'opencode' */
  username?: string
}

/** A connection to one OpenCode server, scoped to one project directory. */
export interface OpencodeConnection {
  /** Typed SDK client for the tools that have their own input schema. */
  client: OpencodeClient
  /**
   * Low-level SDK client with the same base URL and headers. `opencode_api_call` uses it for
   * operations that have no typed tool. A failed request returns `{ error, response }` and does not throw.
   */
  http: Client
  url: string
  directory: string
  /** Stops the OpenCode server if {@link connectOpencode} started it. Does nothing for a server that was already running. */
  close: () => void
}

/**
 * Connects to an OpenCode server, or starts one, and creates the SDK clients for it.
 *
 * A server that this function starts is a child process of this process. The caller must call
 * {@link OpencodeConnection.close} on shutdown, or the server keeps running.
 */
export async function connectOpencode(options: ConnectOpencodeOptions = {}): Promise<OpencodeConnection> {
  const directory = options.directory ?? process.cwd()

  let url = options.url
  let close = () => {}
  if (!url) {
    // Port 0 lets OpenCode select a free port, so a server that the user already runs on
    // the default port 4096 does not block this one. The first start can take more than the
    // SDK default of 5 seconds, because OpenCode installs its plugins.
    const server = await createOpencodeServer({ port: 0, timeout: 30_000 })
    url = server.url
    close = () => server.close()
  }

  const authHeaders: Record<string, string> = options.password
    ? { Authorization: `Basic ${Buffer.from(`${options.username ?? 'opencode'}:${options.password}`).toString('base64')}` }
    : {}

  return {
    client: createOpencodeClient({ baseUrl: url, directory, headers: authHeaders }),
    http: createClient({
      baseUrl: url,
      // `createOpencodeClient` sends the directory in this header. The low-level client must
      // send it too, or the server uses the directory of its own process.
      headers: { ...authHeaders, 'x-opencode-directory': encodeURIComponent(directory) },
    }),
    url,
    directory,
    close,
  }
}
