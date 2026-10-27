# Moomooo95 Extensions

This repository hosts the french sources that are installable directly through the Paperback application.

## Usage

Add this source list to the Paperback app.

## Available Sources

| Name | URL | Template | Status |
| --- | --- | --- | --- |
| Aniverse | <https://aniverse.fr/> | Custom (Next.js) | ✅ |
| MangasOrigines | <https://mangas-origines.fr/> | Madara | ✅ |
| PoseidonScans | <https://poseidon-scans.net/> | Custom (Next.js) | ✅ |
| RaijinScans | <https://raijin-scans.fr/> | Madara | ✅ |

## Notes

- **Aniverse** is a Next.js site backed by a clean JSON API: `/api/manga` (recent releases), `/api/anime/search?media=manga` (search, popular, newest). Manga details, chapter lists and reader pages come from the Next.js flight payload of `/manga/{slug}` and `/read/{slug}/{chapterId}`. Images are served from `cdn.onefy.me`. Premium chapters are prefixed with the lock emoji.
- **MangasOrigines** and **RaijinScans** are WordPress / Madara sites and share the `Madara` template.
- **PoseidonScans** is a custom Next.js site. Its extension reads the clean JSON API (`/api/manga/lastchapters`) for the latest releases and scrapes the rendered pages (and the embedded Next.js flight payload) for details, chapter lists and reader images. Premium (locked) chapters are prefixed with the lock emoji.
- All three sources are marked `CLOUDFLARE_BYPASS_REQUIRED`; if you hit an HTTP 403, open the source once in the in-app WebView to clear the Cloudflare challenge.
