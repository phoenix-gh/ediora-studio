import type { ListToolsResult } from '@ai-sdk/mcp'
import type { ToolSet } from 'ai'

import {
  legacyToolContract,
  normalizeMcpToolContract,
  normalizeNativeToolContract,
  type ToolContract,
  type ToolContractDiagnostic,
  type ToolContractMetadata,
} from './tool-contract'


export type ToolRegistry = {
  tools: ToolSet
  contracts: ReadonlyMap<string, ToolContract>
  diagnostics: readonly ToolContractDiagnostic[]
  get(name: string): { tool: ToolSet[string]; contract: ToolContract } | undefined
}

function diagnostic(
  toolName: string,
  code: ToolContractDiagnostic['code'],
  message: string,
): ToolContractDiagnostic {
  return { toolName, severity: 'error', code, message }
}

function sortedDiagnostics(diagnostics: ToolContractDiagnostic[]) {
  return diagnostics.sort((left, right) => (
    left.toolName.localeCompare(right.toolName)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  ))
}

export function buildToolRegistry(input: {
  tools: ToolSet
  mcpDefinitions?: ListToolsResult['tools']
  nativeContracts?: Readonly<Record<string, ToolContractMetadata>>
  compatibilityMode?: boolean
}): ToolRegistry {
  const definitions = new Map<string, ListToolsResult['tools'][number]>()
  const duplicateDefinitions = new Set<string>()
  for (const definition of input.mcpDefinitions ?? []) {
    if (definitions.has(definition.name)) duplicateDefinitions.add(definition.name)
    else definitions.set(definition.name, definition)
  }

  const nativeContracts = input.nativeContracts ?? {}
  const names = [...new Set([
    ...Object.keys(input.tools),
    ...definitions.keys(),
    ...Object.keys(nativeContracts),
  ])].sort((left, right) => left.localeCompare(right))
  const tools: ToolSet = {}
  const contracts = new Map<string, ToolContract>()
  const diagnostics: ToolContractDiagnostic[] = []

  for (const name of names) {
    const definition = definitions.get(name)
    const nativeMetadata = nativeContracts[name]
    const value = input.tools[name]

    if (duplicateDefinitions.has(name) || (definition && nativeMetadata)) {
      diagnostics.push(diagnostic(
        name,
        'duplicate-tool',
        `Tool ${name} has duplicate contract registrations`,
      ))
      continue
    }
    if (!value) {
      diagnostics.push(diagnostic(
        name,
        'missing-executable',
        `Tool ${name} has a contract but no executable`,
      ))
      continue
    }

    const normalized = definition
      ? normalizeMcpToolContract(definition)
      : nativeMetadata
        ? normalizeNativeToolContract(name, value, nativeMetadata)
        : input.compatibilityMode
          ? legacyToolContract(name, value)
          : {
              diagnostics: [diagnostic(
                name,
                'invalid-contract',
                `Tool ${name} has no MCP definition or native contract`,
              )],
            }
    diagnostics.push(...normalized.diagnostics)
    if (!normalized.contract) continue

    tools[name] = value
    contracts.set(name, normalized.contract)
  }

  const registry: ToolRegistry = {
    tools,
    contracts,
    diagnostics: sortedDiagnostics(diagnostics),
    get(name) {
      const tool = tools[name]
      const contract = contracts.get(name)
      return tool && contract ? { tool, contract } : undefined
    },
  }
  return registry
}

export function contractsForTools(
  registry: ToolRegistry,
  names: readonly string[],
): ReadonlyMap<string, ToolContract> {
  const selected = new Set(names)
  return new Map(
    [...registry.contracts]
      .filter(([name]) => selected.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function registryContractRecord(
  registry: ToolRegistry,
): Readonly<Record<string, ToolContract>> {
  return Object.fromEntries(
    [...registry.contracts].sort(([left], [right]) => left.localeCompare(right)),
  )
}
