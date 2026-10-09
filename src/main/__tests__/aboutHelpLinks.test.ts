import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DOCS_URL, FEEDBACK_URL, ISSUES_URL, REPO_URL } from '../../shared/project'

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
}

describe('About and menu help links', () => {
  it('project links all point at the project repo', () => {
    for (const url of [DOCS_URL, FEEDBACK_URL, ISSUES_URL]) {
      expect(url.startsWith(REPO_URL)).toBe(true)
    }
  })

  it('Send Feedback in the user menu uses the shared feedback link', () => {
    const header = src('src/renderer/src/components/dashboard/Header.tsx')
    const label = '<span>Send Feedback</span>'
    const helpBlock = header.slice(header.indexOf(label) - 400, header.indexOf(label))
    expect(header).toContain(label)
    expect(helpBlock).toContain('openExternal(FEEDBACK_URL)')
  })

  it('About links come from the shared project constants, not hardcoded hosts', () => {
    const about = src('src/renderer/src/components/dashboard/settings/AboutTab.tsx')
    expect(about).toContain('handleOpenLink(REPO_URL)')
    expect(about).toContain('handleOpenLink(ISSUES_URL)')
    expect(about).toContain('handleOpenLink(DOCS_URL)')
    expect(about).toContain('url: FEEDBACK_URL')
    expect(about).not.toMatch(/https?:\/\//)
  })
})
