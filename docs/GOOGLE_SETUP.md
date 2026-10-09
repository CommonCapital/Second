# Connect Google (optional)

Second can read your **Calendar**, **Gmail**, and **Drive** to build the pre-meeting packet: the invite, recent email with the people you are meeting, and matching docs. It is optional, read-only, and off until you connect.

Like your AI keys, you use **your own** Google OAuth client. Second has no server, so your Google data goes only between Google, your Mac, and (when you generate a brief) your AI provider.

Setup takes about five minutes, once.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/projectcreate>.
2. Name it `Second` and click **Create**.

## 2. Turn on the three APIs

In the new project, open each link and click **Enable**:

- Calendar: <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
- Gmail: <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
- Drive: <https://console.cloud.google.com/apis/library/drive.googleapis.com>

Skip any you won't use.

## 3. Configure the consent screen

1. Open <https://console.cloud.google.com/auth/branding> (Google Auth Platform → Branding).
2. App name `Second`, your email as support and developer contact. Save.
3. **Audience:** choose **External**, keep the status **Testing**, and under **Test users** add the Google account(s) you will connect. (Testing mode is fine for personal use; you do not need Google verification.)
4. **Data access → Add or remove scopes:** add
   - `.../auth/calendar.readonly`
   - `.../auth/gmail.readonly`
   - `.../auth/drive.readonly`

## 4. Create the OAuth client

1. Open <https://console.cloud.google.com/auth/clients> → **Create client**.
2. Application type: **Desktop app**. Name: `Second for Mac`.
3. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`).

## 5. Connect in Second

1. **Settings → Second → Integrations → Google**.
2. Paste the client ID and secret, click **Save**, then **Connect Google**.
3. Your browser opens Google's consent screen. Because the app is in Testing mode, Google shows *"Google hasn't verified this app"*: click **Continue**. Tick every box (Calendar, Gmail, Drive) and allow.
4. The browser says *Google is connected*. Back in Second you'll see **Connected** with your account.

## Using it

- **Prepare meeting** now shows **From your calendar**. Pick a meeting: Second fills in who you're meeting and their organization, then lists the invite, recent email threads, and matching Drive docs. Untick anything you don't want included, then **Generate brief** or **Start meeting**.
- **Find email & docs** searches Gmail and Drive for whatever people/organization you typed, even without a calendar event.
- With reminders on, Second notifies you ~10 minutes before a calendar meeting that has other attendees or a video link. Click the notification to open the prep for that meeting.

## What Second reads, and where it goes

| Service | What | Scope |
|---------|------|-------|
| Calendar | Your upcoming events (next 2 days): title, time, attendees, description, video link | `calendar.readonly` |
| Gmail | Up to 5 recent messages (last 180 days) to or from the meeting's attendees: subject, sender, date, body without quoted history | `gmail.readonly` |
| Drive | Up to 4 recently modified files whose name or text matches the organization or meeting title; Google Docs/Slides/Sheets and plain-text files are read as text | `drive.readonly` |

- Nothing is written to your Google account.
- Gathered items are shown to you first. Only ticked items are added to the meeting context, which is sent to **your AI provider** when you generate the brief and used by the live coach during that meeting.
- The refresh token and client secret are stored encrypted on your Mac and never shown to the app's UI.
- **Disconnect** revokes Second's access at Google and deletes the token. You can also remove access any time at <https://myaccount.google.com/permissions>.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Access blocked: Second has not completed the Google verification process" | Add your account under **Audience → Test users** (step 3). |
| "Google did not return a refresh token" | Remove Second at <https://myaccount.google.com/permissions>, then **Connect** again. |
| A service shows "not granted, reconnect" | Click **Reconnect** and tick every box on Google's consent screen. |
| "Google access expired" | Testing-mode tokens expire after 7 days; click **Reconnect**. Publishing the app (Audience → Publish) removes the 7-day limit. |
| `redirect_uri_mismatch` | The client type must be **Desktop app**, not Web application. |
