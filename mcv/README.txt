MANCHESTER VICTORIA DISPLAY SYSTEM — GITHUB PAGES (STATIC)

No Python, Firebase or server to install.

NEW: PLATFORM ALTERATION ALERTS + STAFF ANNOUNCEMENT ASSISTANT
- control.html includes a list of changes OBSERVED IN THIS BROWSER TAB as the live feed refreshes. It does not show earlier changes, validate the official platform, or guarantee that a physical screen is displaying the notice.
- On each passenger board, platform-alterations.js watches that board's own successive departures-feed results. When it sees the same identifiable train move from one allocated platform to another, it shows a clearly marked live-data change/check-platform message relevant to that board. Initial loads and TBC-to-allocated are not classed as alterations. The alert expires after six minutes, is replaced if the same train changes again, or clears on a reported cancellation/departure.
- This is local to each browser. GitHub Pages does not broadcast observed feed changes from one screen to another. If a screen was opened after an alteration, it cannot reconstruct that earlier change. Use authorised station systems for operational decisions.
- After verifying a change with the official station system, staff may press Prepare notice in control.html. That pre-fills the previous notice editor and selects main and affected individual, combined and next-train pages. It does not publish anything. Verify, download notices.json and commit it to GitHub to show a fixed notice to other screens. The default expiry is 15 minutes; it begins when the file is created, not when GitHub finishes deployment. Uploaded static notices do NOT automatically disappear on train departure: they expire on time or require an updated GitHub commit to withdraw.
- Staff announcement assistant is inside control.html#announcements (linked from index.html and staff.html). Select a train, choose Service information, Delay, Cancellation or Observed platform change; optionally add onward calling points and, only once formation is checked, a configured front-two-carriages reminder. Generate an editable script and copy it for STAFF review/delivery; there is no automatic audio or PA connection. The assistant never invents an unreported cancellation/delay/platform change, requires explicit verification for observed platform-change scripts, and invalidates previous drafts if source train details change.
- If the feed fails or is stale (90+ seconds), new script generation is blocked; do not use earlier copies without checking current official information.



DEPLOY
1. Extract this ZIP and upload the files into the same GitHub Pages folder.
2. If your current repository has LIVE notices in notices.json, KEEP that file rather than replacing it with the blank example in this ZIP.
3. Keep your existing licensed bunday-clean-regular.woff and bunday-clean-bold.woff in that folder.
4. The approved Northern logo is already embedded in the HTML; no separate logo file is required.
5. Commit and let GitHub Pages deploy. Open index.html, or control.html for the static control room.

CONTROL ROOM
- control.html reads the live Manchester Victoria departures feed independently of the boards.
- It shows links to the configured screen types. THESE ARE LINKS, NOT ONLINE/OFFLINE MONITORING.
- There is no password in this static page and it is accessible to whoever can view your public GitHub Pages website.
- The page does NOT receive heartbeats or identify which physical screens are on.

PUBLISHING A NOTICE
1. In control.html enter a notice, select its target screens, priority and expiry.
2. Press Download updated JSON. This ONLY downloads a local file.
3. Replace notices.json in your GitHub Pages repository with the downloaded file and COMMIT the change.
4. GitHub Pages must deploy the new file; screens poll notices.json about every 30 seconds.
5. A notice will automatically vanish once its expiry time passes, even if it remains in the file.
6. To withdraw it early, use Remove from draft in control.html, then commit the replacement file.
7. To avoid overwriting other changes, refresh control.html to load the current committed file before editing.

IMPORTANT TIME LIMITATION
Expiry starts when you prepare the file, not when GitHub deploys it. Very short (5-minute) notices may expire before deployment. Use a longer duration if needed. Avoid time-sensitive safety-critical announcements via this method.

SECURITY AND RESTRICTIONS
- Anyone who can access your public website can load control.html and download a draft.
- Only users with GitHub repository write permission can publish (commit) it. Protect your repository accordingly.
- This is NOT a live remote management or authenticated display-monitoring service.
- Do not put secrets, credentials, employee details or unpublished operating data in HTML/JSON.
- Continue to check official railway systems for operational decisions.
- Train data still comes directly from https://api.traini.ac/ (requires browser access and CORS).
- Passenger-facing pages contain the existing train data logic and now also read static-notices.js.
- If the live API is blocked from your GitHub Pages domain, this static package cannot bypass CORS.

FILES
index.html — display selector
control.html — live station feed, directory and downloadable notice drafts
notices.json — committed notices viewed by passenger screens
static-notices.js — shared committed-notice receiver (all passenger boards)
platform-alterations.js — feed-observed platform allocation checks and on-screen alerts (all passenger boards, and control room)
platform.html, platform1.html … platform6.html, platform12.html, platform45.html — departures boards
nexttrain1.html … nexttrain6.html — single next-train screens
staff.html, assist.html, assist-desktop.html — staff tools
