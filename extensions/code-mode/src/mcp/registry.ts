import type {
  AddServerInput,
  ConfigScope,
  McpRegistry,
  RemoveServerOptions,
  ServerConfig,
  ServerRecord,
} from "./types.ts";
import {
  cloneConfig,
  cloneServer,
  loadCodeModeConfig,
  parseCodeModeConfig,
  readCodeModeConfig,
  resolveCodeModeConfigPaths,
  toServerRecord,
  writeCodeModeConfig,
  type CodeModeConfigPaths,
  type LoadedCodeModeConfig,
} from "./config.ts";

export type RegistryCleanup = (record: ServerRecord) => unknown;

export type McpRegistryOptions = {
  cwd?: string;
  projectTrusted?: boolean | (() => boolean);
  paths?: Partial<CodeModeConfigPaths>;
  teardownServer?: RegistryCleanup;
  clearServerCache?: RegistryCleanup;
  clearServerCredentials?: RegistryCleanup;
};

export class McpRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRegistryError";
  }
}

function cloneRecord(record: ServerRecord): ServerRecord {
  return { ...record, config: cloneServer(record.config) };
}

function sameConfig(left: ServerConfig, right: ServerConfig) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function credentialBoundary(config: ServerConfig) {
  if (config.transport === "stdio") return "stdio";
  return `http:${new URL(config.url).href}`;
}

function findRecord(records: ServerRecord[], name: string) {
  return records.find((record) => record.name === name);
}

function configForScope(loaded: LoadedCodeModeConfig, scope: ConfigScope) {
  if (scope === "global") return cloneConfig(loaded.global);
  return cloneConfig(loaded.project ?? { servers: {} });
}

function assertProjectTrusted(
  loaded: LoadedCodeModeConfig,
  scope: ConfigScope,
) {
  if (scope === "project" && !loaded.projectTrusted) {
    throw new McpRegistryError(
      "Project Code Mode configuration is unavailable until the project is trusted",
    );
  }
}

export function createMcpRegistry(
  options: McpRegistryOptions = {},
): McpRegistry {
  const loadOptions = {
    cwd: options.cwd,
    paths: options.paths,
    projectTrusted: options.projectTrusted,
  };
  const paths = resolveCodeModeConfigPaths(loadOptions);
  let loaded: LoadedCodeModeConfig | undefined;
  let pending: Promise<void> = Promise.resolve();

  const loadFresh = () => loadCodeModeConfig(loadOptions);

  const ensureLoaded = async () => {
    loaded ??= await loadFresh();
    return loaded;
  };

  const runExclusive = <T>(operation: () => Promise<T>) => {
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const cleanupChangedRecords = async (
    previous: LoadedCodeModeConfig,
    next: LoadedCodeModeConfig,
  ) => {
    for (const oldRecord of previous.records) {
      const newRecord = findRecord(next.records, oldRecord.name);
      if (
        newRecord &&
        newRecord.scope === oldRecord.scope &&
        sameConfig(newRecord.config, oldRecord.config)
      ) {
        continue;
      }
      await options.teardownServer?.(cloneRecord(oldRecord));
      await options.clearServerCache?.(cloneRecord(oldRecord));
      if (
        newRecord &&
        credentialBoundary(newRecord.config) !==
          credentialBoundary(oldRecord.config)
      ) {
        await options.clearServerCredentials?.(cloneRecord(oldRecord));
      }
    }
  };

  const writeScope = async (
    current: LoadedCodeModeConfig,
    scope: ConfigScope,
    update: (config: ReturnType<typeof cloneConfig>) => void,
  ) => {
    assertProjectTrusted(current, scope);
    const config = configForScope(current, scope);
    update(config);
    await writeCodeModeConfig(
      scope === "global" ? paths.global : paths.project,
      config,
    );
    const next = await loadFresh();
    loaded = next;
    return next;
  };

  return {
    list: () =>
      runExclusive(async () => {
        const current = await ensureLoaded();
        return current.records.map(cloneRecord);
      }),

    add: (input: AddServerInput) =>
      runExclusive(async () => {
        const current = await loadFresh();
        loaded = current;
        assertProjectTrusted(current, input.scope);
        const validated = parseCodeModeConfig({
          servers: { [input.name]: input.config },
        }).servers[input.name];
        if (!validated) {
          throw new McpRegistryError(`Invalid server: ${input.name}`);
        }
        if (findRecord(current.records, input.name)) {
          throw new McpRegistryError(
            `MCP server "${input.name}" is already configured`,
          );
        }

        const next = await writeScope(current, input.scope, (config) => {
          config.servers[input.name] = validated;
        });
        const record = findRecord(next.records, input.name);
        if (!record) {
          throw new McpRegistryError(
            `MCP server "${input.name}" was written but is not effective`,
          );
        }
        await options.clearServerCache?.(cloneRecord(record));
        return cloneRecord(record);
      }),

    remove: (name: string, removeOptions: RemoveServerOptions = {}) =>
      runExclusive(async () => {
        const current = await loadFresh();
        loaded = current;
        const effective = findRecord(current.records, name);
        const scope = removeOptions.scope ?? effective?.scope;
        if (!scope) {
          throw new McpRegistryError(`Unknown MCP server "${name}"`);
        }
        assertProjectTrusted(current, scope);
        const scopedConfig =
          scope === "global"
            ? current.global
            : (current.project ?? { servers: {} });
        const server = scopedConfig.servers[name];
        if (!server) {
          throw new McpRegistryError(
            `MCP server "${name}" is not configured in ${scope} scope`,
          );
        }
        const removedRecord = toServerRecord(name, scope, server);

        await writeScope(current, scope, (config) => {
          delete config.servers[name];
        });
        if (effective?.scope === scope) {
          await options.teardownServer?.(cloneRecord(removedRecord));
        }
        await options.clearServerCache?.(cloneRecord(removedRecord));
        if (removeOptions.removeCredentials === true) {
          await options.clearServerCredentials?.(cloneRecord(removedRecord));
        }
      }),

    enable: (name: string) =>
      runExclusive(async () => {
        const current = await loadFresh();
        loaded = current;
        const record = findRecord(current.records, name);
        if (!record) throw new McpRegistryError(`Unknown MCP server "${name}"`);
        assertProjectTrusted(current, record.scope);
        if (record.enabled) return;
        await writeScope(current, record.scope, (config) => {
          const server = config.servers[name];
          if (!server)
            throw new McpRegistryError(`Unknown MCP server "${name}"`);
          server.enabled = true;
        });
        await options.clearServerCache?.(cloneRecord(record));
      }),

    disable: (name: string) =>
      runExclusive(async () => {
        const current = await loadFresh();
        loaded = current;
        const record = findRecord(current.records, name);
        if (!record) throw new McpRegistryError(`Unknown MCP server "${name}"`);
        assertProjectTrusted(current, record.scope);
        if (!record.enabled) return;
        await writeScope(current, record.scope, (config) => {
          const server = config.servers[name];
          if (!server)
            throw new McpRegistryError(`Unknown MCP server "${name}"`);
          server.enabled = false;
        });
        await options.teardownServer?.(cloneRecord(record));
        await options.clearServerCache?.(cloneRecord(record));
      }),

    reload: () =>
      runExclusive(async () => {
        const previous = await ensureLoaded();
        const next = await loadFresh();
        loaded = next;
        await cleanupChangedRecords(previous, next);
      }),
  };
}

export async function readRegistryScope(
  scope: ConfigScope,
  options: Pick<McpRegistryOptions, "cwd" | "paths"> = {},
) {
  const paths = resolveCodeModeConfigPaths(options);
  return readCodeModeConfig(scope === "global" ? paths.global : paths.project);
}
