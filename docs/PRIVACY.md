# Privacy

Second is a desktop app with **no Second server**. There is no account, no hosted backend, and no cloud sync. This page describes exactly where your data goes so you can decide what is appropriate for your meetings.

## What stays on your machine

| Data | Where | How long |
|------|-------|----------|
| API keys and settings | `electron-store` file in the app's user-data folder | Until you reset settings or uninstall |
| Sessions (transcript, overlay chat, title, summary, action items, follow-up draft) | Local SQLite database (`data/second.db` in the user-data folder) | Until you delete the session |
| Session memory used by Assist while recording | The session row in SQLite | Deleted with the session |
| Mode documents you upload (RAG) | Parsed, chunked, and embedded on-device; chunks stored in SQLite | Until you remove the file from the mode |
| Raw audio | **Not written to disk.** PCM is streamed in memory only | Never retained |

**Incognito** sessions are not written to SQLite at all.

## What leaves your machine, and to whom

Second only talks to the providers *you* configure, using *your* API keys:

| Sent | Recipient | When |
|------|-----------|------|
| Microphone and system audio (live PCM) | Deepgram and/or AssemblyAI | While a session is recording |
| Transcript excerpts, your typed questions, mode instructions, retrieved document snippets | Anthropic or OpenAI | When you ask for Assist, recap, follow-up, Ask, titles, summaries, or insights |
| A screenshot of your screen (Second's own windows excluded) | Anthropic or OpenAI | With **Assist** (Cmd/Ctrl+Enter). Other actions do not attach a screenshot |

Each provider's own terms and retention policy apply to what you send them. Check them before using Second in confidential settings.

Other network traffic:

- **Embedding model download.** The first time you use document search or Ask, Second downloads the `Xenova/all-MiniLM-L6-v2` model (~30 MB) from Hugging Face. Embedding then runs on-device.
- **Update checks.** Installed builds check this project's GitHub Releases for a newer version.
- **Telemetry and crash reporting.** The source contains optional PostHog and Sentry hooks. In this repository they are **unconfigured** (no key or DSN), so nothing is sent. If you build and distribute your own copy with keys added, disclose that to your users.

## Your responsibilities

Recording or transcribing a conversation may require the consent of everyone in it, depending on where you and they are. You are responsible for complying with the laws and any confidentiality obligations that apply to your meetings.

## Deleting your data

- Delete a session from the dashboard to remove its transcript, chat, memory, and search index.
- Remove a document from a mode to delete its chunks.
- Uninstalling Second does not delete the user-data folder. Remove it manually to erase everything:
  - macOS: `~/Library/Application Support/Second`
  - Windows: `%APPDATA%\Second`

## Questions

Open an issue at <https://github.com/CommonCapital/second/issues>, or report security problems privately via <https://github.com/CommonCapital/second/security/advisories/new>.
