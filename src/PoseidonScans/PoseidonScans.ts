import {
    ContentRating,
    SourceInfo,
    BadgeColor,
    SourceIntents,
    SourceManga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    PagedResults,
    Request,
    Response,
    PartialSourceManga,
    MangaProviding,
    ChapterProviding,
    SearchResultsProviding,
    HomePageSectionsProviding,
    HomeSectionType,
    CloudflareBypassRequestProviding
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'

import { parseDate } from '../templates/helper'


const DOMAIN: string = 'https://poseidon-scans.net'

export const PoseidonScansInfo: SourceInfo = {
    version: "1.3",
    language: "FR",
    name: 'PoseidonScans',
    icon: 'icon.png',
    description: `Extension that pulls mangas from ${DOMAIN}`,
    author: 'Freaks85',
    authorWebsite: 'https://github.com/Freaks85',
    contentRating: ContentRating.EVERYONE,
    websiteBaseURL: DOMAIN,
    sourceTags: [
        {
            text: 'FR',
            type: BadgeColor.GREY
        },
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class PoseidonScans implements MangaProviding, ChapterProviding, SearchResultsProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {

    base_url: string = DOMAIN
    lang_code: string = PoseidonScansInfo.language!

    date_format: string = "DD/MM/YYYY"
    date_lang: string = "fr"

    constructor(private cheerio: CheerioAPI) { }


    /////////////////////////////////
    /////    REQUEST MANAGER    /////
    /////////////////////////////////


    requestManager = App.createRequestManager({
        requestsPerSecond: 5,
        requestTimeout: 20000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'referer': `${this.base_url}/`,
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
                    }
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    });


    //////////////////////
    /////    UTILS    /////
    //////////////////////


    coverUrl(slug: string): string {
        return `${this.base_url}/api/covers/${slug}.webp`
    }

    // Extract a manga slug from any poseidon "/serie/{slug}" url
    slugFromUrl(url: string): string {
        const match = url.match(/\/serie\/([^/?#]+)/)
        return match?.[1] ?? url.split('/').filter(Boolean).pop() ?? ''
    }

    parseStatus(statusString: string): string {
        switch (statusString.trim().toLowerCase()) {
            case "en cours": return "En cours"
            case "terminé": return "Terminé"
            case "en pause":
            case "hiatus": return "En pause"
            case "annulé":
            case "abandonné": return "Annulé"
            default: return "N/A"
        }
    }

    viewer(type: string, genres: string[]): string {
        const source = (type + " " + genres.join(" ")).toLowerCase()
        const webtoonTags = ["manhwa", "manhua", "webtoon", "vertical", "korean", "chinese"]
        const rtlTags = ["manga", "japan"]
        return webtoonTags.find(tag => source.includes(tag))
            ?? rtlTags.find(tag => source.includes(tag))
            ?? "unknown"
    }


    /////////////////////////////////
    /////    MANGA PROVIDING    /////
    /////////////////////////////////


    getMangaShareUrl(mangaId: string): string {
        return `${this.base_url}/serie/${mangaId}`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const request = App.createRequest({
            url: `${this.base_url}/serie/${mangaId}`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        this.checkError(response.status)
        const $ = this.cheerio.load(response.data as string)

        const title = $('h1').first().text().trim()
        const altTitle = $('h1').first().next().text().trim()
        const titles = [title]
        if (altTitle && altTitle !== title) titles.push(altTitle)

        const image = this.coverUrl(mangaId)

        // Informations block: "Statut", "Type", "Auteur", "Artiste"
        const infoText = $('h3:contains(Informations)').parent().text()
        const statusMatch = infoText.match(/Statut\s*([^\n]*?)(?:Type|Auteur|Artiste|$)/i)
        const typeMatch = infoText.match(/Type\s*([A-Za-zÀ-ÿ]+)/i)
        const authorMatch = infoText.match(/Auteur\s*([^\n]*?)(?:Artiste|$)/i)
        const artistMatch = infoText.match(/Artiste\s*([^\n]*?)(?:Genres|$)/i)

        const status = this.parseStatus(statusMatch?.[1]?.trim() ?? "")
        const author = authorMatch?.[1]?.trim() || "N/A"
        const artist = artistMatch?.[1]?.trim() || "N/A"
        const type = typeMatch?.[1]?.trim() ?? ""

        const genres: string[] = []
        $('a[href*="/series?tags="]').each((_: number, el: any) => {
            const g = $(el).text().trim()
            if (g) genres.push(g)
        })

        // Synopsis sits under the "Synopsis" heading
        let desc = $('h3:contains(Synopsis)').nextAll('p').first().text().trim()
        if (!desc) desc = $('meta[name="description"]').attr('content')?.trim() ?? ""

        const tagSection = App.createTagSection({
            id: '0',
            label: 'genres',
            tags: genres.map(g => App.createTag({ id: g, label: g }))
        })

        const nsfw = genres.some(g => ["adulte", "mature", "ecchi", "adult"].includes(g.toLowerCase()))

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles,
                image,
                author,
                artist,
                desc,
                status,
                hentai: nsfw,
                tags: [tagSection],
                additionalInfo: {
                    "viewer": this.viewer(type, genres)
                }
            })
        })
    }


    ///////////////////////////////////
    /////    CHAPTER PROVIDING    /////
    ///////////////////////////////////


    async getChapters(mangaId: string): Promise<Chapter[]> {
        const request = App.createRequest({
            url: `${this.base_url}/serie/${mangaId}`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        this.checkError(response.status)
        const body = response.data as string

        // Primary: parse the embedded Next.js RSC stream to get the FULL chapter list
        let chapters = this.parseChaptersFromRsc(body, mangaId)

        // Fallback: parse the rendered chapter links (may be partial, ~20)
        if (chapters.length === 0) {
            chapters = this.parseChaptersFromHtml(this.cheerio.load(body), mangaId)
        }

        if (chapters.length === 0) {
            throw new Error(`Couldn't find any chapters for mangaId: ${mangaId}!`)
        }

        return chapters
    }

    // Parse chapters from the Next.js flight (RSC) payload embedded in <script>self.__next_f.push(...)</script>
    parseChaptersFromRsc(body: string, mangaId: string): Chapter[] {
        const chapters: Chapter[] = []
        const seen = new Set<number>()

        // Reassemble the flight payload
        const pushRegex = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g
        let assembled = ''
        let m: RegExpExecArray | null
        while ((m = pushRegex.exec(body)) !== null) {
            try {
                assembled += JSON.parse(`"${m[1]}"`)
            } catch {
                assembled += m[1]!
            }
        }

        if (!assembled) return chapters

        // Each chapter object in the flight stream looks roughly like:
        // {"id":"cmqvaygeo9qtlynblbmqaei1h","number":129,"title":null,"isPremium":true,"createdAt":"2026-..",...}
        // The CUID "id" is the real chapter identifier used in /serie/{slug}/chapter/{id} URLs;
        // the "number" is only for display and sorting. The field order in the flight stream is
        // not guaranteed, so we capture each field independently across the chapter object.
        const chapterRegex = /\{[^{}]*?"id"\s*:\s*"(c[a-z0-9]+)"[^{}]*?\}/g
        let c: RegExpExecArray | null
        while ((c = chapterRegex.exec(assembled)) !== null) {
            const cuid = c[1]!
            const block = c[0]

            const numMatch = block.match(/"number"\s*:\s*([0-9]+(?:\.[0-9]+)?)/)
            const num = numMatch ? Number(numMatch[1]) : NaN
            const numStr = numMatch ? numMatch[1]!.replace(/\.0$/, '') : cuid
            if (seen.has(num)) continue
            seen.add(num)

            let title: string | undefined
            const titleMatch = block.match(/"title"\s*:\s*("(?:[^"\\]|\\.)*"|null)/)
            if (titleMatch && titleMatch[1] !== 'null') {
                try { title = JSON.parse(titleMatch[1]!) } catch { title = undefined }
            }

            const isPremiumMatch = block.match(/"isPremium"\s*:\s*(true|false)/)
            const isPremium = isPremiumMatch?.[1] === 'true'

            const dateMatch = block.match(/"createdAt"\s*:\s*"([^"]*)"/)
            const date = dateMatch ? new Date(dateMatch[1]!) : new Date()

            const name = title && title.trim()
                ? `Chapitre ${numStr} - ${title.trim()}`
                : `Chapitre ${numStr}`

            chapters.push(App.createChapter({
                id: cuid,
                name: (isPremium ? "🔒 " : "") + name,
                langCode: this.lang_code,
                chapNum: isNaN(num) ? 0 : num,
                time: isNaN(date.getTime()) ? new Date() : date
            }))
        }

        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    parseChaptersFromHtml($: CheerioAPI, mangaId: string): Chapter[] {
        const chapters: Chapter[] = []
        const seen = new Set<string>()

        $(`a[href*="/serie/${mangaId}/chapter/"]`).each((_: number, el: any) => {
            const href = $(el).attr('href') ?? ''
            const idMatch = href.match(/\/chapter\/([^/?#]+)/)
            if (!idMatch) return
            const chapNum = idMatch[1]!
            if (seen.has(chapNum)) return
            seen.add(chapNum)

            const text = $(el).text().trim()
            const titleMatch = text.match(/Ch\.\s*[0-9.]+\s*-\s*(.+?)(?:[0-9]+\s*(?:minute|heure|jour|semaine|mois|an)|$)/i)
            const title = titleMatch?.[1]?.trim()

            const name = title
                ? `Chapitre ${chapNum} - ${title}`
                : `Chapitre ${chapNum}`

            const dateMatch = text.match(/([0-9]+\s*(?:minute|heure|jour|semaine|mois|an)[a-z]*)/i)
            const date = dateMatch ? parseDate(dateMatch[1]!, this.date_format, this.date_lang) : new Date()

            chapters.push(App.createChapter({
                id: chapNum,
                name,
                langCode: this.lang_code,
                chapNum: Number(chapNum) || 0,
                time: date
            }))
        })

        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const request = App.createRequest({
            url: `${this.base_url}/serie/${mangaId}/chapter/${chapterId}`,
            method: 'GET'
        })

        const response = await this.requestManager.schedule(request, 1)
        this.checkError(response.status)
        const body = response.data as string

        // Primary: scrape rendered <img> tags pointing at chapter pages. The site has
        // historically served these from "/api/chapters/...", but the storage path may
        // differ, so we match any image whose URL contains "/chapters/".
        const $ = this.cheerio.load(body)
        const pages: string[] = []
        const seen = new Set<string>()
        $(`img[src*="/chapters/"]`).each((_: number, el: any) => {
            let src = $(el).attr('src') ?? $(el).attr('data-src') ?? ''
            if (!src || seen.has(src)) return
            // skip tiny UI icons / favicons
            const w = $(el).attr('width')
            if (w && Number(w) > 0 && Number(w) < 50) return
            seen.add(src)
            pages.push(src.startsWith('http') ? src : this.base_url + src)
        })

        // Fallback: extract page URLs from the Next.js flight payload when no <img>
        // tags are present (e.g. images are loaded lazily from the RSC stream).
        if (pages.length === 0) {
            const pushRegex = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g
            let assembled = ''
            let m: RegExpExecArray | null
            while ((m = pushRegex.exec(body)) !== null) {
                try { assembled += JSON.parse(`"${m[1]}"`) } catch { assembled += m[1]! }
            }
            const imgRegex = /(https?:\/\/[^"'\s]+\/chapters\/[^"'\s]+\.(?:webp|jpe?g|png|avif))/gi
            let r: RegExpExecArray | null
            while ((r = imgRegex.exec(assembled)) !== null) {
                if (!seen.has(r[1]!)) { seen.add(r[1]!); pages.push(r[1]!) }
            }
            // also relative paths in the flight stream
            const relRegex = /(\/(?:api|storage)\/chapters\/[^"'\s]+\.(?:webp|jpe?g|png|avif))/gi
            while ((r = relRegex.exec(assembled)) !== null) {
                if (!seen.has(r[1]!)) {
                    seen.add(r[1]!)
                    pages.push(this.base_url + r[1]!)
                }
            }
        }

        return App.createChapterDetails({
            id: chapterId,
            mangaId,
            pages
        })
    }


    //////////////////////////////////////////
    /////    SEARCH RESULTS PROVIDING    /////
    //////////////////////////////////////////


    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1
        const search = query.title?.trim() ?? ''

        let url = `${this.base_url}/series?`
        if (search) url += `search=${encodeURIComponent(search)}&`
        url += `page=${page}`

        const request = App.createRequest({ url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 1)
        this.checkError(response.status)
        const $ = this.cheerio.load(response.data as string)

        const manga = this.parseMangaGrid($)
        const hasNext = manga.length > 0 && $('a:contains(Suivant)').length > 0

        return App.createPagedResults({
            results: manga,
            metadata: hasNext ? { page: page + 1 } : undefined
        })
    }

    parseMangaGrid($: CheerioAPI): PartialSourceManga[] {
        const items: PartialSourceManga[] = []
        const seen = new Set<string>()

        $('a[href*="/serie/"]').each((_: number, el: any) => {
            const href = $(el).attr('href') ?? ''
            // skip chapter links, keep series root links only
            if (/\/chapter\//.test(href)) return
            const slug = this.slugFromUrl(href)
            if (!slug || seen.has(slug)) return

            const title = $(el).find('h2, h3').first().text().trim()
                || $(el).attr('title')?.replace(/^Lire\s+/, '').replace(/\s+scan VF.*$/, '').trim()
                || $(el).find('img').attr('alt')?.trim()
                || ''
            if (!title) return

            seen.add(slug)
            items.push(App.createPartialSourceManga({
                image: this.coverUrl(slug),
                title,
                mangaId: slug
            }))
        })

        return items
    }


    /////////////////////////////////////////////
    /////    HOMEPAGE SECTIONS PROVIDING    /////
    /////////////////////////////////////////////


    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        // Latest (clean JSON API)
        const latestSection = App.createHomeSection({
            id: 'latest',
            title: 'Dernières Sorties',
            type: HomeSectionType.singleRowNormal,
            containsMoreItems: true
        })
        try {
            const req = App.createRequest({
                url: `${this.base_url}/api/manga/lastchapters?limit=16&page=1`,
                method: 'GET'
            })
            const res = await this.requestManager.schedule(req, 1)
            this.checkError(res.status)
            latestSection.items = this.parseLatestApi(res.data as string)
        } catch {
            latestSection.items = []
        }
        sectionCallback(latestSection)

        // Popular / Catalogue (scrape series page)
        const popularSection = App.createHomeSection({
            id: 'popular',
            title: 'Catalogue',
            type: HomeSectionType.singleRowNormal,
            containsMoreItems: true
        })
        try {
            const req = App.createRequest({ url: `${this.base_url}/series?page=1`, method: 'GET' })
            const res = await this.requestManager.schedule(req, 1)
            this.checkError(res.status)
            const $ = this.cheerio.load(res.data as string)
            popularSection.items = this.parseMangaGrid($).slice(0, 24)
        } catch {
            popularSection.items = []
        }
        sectionCallback(popularSection)
    }

    parseLatestApi(data: string): PartialSourceManga[] {
        const items: PartialSourceManga[] = []
        const seen = new Set<string>()
        try {
            const json = JSON.parse(data)
            const list = json?.data ?? []
            for (const m of list) {
                const slug = m.slug
                if (!slug || seen.has(slug)) continue
                seen.add(slug)
                items.push(App.createPartialSourceManga({
                    image: this.coverUrl(slug),
                    title: m.title ?? slug,
                    mangaId: slug
                }))
            }
        } catch {
            // ignore parse error
        }
        return items
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1

        if (homepageSectionId === 'latest') {
            const req = App.createRequest({
                url: `${this.base_url}/api/manga/lastchapters?limit=16&page=${page}`,
                method: 'GET'
            })
            const res = await this.requestManager.schedule(req, 1)
            this.checkError(res.status)
            const items = this.parseLatestApi(res.data as string)
            return App.createPagedResults({
                results: items,
                metadata: items.length === 16 ? { page: page + 1 } : undefined
            })
        }

        // popular
        const req = App.createRequest({ url: `${this.base_url}/series?page=${page}`, method: 'GET' })
        const res = await this.requestManager.schedule(req, 1)
        this.checkError(res.status)
        const $ = this.cheerio.load(res.data as string)
        const items = this.parseMangaGrid($)
        const hasNext = items.length > 0 && $('a:contains(Suivant)').length > 0
        return App.createPagedResults({
            results: items,
            metadata: hasNext ? { page: page + 1 } : undefined
        })
    }


    /////////////////////////////////////////////////
    /////    CLOUDFLARE BYPASS REQUEST PROVIDING   ///
    /////////////////////////////////////////////////

    // Poseidon only protects SPECIFIC routes with Cloudflare: /series, /serie/{slug}
    // and /serie/{slug}/chapter/{id}. The homepage (/) and the JSON API
    // (/api/manga/lastchapters) are NOT protected, which is why "latest releases"
    // loads fine. Reading chapters needs a Cloudflare-protected page, so we expose a
    // bypass request pointed at a protected route (/series). When the user hits a 403,
    // Paperback opens THIS url in its in-app WebView. Because /series is actually
    // behind the Cloudflare JS challenge, the WebView solves it and the resulting
    // cf_clearance cookie is injected into the request manager for every later request
    // (including chapter pages). Pointing at the unprotected homepage would solve no
    // challenge and leave chapter reading broken.
    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return await App.createRequest({
            url: `${this.base_url}/series`,
            method: 'GET'
        })
    }


    /////////////////////////////////
    /////    ERROR HANDLING    /////
    /////////////////////////////////


    checkError(status: any) {
        if (status == 403) {
            throw new Error("Contourner Cloudflare avant d'utiliser la source !")
        }
    }
}
