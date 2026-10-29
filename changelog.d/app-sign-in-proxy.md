### Fixed
- The Android and iOS apps open a PC behind a sign-in such as Cloudflare Access, oauth2-proxy or
  Authelia: the sign-in shows in the app, without access to the app's own functions, and the PC
  opens once it is done. Before, the app showed an error page, or handed the sign-in to the browser,
  whose cookie the app never saw. Reported by @candiesdoodle, whose #2008 laid out the approach.
