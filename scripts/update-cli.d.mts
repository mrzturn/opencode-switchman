export declare function configDirOf(env?: Record<string, string | undefined>, home?: string): string
export declare function stateDirOf(env?: Record<string, string | undefined>, home?: string): string
export declare function cachePackagesDirOf(env?: Record<string, string | undefined>, home?: string): string
export declare type RewriteAction = "replaced" | "uncommented" | "inserted" | "created" | "noop" | "file-ref" | "unparseable"
export declare function rewriteSpec(text: string, spec: string, pkg?: string): { text: string; action: RewriteAction; previous?: string | null }
export declare function pruneCaches(packagesDir: string, pkg?: string): string[]
export declare function latestVersion(fetchImpl?: unknown): Promise<string>
export declare function run(argv?: string[], io?: { env?: Record<string, string | undefined>; home?: string; log?: (message: string) => void }): Promise<{
  spec: string
  actions: Array<{ file: string; action: RewriteAction; previous: string | null }>
}>
