// server.js - Stremio Addon for Jackett Integration with advanced features and Worker Threads

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { performance } = require('perf_hooks');
const { Worker } = require('worker_threads');
require('dotenv').config();

// --- Configuration (Set these as environment variables or update directly) ---
const JACKETT_HOST = process.env.JACKETT_HOST || 'http://localhost:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || 'YOUR_JACKETT_API_KEY_HERE';
const OMDb_API_KEY = process.env.OMDB_API_KEY || 'YOUR_OMDB_API_KEY_HERE';
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'YOUR_TMDB_API_KEY_HERE';

const TRACKERS_URL = process.env.TRACKERS_URL || 'https://raw.githubusercontent.com/ngosang/trackerslist/refs/heads/master/trackers_best.txt';
const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || '20000', 10);
const MINIMUM_SEEDERS = parseInt(process.env.MINIMUM_SEEDERS || '0', 10);

// --- Filtering and Sorting Configuration ---
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '20', 10);
const MIN_TORRENT_SIZE_MB = parseInt(process.env.MIN_TORRENT_SIZE_MB || '10', 10);
const MAX_TORRENT_SIZE_MB = parseInt(process.env.MAX_TORRENT_SIZE_MB || '8048', 10); // Matches .env.sample example

// Limit for initial date-based filtering, applied directly in Jackett API query
const INITIAL_DATE_FILTER_LIMIT = parseInt(process.env.INITIAL_DATE_FILTER_LIMIT || '100', 10);

const PREFERRED_LANGUAGES = (process.env.PREFERRED_LANGUAGES || '').toLowerCase().split(',').map(lang => lang.trim()).filter(lang => lang.length > 0);

const PREFERRED_VIDEO_QUALITIES_CONFIG = (process.env.PREFERRED_VIDEO_QUALITIES || 'remux,bluray,bdrip,web-dl,webrip,hdrip,hdtv,dvdrip,x265,x264,hevc,xvid,av1').toLowerCase().split(',').map(q => q.trim());
const PREFERRED_AUDIO_QUALITIES_CONFIG = (process.env.PREFERRED_AUDIO_QUALITIES || 'truehd,dts-hd,atmos,dts,eac3,ddp,ac3,aac,mp3').toLowerCase().split(',').map(q => q.trim());

// --- Global Cache for Public Trackers ---
let publicTrackers = [];

/**
 * Fetches and caches a list of public BitTorrent trackers.
 */
async function fetchAndCacheTrackers() {
    console.log('[INFO] [TRACKERS CACHE] Fetching public trackers from URL:', TRACKERS_URL);
    try {
        const response = await fetch(TRACKERS_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch trackers: ${response.statusText}`);
        }
        const text = await response.text();
        publicTrackers = text.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'));
        console.log(`[INFO] [TRACKERS CACHE] Successfully fetched and cached ${publicTrackers.length} public trackers.`);
    } catch (error) {
        console.error('[ERROR] [TRACKERS CACHE] Failed to fetch public trackers:', error.message);
        publicTrackers = [];
    }
}

// --- Helper Functions for API Interactions ---

/**
 * Fetches movie/series metadata from OMDb API using IMDb ID.
 */
async function getOmdbMetadata(imdbId) {
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDb_API_KEY}&i=${imdbId}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`OMDb API HTTP error: ${response.statusText}`);
        const data = await response.json();
        if (data.Response === 'False') throw new Error(`OMDb API responded with error: ${data.Error}`);
        const yearMatch = data.Year ? data.Year.match(/\d{4}/) : null;
        return { title: data.Title, year: yearMatch ? parseInt(yearMatch[0], 10) : null, type: data.Type === 'movie' ? 'movie' : 'series' };
    } catch (error) {
        console.warn(`[WARN] OMDb metadata fetch failed for ${imdbId}:`, error.message);
        return null;
    }
}

/**
 * Fetches movie/series metadata from TMDB API using IMDb ID.
 */
async function getTmdbMetadata(imdbId, itemType) {
    let mediaType = itemType === 'movie' ? 'movie' : 'tv';
    try {
        const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&language=en-US&external_source=imdb_id`;
        const findResponse = await fetch(findUrl);
        if (!findResponse.ok) throw new Error(`TMDB Find API HTTP error: ${findResponse.statusText}`);
        const findData = await findResponse.json();

        let tmdbId = null;
        if (mediaType === 'movie' && findData.movie_results && findData.movie_results.length > 0) tmdbId = findData.movie_results[0].id;
        else if (mediaType === 'tv' && findData.tv_results && findData.tv_results.length > 0) tmdbId = findData.tv_results[0].id;
        if (!tmdbId) throw new Error('TMDB ID not found for IMDb ID');

        const detailsUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const detailsResponse = await fetch(detailsUrl);
        if (!detailsResponse.ok) throw new Error(`TMDB Details API HTTP error: ${detailsResponse.statusText}`);
        const detailsData = await detailsResponse.json();

        const year = detailsData.release_date ? parseInt(detailsData.release_date.substring(0, 4), 10) :
                     (detailsData.first_air_date ? parseInt(detailsData.first_air_date.substring(0, 4), 10) : null);
        return { title: detailsData.title || detailsData.name, year: year, type: mediaType === 'movie' ? 'movie' : 'series' };
    } catch (error) {
        console.warn(`[WARN] TMDB metadata fetch failed for ${imdbId} (type:${itemType}):`, error.message);
        return null;
    }
}

/**
 * Performs a search on Jackett's Torznab API, including sorting and limiting.
 */
async function jackettSearch(query, imdbId, itemType, season, episode) {
    let url = `${JACKETT_HOST}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&Query=${encodeURIComponent(query)}`;
    if (imdbId) url += `&imdbid=${imdbId}`;
    if (itemType === 'series' && season && episode) url += `&season=${season}&ep=${episode}`;

    // Add sort by posted date (descending) and limit the results directly from Jackett
    url += `&sort=posted_desc`; // 'posted' is the Torznab equivalent for pubDate
    url += `&limit=${INITIAL_DATE_FILTER_LIMIT}`; // Limit results fetched from Jackett

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Jackett API HTTP error: ${response.statusText}`);
        const data = await response.json();
        return data.Results || [];
    } catch (error) {
        console.error(`[ERROR] Jackett search failed for "${query}" (IMDb: ${imdbId}):`, error.message);
        return [];
    }
}

// --- Worker Thread Processing Function ---
/**
 * Processes Jackett results in a worker thread.
 */
function processTorrentsInWorker(jackettResults, metadata, season, episode, config, publicTrackers) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./torrentProcessorWorker.js');

        worker.on('message', (message) => {
            if (message.error) {
                reject(new Error(`Worker Error: ${message.error}\nStack: ${message.stack}`));
            } else {
                resolve(message);
            }
            worker.terminate();
        });

        worker.on('error', (err) => {
            console.error('[ERROR] Worker thread encountered an unhandled error:', err);
            reject(err);
            worker.terminate();
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`[ERROR] Worker thread exited unexpectedly with code ${code}. Check torrentProcessorWorker.js for unhandled exceptions.`);
                reject(new Error(`Worker thread exited unexpectedly with code ${code}`));
            }
        });

        worker.postMessage({
            jackettResults,
            metadata,
            season,
            episode,
            config: {
                MINIMUM_SEEDERS: config.MINIMUM_SEEDERS,
                MIN_TORRENT_SIZE_MB: config.MIN_TORRENT_SIZE_MB,
                MAX_TORRENT_SIZE_MB: config.MAX_TORRENT_SIZE_MB,
                PREFERRED_LANGUAGES: config.PREFERRED_LANGUAGES,
                PREFERRED_VIDEO_QUALITIES_CONFIG: config.PREFERRED_VIDEO_QUALITIES_CONFIG,
                PREFERRED_AUDIO_QUALITIES_CONFIG: config.PREFERRED_AUDIO_QUALITIES_CONFIG,
            },
            publicTrackers: publicTrackers
        });
    });
}

// --- Stremio Addon Setup ---
const builder = new addonBuilder({
    id: 'org.jackett.stremio.addon',
    version: '1.7.1', // Updated version for direct API sorting and limiting, enhanced worker robustness
    name: 'Jackett Stream Provider',
    description: 'Provides P2P streams sourced from Jackett with advanced filtering, validation, and quality sorting, optimized with Worker Threads.',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    icon: 'https://cdn.iconscout.com/icon/free/png-256/jackett-3027871-2522777.png',
    background: 'https://www.wallpaperflare.com/static/863/826/360/film-clapper-black-background-clapperboard-wallpaper.jpg',
    idPrefixes: ['tt']
});

// Define the stream handler
builder.defineStreamHandler(async (args) => {
    const totalStartTime = performance.now();

    const imdbId = args.id.split(':')[0];
    const itemType = args.type;

    let season, episode;
    if (itemType === 'series') {
        const parts = args.id.split(':');
        if (parts.length === 3) {
            season = parseInt(parts[1].substring(1), 10);
            episode = parseInt(parts[2].substring(1), 10);
        }
    }

    console.log(`[INFO] Stream requested: Type=${itemType}, ID=${args.id}`);
    console.log(`[CONFIG] Filters: Min Seeders=${MINIMUM_SEEDERS}, Min Size=${MIN_TORRENT_SIZE_MB}MB, Max Size=${MAX_TORRENT_SIZE_MB}MB, Preferred Languages=[${PREFERRED_LANGUAGES.join(', ')}]`);
    console.log(`[CONFIG] Quality Prefs: Video=[${PREFERRED_VIDEO_QUALITIES_CONFIG.join(', ')}], Audio=[${PREFERRED_AUDIO_QUALITIES_CONFIG.join(', ')}]`);
    console.log(`[CONFIG] Initial Date Filter Limit (via Jackett API): ${INITIAL_DATE_FILTER_LIMIT}`);

    try {
        const metadataStartTime = performance.now();
        const [omdbResult, tmdbResult] = await Promise.allSettled([
            getOmdbMetadata(imdbId),
            getTmdbMetadata(imdbId, itemType)
        ]);
        const metadataEndTime = performance.now();
        console.log(`[INFO] Metadata fetch time: ${((metadataEndTime - metadataStartTime) / 1000).toFixed(2)} seconds.`);

        let metadata = null;
        let searchQueryTitle = imdbId;
        let determinedType = itemType;

        if (omdbResult.status === 'fulfilled' && omdbResult.value) {
            metadata = omdbResult.value;
            searchQueryTitle = metadata.title;
            determinedType = metadata.type;
            console.log(`[INFO] Metadata from OMDb: Title="${metadata.title}", Year="${metadata.year}", Type="${metadata.type}"`);
        } else if (tmdbResult.status === 'fulfilled' && tmdbResult.value) {
            metadata = tmdbResult.value;
            searchQueryTitle = metadata.title;
            determinedType = metadata.type;
            console.log(`[INFO] Metadata from TMDB: Title="${metadata.title}", Year="${metadata.year}", Type="${metadata.type}"`);
        } else {
            console.warn(`[WARN] Could not retrieve metadata for ${imdbId} from OMDb or TMDB. Proceeding with IMDb ID as fallback.`);
            metadata = { title: imdbId, year: null, type: itemType };
        }

        let jackettQuery = searchQueryTitle;
        if (determinedType === 'movie' && metadata.year) {
            jackettQuery = `${searchQueryTitle} ${metadata.year}`;
        } else if (determinedType === 'series' && season && episode) {
            jackettQuery = `${searchQueryTitle} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        }

        const jackettSearchStartTime = performance.now();
        console.log(`[INFO] Searching Jackett for: "${jackettQuery}" (IMDb: ${imdbId}) with sort=posted_desc and limit=${INITIAL_DATE_FILTER_LIMIT}`);
        const jackettResults = await jackettSearch(jackettQuery, imdbId, determinedType, season, episode);
        const jackettSearchEndTime = performance.now();
        console.log(`[INFO] Jackett search returned ${jackettResults.length} raw results in ${((jackettSearchEndTime - jackettSearchStartTime) / 1000).toFixed(2)} seconds.`);

        // --- Offload heavy processing (filtering and parsing) to Worker Thread ---
        const workerProcessingStartTime = performance.now();
        console.log('[INFO] Offloading torrent processing (filtering, parsing) to worker thread...');
        // Worker now receives results that are already date-sorted and limited by Jackett API
        const processedStreams = await processTorrentsInWorker(
            jackettResults,
            metadata,
            season,
            episode,
            {
                MINIMUM_SEEDERS,
                MIN_TORRENT_SIZE_MB,
                MAX_TORRENT_SIZE_MB,
                PREFERRED_LANGUAGES,
                PREFERRED_VIDEO_QUALITIES_CONFIG,
                PREFERRED_AUDIO_QUALITIES_CONFIG,
            },
            publicTrackers
        );
        const workerProcessingEndTime = performance.now();
        console.log(`[INFO] Worker processing completed. Time: ${((workerProcessingEndTime - workerProcessingStartTime) / 1000).toFixed(2)} seconds.`);
        console.log(`[INFO] Worker returned ${processedStreams.length} filtered and parsed streams to main thread.`);

        // --- Stage 3: Apply full multi-criteria sort in main thread ---
        // Results from worker are already largely date-sorted (from Jackett API)
        const candidatesForFinalSort = processedStreams;

        const finalSortStartTime = performance.now();
        candidatesForFinalSort.sort((a, b) => {
            // 1. Seeders (descending) - Highest priority
            if (b.originalResult.Seeders !== a.originalResult.Seeders) {
                return b.originalResult.Seeders - a.originalResult.Seeders;
            }

            // 2. PublishedDate (descending) - Second highest priority
            // Use effectivePublishedDate from worker, which is either valid or null
            const dateA = a.effectivePublishedDate ? new Date(a.effectivePublishedDate).getTime() : 0; // Use 0 for invalid/null dates to push them to bottom
            const dateB = b.effectivePublishedDate ? new Date(b.effectivePublishedDate).getTime() : 0;

            if (dateB !== dateA) {
                return dateB - dateA;
            }
            
            // If seeders and dates are the same (or invalid/equal), then apply quality sorting
            // 3. Preferred Language (prioritize preferred, then original order)
            if (a.hasPreferredLanguage && !b.hasPreferredLanguage) return -1;
            if (!a.hasPreferredLanguage && b.hasPreferredLanguage) return 1;

            // 4. Resolution (descending)
            if (a.resolutionRank !== b.resolutionRank) {
                return b.resolutionRank - a.resolutionRank;
            }

            // 5. Video Quality (descending)
            if (a.videoQualityRank !== b.videoQualityRank) {
                return b.videoQualityRank - a.videoQualityRank;
            }

            // 6. Audio Quality (descending)
            if (a.audioQualityRank !== b.audioQualityRank) {
                return b.audioQualityRank - a.audioQualityRank;
            }

            return 0; // If all criteria are equal, maintain original relative order
        });
        const finalSortEndTime = performance.now();
        console.log(`[INFO] Main thread final sorting time: ${((finalSortEndTime - finalSortStartTime) / 1000).toFixed(2)} seconds.`);

        // --- Stage 4: Format for Stremio and apply final MAX_STREAMS limit ---
        const stremioStreams = [];
        for (let i = 0; i < Math.min(candidatesForFinalSort.length, MAX_STREAMS); i++) {
            const stream = candidatesForFinalSort[i];
            const result = stream.originalResult;
            const torrentSizeMB = (result.Size / (1024 * 1024)).toFixed(2);

            // Construct title for Stremio, including parsed details
            let titleParts = [result.Title];
            if (stream.parsedDetails.resolution) titleParts.push(stream.parsedDetails.resolution.toUpperCase());
            if (stream.parsedDetails.videoQuality) titleParts.push(stream.parsedDetails.videoQuality.toUpperCase());
            if (stream.parsedDetails.audioQuality) titleParts.push(stream.parsedDetails.audioQuality.toUpperCase());
            if (stream.parsedDetails.language) titleParts.push(stream.parsedDetails.language.charAt(0).toUpperCase() + stream.parsedDetails.language.slice(1));
            titleParts.push(`S:${result.Seeders}`, `L:${result.Peers}`, `Size:${torrentSizeMB}MB`);

            // Construct sources array with individual trackers and DHT node, as per Stremio documentation
            const streamSources = publicTrackers.map(trackerUrl => `tracker:${trackerUrl}`);
            streamSources.push(`dht:${stream.infoHash}`);

            stremioStreams.push({
                name: `Jackett | ${result.Tracker}`,
                title: titleParts.join(' | '),
                infoHash: stream.infoHash,
                sources: streamSources, // Only individual trackers and DHT as sources
            });
        }

        console.log(`[INFO] [STREMIO RESPONSE] Sending ${stremioStreams.length} streams to Stremio for ID: ${args.id}`);

        const totalEndTime = performance.now();
        console.log(`[INFO] Total processing time for ${args.id}: ${((totalEndTime - totalStartTime) / 1000).toFixed(2)} seconds.`);

        return { streams: stremioStreams };

    } catch (error) {
        console.error(`[ERROR] Stream processing failed for ID ${args.id}:`, error.message);
        console.warn(`[WARN] Stream processing for ID ${args.id} failed. Returning empty streams.`);
        return { streams: [] };
    }
});

// --- Initialize and Start the Addon Server ---
console.log('[INFO] [SERVER STARTUP] Pre-fetching public trackers to warm cache...');
fetchAndCacheTrackers().then(() => {
    console.log('[INFO] [SERVER STARTUP] Public tracker pre-fetch complete.');
});

serveHTTP(builder.getInterface(), { port: 7000 });

console.log('[INFO] Logging Level: info');
console.log(`[INFO] Addon is listening on http://127.0.0.1:7000/manifest.json (default port)`);
