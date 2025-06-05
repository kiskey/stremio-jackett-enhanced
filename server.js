// server.js - Stremio Addon for Jackett Integration with advanced features

// Corrected import: 'addonBuilder' and 'serveHTTP' are exported directly
const { addonBuilder, get, serveHTTP } = require('stremio-addon-sdk');
const { performance } = require('perf_hooks'); // For measuring execution time
require('dotenv').config(); // Load environment variables from .env file

// --- Configuration (Set these as environment variables or update directly) ---
const JACKETT_HOST = process.env.JACKETT_HOST || 'http://localhost:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY || 'YOUR_JACKETT_API_KEY_HERE'; // !!! IMPORTANT: Replace with your actual Jackett API Key !!!
const OMDb_API_KEY = process.env.OMDB_API_KEY || 'YOUR_OMDB_API_KEY_HERE';     // !!! IMPORTANT: Replace with your actual OMDb API Key !!!
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'YOUR_TMDB_API_KEY_HERE';     // !!! IMPORTANT: Replace with your actual TMDB API Key !!!

const TRACKERS_URL = process.env.TRACKERS_URL || 'https://raw.githubusercontent.com/ngosang/trackerslist/refs/heads/master/trackers_best.txt';
const RESPONSE_TIMEOUT_MS = parseInt(process.env.RESPONSE_TIMEOUT_MS || '20000', 10); // Max time to respond to Stremio
const MINIMUM_SEEDERS = parseInt(process.env.MINIMUM_SEEDERS || '0', 10); // Minimum seeders for a torrent to be considered

// --- New Filtering and Sorting Configuration ---
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '20', 10); // Maximum number of streams to return to Stremio
const MIN_TORRENT_SIZE_MB = parseInt(process.env.MIN_TORRENT_SIZE_MB || '10', 10); // Minimum allowed torrent size in MB
const MAX_TORRENT_SIZE_MB = parseInt(process.env.MAX_TORRENT_SIZE_MB || '4096', 10); // Maximum allowed torrent size in MB (e.g., 4GB)
const PREFERRED_LANGUAGES = (process.env.PREFERRED_LANGUAGES || '').toLowerCase().split(',').map(lang => lang.trim()).filter(lang => lang.length > 0);
const SORT_BY = process.env.SORT_BY || 'seeders'; // 'seeders', 'size', 'recent'
const SORT_ORDER = process.env.SORT_ORDER || 'desc'; // 'asc', 'desc'

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

// --- Utility Functions for Validation and Filtering ---

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

    // Remove common release group tags and other extraneous info
    // This regex is a simplified example and can be extended based on observed patterns
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
 * Detects the language from a torrent title based on common tags.
 * @param {string} torrentTitle - The torrent title to analyze.
 * @returns {string|null} - Detected language (e.g., 'english', 'hindi') or null if not found.
 */
function getTorrentLanguage(torrentTitle) {
    const lowerTitle = torrentTitle.toLowerCase();
    const languageMap = {
        'eng': 'english', 'english': 'english',
        'hin': 'hindi', 'hindi': 'hindi',
        'tam': 'tamil', 'tamil': 'tamil',
        'mal': 'malayalam', 'malayalam': 'malayalam',
        'kan': 'kannada', 'kannada': 'kannada',
        'chn': 'chinese', 'chinese': 'chinese',
        'kor': 'korean', 'korean': 'korean',
        'spa': 'spanish', 'spanish': 'spanish',
        'ger': 'german', 'german': 'german',
        'jpn': 'japanese', 'japanese': 'japanese',
        // Add more common language tags/keywords as needed
    };

    for (const key in languageMap) {
        if (lowerTitle.includes(key)) {
            return languageMap[key];
        }
    }
    return null;
}

// --- Stremio Addon Setup ---
const builder = new addonBuilder({
    id: 'org.jackett.stremio.addon',
    version: '1.1.3', // Updated version for bug fix
    name: 'Jackett Stream Provider',
    description: 'Provides P2P streams sourced from Jackett with advanced filtering and validation.',
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

    // Extract IMDb ID and item type from the Stremio request arguments
    // args.id can be 'tt1234567' for movies or 'tt1234567:S01E01' for series episodes
    const imdbId = args.id.split(':')[0];
    const itemType = args.type; // 'movie' or 'series'

    let season, episode;
    // If it's a series, parse season and episode numbers
    if (itemType === 'series') {
        const parts = args.id.split(':');
        if (parts.length === 3) {
            season = parseInt(parts[1].substring(1), 10); // e.g., 'S01' -> 1
            episode = parseInt(parts[2].substring(1), 10); // e.g., 'E01' -> 1
        }
    }

    console.log(`[INFO] Stream requested: Type=${itemType}, ID=${args.id}`);
    console.log(`[CONFIG] Filters: Min Seeders=${MINIMUM_SEEDERS}, Min Size=${MIN_TORRENT_SIZE_MB}MB, Max Size=${MAX_TORRENT_SIZE_MB}MB, Preferred Languages=[${PREFERRED_LANGUAGES.join(', ')}]`);
    console.log(`[CONFIG] Sorting: By='${SORT_BY}', Order='${SORT_ORDER}'`);

    try {
        // --- Step 1: Fetch metadata in parallel from OMDb and TMDB ---
        const [omdbResult, tmdbResult] = await Promise.allSettled([
            getOmdbMetadata(imdbId),
            getTmdbMetadata(imdbId, itemType)
        ]);

        let metadata = null;
        let searchQueryTitle = imdbId; // Fallback title
        let determinedType = itemType; // Default to the requested type

        // Prioritize OMDb metadata if available and successful
        if (omdbResult.status === 'fulfilled' && omdbResult.value) {
            metadata = omdbResult.value;
            searchQueryTitle = metadata.title;
            determinedType = metadata.type;
            console.log(`[INFO] Metadata from OMDb: Title="${metadata.title}", Year="${metadata.year}", Type="${metadata.type}"`);
        } else if (tmdbResult.status === 'fulfilled' && tmdbResult.value) {
            // Fallback to TMDB metadata
            metadata = tmdbResult.value;
            searchQueryTitle = metadata.title;
            determinedType = metadata.type;
            console.log(`[INFO] Metadata from TMDB: Title="${metadata.title}", Year="${metadata.year}", Type="${metadata.type}"`);
        } else {
            console.warn(`[WARN] Could not retrieve metadata for ${imdbId} from OMDb or TMDB. Proceeding with IMDb ID as fallback.`);
            // If no metadata, create a fallback metadata object for validation (title will be imdbId)
            metadata = { title: imdbId, year: null, type: itemType };
        }

        // Construct the search query for Jackett
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

        // --- Step 3: Process, Filter, and Validate Jackett results ---
        const validStreams = [];
        const processedInfoHashes = new Set(); // Use a Set to efficiently track and prevent duplicate infoHashes

        for (const result of jackettResults) {
            // 3.1 Basic validation: ensure we have an InfoHash or MagnetUri
            if (!result.InfoHash && !result.MagnetUri) {
                // console.debug(`[DEBUG] Skipping result without InfoHash or MagnetUri:`, result.Title);
                continue;
            }

            let infoHash = result.InfoHash || get(result, 'MagnetUri', '').match(/btih:([^&/]+)/)?.[1];
            if (!infoHash) {
                // console.debug(`[DEBUG] Skipping result as InfoHash could not be determined:`, result.Title);
                continue;
            }
            infoHash = infoHash.toLowerCase();

            // Skip if this infoHash has already been processed (duplicate)
            if (processedInfoHashes.has(infoHash)) {
                // console.debug(`[DEBUG] Skipping duplicate infoHash: ${infoHash} for ${result.Title}`);
                continue;
            }

            // 3.2 Robust Torrent Title and Year Validation
            if (!validateTorrentTitle(metadata, season, episode, result.Title)) {
                continue; // Skip if title validation fails
            }

            // 3.3 Filter by minimum seeders
            if (result.Seeders < MINIMUM_SEEDERS) {
                console.log(`[FILTERED] Low seeders (${result.Seeders} < ${MINIMUM_SEEDERS}): ${result.Title}`);
                continue;
            }

            // 3.4 Size Filtering
            const torrentSizeMB = result.Size / (1024 * 1024); // Convert bytes to MB
            if (torrentSizeMB < MIN_TORRENT_SIZE_MB || torrentSizeMB > MAX_TORRENT_SIZE_MB) {
                console.log(`[FILTERED] Size out of range (${torrentSizeMB.toFixed(2)}MB, min:${MIN_TORRENT_SIZE_MB}, max:${MAX_TORRENT_SIZE_MB}): ${result.Title}`);
                continue;
            }

            // 3.5 Language Filtering
            const detectedLanguage = getTorrentLanguage(result.Title);
            if (PREFERRED_LANGUAGES.length > 0) {
                if (!detectedLanguage || !PREFERRED_LANGUAGES.includes(detectedLanguage)) {
                    console.log(`[FILTERED] Language not preferred (Detected: ${detectedLanguage || 'none'}, Preferred: ${PREFERRED_LANGUAGES.join(', ')}): ${result.Title}`);
                    continue;
                }
            }
            // If PREFERRED_LANGUAGES is empty, all languages are allowed, so no filtering needed.

            // If all validations and filters pass, add to valid streams
            processedInfoHashes.add(infoHash);
            validStreams.push({
                originalResult: result, // Keep original result for sorting
                magnetLink: buildMagnetLink(infoHash, publicTrackers),
                infoHash: infoHash,
            });
        }

        console.log(`[INFO] Processed and filtered down to ${validStreams.length} valid results.`);

        // --- Step 4: Sort the valid streams ---
        validStreams.sort((a, b) => {
            let valA, valB;

            switch (SORT_BY) {
                case 'seeders':
                    valA = a.originalResult.Seeders;
                    valB = b.originalResult.Seeders;
                    break;
                case 'size':
                    valA = a.originalResult.Size; // Sort by bytes, then convert for display
                    valB = b.originalResult.Size;
                    break;
                case 'recent':
                    valA = new Date(a.originalResult.PublishDate).getTime();
                    valB = new Date(b.originalResult.PublishDate).getTime();
                    break;
                default: // Default to seeders
                    valA = a.originalResult.Seeders;
                    valB = b.originalResult.Seeders;
            }

            if (SORT_ORDER === 'asc') {
                return valA - valB;
            } else {
                return valB - valA;
            }
        });

        // --- Step 5: Format for Stremio and apply MAX_STREAMS limit ---
        const stremioStreams = [];
        for (let i = 0; i < Math.min(validStreams.length, MAX_STREAMS); i++) {
            const stream = validStreams[i];
            const result = stream.originalResult;
            const torrentSizeMB = (result.Size / (1024 * 1024)).toFixed(2); // Convert bytes to MB for display

            stremioStreams.push({
                name: `Jackett | ${result.Tracker}`, // Display the tracker name
                title: `${result.Title} (S: ${result.Seeders}, L: ${result.Peers}, Size: ${torrentSizeMB}MB)`, // Show seeders/leechers/size in title
                infoHash: stream.infoHash,
                sources: [`${stream.magnetLink}`],
            });
        }

        console.log(`[INFO] [STREMIO RESPONSE] Sending ${stremioStreams.length} streams to Stremio for ID: ${args.id}`);

        const endTime = performance.now(); // Mark the end of processing
        console.log(`[INFO] Total processing time for ${args.id}: ${((endTime - startTime) / 1000).toFixed(2)} seconds.`);

        // Return the streams in the format Stremio expects
        return { streams: stremioStreams };

    } catch (error) {
        // Log any unexpected errors during stream processing and return an empty array
        console.error(`[ERROR] Stream processing failed for ID ${args.id}:`, error.message);
        console.warn(`[WARN] Stream processing for ID ${args.id} failed. Returning empty streams.`);
        return { streams: [] };
    }
});

// --- Initialize and Start the Addon Server ---

// Pre-fetch public trackers when the server starts
console.log('[INFO] [SERVER STARTUP] Pre-fetching public trackers to warm cache...');
fetchAndCacheTrackers().then(() => {
    console.log('[INFO] [SERVER STARTUP] Public tracker pre-fetch complete.');
});

// Set up the HTTP server for the addon using the correct function call
serveHTTP(builder.getInterface()); // Corrected: serveHTTP is a function, not a builder method

console.log('[INFO] Logging Level: info');
console.log(`[INFO] Response Timeout: ${RESPONSE_TIMEOUT_MS}ms`);
console.log(`[INFO] Addon is listening on http://127.0.0.1:7000/manifest.json (default port)`); // Stremio default port
