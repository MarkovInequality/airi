# @proj-airi/opencode-mcp

An MCP server that gives AIRI, or another MCP client, control of [OpenCode](https://opencode.ai), a coding agent.

The server uses the official OpenCode SDK (`@opencode-ai/sdk`). It connects to an OpenCode server, or starts one, and gives MCP tools for the whole OpenCode server API.

## What It Does

The server has 18 tools:

- 16 typed tools for the usual work: sessions, prompts, permission replies, project info, and git status. Each tool has a small input schema and returns a short result.
- 2 generic tools that reach every other operation of the OpenCode API (182 of its 188 operations; see [Limits](#limits)). `opencode_api_search` finds an operation and gives its input schema. `opencode_api_call` runs it.

In an MCP client that gives each tool to the model, the tool list costs about 2,300 tokens in each request. One tool for each API operation costs about 47,000 tokens. AIRI gives the model one tool that lists the MCP tools, so the list goes into the chat only when the model calls that tool.

### How a Task Runs

An OpenCode agent can work for minutes, but many MCP clients end a tool call after a short timeout. Thus the wait for the agent sends progress notifications:

1. `opencode_session_prompt` sends the task and returns the `sessionID` at once.
2. `opencode_session_wait` waits until the agent finishes or needs input. It has no time limit. It checks the session once a second, and after each check it sends a progress notification if the client sent a progress token. A client that restarts its timeout on progress waits as long as the agent works. AIRI restarts its 10-second timeout on progress. The client ends the wait when it cancels the call.
3. The wait returns a `state`:
   - `done`: the agent finished. `reply` holds its answer.
   - `needs-input`: the agent waits for you. Reply with `opencode_permission_reply` or `opencode_question_reply`, then wait again.

`opencode_session_command` runs slash commands (for example `init`) in the same way.

## When to Use It

- You want AIRI to give coding tasks to OpenCode.
- You want an MCP client to use OpenCode features that it does not have.

## When Not to Use It

- You want to use OpenCode yourself. Use the OpenCode terminal interface or `opencode run`.
- You want a client that follows live events or terminal output. This server gives request and response tools only.

## Usage

Build the server first:

```sh
pnpm -F @proj-airi/opencode-mcp build
```

### With AIRI (stdio)

Add an entry to `mcp.json` in the AIRI settings (**Settings > Modules > MCP servers**):

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/path/to/airi/services/opencode-mcp/dist/bin/run.mjs", "--directory", "/path/to/your/project"]
    }
  }
}
```

The server starts `opencode serve` for the project, and stops it when AIRI stops the server. AIRI adds the instructions of the server, which explain the order of the tool calls, to the system prompt of the chat.

If the test in AIRI shows `spawn opencode ENOENT`, AIRI cannot find the `opencode` command. Add the directory of `opencode` to `PATH` in the `env` field of the entry, for example `"env": { "PATH": "/home/you/.opencode/bin:/usr/bin:/bin" }`. Or start OpenCode yourself and use `--url`.

### With an HTTP Client

For an MCP client that supports the Streamable HTTP transport:

```sh
node services/opencode-mcp/dist/bin/run.mjs --http-port 3920 --directory /path/to/your/project
```

Then connect the client to `http://127.0.0.1:3920/mcp`.

### Options

| Option | Description |
|---|---|
| `--url <url>` | Use an OpenCode server that already runs, for example `http://127.0.0.1:4096`. Without it, the server starts `opencode serve` on a free port. |
| `--directory <path>` | Project directory. OpenCode selects the project, sessions, and config from it. The default is the working directory. |
| `--http-port <port>` | Serve MCP over HTTP on this port, not over stdio. `0` selects a free port. |
| `--http-host <host>` | Host for `--http-port`. The default is `127.0.0.1`. |

| Environment variable | Description |
|---|---|
| `OPENCODE_SERVER_PASSWORD` | Password of an OpenCode server that requires one. |
| `OPENCODE_SERVER_USERNAME` | User name for that password. The default is `opencode`. |
| `OPENCODE_ENABLE_EXA` | Set to `1` to give the OpenCode agent its `websearch` tool. The server passes it to the `opencode serve` that it starts. |
| `EXA_API_KEY` | Optional key for Exa. Without it, OpenCode uses the free Exa endpoint. |

OpenCode sends web search queries to Exa (`https://mcp.exa.ai/mcp`). The tool descriptions tell the model that OpenCode can search the web, so set `OPENCODE_ENABLE_EXA` when you use this server. With `--url`, set it on the OpenCode server that you started.

### Tools

| Tool | Description |
|---|---|
| `opencode_session_list` | List the sessions of the project. |
| `opencode_session_delete` | Delete a session. |
| `opencode_session_prompt` | Send a task to the agent. Returns at once. |
| `opencode_session_command` | Run a slash command. Returns at once. |
| `opencode_session_wait` | Wait until the agent finishes or needs input, then return its state and reply. |
| `opencode_session_messages` | Read the latest messages of a session. |
| `opencode_session_abort` | Stop the agent of a session. |
| `opencode_session_diff` | List the files that a session changed. |
| `opencode_session_revert` | Undo a message and the messages after it, with their file changes. |
| `opencode_session_unrevert` | Restore what `opencode_session_revert` undid. |
| `opencode_pending_requests` | List the permission requests and questions that wait for a reply. |
| `opencode_permission_reply` | Allow or reject a permission request. |
| `opencode_question_reply` | Answer or reject a question from the agent. |
| `opencode_project_info` | Show the OpenCode version, the project directory, and the git branch. |
| `opencode_prompt_options` | List the agents, slash commands, and models. |
| `opencode_vcs_status` | Show the git branch and the changed files. |
| `opencode_api_search` | Find any API operation and its input schema. |
| `opencode_api_call` | Run any API operation by its `operationId`. |

## Security

CAUTION: Connect this server only to a model that you trust with your project. Through `opencode_api_call`, the model can run shell commands, change the OpenCode config and credentials, and upgrade OpenCode.

CAUTION: Do not set `--http-host` to an address that other computers can reach. The HTTP endpoint has no authentication. On a loopback host, the server rejects requests whose `Host` header is not a loopback address. This check stops web pages that use DNS rebinding.

The typed tools do not return provider API keys. `opencode_api_call` returns the full responses of OpenCode, which can include them.

## Limits

- A client that does not restart its timeout on progress ends each `opencode_session_wait` at that timeout, without a reply. Raise its timeout, or use a client that restarts it on progress.
- Event streams (`event.subscribe`, `global.event`, `v2.event.subscribe`, `v2.session.events`) and terminal connections (`pty.connect`, `v2.pty.connect`) cannot run as a tool call. The terminal operations that do not stream (`pty.create`, `pty.list`, and more) work.
- Some API operations wait until the agent finishes, for example `session.prompt` and `session.shell`. Through `opencode_api_call`, the MCP client can end the call before they finish. Use `opencode_session_prompt` and `opencode_session_command` for agent work.
- The server cuts each tool result at 16,000 characters.
- If the process stops with `SIGKILL`, an OpenCode server that it started keeps running.
- The API catalog loads one time for each process. After you upgrade OpenCode, restart the server.

## Development

```sh
pnpm -F @proj-airi/opencode-mcp test        # unit tests against a fake OpenCode server
OPENCODE_MCP_INTEGRATION=true pnpm -F @proj-airi/opencode-mcp test   # also run against a real `opencode serve`
pnpm -F @proj-airi/opencode-mcp typecheck
pnpm -F @proj-airi/opencode-mcp mcp:inspector   # try the tools in the MCP Inspector
```

The source is in `src/`:

- `opencode.ts`: connects to OpenCode, or starts it, and creates the SDK clients.
- `server.ts`: creates the MCP server and registers the tools.
- `serve.ts`: serves MCP over stdio or Streamable HTTP.
- `tools/`: the tools. `sessions.ts` owns the prompt and wait flow, `api.ts` owns the generic tools.
