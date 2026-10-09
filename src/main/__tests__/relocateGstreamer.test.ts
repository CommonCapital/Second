import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import { join } from 'path'

const require = createRequire(import.meta.url)
const { relocate, parseOtoolL, parseRpaths } = require(join(process.cwd(), 'scripts', 'relocate-gstreamer-mac.cjs'))

const R = '/App/Second.app/Contents/Resources'

/** Minimal in-memory Mach-O world: install names, rpaths, files. */
function world() {
  const deps: Record<string, string[]> = {
    [`${R}/second-aec.node`]: ['@rpath/second-aec.node', '/opt/homebrew/opt/gstreamer/lib/libgstreamer-1.0.0.dylib', '/usr/lib/libSystem.B.dylib'],
    [`${R}/gstreamer-1.0/libgstwebrtcdsp.dylib`]: ['/tmp/build/libgstwebrtcdsp.dylib', '/opt/homebrew/opt/gstreamer/lib/libgstreamer-1.0.0.dylib', '/opt/homebrew/opt/abseil/lib/libabsl_base.dylib'],
    [`${R}/gstreamer-lib/libgstreamer-1.0.0.dylib`]: ['/opt/homebrew/opt/gstreamer/lib/libgstreamer-1.0.0.dylib', '/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib'],
    '/opt/homebrew/Cellar/abseil/1/lib/libabsl_base.dylib': ['/opt/homebrew/opt/abseil/lib/libabsl_base.dylib', '/System/Library/Frameworks/Foundation.framework/Foundation'],
    '/opt/homebrew/Cellar/glib/2/lib/libglib-2.0.0.dylib': ['/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib'],
  }
  const rpaths: Record<string, string[]> = {
    [`${R}/gstreamer-1.0/libgstwebrtcdsp.dylib`]: ['/opt/homebrew/Cellar/gstreamer/1.28/lib'],
  }
  const real: Record<string, string> = {
    '/opt/homebrew/opt/abseil/lib/libabsl_base.dylib': '/opt/homebrew/Cellar/abseil/1/lib/libabsl_base.dylib',
    '/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib': '/opt/homebrew/Cellar/glib/2/lib/libglib-2.0.0.dylib',
  }
  const files = new Set([...Object.keys(deps), ...Object.keys(real)])
  const calls: string[][] = []
  const signed: string[] = []

  const apply = (args: string[]) => {
    calls.push(args)
    const file = args[args.length - 1]
    if (args[0] === '-change') deps[file] = deps[file].map((d) => (d === args[1] ? args[2] : d))
    if (args[0] === '-id') deps[file][0] = args[1]
    if (args[0] === '-add_rpath') rpaths[file] = [...(rpaths[file] ?? []), args[1]]
    if (args[0] === '-delete_rpath') rpaths[file] = (rpaths[file] ?? []).filter((r) => r !== args[1])
  }

  const fake = {
    otoolL: (f: string) => `${f}:\n${(deps[f] ?? []).map((d) => `\t${d} (compatibility version 1.0.0, current version 1.0.0)`).join('\n')}\n`,
    otoolLoad: (f: string) => (rpaths[f] ?? []).map((r) => `Load command 9\n          cmd LC_RPATH\n      cmdsize 48\n         path ${r} (offset 12)`).join('\n'),
    installNameTool: apply,
    codesign: (f: string) => { signed.push(f) },
    exists: (p: string) => files.has(p) || p in real,
    realpath: (p: string) => real[p] ?? p,
    copy: (src: string, dst: string) => { files.add(dst); deps[dst] = [...(deps[src] ?? [])] },
    list: (dir: string) => [...files].filter((f) => f.startsWith(dir + '/')).map((f) => f.slice(dir.length + 1)).filter((n) => !n.includes('/')),
    mkdir: () => {},
    log: () => {},
  }
  return { fake, deps, rpaths, calls, signed }
}

describe('relocate-gstreamer-mac', () => {
  it('parses otool output, dropping the file\'s own install name', () => {
    expect(parseOtoolL('x.node:\n\t@rpath/x.node (compatibility version 0.0.0)\n\t/opt/homebrew/a.dylib (compatibility version 1)\n', 'x.node')).toEqual(['/opt/homebrew/a.dylib'])
    expect(parseOtoolL('p.dylib:\n\t/opt/homebrew/a.dylib (compatibility version 1)\n', 'p.so')).toEqual(['/opt/homebrew/a.dylib'])
    expect(parseRpaths('cmd LC_RPATH\n cmdsize 32\n path @loader_path (offset 12)')).toEqual(['@loader_path'])
  })

  it('bundles transitive deps, rewrites to @rpath, replaces foreign rpaths, and re-signs', () => {
    const w = world()
    const result = relocate(R, w.fake)
    expect(result.copied.sort()).toEqual(['libabsl_base.dylib', 'libglib-2.0.0.dylib'])
    // Every non-system reference now resolves inside the app.
    for (const [file, list] of Object.entries(w.deps)) {
      if (!file.startsWith(R)) continue
      for (const d of list.slice(1)) {
        expect(d.startsWith('@rpath/') || d.startsWith('/usr/lib/') || d.startsWith('/System/'), `${file} -> ${d}`).toBe(true)
      }
    }
    // Homebrew rpath removed from the plugin; loader-relative ones added.
    expect(w.rpaths[`${R}/gstreamer-1.0/libgstwebrtcdsp.dylib`]).toEqual(['@loader_path/../gstreamer-lib'])
    expect(w.rpaths[`${R}/second-aec.node`]).toEqual(['@loader_path/gstreamer-lib'])
    expect(w.rpaths[`${R}/gstreamer-lib/libglib-2.0.0.dylib`]).toEqual(['@loader_path'])
    expect(w.deps[`${R}/gstreamer-lib/libglib-2.0.0.dylib`][0]).toBe('@rpath/libglib-2.0.0.dylib')
    expect(w.signed).toContain(`${R}/second-aec.node`)
  })

  it('is idempotent on an already relocated app', () => {
    const w = world()
    relocate(R, w.fake)
    w.calls.length = 0
    const again = relocate(R, w.fake)
    expect(again.copied).toEqual([])
    // Second run changes no references or search paths (re-setting ids is harmless).
    expect(w.calls.filter((c) => c[0] !== '-id')).toEqual([])
  })

  it('fails loudly when a dependency cannot be found', () => {
    const w = world()
    w.deps[`${R}/second-aec.node`].push('/opt/homebrew/opt/missing/lib/libmissing.dylib')
    expect(() => relocate(R, w.fake)).toThrow(/cannot resolve .*libmissing/)
  })

  it('skips cleanly when the AEC addon is not bundled', () => {
    const w = world()
    delete w.deps[`${R}/second-aec.node`]
    const fake = { ...w.fake, exists: (p: string) => p !== `${R}/second-aec.node` && w.fake.exists(p) }
    expect(relocate(R, fake)).toEqual({ copied: [], modified: [] })
  })
})
