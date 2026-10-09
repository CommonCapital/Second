import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

function readme(): string {
  return readFileSync(join(process.cwd(), 'README.md'), 'utf8')
}

describe('README matches the OSS runtime', () => {
  it('does not claim store.ts is SQLite or mention a missing aiService.ts', () => {
    const text = readme()
    expect(text).toMatch(/store\.ts\s+#\s+electron-store/)
    expect(text).toMatch(/database\.ts\s+#\s+SQLite/)
    expect(text).toContain('claudeService.ts')
    expect(text).not.toMatch(/aiService\.ts/)
    expect(text).not.toMatch(/store\.ts\s+#\s+SQLite/)
  })

  it('documents AssemblyAI routing and residual echo gate, not Deepgram-only STT', () => {
    const text = readme()
    expect(text).toMatch(/AssemblyAI/)
    expect(text).toMatch(/u3-rt-pro/)
    expect(text).toMatch(/nova-3/)
    expect(text).toMatch(/ResidualEchoGate|residual echo gate/)
    expect(text).not.toMatch(/two parallel WebSocket connections to Deepgram Nova-3/)
  })

  it('describes RAG as local MiniLM per mode, not cross-meeting memory', () => {
    const text = readme()
    expect(text).toMatch(/Xenova\/all-MiniLM-L6-v2/)
    expect(text).toMatch(/sessionMemory/)
    expect(text).toMatch(/cross-meeting user-memory/)
    expect(text).toMatch(/There is no global/)
    expect(text).not.toMatch(/Second Backend/)
    expect(text).not.toMatch(/Pro Loader/)
  })

  it('lists current global hotkeys, not Cmd+R recording', () => {
    const text = readme()
    expect(text).toMatch(/Cmd \+ Shift \+ Space/)
    expect(text).toMatch(/Cmd \+ Shift \+ Backspace/)
    expect(text).not.toMatch(/Start\/Stop Recording \| `Cmd \+ R`/)
    expect(text).not.toMatch(/Clear Conversation \| `Cmd \+ Shift \+ R`/)
  })

  it('does not advertise accounts, cloud sync, or a meeting bot as available', () => {
    const text = readme()
    expect(text).toMatch(/No Second account/)
    expect(text).toMatch(/no login, cloud sync, or meeting bot/)
    expect(text).toMatch(/docs\/PRIVACY\.md/)
  })

  it('points maintainers at CONTRIBUTING.md for cutting a notarized Mac release', () => {
    const text = readme()
    expect(text).toMatch(/CONTRIBUTING\.md#releasing/)
  })
})

describe('CONTRIBUTING.md documents the Mac release loop', () => {
  it('states that publishing a GitHub Release is the notarize trigger', () => {
    const text = readFileSync(join(process.cwd(), 'CONTRIBUTING.md'), 'utf8')
    expect(text).toMatch(/## Releasing/)
    expect(text).toMatch(/release-macos\.yml/)
    expect(text).toMatch(/release: published/)
    for (const secret of ['MAC_CERTIFICATE', 'MAC_CERTIFICATE_PASSWORD', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) {
      expect(text).toContain(`\`${secret}\``)
    }
    expect(text).not.toMatch(/-private/)
  })
})