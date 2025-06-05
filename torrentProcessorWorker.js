// torrentProcessorWorker.js
const { parentPort } = require('worker_threads');
const get = require('lodash.get'); // lodash.get is still useful for safe property access

// Re-declare utility functions that will be used by the worker
// These need to be passed or re-defined in the worker's scope
// Configuration values will be received via postMessage
let MINIMUM_SEEDERS;
let MIN_TORRENT_SIZE_MB;
let MAX_TORRENT_SIZE_MB;
let PREFERRED_LANGUAGES;
let PREFERRED_VIDEO_QUALITIES_CONFIG;
let PREFERRED_AUDIO_QUALITIES_CONFIG;

// --- Utility Functions for Validation, Parsing, and Filtering (copied from server.js) ---

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
        // In worker, we might not log this as intensely, or return a specific status
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
        'chn': 'chinese', 'chinese': 'chinese',
        'kor': 'korean', 'korean': 'korean',
        'spa': 'spanish', 'spanish': 'spanish',
        'ger': 'german', 'german': 'german',
        'jpn': 'japanese', 'japanese': 'japanese',
    };

    for (const key in languageMap) {
        if (lowerTitle.includes(key)) {
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

    // Video Quality: e.g., web-dl, bluray, remux, hdtv, webrip, hdrip, x264, x265, hevc, hdr
    const videoQualityMatches = lowerTitle.match(/(remux|bluray|web-dl|webrip|hdrip|hdtv|dvdrip|x264|x265|hevc|hdr)/g);
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

    // Audio Quality: e.g., dts-hd, truehd, atmos, dts, ac3, aac, mp3
    const audioQualityMatches = lowerTitle.match(/(truehd|dts-hd|atmos|dd\+?5\.1|dd\+?7\.1|ac3|aac|mp3)/g);
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
    const { jackettResults, metadata, season, episode, config, publicTrackers } = message;

    // Set worker's config from the received message
    MINIMUM_SEEDERS = config.MINIMUM_SEEDERS;
    MIN_TORRENT_SIZE_MB = config.MIN_TORRENT_SIZE_MB;
    MAX_TORRENT_SIZE_MB = config.MAX_TORRENT_SIZE_MB;
    PREFERRED_LANGUAGES = config.PREFERRED_LANGUAGES;
    PREFERRED_VIDEO_QUALITIES_CONFIG = config.PREFERRED_VIDEO_QUALITIES_CONFIG;
    PREFERRED_AUDIO_QUALITIES_CONFIG = config.PREFERRED_AUDIO_QUALITIES_CONFIG;

    const processedStreams = [];
    const processedInfoHashes = new Set(); // Use a Set to efficiently track and prevent duplicate infoHashes

    for (const result of jackettResults) {
        if (!result.InfoHash && !result.MagnetUri) continue;

        let infoHash = result.InfoHash || get(result, 'MagnetUri', '').match(/btih:([^&/]+)/)?.[1];
        if (!infoHash) continue;
        infoHash = infoHash.toLowerCase();

        if (processedInfoHashes.has(infoHash)) continue;

        if (!validateTorrentTitle(metadata, season, episode, result.Title)) continue;

        if (result.Seeders < MINIMUM_SEEDERS) {
            continue; // Filtered by min seeders
        }

        const torrentSizeMB = result.Size / (1024 * 1024);
        if (torrentSizeMB < MIN_TORRENT_SIZE_MB || torrentSizeMB > MAX_TORRENT_SIZE_MB) {
            continue; // Filtered by size
        }

        const detectedLanguage = getTorrentLanguage(result.Title);
        if (PREFERRED_LANGUAGES.length > 0) {
            if (!detectedLanguage || !PREFERRED_LANGUAGES.includes(detectedLanguage)) {
                continue; // Filtered by language preference
            }
        }

        // Parse detailed quality information
        const parsedDetails = parseTorrentDetails(result.Title);
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}&${publicTrackers.map(t => `tr=${encodeURIComponent(t)}`).join('&')}`;

        processedInfoHashes.add(infoHash); // Add to processed list after all filters pass

        processedStreams.push({
            originalResult: result,
            magnetLink: magnetLink,
            infoHash: infoHash,
            parsedDetails: parsedDetails,
            resolutionRank: getResolutionRank(parsedDetails.resolution),
            videoQualityRank: getVideoQualityRank(parsedDetails.videoQuality),
            audioQualityRank: getAudioQualityRank(parsedDetails.audioQuality),
            hasPreferredLanguage: PREFERRED_LANGUAGES.length > 0 && parsedDetails.language && PREFERRED_LANGUAGES.includes(parsedDetails.language),
        });
    }

    // Initial sort by PublishedDate (most recent first) before sending back
    processedStreams.sort((a, b) => {
        const dateA = new Date(a.originalResult.PublishDate).getTime();
        const dateB = new Date(b.originalResult.PublishDate).getTime();
        return dateB - dateA; // Descending order
    });

    parentPort.postMessage(processedStreams);
});
