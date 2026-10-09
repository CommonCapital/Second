/**
 * App identity and data location. Imported first by index.ts, before any
 * module that opens the settings store or the database.
 *
 * Electron derives the userData folder from package.json "name"
 * (second-desktop). Installed builds use ~/Library/Application Support/Second;
 * dev runs keep second-desktop so they never share a database with the
 * installed app.
 */

import { app } from 'electron'
import { join } from 'path'

if (app.isPackaged) {
  app.setName('Second')
  app.setPath('userData', join(app.getPath('appData'), 'Second'))
}
