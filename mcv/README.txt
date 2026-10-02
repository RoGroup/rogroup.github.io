MANCHESTER VICTORIA — ACCESSIBILITY & DISRUPTION STAFF TOOLS
GitHub Pages static add-on — 2 October 2026

WHAT IS INCLUDED
accessibility.html   — Accessibility & Passenger Assistance Hub
  Documented MCV facilities; links to official station/lift status information;
  Northern Passenger Assist contacts; service-aware staff handover checklist;
  direct and one-change journey candidates with accessibility warnings.

disruption.html      — Disruption & Alternative Journey Assistant
  Currently reported cancellations and delays from the MCV departures feed;
  candidate direct/one-change alternatives from the existing journey feed;
  flags cancelled candidates, at-risk/unknown connections; guidance drafts.

staff-hubs.css       — Shared Northern-styled responsive layout; Bunday font rules
staff-hubs.js        — Shared live feed, station lookup, journey search & draft logic
index.html           — Existing display launcher with both new shortcuts
control.html         — Existing static control room with both links in Staff tools

INSTALLATION (NO SERVER, NO PYTHON, NO FIREBASE)
1. Copy all six files from this ZIP into the SAME GitHub Pages folder as your
   existing platform.html, staff.html, control.html, assist.html etc.
2. Replace the old index.html and control.html with the included versions.
3. Do NOT delete or replace notices.json, static-notices.js,
   platform-alterations.js, or any of your passenger-facing HTML pages.
4. Keep your licensed bunday-clean-regular.woff and
   bunday-clean-bold.woff alongside these files to see the approved Bunday face.
5. Commit to your existing GitHub repository and wait for Pages to deploy.
6. Open accessibility.html / disruption.html via the updated launcher.

WHAT THE DATA DOES AND DOES NOT VERIFY
- Live train data uses the SAME existing third-party API as the earlier
  Passenger Assist pages: https://api.traini.ac/api/.
- It refreshes MCV departures at 30-second intervals and checks for reported
  departures and cancellation reasons separately. Journey searches use the
  existing station search and journey endpoints, with 0 or 1 change.
- A route is a candidate, NOT a confirmed rail replacement, passenger
  entitlement, valid ticket acceptance or accessible itinerary.
- Step-free station category and lift installation are PUBLISHED information,
  NOT live lift availability. Use the linked official National Rail station
  pages for lift status, accessible routes and changing station works.
- The handover drafts DO NOT make Passenger Assist bookings, notify a
  receiving station, contact a customer, or broadcast an announcement.
- No passenger names, contacts, medical details or other personal information
  should be entered. Do not place any of those in a public GitHub repository.
- Staff must check the official railway systems for current platforms,
  operation, connection feasibility, ticket validity, accessibility and
  authorised assistance processes before advising passengers.

GITHUB PAGES ACCESS CONTROL
- These static HTML pages are accessible to anyone who knows the public site
  URL. They are staff-labelled interfaces, NOT password-protected staff systems.
- They DO NOT store data in a backend and provide no authenticated workflow.
  Do not publish confidential or personally identifying station information.
- If the existing third-party API blocks GitHub Pages' browser domain through
  CORS, this static tool cannot bypass it; it will report the feed as offline.

OFFICIAL VERIFICATION LINKS (read them directly for current status)
https://www.nationalrail.co.uk/stations/manchester-victoria/
https://railmap.nationalrail.co.uk/backend/public/station/MCV
https://www.northernrailway.co.uk/help/assisted-travel-support
https://www.northernrailway.co.uk/accessibility-hub/before-you-travel
https://www.nationalrail.co.uk/stations/
https://www.nationalrail.co.uk/disruptions/
https://www.nationalrail.co.uk/

TESTING
The browser tests used simulated API responses, not confirmed live trains.
Verify against the actual GitHub Pages site and authorised station data before
using either page operationally.
