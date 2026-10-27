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
    TagSection,
    MangaProviding,
    ChapterProviding,
    SearchResultsProviding,
    HomePageSectionsProviding,
    HomeSectionType,
    CloudflareBypassRequestProviding
} from '@paperback/types'

import { CheerioAPI } from 'cheerio'


const DOMAIN: string = 'https://aniverse.fr'

const GENRES: string[] = [
    'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo',
    'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life',
    'Sports', 'Supernatural', 'Thriller'
]

export const AniverseInfo: SourceInfo = {
    version: "1.0",
    language: "FR",
    name: 'Aniverse',
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

export class Aniverse implements MangaProviding, ChapterProviding, SearchResultsProviding, HomePageSectionsProviding, CloudflareBypassRequestProviding {

    base_url: string = DOMAIN
    lang_code: string = AniverseInfo.language!

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
                        'referer': `${this.base_url}/`
                        // No custom user-agent: a cf_clearance cookie obtained in the
                        // WebView is bound to the WebView's own user-agent.
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


    async fetch(url: string): Promise<string> {
        const request = App.createRequest({ url, method: 'GET' })
        const response = await this.requestManager.schedule(request, 1)
        this.checkError(response.status, url)
        return response.data as string
    }

    async fetchJson(url: string): Promise<any> {
        const data = await this.fetch(url)
        try {
            return typeof data === 'string' ? JSON.parse(data) : data
        } catch {
            throw new Error(`[Aniverse] Réponse JSON invalide sur ${url}`)
        }
    }

    // Pages are Next.js App Router pages. The data we need lives in the React Server
    // Components "flight" payload, embedded in the HTML as self.__next_f.push([1,"..."]).
    // Reassemble it into the raw flight text (rows of the form `<hex id>:<json>\n`).
    flight(body: string): string {
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
        // Already a raw flight response (e.g. served with the RSC header)
        return assembled || body
    }

    // Read the balanced JSON value ({...} or [...]) starting at `start`.
    readJson(text: string, start: number): any {
        const open = text[start]
        const close = open === '{' ? '}' : open === '[' ? ']' : ''
        if (!close) return undefined
        let depth = 0
        let inString = false
        for (let i = start; i < text.length; i++) {
            const ch = text[i]
            if (inString) {
                if (ch === '\\') i++
                else if (ch === '"') inString = false
                continue
            }
            if (ch === '"') inString = true
            else if (ch === '{' || ch === '[') depth++
            else if (ch === '}' || ch === ']') {
                depth--
                if (depth === 0) {
                    try {
                        return JSON.parse(text.slice(start, i + 1))
                    } catch {
                        return undefined
                    }
                }
            }
        }
        return undefined
    }

    // Find the first JSON value following `"key":` that matches `accept`.
    findJson(text: string, key: string, accept: (value: any) => boolean): any {
        const needle = `"${key}":`
        let index = text.indexOf(needle)
        while (index !== -1) {
            const value = this.readJson(text, index + needle.length)
            if (value !== undefined && accept(value)) return value
            index = text.indexOf(needle, index + needle.length)
        }
        return undefined
    }

    // Values too big to inline are streamed as a separate row and referenced as "$@<id>".
    resolveRef(text: string, value: any): any {
        if (typeof value !== 'string' || !value.startsWith('$@')) return value
        const id = value.slice(2)
        const match = new RegExp(`(?:^|\\n)${id}:`).exec(text)
        if (!match) return undefined
        return this.readJson(text, match.index + match[0].length)
    }

    stripHtml(html: string): string {
        return this.cheerio.load(html.replace(/<br\s*\/?>/gi, '\n')).text().replace(/\n{3,}/g, '\n\n').trim()
    }

    parseStatus(status: string): string {
        switch ((status ?? '').trim().toUpperCase()) {
            case 'RELEASING':
            case 'ONGOING': return 'En cours'
            case 'FINISHED': return 'Terminé'
            case 'HIATUS':
            case 'ON HIATUS': return 'En pause'
            case 'CANCELLED': return 'Annulé'
            case 'NOT_YET_RELEASED':
            case 'UPCOMING': return 'À venir'
            default: return 'N/A'
        }
    }

    toPartialManga(items: any[]): PartialSourceManga[] {
        const results: PartialSourceManga[] = []
        const seen = new Set<string>()
        for (const item of items ?? []) {
            const slug = item?.slug
            if (!slug || seen.has(slug)) continue
            seen.add(slug)
            const latest = item.latestChapters?.[0]?.number
            results.push(App.createPartialSourceManga({
                mangaId: slug,
                title: item.title ?? item.titleEnglish ?? slug,
                image: item.image ?? '',
                subtitle: latest ? `Chapitre ${latest}` : undefined
            }))
        }
        return results
    }


    /////////////////////////////////
    /////    MANGA PROVIDING    /////
    /////////////////////////////////


    getMangaShareUrl(mangaId: string): string {
        return `${this.base_url}/manga/${mangaId}`
    }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const url = `${this.base_url}/manga/${mangaId}`
        const data = this.flight(await this.fetch(url))

        const manga = this.findJson(data, 'manga', v => v && typeof v === 'object' && v.slug === mangaId)
            ?? this.findJson(data, 'manga', v => v && typeof v === 'object' && v.title !== undefined)
        if (!manga) {
            throw new Error(`[Aniverse] Impossible de lire la fiche de ${mangaId}`)
        }

        const t = manga.title
        const titles: string[] = []
        if (typeof t === 'string') titles.push(t)
        else if (t) {
            for (const v of [t.userPreferred, t.english, t.romaji, t.native]) {
                if (v && !titles.includes(v)) titles.push(v)
            }
        }
        if (titles.length === 0) titles.push(mangaId)

        const image = manga.coverImage?.large ?? manga.coverImage?.extraLarge ?? manga.image ?? ''
        const genres: string[] = manga.genres ?? []

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({
                titles,
                image,
                author: (manga.authors ?? []).join(', ') || 'N/A',
                artist: (manga.artists ?? []).join(', ') || 'N/A',
                desc: this.stripHtml(manga.description ?? ''),
                status: this.parseStatus(manga.status),
                hentai: manga.isAdult === true,
                tags: [App.createTagSection({
                    id: '0',
                    label: 'genres',
                    tags: genres.map(g => App.createTag({ id: g, label: g }))
                })]
            })
        })
    }


    ///////////////////////////////////
    /////    CHAPTER PROVIDING    /////
    ///////////////////////////////////


    async getChapters(mangaId: string): Promise<Chapter[]> {
        const url = `${this.base_url}/manga/${mangaId}`
        const data = this.flight(await this.fetch(url))

        // The manga page props hold "chapters":"$@<row>" pointing at the full list.
        // Other "chapters" keys exist (counts, recommendations), so accept only a
        // reference or an array of chapter objects.
        let list: any = undefined
        const refMatch = /"chapters":"(\$@[0-9a-f]+)"/.exec(data)
        if (refMatch) list = this.resolveRef(data, refMatch[1])
        if (!Array.isArray(list)) {
            list = this.findJson(data, 'chapters', v => Array.isArray(v) && v.length > 0 && v[0]?.number !== undefined && v[0]?.id !== undefined)
        }
        if (!Array.isArray(list) || list.length === 0) {
            throw new Error(`[Aniverse] Aucun chapitre trouvé pour ${mangaId}`)
        }

        const chapters: Chapter[] = []
        const seen = new Set<string>()
        for (const ch of list) {
            if (!ch?.id || seen.has(ch.id)) continue
            seen.add(ch.id)

            const num = Number(ch.number)
            const title = (ch.title ?? '').trim()
            const premium = ch.premiumUntil && new Date(ch.premiumUntil).getTime() > Date.now()
            const date = new Date(ch.updatedAt ?? ch.createdAt ?? '')

            chapters.push(App.createChapter({
                id: ch.id,
                name: (premium ? '🔒 ' : '') + (title ? `Chapitre ${ch.number} - ${title}` : `Chapitre ${ch.number}`),
                langCode: this.lang_code,
                chapNum: isNaN(num) ? 0 : num,
                volume: ch.volume ? Number(ch.volume) || undefined : undefined,
                time: isNaN(date.getTime()) ? new Date() : date
            }))
        }

        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const url = `${this.base_url}/read/${mangaId}/${chapterId}`
        const data = this.flight(await this.fetch(url))

        let list: any = this.findJson(data, 'pages', v => Array.isArray(v) && v.length > 0 && v[0]?.src !== undefined)
        if (!Array.isArray(list)) list = this.resolveRef(data, /"pages":"(\$@[0-9a-f]+)"/.exec(data)?.[1])

        const pages: string[] = Array.isArray(list)
            ? list.map((p: any) => p?.src).filter((src: any) => typeof src === 'string' && src.length > 0)
            : []

        if (pages.length === 0) {
            throw new Error(`[Aniverse] Aucune page trouvée pour ce chapitre (peut-être premium ?)`)
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


    async getSearchTags(): Promise<TagSection[]> {
        return [App.createTagSection({
            id: '0',
            label: 'Genres',
            tags: GENRES.map(g => App.createTag({ id: g, label: g }))
        })]
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1
        const search = query.title?.trim() ?? ''
        const genres = (query.includedTags ?? []).map(t => t.id)

        const params = [`media=manga`, `sort=popularity`, `page=${page}`, `pageSize=40`]
        if (search) params.push(`q=${encodeURIComponent(search)}`)
        for (const g of genres) params.push(`genres=${encodeURIComponent(g)}`)

        const json = await this.fetchJson(`${this.base_url}/api/anime/search?${params.join('&')}`)
        const results = this.toPartialManga(json?.data ?? [])
        const hasNext = json?.page * json?.pageSize < json?.total

        return App.createPagedResults({
            results,
            metadata: hasNext ? { page: page + 1 } : undefined
        })
    }


    /////////////////////////////////////////////
    /////    HOMEPAGE SECTIONS PROVIDING    /////
    /////////////////////////////////////////////


    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const sections = [
            App.createHomeSection({ id: 'latest', title: 'Sorties récentes', type: HomeSectionType.singleRowNormal, containsMoreItems: true }),
            App.createHomeSection({ id: 'popular', title: 'Populaires', type: HomeSectionType.singleRowNormal, containsMoreItems: true }),
            App.createHomeSection({ id: 'newest', title: 'Nouveautés', type: HomeSectionType.singleRowNormal, containsMoreItems: true })
        ]

        const promises: Promise<void>[] = []
        for (const section of sections) {
            sectionCallback(section)
            promises.push(this.getViewMoreItems(section.id, { page: 1 }).then(res => {
                section.items = res.results
                sectionCallback(section)
            }).catch(() => {
                section.items = []
                sectionCallback(section)
            }))
        }
        await Promise.all(promises)
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const page: number = metadata?.page ?? 1

        if (homepageSectionId === 'latest') {
            const json = await this.fetchJson(`${this.base_url}/api/manga?page=${page}`)
            return App.createPagedResults({
                results: this.toPartialManga(json?.items ?? []),
                metadata: json?.hasNextPage ? { page: page + 1 } : undefined
            })
        }

        const sort = homepageSectionId === 'newest' ? 'newest' : 'popularity'
        const json = await this.fetchJson(`${this.base_url}/api/anime/search?media=manga&sort=${sort}&page=${page}&pageSize=40`)
        const hasNext = json?.page * json?.pageSize < json?.total
        return App.createPagedResults({
            results: this.toPartialManga(json?.data ?? []),
            metadata: hasNext ? { page: page + 1 } : undefined
        })
    }


    /////////////////////////////////////////////////
    /////    CLOUDFLARE BYPASS REQUEST PROVIDING   ///
    /////////////////////////////////////////////////


    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({
            url: `${this.base_url}/manga`,
            method: 'GET'
        })
    }


    /////////////////////////////////
    /////    ERROR HANDLING    /////
    /////////////////////////////////


    checkError(status: any, url?: string) {
        if (status == 403 || status == 503) {
            throw new Error(`[Aniverse] ${status} sur ${url ?? '(url?)'} — ouvre la source dans la WebView pour passer Cloudflare`)
        }
        if (status && status >= 400) {
            throw new Error(`[Aniverse] HTTP ${status} sur ${url ?? '(url?)'}`)
        }
    }
}
