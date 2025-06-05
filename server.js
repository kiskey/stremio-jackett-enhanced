// server.js - Stremio Addon for Jackett Integration with advanced features

const { addonBuilder, get, serveHTTP } = require('stremio-addon-sdk');
const { performance } = require('perf_hooks');
require('dotenv').config(); // Load environment variables from .env file

// --- Configuration (Set these as environment variables or update directly) ---
const JACKETT_HOST = process.env.JACKETT_HOST || 'http://localhost:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || 'YOUR_JACKETT_API_KEY_HERE'; // !!! IMPORTANT: Replace with your actual Jackett API Key !!!
const OMDb_API_KEY = process.env.OMDB_API_KEY || 'YOUR_OMDB_API_KEY_HERE';     // !!! IMPORTANT: Replace with your actual OMDb API Key !!!
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'YOUR_TMDB_API_KEY_HERE';     // !!! IMPORTANT: Replace with your actual TMDB API Key !!!

const TRACKERS_URL = process.env.TRACKERS_URL || 'https://raw.githubusercontent.com/ngosang/trackerslist/refs/heads/master/trackers_best.txt';
const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || '20000', 10);
const MINIMUM_SEEDERS = parseInt(process.env.MINIMUM_SEEDERS || '0', 10);

// --- Filtering and Sorting Configuration ---
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '20', 10);
const MIN_TORRENT_SIZE_MB = parseInt(process.env.MIN_TORRENT_SIZE_MB || '10', 10);
const MAX_TORRENT_SIZE_MB = parseInt(process.env.MAX_TORRENT_SIZE_MB || '4096', 10); // e.g., 4GB

// Preferred languages for filtering/sorting (comma-separated string from ENV, then lowercased array)
const PREFERRED_LANGUAGES = (process.env.PREFERRED_LANGUAGES || '').toLowerCase().split(',').map(lang => lang.trim()).filter(lang => lang.length > 0);

// New: Preferred video qualities for sorting (from best to worst, higher index = lower preference)
const PREFERRED_VIDEO_QUALITIES_CONFIG = (process.env.PREFERRED_VIDEO_QUALITIES || 'remux,bluray,web-dl,webrip,hdrip,hdtv,dvdrip').toLowerCase().split(',').map(q => q.trim());
// New: Preferred audio qualities for sorting (from best to worst, higher index = lower preference)
const PREFERRED_AUDIO_QUALITIES_CONFIG = (process.env.PREFERRED_AUDIO_QUALITIES || 'truehd,dts-hd,atmos,dts,ac3,aac,mp3').toLowerCase().split(',').map(q => q.trim());

const SORT_BY = process.env.SORT_BY || 'recent'; // Default to 'recent' for initial sort
const SORT_ORDER = process.env.SORT_ORDER || 'desc'; // Default to 'desc'

// --- Global Cache for Public Trackers ---
let publicTrackers = [];

/**
 * Fetches and caches a list of public BitTorrent trackers.
 * This function runs once on server startup to warm the cache.
 */
async function fetchAndCacheTrackers() {
    console.log('[INFO] [TRACKERS CACHE] Fetching public trackers from URL:', TRACKERS_URL);
    try {
        const response = await fetch(TRACKERS_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch trackers: ${response.statusText}`);
        }
        const text = await response.text();
        // Split by newline, trim whitespace, and filter out empty lines or comment lines
        publicTrackers = text.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'));
        console.log(`[INFO] [TRACKERS CACHE] Successfully fetched and cached ${publicTrackers.length} public trackers.`);
    } catch (error) {
        console.error('[ERROR] [TRACKERS CACHE] Failed to fetch public trackers:', error.message);
        publicTrackers = []; // Ensure it's empty on failure to prevent issues
    }
}

// --- Helper Functions for API Interactions ---

/**
 * Fetches movie/series metadata from OMDb API using IMDb ID.
 * @param {string} imdbId - The IMDb ID (e.g., 'tt1234567').
 * @returns {Promise<{title: string, year: number, type: string}|null>} - Metadata object or null on failure.
 */
async function getOmdbMetadata(imdbId) {
    try {
        const url = `http://www.omdbapi.com/?apikey=${OMDb_API_KEY}&i=${imdbId}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`OMDb API HTTP error: ${response.statusText}`);
        }
        const data = await response.json();
        if (data.Response === 'False') {
            throw new Error(`OMDb API responded with error: ${data.Error}`);
        }

        const yearMatch = data.Year ? data.Year.match(/\d{4}/) : null;
        return {
            title: data.Title,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            type: data.Type === 'movie' ? 'movie' : 'series' // Normalize type for consistency
        };
    } catch (error) {
        console.warn(`[WARN] OMDb metadata fetch failed for ${imdbId}:`, error.message);
        return null;
    }
}

/**
 * Fetches movie/series metadata from TMDB API using IMDb ID.
 * TMDB requires a two-step process: find TMDB ID by IMDb ID, then get details.
 * @param {string} imdbId - The IMDb ID (e.g., 'tt1234567').
 * @param {string} itemType - 'movie' or 'series' to guide the TMDB search.
 * @returns {Promise<{title: string, year: number, type: string}|null>} - Metadata object or null on failure.
 */
async function getTmdbMetadata(imdbId, itemType) {
    let mediaType = itemType === 'movie' ? 'movie' : 'tv'; // TMDB uses 'tv' for series
    try {
        // Step 1: Find the TMDB ID using the IMDb ID
        const findUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&language=en-US&external_source=imdb_id`;
        const findResponse = await fetch(findUrl);
        if (!findResponse.ok) {
            throw new Error(`TMDB Find API HTTP error: ${findResponse.statusText}`);
        }
        const findData = await findResponse.json();

        let tmdbId = null;
        if (mediaType === 'movie' && findData.movie_results && findData.movie_results.length > 0) {
            tmdbId = findData.movie_results[0].id;
        } else if (mediaType === 'tv' && findData.tv_results && findData.tv_results.length > 0) {
            tmdbId = findData.tv_results[0].id;
        }

        if (!tmdbId) {
            throw new Error('TMDB ID not found for IMDb ID');
        }

        // Step 2: Get details using the TMDB ID
        const detailsUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const detailsResponse = await fetch(detailsUrl);
        if (!detailsResponse.ok) {
            throw new Error(`TMDB Details API HTTP error: ${detailsResponse.statusText}`);
        }
        const detailsData = await detailsResponse.json();

        const year = detailsData.release_date ? parseInt(detailsData.release_date.substring(0, 4), 10) :
                     (detailsData.first_air_date ? parseInt(detailsData.first_air_date.substring(0, 4), 10) : null);

        return {
            title: detailsData.title || detailsData.name, // 'title' for movies, 'name' for TV
            year: year,
            type: mediaType === 'movie' ? 'movie' : 'series' // Normalize type to 'movie' or 'series'
        };
    } catch (error) {
        console.warn(`[WARN] TMDB metadata fetch failed for ${imdbId} (type:${itemType}):`, error.message);
        return null;
    }
}

/**
 * Performs a search on Jackett's Torznab API.
 * @param {string} query - The main search query (e.g., movie title, series title S01E01).
 * @param {string} imdbId - The IMDb ID for more specific results.
 * @param {string} itemType - 'movie' or 'series'.
 * @param {number} [season] - Season number for series.
 * @param {number} [episode] - Episode number for series.
 * @returns {Promise<Array<Object>>} - Array of Jackett search results.
 */
async function jackettSearch(query, imdbId, itemType, season, episode) {
    let url = `${JACKETT_HOST}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&Query=${encodeURIComponent(query)}`;

    // Add IMDb ID for better search accuracy
    if (imdbId) {
        url += `&imdbid=${imdbId}`;
    }

    // Add season and episode parameters for series
    if (itemType === 'series' && season && episode) {
        url += `&season=${season}&ep=${episode}`;
    }

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Jackett API HTTP error: ${response.statusText}`);
        }
        const data = await response.json();
        return data.Results || [];
    } catch (error) {
        console.error(`[ERROR] Jackett search failed for "${query}" (IMDb: ${imdbId}):`, error.message);
        return [];
    }
}

/**
 * Constructs a magnet link with the given info hash and a list of trackers.
 * @param {string} infoHash - The BitTorrent info hash.
 * @param {string[]} trackers - An array of tracker URLs.
 * @returns {string} - The complete magnet link.
 */
function buildMagnetLink(infoHash, trackers) {
    const trackerParams = trackers.map(t => `tr=${encodeURIComponent(t)}`).join('&');
    return `magnet:?xt=urn:btih:${infoHash}&${trackerParams}`;
}

// --- Utility Functions for Validation, Parsing, and Filtering ---

/**
 * Sanitizes and standardizes a title for robust comparison.
 * Converts to lowercase, removes special characters, replaces separators, and normalizes common tags.
 * Also attempts to extract a year from the title.
 * @param {string} title - The title string to standardize.
 * @returns {{standardizedTitle: string, extractedYear: number|null}} - The standardized title and any extracted year.
 */
function standardizeTitle(title) {
    let extractedYear = null;

    // Try to extract year first, as it might be in brackets/parentheses
    const yearMatch = title.match(/[\(\[](\d{4})[\)\]]/);
    if (yearMatch) {
        extractedYear = parseInt(yearMatch[1], 10);
        // Remove the year part for further standardization
        title = title.replace(yearMatch[0], '').trim();
    } else {
        // Try simple 4-digit year at the end
        const simpleYearMatch = title.match(/\s(\d{4})$/);
        if (simpleYearMatch) {
            extractedYear = parseInt(simpleYearMatch[1], 10);
            title = title.replace(simpleYearMatch[0], '').trim();
        }
    }

    // Convert to lowercase
    let standardized = title.toLowerCase();

    // Remove common special characters, punctuation, and symbols
    standardized = standardized.replace(/[.,/#!$%^&*;:{}=\-_`~()\[\]]/g, ' ');

    // Replace multiple spaces with a single space and trim
    standardized = standardized.replace(/\s+/g, ' ').trim();

    // Remove common release group tags and other extraneous info that might confuse validation
    standardized = standardized.replace(/(hdrip|webrip|web-dl|x264|x265|h264|h265|aac|ac3|dts|bluray|dvdrip|brrip|bdrip|repack|proper|internal|ita|eng|dubbed|subbed|multi|german|french|spanish|hindi|tamil|korean|japanese|chinese|kannada|malayalam|720p|1080p|2160p|4k|uhd|fhd|mp4|mkv|avi|xvid|hevc|remux|extended|director's cut|uncut|unrated|s\d{2}e\d{2}|s\d{2}|e\d{2})\b/g, ' ');

    // Again, replace multiple spaces with a single space and trim
    standardized = standardized.replace(/\s+/g, ' ').trim();

    return { standardizedTitle: standardized, extractedYear: extractedYear };
}

/**
 * Validates if a torrent title matches the expected movie/series title and year/season/episode.
 * @param {Object} metadata - The metadata object ({ title, year, type }).
 * @param {number} [season] - Season number for series.
 * @param {number} [episode] - Episode number for series.
 * @param {string} torrentTitle - The original torrent title from Jackett.
 * @returns {boolean} - True if validated, false otherwise.
 */
function validateTorrentTitle(metadata, season, episode, torrentTitle) {
    if (!metadata || !metadata.title) {
        console.warn(`[WARN] Cannot validate torrent "${torrentTitle}": Missing metadata.`);
        return false;
    }

    const { standardizedTitle: expectedStandardizedTitle, extractedYear: expectedYear } = standardizeTitle(metadata.title);
    const { standardizedTitle: torrentStandardizedTitle, extractedYear: torrentExtractedYear } = standardizeTitle(torrentTitle);

    // Basic check: torrent title must contain the expected title after standardization
    if (!torrentStandardizedTitle.includes(expectedStandardizedTitle)) {
        console.log(`[VALIDATION FAILED] Title mismatch: Expected="${expectedStandardizedTitle}", Got="${torrentStandardizedTitle}" (Original: "${torrentTitle}")`);
        return false;
    }

    if (metadata.type === 'movie') {
        // For movies, validate year if both expected and torrent year are present and don't match
        if (expectedYear && torrentExtractedYear && expectedYear !== torrentExtractedYear) {
            console.log(`[VALIDATION FAILED] Year mismatch (Movie): Expected=${expectedYear}, Got=${torrentExtractedYear} (Original: "${torrentTitle}")`);
            return false;
        }
    } else if (metadata.type === 'series') {
        // For series, ensure season and episode identifiers are present
        if (season && episode) {
            const seasonEpisodeIdentifier = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
            // Use includes to allow for variations like 'S01.E01', 'S01E01'
            if (!torrentStandardizedTitle.includes(seasonEpisodeIdentifier)) {
                console.log(`[VALIDATION FAILED] Season/Episode mismatch (Series): Expected="${seasonEpisodeIdentifier}", Got="${torrentStandardizedTitle}" (Original: "${torrentTitle}")`);
                return false;
            }
        }
    }

    console.log(`[VALIDATION PASSED] Title validated: "${torrentTitle}"`);
    return true;
}

/**
 * Extracts detailed quality information from a torrent title.
 * @param {string} torrentTitle - The torrent title to parse.
 * @returns {Object} - Object containing parsed details (resolution, videoQuality, audioQuality, language).
 */
function parseTorrentDetails(torrentTitle) {
    const lowerTitle = torrentTitle.toLowerCase();
    let resolution = null;
    let videoQuality = null;
    let audioQuality = null;
    let language = getTorrentLanguage(torrentTitle); // Reuse existing language detection

    // Resolution: e.g., 2160p, 1080p, 720p, 480p, 4k
    const resolutionMatch = lowerTitle.match(/(\d{3,4}p|4k|uhd|fhd)/);
    if (resolutionMatch) {
        resolution = resolutionMatch[1];
        // Normalize 4k/uhd/fhd to 2160p for consistent ranking
        if (['4k', 'uhd', 'fhd'].includes(resolution)) {
            resolution = '2160p';
        }
    }

    // Video Quality: e.g., web-dl, bluray, remux, hdtv, webrip, hdrip, x264, x265, hevc, hdr
    const videoQualityMatches = lowerTitle.match(/(remux|bluray|web-dl|webrip|hdrip|hdtv|dvdrip|x264|x265|hevc|hdr)/g);
    if (videoQualityMatches) {
        // Prioritize based on config or a predefined hierarchy if multiple matches
        // For simplicity, take the first one that matches our preferred list, or just the first if no config match
        for (const prefQuality of PREFERRED_VIDEO_QUALITIES_CONFIG) {
            if (videoQualityMatches.includes(prefQuality)) {
                videoQuality = prefQuality;
                break;
            }
        }
        if (!videoQuality && videoQualityMatches.length > 0) {
            videoQuality = videoQualityMatches[0]; // Fallback to first found
        }
    }

    // Audio Quality: e.g., dts-hd, truehd, atmos, dts, ac3, aac, mp3
    const audioQualityMatches = lowerTitle.match(/(truehd|dts-hd|atmos|dd\+?5\.1|dd\+?7\.1|ac3|aac|mp3)/g);
    if (audioQualityMatches) {
        // Prioritize based on config or a predefined hierarchy
        for (const prefQuality of PREFERRED_AUDIO_QUALITIES_CONFIG) {
            if (audioQualityMatches.includes(prefQuality)) {
                audioQuality = prefQuality;
                break;
            }
        }
        if (!audioQuality && audioQualityMatches.length > 0) {
            audioQuality = audioQualityMatches[0]; // Fallback to first found
        }
    }

    return { resolution, videoQuality, audioQuality, language };
}

/**
 * Ranks a resolution based on a predefined hierarchy. Higher value means better quality.
 * @param {string|null} resolution - The detected resolution string.
 * @returns {number} - Numeric rank.
 */
function getResolutionRank(resolution) {
    switch (resolution) {
        case '2160p': return 4;
        case '1080p': return 3;
        case '720p': return 2;
        case '480p': return 1;
        default: return 0; // Unknown or not found
    }
}

/**
 * Ranks a video quality based on the PREFERRED_VIDEO_QUALITIES_CONFIG. Higher value means better quality.
 * @param {string|null} quality - The detected video quality string.
 * @returns {number} - Numeric rank.
 */
function getVideoQualityRank(quality) {
    if (!quality) return 0;
    const index = PREFERRED_VIDEO_QUALITIES_CONFIG.indexOf(quality);
    return index !== -1 ? PREFERRED_VIDEO_QUALITIES_CONFIG.length - index : 0; // Higher rank for earlier preferred qualities
}

/**
 * Ranks an audio quality based on the PREFERRED_AUDIO_QUALITIES_CONFIG. Higher value means better quality.
 * @param {string|null} quality - The detected audio quality string.
 * @returns {number} - Numeric rank.
 */
function getAudioQualityRank(quality) {
    if (!quality) return 0;
    const index = PREFERRED_AUDIO_QUALITIES_CONFIG.indexOf(quality);
    return index !== -1 ? PREFERRED_AUDIO_QUALITIES_CONFIG.length - index : 0; // Higher rank for earlier preferred qualities
}

// --- Stremio Addon Setup ---
const builder = new addonBuilder({
    id: 'org.jackett.stremio.addon',
    version: '1.2.0', // Updated version for new features
    name: 'Jackett Stream Provider',
    description: 'Provides P2P streams sourced from Jackett with advanced filtering, validation, and quality sorting.',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [], // No catalogs needed as it provides streams dynamically
    icon: 'https://cdn.iconscout.com/icon/free/png-256/jackett-3027871-2522777.png', // Example icon
    background: 'https://www.wallpaperflare.com/static/863/826/360/film-clapper-black-background-clapperboard-wallpaper.jpg', // Example background
    idPrefixes: ['tt'] // Only handle IMDb IDs
});

// Define the stream handler
builder.defineStreamHandler(async (args) => {
    const startTime = performance.now(); // Mark the start of processing

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
    console.log(`[CONFIG] Sorting: Initial by='${SORT_BY}' order='${SORT_ORDER}', Quality Prefs: Video=[${PREFERRED_VIDEO_QUALITIES_CONFIG.join(', ')}], Audio=[${PREFERRED_AUDIO_QUALITIES_CONFIG.join(', ')}]`);


    try {
        // --- Step 1: Fetch metadata in parallel from OMDb and TMDB ---
        const [omdbResult, tmdbResult] = await Promise.allSettled([
            getOmdbMetadata(imdbId),
            getTmdbMetadata(imdbId, itemType)
        ]);

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

        // --- Step 2: Perform Jackett search ---
        console.log(`[INFO] Searching Jackett for: "${jackettQuery}" (IMDb: ${imdbId})`);
        const jackettResults = await jackettSearch(jackettQuery, imdbId, determinedType, season, episode);
        console.log(`[INFO] Jackett returned ${jackettResults.length} raw results.`);

        // --- Stage 1: Initial Filtering & Date Sort ---
        const initialFilteredResults = [];
        const processedInfoHashes = new Set();

        for (const result of jackettResults) {
            if (!result.InfoHash && !result.MagnetUri) continue;

            let infoHash = result.InfoHash || get(result, 'MagnetUri', '').match(/btih:([^&/]+)/)?.[1];
            if (!infoHash) continue;
            infoHash = infoHash.toLowerCase();

            if (processedInfoHashes.has(infoHash)) continue;

            if (!validateTorrentTitle(metadata, season, episode, result.Title)) continue;

            if (result.Seeders < MINIMUM_SEEDERS) {
                console.log(`[FILTERED] Low seeders (${result.Seeders} < ${MINIMUM_SEEDERS}): ${result.Title}`);
                continue;
            }

            const torrentSizeMB = result.Size / (1024 * 1024);
            if (torrentSizeMB < MIN_TORRENT_SIZE_MB || torrentSizeMB > MAX_TORRENT_SIZE_MB) {
                console.log(`[FILTERED] Size out of range (${torrentSizeMB.toFixed(2)}MB, min:${MIN_TORRENT_SIZE_MB}, max:${MAX_TORRENT_SIZE_MB}): ${result.Title}`);
                continue;
            }
            
            // Add to initial filtered results
            processedInfoHashes.add(infoHash);
            initialFilteredResults.push(result);
        }

        console.log(`[INFO] Initial filtered down to ${initialFilteredResults.length} results.`);

        // Sort by PublishedDate (most recent first)
        initialFilteredResults.sort((a, b) => {
            const dateA = new Date(a.PublishDate).getTime();
            const dateB = new Date(b.PublishDate).getTime();
            return dateB - dateA; // Descending order
        });

        // --- Stage 2: Limit to Top N Candidates ---
        const topNCandidates = initialFilteredResults.slice(0, MAX_STREAMS * 2); // Take more than MAX_STREAMS to allow for further quality filtering

        // --- Stage 3: Detailed Parsing & Complex Quality Sort ---
        const finalStreams = [];

        for (const result of topNCandidates) {
            const parsedDetails = parseTorrentDetails(result.Title);
            const magnetLink = buildMagnetLink(result.InfoHash || get(result, 'MagnetUri', '').match(/btih:([^&/]+)/)?.[1], publicTrackers);

            finalStreams.push({
                originalResult: result,
                magnetLink: magnetLink,
                infoHash: result.InfoHash || get(result, 'MagnetUri', '').match(/btih:([^&/]+)/)?.[1].toLowerCase(),
                parsedDetails: parsedDetails, // Store parsed details for sorting
                resolutionRank: getResolutionRank(parsedDetails.resolution),
                videoQualityRank: getVideoQualityRank(parsedDetails.videoQuality),
                audioQualityRank: getAudioQualityRank(parsedDetails.audioQuality),
                hasPreferredLanguage: PREFERRED_LANGUAGES.length > 0 && parsedDetails.language && PREFERRED_LANGUAGES.includes(parsedDetails.language),
            });
        }

        // Complex sorting based on quality, resolution, language, then seeders
        finalStreams.sort((a, b) => {
            // 1. Preferred Language (highest priority)
            if (a.hasPreferredLanguage && !b.hasPreferredLanguage) return -1;
            if (!a.hasPreferredLanguage && b.hasPreferredLanguage) return 1;

            // 2. Resolution (descending)
            if (a.resolutionRank !== b.resolutionRank) {
                return b.resolutionRank - a.resolutionRank;
            }

            // 3. Video Quality (descending)
            if (a.videoQualityRank !== b.videoQualityRank) {
                return b.videoQualityRank - a.videoQualityRank;
            }

            // 4. Audio Quality (descending)
            if (a.audioQualityRank !== b.audioQualityRank) {
                return b.audioQualityRank - a.audioQualityRank;
            }

            // 5. Seeders (descending, final tie-breaker)
            // Note: Acknowledging that seeders might not be perfectly reliable for DHT-crawled magnets
            return b.originalResult.Seeders - a.originalResult.Seeders;
        });

        // --- Stage 4: Format for Stremio and apply MAX_STREAMS limit ---
        const stremioStreams = [];
        for (let i = 0; i < Math.min(finalStreams.length, MAX_STREAMS); i++) {
            const stream = finalStreams[i];
            const result = stream.originalResult;
            const torrentSizeMB = (result.Size / (1024 * 1024)).toFixed(2);

            // Construct title for Stremio, including parsed details
            let titleParts = [result.Title];
            if (stream.parsedDetails.resolution) titleParts.push(stream.parsedDetails.resolution.toUpperCase());
            if (stream.parsedDetails.videoQuality) titleParts.push(stream.parsedDetails.videoQuality.toUpperCase());
            if (stream.parsedDetails.audioQuality) titleParts.push(stream.parsedDetails.audioQuality.toUpperCase());
            if (stream.parsedDetails.language) titleParts.push(stream.parsedDetails.language.charAt(0).toUpperCase() + stream.parsedDetails.language.slice(1));
            titleParts.push(`S:${result.Seeders}`, `L:${result.Peers}`, `Size:${torrentSizeMB}MB`);

            stremioStreams.push({
                name: `Jackett | ${result.Tracker}`,
                title: titleParts.join(' | '),
                infoHash: stream.infoHash,
                sources: [`${stream.magnetLink}`],
            });
        }

        console.log(`[INFO] [STREMIO RESPONSE] Sending ${stremioStreams.length} streams to Stremio for ID: ${args.id}`);

        const endTime = performance.now();
        console.log(`[INFO] Total processing time for ${args.id}: ${((endTime - startTime) / 1000).toFixed(2)} seconds.`);

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
console.log(`[INFO] Response Timeout: ${RESPONSE_TIMEOUT_MS}ms`);
console.log(`[INFO] Addon is listening on http://127.0.0.1:7000/manifest.json (default port)`);
