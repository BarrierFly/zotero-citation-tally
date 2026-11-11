import { config } from '../../package.json'
import { getLocaleID } from '../utils/locale'
import { getPref, setPref } from '../utils/prefs'

/**
 * Validate against the localized strings shipped with the preference pane
 * (`preferences.ftl`). The addon localization instance only loads addon.ftl,
 * so use the preference document's own Fluent bundle.
 */
async function getPrefsString(key: string, args?: Record<string, unknown>): Promise<string> {
  try {
    const doc = addon.data.prefs?.window?.document as
      | (Document & {
          l10n?: {
            ready?: Promise<unknown>
            formatValue: (id: string, args?: Record<string, unknown>) => Promise<string>
          }
        })
      | undefined
    if (doc?.l10n?.formatValue) {
      // Fluent may still be loading the linkset when the pane first loads.
      if (doc.l10n.ready) await doc.l10n.ready
      const value = await doc.l10n.formatValue(getLocaleID(key), args)
      if (value) return value
    }
  } catch (e) {
    ztoolkit.log('Failed to load preference string:', key, e)
  }
  return key
}

export async function registerPrefsScripts(_window: Window) {
  // See addon/content/preferences.xhtml onpaneload
  if (!addon.data.prefs) {
    addon.data.prefs = {
      window: _window,
    }
  } else {
    addon.data.prefs.window = _window
  }
  bindPrefEvents()
}

function bindPrefEvents() {
  const window = addon.data.prefs?.window
  if (!window) return

  // Initialize the database order textbox
  const databaseOrderElement = window.document?.querySelector(
    `#zotero-prefpane-${config.addonRef}-databaseOrderExposed`,
  )

  if (databaseOrderElement) {
    // Set initial value from preference
    const currentValue = getPref('databaseOrder') || 'crossref'
    ;(databaseOrderElement as HTMLInputElement).value = currentValue

    databaseOrderElement.addEventListener('focusout', () => {
      void validateDatabaseOrder(window)
    })
  }

  const autoUpdateRadioGroup = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-autoUpdate`)
  const cutoffDropdown = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-autoUpdateCutoff`)

  function updateCutoffState() {
    const selectedValue = getPref('autoUpdate') || 'never'
    if (cutoffDropdown) {
      ;(cutoffDropdown as any).disabled = selectedValue === 'never'
    }
  }

  // Initial state
  updateCutoffState()

  // Add listener to radiogroup
  if (autoUpdateRadioGroup) {
    autoUpdateRadioGroup.addEventListener('command', updateCutoffState)
  }

  // Add listener for color preference changes to refresh columns immediately
  const useColorsRadioGroup = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-useColors`)
  if (useColorsRadioGroup) {
    useColorsRadioGroup.addEventListener('command', () => {
      // Refresh the item tree columns to apply new color settings
      const manager = Zotero.ItemTreeManager as { refreshColumns?: () => void }
      manager.refreshColumns?.()
    })
  }
}

export interface Validation {
  valid: boolean
  /** Fluent message ID from preferences.ftl; resolved by the caller. */
  messageId: string
  messageArgs?: Record<string, unknown>
}

export function validateDatabaseOrderValue(inputValue: string, andSave: boolean = true): Validation {
  const validDatabases = ['crossref', 'semanticscholar', 'inspire', 'openalex']

  // Parse comma-separated values
  const databases = inputValue
    .split(',')
    .map((db: string) => db.trim())
    .filter((db: string) => db.length > 0)

  // Check for duplicates
  const uniqueDatabases = [...new Set(databases)]
  if (uniqueDatabases.length !== databases.length) {
    return { valid: false, messageId: 'pref-database-duplicate' }
  }

  // Check if all databases are valid
  const invalidDatabases = databases.filter((db: string) => !validDatabases.includes(db))
  if (invalidDatabases.length > 0) {
    return {
      valid: false,
      messageId: 'pref-database-invalid',
      // Passed as a Fluent variable; never interpolated through `String.replace`,
      // which would treat `$&` in user input as a replacement pattern.
      messageArgs: { databases: invalidDatabases.join(', ') },
    }
  }

  if (databases.length === 0) {
    return { valid: false, messageId: 'pref-database-empty' }
  }

  // Check length (1-4 databases)
  if (databases.length > 4) {
    return { valid: false, messageId: 'pref-database-count' }
  }

  // Save the validated order to hidden preference
  if (andSave) {
    setPref('databaseOrder', databases.join(','))
  }

  return { valid: true, messageId: 'pref-database-valid' }
}

export async function validationMarkup(validation: Validation, statusElement: Element) {
  if (!statusElement) return

  const message = await getPrefsString(validation.messageId, validation.messageArgs)
  const element = statusElement as HTMLElement
  // textContent: the value comes from a Fluent bundle (or the message ID),
  // never from raw user input, but avoid `innerHTML` as a rule.
  element.textContent = message
  element.style.color = validation.valid ? '#008000' : '#d70022'
}

export async function validateDatabaseOrder(window: Window, andSave: boolean = true) {
  const inputElement = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-databaseOrderExposed`)
  const statusElement = window.document?.querySelector(`#zotero-prefpane-${config.addonRef}-database-status`)

  if (!inputElement || !statusElement) return

  const inputValue = ((inputElement as HTMLInputElement).value || '').trim().toLowerCase()
  const validation = validateDatabaseOrderValue(inputValue, andSave)
  await validationMarkup(validation, statusElement)
}
