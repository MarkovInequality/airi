import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { OpencodeConnection } from '../opencode'

import { z } from 'zod'

import { respond } from './result'

const httpMethods = ['get', 'post', 'put', 'patch', 'delete'] as const

/** The part of an OpenAPI 3.1 operation that the API tools read. Other fields are ignored. */
const operationSchema = z.object({
  operationId: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  parameters: z.array(z.object({
    name: z.string(),
    in: z.string(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    schema: z.unknown().optional(),
  })).optional(),
  requestBody: z.object({
    content: z.record(z.string(), z.object({ schema: z.unknown().optional() })),
  }).optional(),
  responses: z.record(z.string(), z.object({
    content: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
})

const specSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.object({
    schemas: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
})

type OperationParameter = NonNullable<z.infer<typeof operationSchema>['parameters']>[number]

interface ApiOperation {
  operationId: string
  method: Uppercase<typeof httpMethods[number]>
  /** Path template with `{name}` placeholders, for example `/session/{sessionID}`. */
  path: string
  summary?: string
  description?: string
  tags: string[]
  parameters: OperationParameter[]
  bodySchema?: unknown
}

interface ApiCatalog {
  /** Operations that one tool call can run, keyed by operationId. */
  operations: Map<string, ApiOperation>
  /** Operations that no tool call can run, with the reason, keyed by operationId. */
  unsupported: Map<string, string>
  schemas: Record<string, unknown>
}

/**
 * Query parameters that the tools do not show to the model. The connection sends the project
 * directory in a header on every request, and workspaces are an experimental OpenCode feature.
 * A caller can still pass them in `query`.
 */
const hiddenQueryParameters = new Set(['directory', 'workspace'])

/**
 * Operations that upgrade the connection to a WebSocket.
 *
 * NOTICE:
 * The spec of OpenCode 1.18 describes these as JSON responses, so the content type does not
 * show that they are WebSockets. A tool call cannot hold a terminal connection open.
 * Source: `GET /pty/{ptyID}/connect` and `GET /api/pty/{ptyID}/connect` in the `/doc` spec.
 * Remove an entry when OpenCode marks the upgrade in its spec.
 */
const websocketOperations = new Set(['pty.connect', 'v2.pty.connect'])

/** Depth to which `opencode_api_search` expands `$ref` schemas. Deeper references stay as `{ $ref }`. */
const schemaExpansionDepth = 4

function findUnsupportedReason(operation: z.infer<typeof operationSchema>) {
  if (websocketOperations.has(operation.operationId)) {
    return 'It opens a WebSocket terminal connection.'
  }

  const contentTypes = Object.values(operation.responses ?? {}).flatMap(response => Object.keys(response.content ?? {}))
  if (contentTypes.includes('text/event-stream')) {
    return 'It is a server-sent event stream.'
  }

  return undefined
}

async function loadApiCatalog(connection: OpencodeConnection): Promise<ApiCatalog> {
  // OpenCode serves the OpenAPI spec of its own version at `/doc`. Reading it from the server,
  // and not from the SDK package, keeps the catalog correct when the user upgrades OpenCode.
  const { data, error, response } = await connection.http.get({ url: '/doc' })
  if (error !== undefined) {
    throw new Error(`Could not read the OpenCode API spec: HTTP ${response.status}`)
  }

  const spec = specSchema.parse(data)
  const catalog: ApiCatalog = {
    operations: new Map(),
    unsupported: new Map(),
    schemas: spec.components?.schemas ?? {},
  }

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of httpMethods) {
      const parsed = operationSchema.safeParse(pathItem[method])
      if (!parsed.success) {
        continue
      }

      const operation = parsed.data
      const unsupportedReason = findUnsupportedReason(operation)
      if (unsupportedReason) {
        catalog.unsupported.set(operation.operationId, unsupportedReason)
        continue
      }

      catalog.operations.set(operation.operationId, {
        operationId: operation.operationId,
        method: method.toUpperCase() as ApiOperation['method'],
        path,
        summary: operation.summary,
        description: operation.description,
        tags: operation.tags ?? [],
        parameters: (operation.parameters ?? []).filter(parameter => parameter.in !== 'query' || !hiddenQueryParameters.has(parameter.name)),
        bodySchema: operation.requestBody?.content['application/json']?.schema,
      })
    }
  }

  return catalog
}

/**
 * Creates the loader of the API catalog. The catalog loads on the first call and stays cached
 * for the life of the process. A failed load is not cached, so the next call tries again.
 */
export function createApiCatalogLoader(connection: OpencodeConnection) {
  let catalog: Promise<ApiCatalog> | undefined
  return () => {
    catalog ??= loadApiCatalog(connection).catch((error: unknown) => {
      catalog = undefined
      throw error
    })
    return catalog
  }
}

export type ApiCatalogLoader = ReturnType<typeof createApiCatalogLoader>

/**
 * Replaces `$ref` schemas with their definitions, to `depth` levels. A reference past the depth,
 * or a reference to a schema that is already expanded on the same branch, stays as `{ $ref: name }`.
 *
 * @example
 * expandSchema({ $ref: '#/components/schemas/Range' }, { Range: { type: 'object' } }, 4, [])
 * // => { type: 'object' }
 */
function expandSchema(schema: unknown, schemas: Record<string, unknown>, depth: number, branch: string[]): unknown {
  if (Array.isArray(schema)) {
    return schema.map(item => expandSchema(item, schemas, depth, branch))
  }

  if (!schema || typeof schema !== 'object') {
    return schema
  }

  if ('$ref' in schema && typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').at(-1) ?? schema.$ref
    if (depth <= 0 || branch.includes(name) || !(name in schemas)) {
      return { $ref: name }
    }

    return expandSchema(schemas[name], schemas, depth - 1, [...branch, name])
  }

  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, expandSchema(value, schemas, depth, branch)]))
}

function describeParameter(parameter: OperationParameter) {
  return `${parameter.name} (${parameter.in}${parameter.required ? ', required' : ''})`
}

function describeOperation(operation: ApiOperation, schemas: Record<string, unknown>) {
  return {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    description: operation.description,
    parameters: operation.parameters.map(parameter => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required ?? false,
      description: parameter.description,
      schema: expandSchema(parameter.schema, schemas, schemaExpansionDepth, []),
    })),
    body: operation.bodySchema === undefined ? undefined : expandSchema(operation.bodySchema, schemas, schemaExpansionDepth, []),
  }
}

/**
 * Finds the operations that contain every word of the query. A word in the operationId or the
 * path counts more than a word in the summary, description, or tags.
 */
function searchOperations(operations: Iterable<ApiOperation>, query: string, limit: number) {
  const words = query.toLowerCase().split(/[\s./_{}-]+/).filter(Boolean)
  const matches: Array<{ operation: ApiOperation, score: number }> = []

  for (const operation of operations) {
    const primaryText = `${operation.operationId} ${operation.path}`.toLowerCase()
    const secondaryText = [operation.summary, operation.description, ...operation.tags].join(' ').toLowerCase()

    let score = 0
    for (const word of words) {
      if (primaryText.includes(word)) {
        score += 2
      }
      else if (secondaryText.includes(word)) {
        score += 1
      }
      else {
        score = -1
        break
      }
    }

    if (score >= 0) {
      matches.push({ operation, score })
    }
  }

  return matches
    .sort((left, right) => right.score - left.score || left.operation.operationId.localeCompare(right.operation.operationId))
    .slice(0, limit)
    .map(({ operation }) => operation)
}

export function registerApiTools(server: McpServer, connection: OpencodeConnection, loadCatalog: ApiCatalogLoader) {
  server.registerTool('opencode_api_search', {
    description: 'Search the full OpenCode API for operations that no other opencode tool covers, for example worktrees, MCP servers, config, or terminals. Give an exact operationId to get its full input schema for opencode_api_call.',
    inputSchema: {
      query: z.string().min(1).describe('Words to find, or an exact operationId such as "worktree.create".'),
      limit: z.number().int().min(1).max(50).optional().describe('Default 15.'),
    },
  }, async ({ query, limit }) => respond(async () => {
    const catalog = await loadCatalog()

    const exact = catalog.operations.get(query.trim())
    if (exact) {
      return describeOperation(exact, catalog.schemas)
    }

    const unsupportedReason = catalog.unsupported.get(query.trim())
    if (unsupportedReason) {
      return { operationId: query.trim(), callable: false, reason: unsupportedReason }
    }

    return searchOperations(catalog.operations.values(), query, limit ?? 15).map(operation => ({
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      summary: operation.summary,
      parameters: operation.parameters.length ? operation.parameters.map(describeParameter) : undefined,
      hasBody: operation.bodySchema !== undefined,
    }))
  }))

  server.registerTool('opencode_api_call', {
    description: 'Call any OpenCode API operation by operationId. Get the operationId and the inputs from opencode_api_search. Some operations, such as session.prompt, wait until the agent finishes; use opencode_session_prompt for those.',
    // NOTICE:
    // `path`, `query`, and `body` are open records, because one tool serves operations with
    // different inputs. opencode_api_search gives the exact input schema of each operation.
    inputSchema: {
      operationId: z.string().min(1),
      path: z.record(z.string(), z.string()).optional().describe('Path parameters, for example { "sessionID": "ses_123" }.'),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query parameters.'),
      body: z.record(z.string(), z.unknown()).optional().describe('JSON request body.'),
    },
  }, async ({ operationId, path, query, body }) => respond(async () => {
    const catalog = await loadCatalog()

    const operation = catalog.operations.get(operationId)
    if (!operation) {
      const reason = catalog.unsupported.get(operationId)
      throw new Error(reason
        ? `${operationId} cannot run as a tool call. ${reason}`
        : `Unknown operationId "${operationId}". Find operations with opencode_api_search.`)
    }

    const missingPathParameters = operation.parameters
      .filter(parameter => parameter.in === 'path' && !path?.[parameter.name])
      .map(parameter => parameter.name)
    if (missingPathParameters.length) {
      throw new Error(`${operationId} needs the path parameters: ${missingPathParameters.join(', ')}.`)
    }

    const result = await connection.http.request({
      method: operation.method,
      url: operation.path,
      path,
      query,
      body,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    })

    if (result.error !== undefined) {
      const detail = typeof result.error === 'string' ? result.error : JSON.stringify(result.error)
      throw new Error(`OpenCode returned HTTP ${result.response.status} for ${operationId}: ${detail}`)
    }

    // `vcs.diff.raw` returns text, and `v2.fs.read` returns file bytes, which the client reads as a Blob.
    const data = result.data instanceof Blob ? await result.data.text() : result.data
    return { status: result.response.status, data }
  }))
}
