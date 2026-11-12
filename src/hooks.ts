import { startAutomaticUpdate, stopAutomaticUpdate } from './modules/citationAutoupdate'
import { BasicRegistrar, scheduleMonthlyCleanup, stopMonthlyCleanup, UIRegistrar, UX } from './modules/citationTally'
import { IgnoredItemsStore } from './modules/ignoredItems'
/* PUBIGNORE 
import {
  BasicExampleFactory,
  HelperExampleFactory,
  KeyExampleFactory,
  PromptExampleFactory,
  UIExampleFactory,
} from './modules/examples'
*/
import { registerPrefsScripts, validateDatabaseOrder } from './modules/preferenceScript'
import { getString, initLocale } from './utils/locale'
// import { getPref } from './utils/prefs'
import { createZToolkit } from './utils/ztoolkit'

async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise])

  initLocale()

  await BasicRegistrar.registerPrefs()

  // Each registration is isolated: one failing API (e.g. a removed
  // ItemTreeManager hook on an older Zotero) must not prevent the rest of the
  // plugin from loading.
  try {
    // Register citation count notifier to detect new items
    UIRegistrar.registerNotifier()
  } catch (e) {
    ztoolkit.log('Failed to register item notifier:', e)
  }

  try {
    // Register custom column for citation counts
    UIRegistrar.registerCitationColumn()
  } catch (e) {
    ztoolkit.log('Failed to register citation column:', e)
  }

  try {
    // Register custom column for FWCI
    UIRegistrar.registerFWCIColumn()
  } catch (e) {
    ztoolkit.log('Failed to register FWCI column:', e)
  }

  try {
    // Register custom column for average citations per year
    UIRegistrar.registerAvgCiteColumn()
  } catch (e) {
    ztoolkit.log('Failed to register AvgCite column:', e)
  }

  // KeyExampleFactory.registerShortcuts()

  // await UIExampleFactory.registerExtraColumn()

  // await UIExampleFactory.registerExtraColumnWithCustomCell()

  // UIExampleFactory.registerItemPaneCustomInfoRow()

  // UIExampleFactory.registerItemPaneSection()

  // UIExampleFactory.registerReaderItemPaneSection()

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)))

  // Start automatic citation updates if enabled. Errors are handled inside,
  // but keep the promise from becoming an unhandled rejection.
  startAutomaticUpdate().catch((error) => ztoolkit.log('Automatic update failed to start:', error))

  // Schedule cleanup of ignored items
  scheduleMonthlyCleanup()

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit()

  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-mainWindow.ftl`)
  // @ts-ignore This is a moz feature
  win.MozXULElement.insertFTLIfNeeded(`${addon.data.config.addonRef}-addon.ftl`)

  const popupWin = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString('startup-begin'),
      type: 'default',
      progress: 0,
    })
    .show()

  // No artificial startup delay: nothing is awaited here, so a sleep would only
  // slow down Zotero startup and keep the progress window around.

  // UIExampleFactory.registerStyleSheet(win) // PUBIGNORE

  // UIExampleFactory.registerRightClickMenuItem() // PUBIGNORE

  // UIExampleFactory.registerRightClickMenuPopup(win) // PUBIGNORE

  // UIExampleFactory.registerWindowMenuWithSeparator() // PUBIGNORE

  // Menu registration is global (MenuManager) or per-window (Zotero 7 DOM);
  // both functions are idempotent, and a failure in one menu group must not
  // stop the other from being added.
  try {
    // Register citation count update menu item
    UIRegistrar.registerCitationCountMenuItem()
  } catch (e) {
    ztoolkit.log('Failed to register citation menu item:', e)
  }

  try {
    // Register retally outdated citations menubar item
    UIRegistrar.registerRetallyCitationsMenuItem()
  } catch (e) {
    ztoolkit.log('Failed to register retally menu item:', e)
  }

  // Theme observers are registered once for the plugin, not per window.
  UIRegistrar.registerThemeObservers()

  // PromptExampleFactory.registerNormalCommandExample() // PUBIGNORE

  // PromptExampleFactory.registerAnonymousCommandExample(win) // PUBIGNORE

  // PromptExampleFactory.registerConditionalCommandExample() // PUBIGNORE

  // await Zotero.Promise.delay(1000)

  try {
    popupWin.changeLine({
      progress: 100,
      text: getString('startup-progress', { args: { percent: 100, message: getString('startup-finish') } }),
    })
    popupWin.startCloseTimer(1000)
  } catch (e) {
    // The user may have dismissed the window already (closeOnClick)
    ztoolkit.log('Startup progress window already closed:', e)
  }

  // addon.hooks.onDialogEvents('dialogExample')
}

async function onMainWindowUnload(win: Window): Promise<void> {
  try {
    // Only clean up what belongs to this window. `ztoolkit.unregisterAll()`
    // removes every cached element across all windows, which would strip the
    // menus from windows that are still open. Zotero 8+ menu registrations are
    // owned by Zotero and removed automatically.
    UIRegistrar.unregisterZotero7Menus(win)
    addon.data.dialog?.window?.close()
  } catch (e) {
    ztoolkit.log('Error while unloading main window:', e)
  }
}

function onShutdown(): void {
  addon.data.alive = false

  try {
    stopAutomaticUpdate()
  } catch (e) {
    ztoolkit.log('Failed to stop automatic update:', e)
  }

  try {
    stopMonthlyCleanup()
  } catch (e) {
    ztoolkit.log('Failed to stop cleanup timer:', e)
  }

  try {
    // The debounced write may not have fired yet; persist it before the
    // plugin's globals disappear.
    IgnoredItemsStore.flush()
  } catch (e) {
    ztoolkit.log('Failed to flush ignored items:', e)
  }

  try {
    UIRegistrar.unregisterThemeObservers()
  } catch (e) {
    ztoolkit.log('Failed to unregister theme observers:', e)
  }

  try {
    ztoolkit.unregisterAll()
    UIRegistrar.unregisterZotero7Menus()
    addon.data.dialog?.window?.close()
  } catch (e) {
    ztoolkit.log('Error during shutdown cleanup:', e)
  }

  // @ts-ignore - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance]
}

/** PUBIGNORE
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this function clear.
 */
/* PUBIGNORE
async function onNotify(event: string, type: string, ids: (string | number)[], extraData: Record<string, any>) {
  // Add code to the corresponding notify type
  ztoolkit.log('notify', event, type, ids, extraData)
  if (event == 'select' && type == 'tab' && extraData[ids[0]].type == 'reader') {
    BasicExampleFactory.exampleNotifierCallback()
  } else {
    return
  }
}
*/

/**
 * Dispatcher for Preference UI events.
 * Any operations should be placed in a function to keep this function clear.
 * @param type event type
 * @param data event data
 */
async function onPrefsEvent(type: string, data: Record<string, any>) {
  switch (type) {
    case 'load':
      void registerPrefsScripts(data.window)
      break
    case 'validateDatabases':
      void validateDatabaseOrder(data.window)
      break
    default:
      return
  }
}

/* PUBIGNORE 
function onShortcuts(type: string) {
  switch (type) {
    case 'larger':
      KeyExampleFactory.exampleShortcutLargerCallback()
      break
    case 'smaller':
      KeyExampleFactory.exampleShortcutSmallerCallback()
      break
    default:
      break
  }
  return
}
*/

function onDialogEvents(type: string) {
  switch (type) {
    /* PUBIGNORE 
    case 'dialogExample':
      HelperExampleFactory.dialogExample()
      break
    case 'clipboardExample':
      HelperExampleFactory.clipboardExample()
      break
    case 'filePickerExample':
      HelperExampleFactory.filePickerExample()
      break
    case 'progressWindowExample':
      HelperExampleFactory.progressWindowExample()
      break
    case 'vtableExample':
      HelperExampleFactory.vtableExample()
      break
    */
    case 'updateCitationCounts':
      UX.updateSelectedItemsCitationCounts()
      break
    case 'updateCitationCounts-crossref':
      UX.updateSelectedItemsCitationCounts('crossref')
      break
    case 'updateCitationCounts-inspire':
      UX.updateSelectedItemsCitationCounts('inspire')
      break
    case 'updateCitationCounts-semanticscholar':
      UX.updateSelectedItemsCitationCounts('semanticscholar')
      break
    case 'updateCitationCounts-openalex':
      UX.updateSelectedItemsCitationCounts('openalex')
      break
    case 'updateCitationCounts-avgcite':
      UX.updateSelectedItemsAvgCite()
      break
    case 'retallyOutdatedCitations':
      // Explicit menu action: show progress UI and bypass the autoUpdate mode check
      void startAutomaticUpdate(false, true)
      break
    default:
      break
  }
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  // onNotify, // PUBIGNORE
  onPrefsEvent,
  // onShortcuts, // PUBIGNORE
  onDialogEvents,
}
