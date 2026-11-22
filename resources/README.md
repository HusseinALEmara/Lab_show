The release build places `cloudflared.exe` here (downloaded and checked against
Cloudflare's published SHA-256 by `tools/fetch-cloudflared.js`). It is shipped next to
the app and gives each device its own public https address without opening ports.
