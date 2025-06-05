// torrentProcessorWorker.js
const { parentPort } = require('worker_threads');
const { performance } = require('perf_hooks'); // Import performance for timing in worker

// Simple 'get' helper function for safer property access without external dependency
const simpleGet = (obj, path, defaultValue) => {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length; i++) {
        if (current === null || typeof current !== 'object' || !current.hasOwnProperty(parts[i])) {
            return defaultValue;
        }
        current = current[parts[i]];
    }
    return current !== undefined ? current : defaultValue;
};

// Configuration values will be received via postMessage
let MINIMUM_SEEDERS;
let MIN_TORRENT_SIZE_MB;
let MAX_TORRENT_SIZE_MB;
let PREFERRED_LANGUAGES;
let PREFERRED_VIDEO_QUALITIES_CONFIG;
let PREFERRED_AUDIO_QUALITIES_CONFIG;

// --- Utility Functions for Validation, Parsing, and Filtering ---

/**
 * Sanitizes and standardizes a title for robust comparison.
 * Converts to lowercase, removes special characters, replaces separators, and normalizes common tags.
 * Also attempts to extract a year from the title (for validation purposes, not for pubDate).
 * @param {string} title - The title string to standardize.
 * @returns {{standardizedTitle: string, extractedYear: number|null}} - The standardized title and any extracted year.
 */
function standardizeTitle(title) {
    let extractedYear = null;

    // Try to extract year first, as it might be in brackets/parentheses for validation
    const yearMatch = title.match(/[\(\[](\d{4})[\)\]]/);
    if (yearMatch) {
        extractedYear = parseInt(yearMatch[1], 10);
        title = title.replace(yearMatch[0], '').trim();
    } else {
        const simpleYearMatch = title.match(/\s(\d{4})$/);
        if (simpleYearMatch) {
            extractedYear = parseInt(simpleYearMatch[1], 10);
            title = title.replace(simpleYearMatch[0], '').trim();
        }
    }

    let standardized = title.toLowerCase();
    standardized = standardized.replace(/[^\w\s]/g, ' ');
    standardized = standardized.replace(/[\s\.\-]+/g, ' ').trim();
    standardized = standardized.
        replace(/(hdrip|webrip|web-dl|x264|x265|h264|h265|aac|ac3|dts|bluray|dvdrip|brrip|bdrip|repack|proper|internal|ita|eng|dubbed|subbed|multi|german|french|spanish|hindi|tamil|korean|japanese|chinese|kannada|malayalam|telugu|720p|1080p|2160p|4k|uhd|fhd|mp4|mkv|avi|xvid|hevc|remux|extended|director's cut|uncut|unrated|s\d{2}e\d{2}|s\d{2}|e\d{2}|freeleech|true|ddp|hdr|dts-hd|ma|atmos|xvid|av1|rip|by|rg|uh|etrg|ethd|t0m|war|din|hurtom|rutracker|generalfilm|nahom|edge2020|xvi|mp3|eac3|subs)\b/g, ' ');
    
    if (extractedYear) {
        standardized = standardized.replace(new RegExp(`\\s${extractedYear}\\s`, 'g'), ' ');
    }

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
        return false;
    }

    const { standardizedTitle: expectedStandardizedTitle, extractedYear: expectedYear } = standardizeTitle(metadata.title);
    const { standardizedTitle: torrentStandardizedTitle, extractedYear: torrentExtractedYear } = standardizeTitle(torrentTitle);

    if (!torrentStandardizedTitle.includes(expectedStandardizedTitle)) {
        return false;
    }

    if (metadata.type === 'movie') {
        if (expectedYear && torrentExtractedYear && expectedYear !== torrentExtractedYear) {
            return false;
        }
    } else if (metadata.type === 'series') {
        if (season && episode) {
            const seasonEpisodeIdentifier = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
            if (!torrentStandardizedTitle.includes(seasonEpisodeIdentifier)) {
                return false;
            }
        }
    }
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
        'tel': 'telugu', 'telugu': 'telugu',
        'chn': 'chinese', 'chinese': 'chinese',
        'kor': 'korean', 'korean': 'korean',
        'spa': 'spanish', 'spanish': 'spanish',
        'ger': 'german', 'german': 'german',
        'jpn': 'japanese', 'japanese': 'japanese',
        'ukr': 'ukrainian', 'ukrainian': 'ukrainian',
        'ita': 'italian', 'italian': 'italian',
        'fre': 'french', 'french': 'french',
        'duo': 'dual-audio',
        'multi': 'multi-language'
    };

    for (const key in languageMap) {
        if (lowerTitle.includes(key) || lowerTitle.includes(languageMap[key])) {
            return languageMap[key];
        }
    }
    return null;
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
    let language = getTorrentLanguage(torrentTitle);

    // Resolution: e.g., 2160p, 1080p, 720p, 480p, 4k
    const resolutionMatch = lowerTitle.match(/(\d{3,4}p|4k|uhd|fhd)/);
    if (resolutionMatch) {
        resolution = resolutionMatch[1];
        if (['4k', 'uhd', 'fhd'].includes(resolution)) {
            resolution = '2160p';
        }
    }

    // Video Quality: e.g., remux, bluray, web-dl, webrip, hdrip, hdtv, dvdrip, x264, x265, hevc, hdr, bdrip, xvid, av1
    const videoQualityMatches = lowerTitle.match(/(remux|bluray|bdrip|web-dl|webrip|hdrip|hdtv|dvdrip|x264|x265|hevc|hdr|xvid|av1)/g);
    if (videoQualityMatches) {
        for (const prefQuality of PREFERRED_VIDEO_QUALITIES_CONFIG) {
            if (videoQualityMatches.includes(prefQuality)) {
                videoQuality = prefQuality;
                break;
            }
        }
        if (!videoQuality && videoQualityMatches.length > 0) {
            videoQuality = videoQualityMatches[0];
        }
    }

    // Audio Quality: e.g., truehd, dts-hd, atmos, dts, ac3, aac, mp3, eac3, ddp
    // Also include channel info if possible (e.g., 5.1, 7.1) for better context
    const audioQualityMatches = lowerTitle.match(/(truehd|dts-hd|atmos|dts|eac3|ddp|ac3|aac|mp3|(\d\.\d)|(ch))(\s*(ma))?/g);
    if (audioQualityMatches) {
        for (const prefQuality of PREFERRED_AUDIO_QUALITIES_CONFIG) {
            if (audioQualityMatches.includes(prefQuality)) {
                audioQuality = prefQuality;
                break;
            }
        }
        if (!audioQuality && audioQualityMatches.length > 0) {
            audioQuality = audioQualityMatches[0];
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
        case '576p':
        case '480p': return 1;
        default: return 0;
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
    return index !== -1 ? PREFERRED_VIDEO_QUALITIES_CONFIG.length - index : 0;
}

/**
 * Ranks an audio quality based on the PREFERRED_AUDIO_QUALITIES_CONFIG. Higher value means better quality.
 * @param {string|null} quality - The detected audio quality string.
 * @returns {number} - Numeric rank.
 */
function getAudioQualityRank(quality) {
    if (!quality) return 0;
    const index = PREFERRED_AUDIO_QUALITIES_CONFIG.indexOf(quality);
    return index !== -1 ? PREFERRED_AUDIO_QUALITIES_CONFIG.length - index : 0;
}

// Listen for messages from the main thread
parentPort.on('message', (message) => {
    const workerStartTime = performance.now();
    try {
        const { jackettResults, metadata, season, episode, config, publicTrackers } = message;

        // Set worker's config from the received message
        MINIMUM_SEEDERS = config.MINIMUM_SEEDERS;
        MIN_TORRENT_SIZE_MB = config.MIN_TORRENT_SIZE_MB;
        MAX_TORRENT_SIZE_MB = config.MAX_TORRENT_SIZE_MB;
        PREFERRED_LANGUAGES = config.PREFERRED_LANGUAGES;
        PREFERRED_VIDEO_QUALITIES_CONFIG = config.PREFERRED_VIDEO_QUALITIES_CONFIG;
        PREFERRED_AUDIO_QUALITIES_CONFIG = config.PREFERRED_AUDIO_QUALITIES_CONFIG;

        const processedStreams = [];
        const processedInfoHashes = new Set();

        // Jackett results are already limited and sorted by date via the API query in server.js
        const resultsToProcess = jackettResults; 
        console.log(`[WORKER] Received ${resultsToProcess.length} results from main thread (already date-sorted and limited by Jackett API).`);

        for (const result of resultsToProcess) {
            try { // Individual try-catch for each result to prevent worker crash
                const title = simpleGet(result, 'Title', ''); // Use simpleGet for Title
                const lowerTitle = title.toLowerCase();

                // --- Early Filtering of low-quality types (TS/Telecine) ---
                if (lowerTitle.includes('ts') || lowerTitle.includes('telecine')) {
                    continue; // Skip TS/Telecine
                }

                // --- Basic InfoHash/MagnetUri Validation ---
                if (!simpleGet(result, 'InfoHash', null) && (!simpleGet(result, 'MagnetUri', null) || typeof simpleGet(result, 'MagnetUri', null) !== 'string')) continue;

                let infoHash = simpleGet(result, 'InfoHash', null) || (typeof simpleGet(result, 'MagnetUri', null) === 'string' ? simpleGet(result, 'MagnetUri', null).match(/btih:([^&/]+)/)?.[1] : null);
                if (!infoHash) continue;
                infoHash = infoHash.toLowerCase();

                if (processedInfoHashes.has(infoHash)) continue;

                // --- Validate Torrent Title vs. Expected Metadata ---
                if (!validateTorrentTitle(metadata, season, episode, title)) continue;

                // --- Prioritize Torznab API fields, fallback to title parsing ONLY IF NOT AVAILABLE ---
                let torrentResolution = simpleGet(result, 'Resolution', null);
                let torrentVideoQuality = simpleGet(result, 'Quality', null); // Jackett's 'Quality' field
                let torrentAudioQuality = simpleGet(result, 'AudioChannels', null); // Jackett's 'AudioChannels' or similar
                let torrentLanguage = simpleGet(result, 'Language', null); // Jackett's 'Language' field

                // Fallback to title parsing only if Torznab API fields are explicitly null/undefined/empty
                const parsedDetailsFromTitle = parseTorrentDetails(title);

                if (!torrentResolution) {
                     torrentResolution = parsedDetailsFromTitle.resolution;
                }
                if (!torrentVideoQuality) {
                     torrentVideoQuality = parsedDetailsFromTitle.videoQuality;
                }
                if (!torrentAudioQuality) {
                     torrentAudioQuality = parsedDetailsFromTitle.audioQuality;
                }
                if (!torrentLanguage) {
                     torrentLanguage = parsedDetailsFromTitle.language;
                }

                // Create a consolidated parsedDetails object
                const consolidatedParsedDetails = {
                    resolution: torrentResolution,
                    videoQuality: torrentVideoQuality,
                    audioQuality: torrentAudioQuality,
                    language: torrentLanguage
                };

                // --- Filter out resolutions less than 720p (early) ---
                if (getResolutionRank(consolidatedParsedDetails.resolution) < getResolutionRank('720p')) {
                    continue; // Skip resolutions below 720p
                }

                // --- Existing Filters (Seeders, Size, Language Preference) ---
                const currentSeeders = simpleGet(result, 'Seeders', 0); // Use simpleGet for Seeders
                if (currentSeeders < MINIMUM_SEEDERS) {
                    continue;
                }

                const currentSize = simpleGet(result, 'Size', 0); // Use simpleGet for Size
                const torrentSizeMB = currentSize / (1024 * 1024);
                if (torrentSizeMB < MIN_TORRENT_SIZE_MB || torrentSizeMB > MAX_TORRENT_SIZE_MB) {
                    continue;
                }

                // Check language preference using the consolidated language
                if (PREFERRED_LANGUAGES.length > 0) {
                    if (!consolidatedParsedDetails.language || !PREFERRED_LANGUAGES.includes(consolidatedParsedDetails.language)) {
                        continue;
                    }
                }

                // --- Published Date Handling ---
                // Strictly use result.PublishedDate from API. If invalid/missing, set to null. No title parsing for date.
                let torrentPublishedDate = simpleGet(result, 'PublishedDate', null);
                if (torrentPublishedDate && isNaN(new Date(torrentPublishedDate).getTime())) {
                    console.warn(`[WORKER] Invalid PublishedDate from API for "${title}". Setting to null for sorting.`);
                    torrentPublishedDate = null;
                }

                const magnetLink = `magnet:?xt=urn:btih:${infoHash}&${publicTrackers.map(t => `tr=${encodeURIComponent(t)}`).join('&')}`;

                processedInfoHashes.add(infoHash);

                processedStreams.push({
                    originalResult: result, // Keep original result for data like Title, Tracker, Seeders etc.
                    magnetLink: magnetLink,
                    infoHash: infoHash,
                    parsedDetails: consolidatedParsedDetails, // Use consolidated details
                    resolutionRank: getResolutionRank(consolidatedParsedDetails.resolution),
                    videoQualityRank: getVideoQualityRank(consolidatedParsedDetails.videoQuality),
                    audioQualityRank: getAudioQualityRank(consolidatedParsedDetails.audioQuality),
                    hasPreferredLanguage: PREFERRED_LANGUAGES.length > 0 && consolidatedParsedDetails.language && PREFERRED_LANGUAGES.includes(consolidatedParsedDetails.language),
                    effectivePublishedDate: torrentPublishedDate // Pass the strictly API-derived or nullified PublishedDate
                });
            } catch (innerErr) {
                // Catch errors for an individual torrent result to prevent the entire worker from crashing
                console.error(`[ERROR][WORKER] Error processing individual torrent "${simpleGet(result, 'Title', 'Unknown Title')}": ${innerErr.message}`);
                console.error(innerErr.stack);
            }
        }

        const workerEndTime = performance.now();
        console.log(`[INFO][WORKER] Processing ${jackettResults.length} raw results to ${processedStreams.length} filtered results in: ${((workerEndTime - workerStartTime) / 1000).toFixed(2)} seconds.`);
        parentPort.postMessage(processedStreams);
    } catch (err) {
        // Catch any broader errors outside the individual torrent loop that could crash the worker
        console.error(`[ERROR][WORKER] Unhandled error during torrent processing: ${err.message}`);
        console.error(err.stack);
        parentPort.postMessage({ error: err.message, stack: err.stack });
    }
});
