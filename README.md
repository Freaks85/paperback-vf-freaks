# Moomooo95 Extensions

This repository hosts the french sources that are installable directly through the Paperback application.

## Usage

Add this source list to the Paperback app.

## Available Sources

| Name | URL | Template | Status |
| --- | --- | --- | --- |
| MangasOrigines | <https://mangas-origines.fr/> | Madara | ✅ |
| PoseidonScans | <https://poseidon-scans.net/> | Custom (Next.js) | ✅ |
| RaijinScans | <https://raijin-scans.fr/> | Madara | ✅ |

## Notes

- **MangasOrigines** and **RaijinScans** are WordPress / Madara sites and share the `Madara` template.
- **PoseidonScans** is a custom Next.js site. Its extension reads the clean JSON API (`/api/manga/lastchapters`) for the latest releases and scrapes the rendered pages (and the embedded Next.js flight payload) for details, chapter lists and reader images. Premium (locked) chapters are prefixed with the lock emoji.
- All three sources are marked `CLOUDFLARE_BYPASS_REQUIRED`; if you hit an HTTP 403, open the source once in the in-app WebView to clear the Cloudflare challenge.
