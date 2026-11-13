declare const _globalThis: {
  [key: string]: any
  Zotero: _ZoteroTypes.Zotero
  ztoolkit: ZToolkit
  addon: typeof addon
}

declare type ZToolkit = ReturnType<typeof import('../src/utils/ztoolkit').createZToolkit>

declare const ztoolkit: ZToolkit

declare const rootURI: string

declare const addon: import('../src/addon').default

/**
 * Timer functions injected into the plugin sandbox by `Zotero.Plugins`.
 *
 * They are real globals inside the plugin (see the `setTimeout`,
 * `clearTimeout`, `setInterval` and `clearInterval` entries that Zotero adds to
 * the sandbox in plugins.js), but `zotero-types`' sandbox entry point only
 * declares the `Zotero.*` variants. Without these declarations `tsc` fails with
 * "Cannot find name 'setTimeout'" even though the code runs correctly.
 */
declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number
declare function clearTimeout(id?: number): void
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number
declare function clearInterval(id?: number): void

declare const __env__: 'production' | 'development'
