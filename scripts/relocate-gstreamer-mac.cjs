'use strict'

/**
 * Make the packaged app's GStreamer + echo-cancellation binaries
 * self-contained, so Second works on Macs without Homebrew.
 *
 * Homebrew dylibs reference each other by absolute path
 * (/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib). In the packaged app:
 *   1. every non-system dependency of second-aec.node, the bundled plugins,
 *      and the bundled libs is copied into Resources/gstreamer-lib/
 *   2. each reference is rewritten to @rpath/<name>, each lib's id to
 *      @rpath/<name>, and rpaths are added so everything resolves inside
 *      the app bundle
 *   3. every modified Mach-O is ad-hoc re-signed (arm64 refuses to load
 *      binaries whose signature was invalidated by install_name_tool);
 *      Developer ID builds are re-signed by electron-builder afterwards.
 *
 * Usage: node scripts/relocate-gstreamer-mac.cjs <path/to/Second.app/Contents/Resources>
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/** Paths macOS provides; never bundled. */
function isSystemPath(p) {
  return p.startsWith('/usr/lib/') || p.startsWith('/System/')
}

/**
 * Parse `otool -L` output into dependency install names, excluding the
 * file's own install name (shared libraries, including .node addons built
 * as dylibs, list their id first).
 */
function parseOtoolL(output, fileName) {
  const lines = output.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
  const deps = lines.map((l) => l.replace(/\s+\(compatibility version.*$/, '').trim())
  if (deps.length && fileName && path.basename(deps[0]) === fileName) return deps.slice(1)
  return deps
}

/** Parse LC_RPATH entries from `otool -l`. */
function parseRpaths(output) {
  const out = []
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('cmd LC_RPATH')) {
      for (let j = i + 1; j < i + 4 && j < lines.length; j++) {
        const m = lines[j].match(/path (.+?) \(offset/)
        if (m) {
          out.push(m[1])
          break
        }
      }
    }
  }
  return out
}

/**
 * Resolve an install name to a real file, given the real path of the file
 * that references it. Handles absolute paths, @loader_path, and @rpath
 * (against the referencing file's own rpaths).
 */
function resolveDep(dep, referrerRealPath, referrerRpaths, exists) {
  const loaderDir = path.dirname(referrerRealPath)
  if (dep.startsWith('/')) return exists(dep) ? dep : null
  if (dep.startsWith('@loader_path/') || dep.startsWith('@executable_path/')) {
    const p = path.resolve(loaderDir, dep.replace(/^@(loader|executable)_path\//, ''))
    return exists(p) ? p : null
  }
  if (dep.startsWith('@rpath/')) {
    const rest = dep.slice('@rpath/'.length)
    for (const rp of referrerRpaths) {
      const base = rp.startsWith('@loader_path') ? path.resolve(loaderDir, rp.replace(/^@loader_path\/?/, '')) : rp
      const p = path.join(base, rest)
      if (exists(p)) return p
    }
    return null
  }
  return null
}

function defaultDeps() {
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    otoolL: (f) => run('otool', ['-L', f]),
    otoolLoad: (f) => run('otool', ['-l', f]),
    installNameTool: (args) => run('install_name_tool', args),
    codesign: (f) => run('codesign', ['--force', '--sign', '-', f]),
    exists: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
    copy: (src, dst) => {
      fs.copyFileSync(src, dst)
      fs.chmodSync(dst, 0o755)
    },
    list: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    log: (msg) => console.log(msg),
  }
}

function relocate(resourcesDir, deps = defaultDeps()) {
  const libDir = path.join(resourcesDir, 'gstreamer-lib')
  const pluginDir = path.join(resourcesDir, 'gstreamer-1.0')
  const aecNode = path.join(resourcesDir, 'second-aec.node')
  if (!deps.exists(aecNode)) {
    deps.log('relocate: second-aec.node not bundled; skipping')
    return { copied: [], modified: [] }
  }
  if (!deps.exists(libDir)) deps.mkdir(libDir)

  /** bundled file path -> real source path we resolve its deps against */
  const origin = new Map()
  const queue = []
  const enqueue = (file, src) => {
    if (origin.has(file)) return
    origin.set(file, src)
    queue.push(file)
  }

  // Seed: the addon, plugins, and libs already bundled. Their "origin" is
  // where Homebrew keeps them (resolved via their own install names).
  enqueue(aecNode, aecNode)
  for (const name of deps.list(pluginDir).filter((n) => n.endsWith('.dylib'))) {
    enqueue(path.join(pluginDir, name), path.join(pluginDir, name))
  }
  const bundledLibs = new Set(deps.list(libDir).filter((n) => n.endsWith('.dylib')))
  for (const name of bundledLibs) enqueue(path.join(libDir, name), path.join(libDir, name))

  const copied = []
  const modified = new Set()

  while (queue.length) {
    const file = queue.shift()
    const isLib = file.startsWith(libDir + path.sep)
    const isDylib = file.endsWith('.dylib')
    const own = parseOtoolL(deps.otoolL(file), path.basename(file))
    const ownRpaths = parseRpaths(deps.otoolLoad(file))
    const srcRef = origin.get(file)

    for (const dep of own) {
      if (isSystemPath(dep)) continue
      const base = path.basename(dep)
      if (dep === `@rpath/${base}` && bundledLibs.has(base)) continue

      if (!bundledLibs.has(base)) {
        const resolved = resolveDep(dep, srcRef, ownRpaths, deps.exists)
        if (!resolved) {
          throw new Error(`relocate: cannot resolve ${dep} (needed by ${path.basename(file)})`)
        }
        const real = deps.realpath(resolved)
        const dst = path.join(libDir, base)
        deps.copy(real, dst)
        bundledLibs.add(base)
        copied.push(base)
        enqueue(dst, real)
      }
      deps.installNameTool(['-change', dep, `@rpath/${base}`, file])
      modified.add(file)
    }

    if (isLib && isDylib) {
      deps.installNameTool(['-id', `@rpath/${path.basename(file)}`, file])
      modified.add(file)
    }

    const wantRpath = isLib ? '@loader_path' : file === aecNode ? '@loader_path/gstreamer-lib' : '@loader_path/../gstreamer-lib'
    // Drop every other search path (e.g. Homebrew's lib dirs): dyld tries
    // rpaths in order, so a leftover one would load a second, conflicting
    // copy of GLib/GStreamer from /opt/homebrew on Macs that have it.
    for (const rp of new Set(ownRpaths)) {
      if (rp === wantRpath) continue
      deps.installNameTool(['-delete_rpath', rp, file])
      modified.add(file)
    }
    if (!ownRpaths.includes(wantRpath)) {
      deps.installNameTool(['-add_rpath', wantRpath, file])
      modified.add(file)
    }
  }

  for (const f of modified) deps.codesign(f)

  // Verify nothing still points outside the app.
  const leftovers = []
  for (const f of origin.keys()) {
    for (const dep of parseOtoolL(deps.otoolL(f), path.basename(f))) {
      if (!isSystemPath(dep) && !dep.startsWith('@rpath/')) leftovers.push(`${path.basename(f)} -> ${dep}`)
    }
  }
  for (const f of origin.keys()) {
    for (const rp of parseRpaths(deps.otoolLoad(f))) {
      if (!rp.startsWith('@loader_path')) leftovers.push(`${path.basename(f)} rpath -> ${rp}`)
    }
  }
  if (leftovers.length) throw new Error(`relocate: external references remain:\n  ${leftovers.join('\n  ')}`)

  deps.log(`relocate: ${origin.size} binaries self-contained (${copied.length} extra libs bundled${copied.length ? `: ${copied.join(', ')}` : ''})`)
  return { copied, modified: [...modified] }
}

module.exports = { relocate, parseOtoolL, parseRpaths, resolveDep, isSystemPath }

if (require.main === module) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: node scripts/relocate-gstreamer-mac.cjs <Second.app/Contents/Resources>')
    process.exit(1)
  }
  relocate(path.resolve(dir))
}
