// server.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // Required for fetching trackers and Jackett API
const parseTorrent = require('parse-torrent'); // Required for parsing magnet URIs
const xml2js = require('xml2js'); // Required for parsing XML responses from Jackett

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 7000; // Default port for Stremio addons

// Enable CORS for all routes
app.use(cors());
app.use(express.json()); // For parsing application/json

// Serve static files from the 'public' directory for the configuration UI
app.use(express.static('public'));

// Default configuration for the addon
// These will be overridden by query parameters from Stremio's manifest config
let CURRENT_CONFIG = {
  jackettUrl: process.env.JACKETT_URL || 'http://localhost:9117',
  jackettApiKey: process.env.JACKETT_API_KEY || 'YOUR_JACKETT_API_KEY',
  omdbApiKey: process.env.OMDB_API_KEY || 'YOUR_OMDB_API_KEY',
  tmdbApiKey: process.env.TMDB_API_KEY || 'YOUR_TMDB_API_KEY',
  preferredResolutions: (process.env.PREFERRED_RESOLUTIONS || '2160p,1080p,720p').split(',').map(item => item.trim()).filter(Boolean),
  preferredLanguages: (process.env.PREFERRED_LANGUAGES || 'Tamil,Hindi,Malayalam,Telugu,English,Japanese,Korean,Chinese').split(',').map(item => item.trim()).filter(Boolean),
  maxResults: parseInt(process.env.MAX_RESULTS || '50', 10),
  maxSize: parseInt(process.env.MAX_SIZE || '0', 10), // Max size in bytes (0 means no restriction)
  publicTrackersUrl: process.env.PUBLIC_TRACKERS_URL || 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt',
  logLevel: process.env.LOG_LEVEL || 'info', 
  filterBySeeders: parseInt(process.env.FILTER_BY_SEEDERS || '0', 10), // New: Configurable minimum seeders
  sortBy: process.env.SORT_BY || 'seeders', // New: Configurable sort order
};

// Jackett Category mappings based on content type - MOVED TO GLOBAL SCOPE
const JACKETT_CATEGORIES = {
  movie: '2000,2030,2040,2045,2060,102000,102060,102040,102030,102045',
  series: '5000,5030,5040,5045,105000,105040,105030,105045'
};


// --- Simple Logging Utility ---
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const log = {
  debug: (...args) => {
    if (LOG_LEVELS[CURRENT_CONFIG.logLevel] <= LOG_LEVELS.debug) console.log('[DEBUG]', ...args);
  },
  info: (...args) => {
    if (LOG_LEVELS[CURRENT_CONFIG.logLevel] <= LOG_LEVELS.info) console.log('[INFO]', ...args);
  },
  warn: (...args) => {
    if (LOG_LEVELS[CURRENT_CONFIG.logLevel] <= LOG_LEVELS.warn) console.warn('[WARN]', ...args);
  },
  error: (...args) => {
    if (LOG_LEVELS[CURRENT_CONFIG.logLevel] <= LOG_LEVELS.error) console.error('[ERROR]', ...args);
  },
};

// In-memory cache for public trackers
let cachedPublicTrackers = [];
let lastTrackersFetchTime = 0;
const TRACKER_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

/**
 * Fetches public trackers from a URL and caches them.
 * This function is called on startup and periodically.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of tracker URLs.
 */
const fetchAndCachePublicTrackers = async (publicTrackersUrl) => {
  const currentTime = Date.now();
  // If cache is not empty and still fresh, return cached trackers
  if (cachedPublicTrackers.length > 0 && (currentTime - lastTrackersFetchTime < TRACKER_CACHE_TTL)) {
    log.debug('Using cached public trackers (still fresh).');
    return cachedPublicTrackers;
  }

  log.info('Fetching public trackers from URL:', publicTrackersUrl);

  try {
    const response = await fetch(publicTrackersUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch trackers: ${response.statusText} (Status: ${response.status})`);
    }
    const text = await response.text();
    // Split by new line, trim whitespace, and filter out empty lines
    const trackers = text.split('\n').map(line => line.trim()).filter(line => line !== '');
    
    if (trackers.length > 0) {
      cachedPublicTrackers = trackers;
      lastTrackersFetchTime = currentTime;
      log.info(`Successfully fetched and cached ${trackers.length} public trackers.`);
    } else {
      log.warn('Fetched an empty list of trackers. Retaining old cache or falling back to empty list.');
    }
    return cachedPublicTrackers; // Return the newly fetched or existing cached trackers
  } catch (error) {
    log.error('Error fetching public trackers:', error.message);
    log.warn('Using existing cached public trackers or empty list due to fetch error.');
    return cachedPublicTrackers; 
  }
};

// Initial fetch on startup (will be triggered once manifest is requested and config is set)
// No need to call setInterval here, it will be handled on config update.

/**
 * Normalizes a string for comparison by converting to lowercase,
 * removing non-alphanumeric characters (except spaces), and collapsing multiple spaces.
 * @param {string} str - The input string.
 * @param {boolean} aggressive - If true, removes all non-alphanumeric chars including spaces, dots, hyphens.
 * @returns {string} The normalized string.
 */
const normalizeString = (str, aggressive = false) => {
  if (!str) return '';
  if (aggressive) {
    // Aggressive normalization: remove all non-alphanumeric characters and spaces
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
  } else {
    // Standard normalization: remove special characters but keep spaces, collapse multiple spaces
    return str.toLowerCase().replace(/[^a-z0-9\s]/g, '')
              .replace(/\s+/g, ' ')
              .trim();
  }
};

// Regex patterns for resolution and language extraction from torrent titles
const RESOLUTION_PATTERNS = {
  '2160p': /(2160p|4K|UHD)/i,
  '1080p': /(1080p|FHD)/i,
  '720p': /(720p|HD)/i,
  '480p': /(480p|SD)/i,
};

// Comprehensive language patterns including abbreviations and Unicode ranges for specific languages
const LANGUAGE_PATTERNS = {
  'English': /(eng|english|en)\b/i,
  'Hindi': /(hin|hindi|हिंदी|h.indi)\b/i, // Added common Hindi abbreviations
  'Tamil': /(tam|tamil|தமிழ்)\b/i, // Added Tamil script Unicode check
  'Malayalam': /(mal|malayalam|മലയാളം)\b/i, // Added Malayalam script Unicode check
  'Telugu': /(tel|telugu|తెలుగు)\b/i, // Added Telugu script Unicode check
  'Japanese': /(jpn|japanese|日本語|ja)\b/i, // Added common Japanese abbreviations and Kanji
  'Korean': /(kor|korean|한국어|ko)\b/i, // Added common Korean abbreviations and Hangul
  'Chinese': /(chi|chinese|中文|zh)\b/i, // Added common Chinese abbreviations and Han characters
};


/**
 * Extracts resolution from a torrent title.
 * @param {string} title - The torrent title.
 * @returns {string|null} The detected resolution (e.g., '1080p') or null if not found.
 */
const extractResolution = (title) => {
  for (const res in RESOLUTION_PATTERNS) {
    if (RESOLUTION_PATTERNS[res].test(title)) {
      return res;
    }
  }
  return null;
};

/**
 * Extracts language from a torrent title.
 * @param {string} title - The torrent title.
 * @returns {string|null} The detected language (e.g., 'English') or null if not found.
*/
const extractLanguage = (title) => {
  for (const lang in LANGUAGE_PATTERNS) {
    if (LANGUAGE_PATTERNS[lang].test(title)) {
      return lang;
    }
  }
  return null;
};

/**
 * Enriches a magnet URI with additional public trackers from the cached list.
 * @param {string} magnetUri - The original magnet URI.
 * @returns {string} The magnet URI with enriched trackers.
 */
const enrichMagnetUri = (magnetUri) => {
  try {
    const url = new URL(magnetUri);
    const existingTrackers = url.searchParams.getAll('tr');
    // Use the current cached trackers for enrichment
    const trackersToUse = cachedPublicTrackers;
    const newTrackers = trackersToUse.filter(tracker => !existingTrackers.includes(`tracker:${tracker}`)); // Filter out existing trackers
    
    // Add new trackers to the URL's search parameters directly
    newTrackers.forEach(tracker => url.searchParams.append('tr', tracker));
    return url.toString();
  } catch (error) {
    log.error('Error enriching magnet URI:', error);
    return magnetUri; // Return original if parsing fails
  }
};

/**
 * Converts bytes to a human-readable size string.
 * @param {number} bytes - The size in bytes.
 * @returns {string} Human-readable size (e.g., "2.5 GB").
 */
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Fetches metadata (title, year, aka titles) for an IMDB ID from OMDB and/or TMDB.
 * @param {string} imdbId - The IMDB ID (e.g., 'tt1234567').
 * @param {string} omdbApiKey - OMDB API Key.
 * @param {string} tmdbApiKey - TMDB API Key.
 * @returns {Promise<object>} An object containing metadata like title, year, akaTitles, tmdbId.
 */
const fetchMetadataFromOmdbTmdb = async (imdbId, omdbApiKey, tmdbApiKey) => {
  let metadata = { title: null, year: null, akaTitles: [], tmdbId: null, imdbId: imdbId }; 
  
  // 1. Try OMDB first
  if (omdbApiKey && omdbApiKey !== 'YOUR_OMDB_API_KEY') {
    log.debug(`Fetching OMDB metadata for IMDB ID: ${imdbId}`);
    try {
      const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}`;
      const omdbResponse = await fetch(omdbUrl);
      const omdbData = await omdbResponse.json();
      if (omdbData && omdbData.Response === 'True') {
        metadata.title = omdbData.Title;
        metadata.year = omdbData.Year;
        log.debug(`OMDB metadata found: ${JSON.stringify(metadata)}`);
      } else {
        log.warn(`OMDB did not return valid data for ${imdbId}: ${omdbData.Error || 'Unknown error'}`);
      }
    } catch (error) {
      log.error(`Error fetching from OMDB for ${imdbId}: ${error.message}`);
    }
  } else {
    log.warn('OMDB API Key not configured or is default. Skipping OMDB lookup.');
  }

  // 2. Fallback to TMDB if OMDB failed to provide title or not configured
  if (tmdbApiKey && tmdbApiKey !== 'YOUR_TMDB_API_KEY') {
    log.debug(`Fetching TMDB metadata for IMDB ID: ${imdbId}`);
    try {
      const tmdbFindUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id`;
      const tmdbFindResponse = await fetch(tmdbFindUrl);
      const tmdbFindData = await tmdbFindResponse.json();

      let tmdbId = null;
      let mediaType = null;

      if (tmdbFindData.movie_results && tmdbFindData.movie_results.length > 0) {
        tmdbId = tmdbFindData.movie_results[0].id;
        mediaType = 'movie';
        // Only update title/year if OMDB didn't provide it, or if TMDB's is potentially better
        if (!metadata.title) {
            metadata.title = tmdbFindData.movie_results[0].title;
            metadata.year = tmdbFindData.movie_results[0].release_date ? tmdbFindData.movie_results[0].release_date.substring(0, 4) : null;
        }
      } else if (tmdbFindData.tv_results && tmdbFindData.tv_results.length > 0) {
        tmdbId = tmdbFindData.tv_results[0].id;
        mediaType = 'tv';
        if (!metadata.title) {
            metadata.title = tmdbFindData.tv_results[0].name;
            metadata.year = tmdbFindData.tv_results[0].first_air_date ? tmdbFindData.tv_results[0].first_air_date.substring(0, 4) : null;
        }
      }

      if (tmdbId && mediaType) {
        // Fetch alternative titles
        const tmdbAltTitlesUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/alternative_titles?api_key=${tmdbApiKey}`;
        const tmdbAltTitlesResponse = await fetch(tmdbAltTitlesUrl);
        const tmdbAltTitlesData = await tmdbAltTitlesResponse.json();
        if (tmdbAltTitlesData.results) {
          // Filter to only include titles in English or the original language, and avoid duplicates
          const uniqueAltTitles = new Set(metadata.akaTitles); 
          tmdbAltTitlesData.results.forEach(t => {
            // Include titles that are 'default' or in 'en' language, or are different from the primary title
            if (t.title && t.title !== metadata.title && (t.iso_3166_1 === 'US' || t.iso_3166_1 === 'GB' || t.iso_3166_1 === 'null')) {
              uniqueAltTitles.add(t.title);
            }
          });
          metadata.akaTitles = Array.from(uniqueAltTitles);
        }
        metadata.tmdbId = tmdbId; // Store TMDB ID for potential Jackett query
        log.debug(`TMDB metadata found (and possibly updated title/year/akaTitles): ${JSON.stringify(metadata)}`);
      } else {
        log.warn(`TMDB did not find results for IMDB ID: ${imdbId}`);
      }
    }
    catch (error) {
      log.error(`Error fetching from TMDB for ${imdbId}: ${error.message}`);
    }
  } else {
    log.warn('TMDB API Key not configured or is default. Skipping TMDB lookup.');
  }

  return metadata;
};


/**
 * Fetches results from the actual Jackett API.
 * @param {object} searchParams - An object containing parameters for the Jackett query (e.g., q, cat, imdbid, tmdbid).
 * @param {string} jackettUrl - The Jackett base URL.
 * @param {string} jackettApiKey - The Jackett API Key.
 * @param {number} limit - The maximum number of results to request from Jackett.
 * @returns {Promise<Array>} A promise that resolves to an array of Jackett torrent results.
 */
const fetchJackettResults = async (searchParams, jackettUrl, jackettApiKey, limit) => {
  if (!jackettUrl || jackettApiKey === 'YOUR_JACKETT_API_KEY') {
    log.error('Jackett URL or API Key not configured. Cannot fetch from Jackett.');
    throw new Error('Jackett URL or API Key is not configured.');
  }

  const jackettApiUrl = new URL(`${jackettUrl}/api/v2.0/indexers/all/results/torznab/api`);
  jackettApiUrl.searchParams.append('apikey', jackettApiKey);
  jackettApiUrl.searchParams.append('limit', limit); 

  // Add search parameters dynamically
  if (searchParams.q) jackettApiUrl.searchParams.append('q', searchParams.q);
  if (searchParams.cat) jackettApiUrl.searchParams.append('cat', searchParams.cat);
  if (searchParams.imdbid) jackettApiUrl.searchParams.append('imdbid', searchParams.imdbid);
  if (searchParams.tmdbid) jackettApiUrl.searchParams.append('tmdbid', searchParams.tmdbid);
  if (searchParams.season) jackettApiUrl.searchParams.append('season', searchParams.season); // For series
  if (searchParams.ep) jackettApiUrl.searchParams.append('ep', searchParams.ep); // For series

  log.debug(`Fetching from Jackett: ${jackettApiUrl.toString()}`);

  try {
    const response = await fetch(jackettApiUrl.toString());
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jackett API responded with status ${response.status}: ${errorText}`);
    }
    const xmlText = await response.text();
    
    const parser = new xml2js.Parser({
      explicitArray: false, 
      mergeAttrs: true 
    });
    const parsedXml = await parser.parseStringPromise(xmlText);

    const rawResults = parsedXml?.rss?.channel?.item || [];

    const mappedResults = rawResults.map(item => {
        const attrs = item['torznab:attr'] || [];
        const findAttr = (name) => {
            const attr = attrs.find(a => a.name === name);
            return attr ? attr.value : undefined;
        };

        return {
            Title: item.title,
            MagnetUri: item.guid, 
            PublishDate: item.pubDate,
            Size: parseInt(findAttr('size') || '0', 10), 
            Seeders: parseInt(findAttr('seeders') || '0', 10),
            Leechers: parseInt(findAttr('leechers') || '0', 10), 
            Tracker: item.tracker || item.jackettindexer || 'Unknown' 
        };
    }).filter(item => item.MagnetUri);

    return { Results: mappedResults };

  } catch (error) {
    log.error('Error fetching from Jackett API:', error.message);
    throw error;
  }
};


/**
 * Utility function to create a Stremio stream object from a Jackett torrent item and magnet URI.
 * @param {object} tor - The Jackett torrent item object.
 * @param {string} type - The Stremio content type ('movie' or 'series').
 * @param {string} magnetUri - The magnet URI for the torrent.
 * @param {string[]} currentTrackers - The list of public trackers to enrich the magnet URI.
 * @returns {object|null} The formatted Stremio stream object or null if parsing fails.
 */
const createStremioStream = (tor, type, magnetUri, currentTrackers) => {
    let parsedTorrent;
    try {
        parsedTorrent = parseTorrent(magnetUri);
    } catch (e) {
        log.error(`Error parsing magnet URI for stream: ${e.message}. URI: ${magnetUri}`);
        return null; 
    }

    const infoHash = parsedTorrent.infoHash ? parsedTorrent.infoHash.toLowerCase() : null;
    if (!infoHash) {
        log.warn(`Skipping stream for "${tor.Title}" due to missing/invalid infoHash after magnet URI parsing.`);
        return null;
    }

    let title = tor.Title; 

    const resolution = extractResolution(tor.Title) || 'Unknown';
    const language = extractLanguage(tor.Title) || 'Unknown';

    let subtitleParts = [];
    if (tor.Seeders !== undefined) subtitleParts.push(`S: ${tor.Seeders}`);
    if (tor.Leechers !== undefined) subtitleParts.push(`L: ${tor.Leechers}`);
    if (resolution !== 'Unknown') subtitleParts.push(resolution);
    if (language !== 'Unknown') subtitleParts.push(language);
    if (tor.Size) subtitleParts.push(formatBytes(tor.Size));

    const subtitle = subtitleParts.join(' / '); 

    title += (title.indexOf('\n') > -1 ? '\r\n' : '\r\n\r\n') + subtitle;

    // Prepare sources: existing announces from parsed torrent + enriched trackers
    const existingSources = (parsedTorrent.announce || []).map(x => `tracker:${x}`);
    const newTrackers = currentTrackers.filter(tracker => !existingSources.includes(`tracker:${tracker}`)); // Filter out existing trackers
    
    const allSources = [...new Set([...existingSources, ...newTrackers.map(t => `tracker:${t}`), `dht:${infoHash}`])];

    return {
        name: tor.Tracker || 'Jackett', 
        type: type,
        infoHash: infoHash,
        sources: allSources,
        title: title
    };
};

/**
 * Calculates a match score for a torrent item based on its title and metadata.
 * Higher score indicates a better match.
 * @param {object} item - The raw Jackett torrent item.
 * @param {object} metadata - The metadata object (title, year, akaTitles, tmdbId, imdbId) obtained from OMDB/TMDB.
 * @returns {number} The match score.
 */
const calculateMatchScore = (item, metadata) => {
    let score = 0;
    const normalizedItemTitle = normalizeString(item.Title, true); // Aggressive normalization for scoring
    const itemYearMatch = item.Title ? (item.Title.match(/\b(\d{4})\b/) ? item.Title.match(/\b(\d{4})\b/)[1] : null) : null;

    const normalizedPrimaryTitle = normalizeString(metadata.title, true);
    const normalizedAkaTitles = (metadata.akaTitles || []).map(t => normalizeString(t, true));

    // Strongest match: Normalized Primary Title + Year
    if (normalizedPrimaryTitle && normalizedItemTitle.includes(normalizedPrimaryTitle) && metadata.year && itemYearMatch === metadata.year) {
        score += 100;
    } 
    // Next: Normalized Primary Title only (if year doesn't match or not available)
    else if (normalizedPrimaryTitle && normalizedItemTitle.includes(normalizedPrimaryTitle)) {
        score += 50; // Increased base for primary title
    }

    // Iterate through normalized aka titles for scoring
    for (const akaTitle of normalizedAkaTitles) {
        // Strongest aka match: Normalized AKA Title + Year
        if (akaTitle && normalizedItemTitle.includes(akaTitle) && metadata.year && itemYearMatch === metadata.year) {
            score += 40; 
        } 
        // Next: Normalized AKA Title only (if year doesn't match or not available)
        else if (akaTitle && normalizedItemTitle.includes(akaTitle)) {
            score += 20; 
        }
    }
    
    // Boost for exact normalized title match (whole string) if available - can be a strong indicator
    if (normalizedPrimaryTitle && normalizedItemTitle === normalizedPrimaryTitle) { 
        score += 10;
    }

    // Boost if item title contains IMDB/TMDB ID (especially for ID-based queries)
    if (metadata.imdbId && normalizedItemTitle.includes(normalizeString(metadata.imdbId, true))) {
        score += 15;
    }
    if (metadata.tmdbId && normalizedItemTitle.includes(normalizeString(metadata.tmdbId.toString(), true))) {
        score += 10;
    }

    // Penalize if the torrent title contains an obvious different year when metadata year is known
    if (metadata.year && itemYearMatch && itemYearMatch !== metadata.year) {
        if (normalizedItemTitle.includes(normalizedPrimaryTitle) || normalizedAkaTitles.some(t => normalizedItemTitle.includes(t))) {
             score -= 30; // Stronger penalty for wrong year on a matched title
        }
    }

    // Small boost for more seeders (general quality)
    score += Math.min(item.Seeders / 10, 5); // Max 5 points for seeders

    return Math.max(0, score);
};

/**
 * Validates a Jackett result against expected metadata and user preferences.
 * This is now much stricter for ID-based queries.
 * @param {object} item - The raw Jackett torrent item.
 * @param {object} metadata - The metadata object (title, year, akaTitles, tmdbId, imdbId) obtained from OMDB/TMDB.
 * @param {boolean} wasIdQuery - True if the Jackett query was primarily an IMDB/TMDB ID search.
 * @param {object} config - The addon's current configuration (for preferences).
 * @returns {boolean} True if the item passes validation, false otherwise.
 */
const validateJackettResult = (item, metadata, wasIdQuery, config) => {
  const normalizedItemTitle = normalizeString(item.Title, true); 
  const itemYearMatch = item.Title ? (item.Title.match(/\b(\d{4})\b/) ? item.Title.match(/\b(\d{4})\b/)[1] : null) : null;

  // 1. Basic check: Ensure MagnetUri and valid infoHash. parseTorrent will check this later more robustly.
  if (!item.MagnetUri) {
    log.debug(`Validation failed: Missing MagnetUri for "${item.Title}"`);
    return false;
  }

  // 2. Title/AKA Title/Year/ID Match (Crucial for relevance)
  let passesTitleMatch = false;
  let debugReason = '';

  const normalizedPrimaryTitle = normalizeString(metadata.title, true);
  const normalizedAkaTitles = (metadata.akaTitles || []).map(t => normalizeString(t, true));
  
  // Check if primary title or any aka title exists in the normalized item title
  const hasStrongTitleOverlap = [normalizedPrimaryTitle, ...normalizedAkaTitles].some(t => {
    // Require at least 50% match for shorter titles, or presence of full title for longer ones
    if (!t) return false;
    if (t.length > 5 && normalizedItemTitle.includes(t)) return true; // Full title match
    if (t.length <= 5 && normalizedItemTitle.includes(t)) return true; // Short exact match
    return false;
  });

  const containsImdbId = metadata.imdbId && normalizedItemTitle.includes(normalizeString(metadata.imdbId, true));
  const containsTmdbId = metadata.tmdbId && normalizedItemTitle.includes(normalizeString(metadata.tmdbId.toString(), true));
  
  const yearMatches = (metadata.year && itemYearMatch) ? (parseInt(itemYearMatch, 10) === parseInt(metadata.year, 10)) : true;

  // IMPORTANT: This validation logic applies AFTER Jackett has returned results.
  // The querying strategy (which queries are sent to Jackett) is now what determines initial relevance.
  // This validation acts as a final filter.
  if (wasIdQuery) {
    // For content requested via IMDb/TMDB ID, we expect a strong match.
    // It must either contain the ID or have a very strong title/year overlap.
    if (containsImdbId || containsTmdbId) {
        // If an ID is present in the torrent title, we'll generally consider it a good sign.
        // We add `hasStrongTitleOverlap` as a secondary check to avoid cases like "tt1234567" appearing
        // in a torrent for a completely different movie.
        if (hasStrongTitleOverlap || (!metadata.title && !metadata.akaTitles.length)) { 
            passesTitleMatch = true;
            debugReason = `ID Query: Matched ID (${metadata.imdbId || metadata.tmdbId}) in torrent title.`;
        } else {
            // If ID is present but title is completely unrelated, it's probably junk
            debugReason = `ID Query: ID present but insufficient title match for "${item.Title}".`;
        }
    } else if (hasStrongTitleOverlap && yearMatches) {
        // If no ID is found in the title, but there's a strong title+year match, still accept.
        passesTitleMatch = true;
        debugReason = `ID Query: Strong Title/AKA/Year Match (without explicit ID in torrent title) for "${metadata.title}" (${metadata.year}).`;
    } else {
        // If neither ID nor strong title/year match, it's irrelevant for an ID query.
        debugReason = `ID Query: No ID match and insufficient title/year match for "${item.Title}".`;
    }

    if (!passesTitleMatch) {
        log.debug(`Validation failed: ${debugReason}`);
        return false; 
    } else {
        log.debug(`Validation passed: ${debugReason}`);
    }

  } else { // Original query was title-based (e.g., from search bar or catalog click without specific ID)
    // For title-based queries, strict title/year match is paramount
    if (normalizedPrimaryTitle && metadata.year && normalizedItemTitle.includes(normalizedPrimaryTitle) && yearMatches) {
        passesTitleMatch = true;
        debugReason = "Title-based: Exact Title+Year Match";
    } else if (normalizedAkaTitles.length > 0) {
        for (const akaTitle of normalizedAkaTitles) {
            if (akaTitle && normalizedItemTitle.includes(akaTitle)) {
                if (metadata.year && yearMatches) {
                    passesTitleMatch = true;
                    debugReason = "Title-based: AKA Title+Year Match";
                    break;
                } else if (!metadata.year) { // AKA title matches, and no year info from metadata to check against
                    passesTitleMatch = true;
                    debugReason = "Title-based: AKA Title Match, no year metadata to compare.";
                    break;
                }
            }
        }
    }
    
    // Fallback to just primary title match if no strong match found (only if metadata title is available)
    if (!passesTitleMatch && normalizedPrimaryTitle && normalizedItemTitle.includes(normalizedPrimaryTitle)) {
        passesTitleMatch = true;
        debugReason = "Title-based: Basic Title Match (no year check or AKA)";
    }
    
    if (!passesTitleMatch) {
        log.debug(`Validation failed: Title-based query, no sufficient title/year match for "${item.Title}". (Reason: ${debugReason})`);
        return false;
    } else {
        log.debug(`Validation passed: Title-based query match for "${item.Title}". (Reason: ${debugReason})`);
    }
  }

  // At this point, title/ID relevance match has passed.
  // Now apply user preferences filters from CURRENT_CONFIG.

  const itemResolution = extractResolution(item.Title) || 'Unknown';
  const itemLanguage = extractLanguage(item.Title) || 'Unknown';
  const itemSize = item.Size || 0;

  const passesSize = config.maxSize === 0 || itemSize <= config.maxSize;
  const passesResolution = config.preferredResolutions.length === 0 ||
                           config.preferredResolutions.includes(itemResolution) ||
                           itemResolution === 'Unknown'; 
  const passesLanguage = config.preferredLanguages.length === 0 ||
                         config.preferredLanguages.includes(itemLanguage) ||
                         itemLanguage === 'Unknown'; 

  if (!passesSize) log.debug(`Validation failed: Size (${formatBytes(itemSize)}) exceeds max size (${formatBytes(config.maxSize)}) for "${item.Title}"`);
  if (!passesResolution) log.debug(`Validation failed: Resolution (${itemResolution}) not preferred for "${item.Title}" (Preferred: ${config.preferredResolutions.join(',')})`);
  if (!passesLanguage) log.debug(`Validation failed: Language (${itemLanguage}) not preferred for "${item.Title}" (Preferred: ${config.preferredLanguages.join(',')})`);

  return passesSize && passesResolution && passesLanguage; 
};

// --- Stremio Addon Endpoints ---

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  log.info('Manifest requested');

  // Update CURRENT_CONFIG based on query parameters from Stremio's config UI
  // Use logical OR to ensure env variables are used if query params are missing (e.g., first load)
  const {
      jackettHost = process.env.JACKETT_URL || CURRENT_CONFIG.jackettUrl,
      jackettApiKey = process.env.JACKETT_API_KEY || CURRENT_CONFIG.jackettApiKey,
      omdbApiKey = process.env.OMDB_API_KEY || CURRENT_CONFIG.omdbApiKey,
      tmdbApiKey = process.env.TMDB_API_KEY || CURRENT_CONFIG.tmdbApiKey,
      preferredResolutions, // Will be string from query, need to parse
      preferredLanguages, // Will be string from query, need to parse
      maxResults, // Will be string from query, need to parse
      maxSize, // Will be string from query, need to parse
      logLevel = process.env.LOG_LEVEL || CURRENT_CONFIG.logLevel,
      publicTrackersUrl = process.env.PUBLIC_TRACKERS_URL || CURRENT_CONFIG.publicTrackersUrl,
      filterBySeeders, // Will be string from query, need to parse
      sortBy // Will be string from query, no parse needed
  } = req.query;

  // Safely parse values, using CURRENT_CONFIG defaults if query parameter is empty/invalid
  CURRENT_CONFIG = {
      jackettUrl: jackettHost,
      jackettApiKey: jackettApiKey,
      omdbApiKey: omdbApiKey,
      tmdbApiKey: tmdbApiKey,
      preferredResolutions: (preferredResolutions !== undefined ? preferredResolutions.split(',').map(item => item.trim()).filter(Boolean) : CURRENT_CONFIG.preferredResolutions),
      preferredLanguages: (preferredLanguages !== undefined ? preferredLanguages.split(',').map(item => item.trim()).filter(Boolean) : CURRENT_CONFIG.preferredLanguages),
      maxResults: parseInt(maxResults, 10) || CURRENT_CONFIG.maxResults,
      maxSize: parseInt(maxSize, 10) || CURRENT_CONFIG.maxSize,
      logLevel: logLevel,
      publicTrackersUrl: publicTrackersUrl,
      filterBySeeders: parseInt(filterBySeeders, 10) || CURRENT_CONFIG.filterBySeeders,
      sortBy: sortBy || CURRENT_CONFIG.sortBy,
  };

  // Initial fetch of trackers with the potentially updated URL
  fetchAndCachePublicTrackers(CURRENT_CONFIG.publicTrackersUrl);

  res.json({
    id: 'community.stremio.jackettaddon.enhanced', 
    version: '1.0.3', // Incremented version after query strategy fix
    name: 'Jackett Enhanced Streams',
    description: 'Advanced filtering and reliable torrent streaming via Jackett, with comprehensive configuration options. Prioritizes title-based searches for better relevance.',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
      {
        type: 'movie',
        id: 'jackett_movies',
        name: 'Jackett Movies',
        extra: [{ name: 'search', isRequired: false }],
      },
      {
        type: 'series',
        id: 'jackett_series',
        name: 'Jackett Series',
        extra: [{ name: 'search', isRequired: false }],
      },
    ],
    idPrefixes: ['tt'], 
    logo: 'https://placehold.co/256x256/007bff/ffffff?text=JE', 
    behaviorHints: {
        configurable: true,
        configuration: [
            {
                key: 'jackettHost',
                type: 'text',
                title: 'Jackett Host URL (e.g., http://localhost:9117)',
                required: true,
                default: CURRENT_CONFIG.jackettUrl
            },
            {
                key: 'jackettApiKey',
                type: 'text',
                title: 'Jackett API Key',
                required: true,
                default: CURRENT_CONFIG.jackettApiKey
            },
            {
                key: 'omdbApiKey',
                type: 'text',
                title: 'OMDb API Key (optional, for metadata)',
                required: false,
                default: CURRENT_CONFIG.omdbApiKey
            },
            {
                key: 'tmdbApiKey',
                type: 'text',
                title: 'TMDb API Key (optional, for metadata & AKA titles)',
                required: false,
                default: CURRENT_CONFIG.tmdbApiKey
            },
            {
                key: 'preferredResolutions',
                type: 'text',
                title: 'Preferred Resolutions (comma-separated, e.g., 2160p,1080p)',
                required: false,
                default: CURRENT_CONFIG.preferredResolutions.join(',')
            },
            {
                key: 'preferredLanguages',
                type: 'text',
                title: 'Preferred Languages (comma-separated, e.g., Tamil,English)',
                required: false,
                default: CURRENT_CONFIG.preferredLanguages.join(',')
            },
            {
                key: 'maxResults',
                type: 'number',
                title: 'Max Results to Show (default: 50, Max: 100)',
                required: false,
                default: CURRENT_CONFIG.maxResults.toString(),
                min: 1,
                max: 100
            },
            {
                key: 'maxSize',
                type: 'number',
                title: 'Max Torrent Size in Bytes (0 for no limit)',
                required: false,
                default: CURRENT_CONFIG.maxSize.toString(),
                min: 0
            },
            {
                key: 'filterBySeeders',
                type: 'number',
                title: 'Minimum Seeders (optional)',
                required: false,
                default: CURRENT_CONFIG.filterBySeeders.toString(),
                min: 0
            },
            {
                key: 'sortBy',
                type: 'select',
                title: 'Sort By',
                options: [
                    { value: 'score', label: 'Best Match Score' }, // Moved to top for default preference
                    { value: 'seeders', label: 'Most Seeders' },
                    { value: 'publishAt', label: 'Recently Published' }
                ],
                required: false,
                default: CURRENT_CONFIG.sortBy
            },
            {
                key: 'publicTrackersUrl',
                type: 'text',
                title: 'GitHub Raw URL for Public Trackers (optional)',
                description: 'e.g., https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt',
                required: false,
                default: CURRENT_CONFIG.publicTrackersUrl
            },
            {
                key: 'logLevel',
                type: 'select',
                title: 'Logging Level',
                options: [
                    { value: 'debug', label: 'Debug' },
                    { value: 'info', label: 'Info' },
                    { value: 'warn', label: 'Warning' },
                    { value: 'error', label: 'Error' },
                    { value: 'silent', label: 'Silent' }
                ],
                required: false,
                default: CURRENT_CONFIG.logLevel
            }
        ]
    }
  });
});

// Catalog endpoint (handles search)
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const { search, skip } = req.query; 

  log.info(`Catalog requested: Type=${type}, ID=${id}, Search=${search}, Skip=${skip}`);

  const config = { ...CURRENT_CONFIG }; 

  let jackettSearchQuery = search;
  let jackettSearchParams = { cat: JACKETT_CATEGORIES[type] }; 
  let metadataForValidation = {};
  let wasIdQueryForValidation = false; 
  const JACKETT_CATALOG_FETCH_LIMIT = 100; 

  if (id.startsWith('tt') && !search) { 
    log.debug(`IMDB ID detected for catalog: ${id}. Attempting metadata lookup for initial search query.`);
    metadataForValidation = await fetchMetadataFromOmdbTmdb(id, config.omdbApiKey, config.tmdbApiKey);
    metadataForValidation.imdbId = id; 
    wasIdQueryForValidation = true; 
    if (metadataForValidation.title) {
      jackettSearchQuery = metadataForValidation.title; 
      jackettSearchParams.imdbid = id; 
    } else {
      log.warn(`Could not get title for IMDB ID ${id} for catalog. Falling back to using IMDB ID as query.`);
      jackettSearchQuery = id; 
    }
  } else if (id.startsWith('jackett:')) {
     jackettSearchQuery = decodeURIComponent(id.substring('jackett:'.length).split('-').slice(0, -1).join(' '));
     metadataForValidation = { title: jackettSearchQuery };
     wasIdQueryForValidation = false;
  } else {
    metadataForValidation = { title: search };
    wasIdQueryForValidation = false;
  }

  if (!jackettSearchQuery) {
    log.debug('No effective search query for catalog, returning empty metas.');
    return res.json({ metas: [] });
  }

  // Build query list for catalog, prioritizing title/aka over direct ID for query to Jackett
  let queries = [];
  if (metadataForValidation.title) {
      queries.push(metadataForValidation.title);
      if (metadataForValidation.year) {
          queries.push(`${metadataForValidation.title} ${metadataForValidation.year}`);
      }
  }
  if (metadataForValidation.akaTitles && metadataForValidation.akaTitles.length > 0) {
      metadataForValidation.akaTitles.forEach(akaTitle => {
          queries.push(akaTitle);
          if (metadataForValidation.year) {
              queries.push(`${akaTitle} ${metadataForValidation.year}`);
          }
      });
  }
  // Fallback to direct ID only if no strong title was resolved
  if (!metadataForValidation.title && metadataForValidation.imdbId) {
      queries.push(metadataForValidation.imdbId);
  }
  if (!metadataForValidation.title && metadataForValidation.tmdbId) {
      queries.push(metadataForValidation.tmdbId.toString());
  }
  queries = [...new Set(queries.filter(q => q && q.trim() !== ''))]; 

  let allJackettResults = [];
  for (const q of queries) {
      try {
          const params = { cat: jackettSearchParams.cat, q: q }; // Always use 'q' for general search
          // Only add imdbid/tmdbid if the query itself is the ID, not for title queries
          if (q.startsWith('tt')) params.imdbid = q; 
          if (q.match(/^\d+$/) && q.length > 5) params.tmdbid = q; // Simple numeric check for TMDB ID
          
          const jackettResponse = await fetchJackettResults(params, config.jackettUrl, config.jackettApiKey, JACKETT_CATALOG_FETCH_LIMIT);
          if (jackettResponse && jackettResponse.Results) {
              allJackettResults = allJackettResults.concat(jackettResponse.Results);
              if (allJackettResults.length >= JACKETT_CATALOG_FETCH_LIMIT) break; // Stop if we have enough raw results
          }
      } catch (error) {
          log.warn(`Error during catalog Jackett search for "${q}": ${error.message}`);
      }
  }
  
  // Deduplicate all results
  const seenGuids = new Set();
  allJackettResults = allJackettResults.filter(item => {
      const uniqueIdentifier = item.guid || item.MagnetUri; 
      if (seenGuids.has(uniqueIdentifier)) { 
          return false;
      }
      seenGuids.add(uniqueIdentifier);
      return true;
  });


  try {
    let processedLinks = [];
    if (allJackettResults.length > 0) {
      // Filter results for quality and preferences before sorting
      const validatedResults = allJackettResults.filter(item => 
        validateJackettResult(item, metadataForValidation, wasIdQueryForValidation, config)
      );

      const resultsWithScore = validatedResults.map(item => {
          const resolution = extractResolution(item.Title) || 'Unknown';
          const language = extractLanguage(item.Title) || 'Unknown';

          return {
              item, 
              id: `jackett:${encodeURIComponent(item.Title.replace(/\s+/g, '-'))}-${item.Seeders}`,
              type: type,
              name: item.Title,
              poster: `https://placehold.co/200x300/007bff/ffffff?text=${encodeURIComponent(item.Title.substring(0, Math.min(item.Title.length, 10)))}`,
              description: `Size: ${formatBytes(item.Size || 0)} | S: ${item.Seeders || 0} | L: ${item.Leechers || 0} | Res: ${resolution} | Lang: ${language}`,
              originalSeeders: item.Seeders || 0,
              originalSize: item.Size || 0,
              resolution: resolution,
              language: language,
              score: calculateMatchScore(item, metadataForValidation),
              publishDate: new Date(item.PublishDate || 0)
          };
      }).filter(Boolean); 

      // Sort results based on user config and new scoring for catalog
      processedLinks = resultsWithScore.sort((a, b) => {
        // 1. Sort by Score (highest first) if sortBy is 'score'
        if (config.sortBy === 'score') {
            if (b.score !== a.score) return b.score - a.score;
        }
        // 2. Then by seeders (more seeders first) if sortBy is 'seeders'
        if (config.sortBy === 'seeders') {
          if (b.originalSeeders !== a.originalSeeders) return b.originalSeeders - a.originalSeeders;
        }
        // 3. Then by PublishDate (latest first) if sortBy is 'publishAt'
        if (config.sortBy === 'publishAt') {
          if (b.publishDate.getTime() !== a.publishDate.getTime()) return b.publishDate.getTime() - a.publishDate.getTime();
        }
        // Fallback sorting: Score, then Seeders, then PublishDate
        if (b.score !== a.score) return b.score - a.score;
        if (b.originalSeeders !== a.originalSeeders) return b.originalSeeders - a.originalSeeders;
        return b.publishDate.getTime() - a.publishDate.getTime();
      })
      .slice(0, config.maxResults); // Apply maxResults after full sorting and filtering
      
      const start = parseInt(skip || '0', 10);
      const end = start + 100; 
      const paginatedResults = processedLinks.slice(start, end);

      res.json({ metas: paginatedResults });
    } else {
      log.info('No results found from Jackett for catalog request after filtering.');
      res.json({ metas: [] });
    }
  } catch (error) {
    log.error('Error in catalog endpoint:', error);
    res.status(500).json({ error: 'Failed to retrieve catalog items.' });
  }
});

// Stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params; 

  log.info(`Stream requested: Type=${type}, ID=${id}`);

  const config = { ...CURRENT_CONFIG }; 

  if (!config.jackettUrl || config.jackettApiKey === 'YOUR_JACKETT_API_KEY') {
    log.error('Jackett URL or API Key not configured. Cannot retrieve streams.');
    return res.status(500).json({ error: 'Jackett configuration missing.' });
  }

  let metadata = {};
  let allJackettResults = [];
  const category = JACKETT_CATEGORIES[type]; 
  let wasIdQuery = false; 
  const JACKETT_STREAM_FETCH_LIMIT = 200; 

  let baseImdbId = id.split(':')[0]; 
  let season = null;
  let episode = null;

  if (type === 'series') {
      const parts = id.split(':');
      if (parts.length >= 3) {
          season = parseInt(parts[1], 10);
          episode = parseInt(parts[2], 10);
          log.debug(`Detected Season: ${season}, Episode: ${episode}`);
      }
  }


  if (baseImdbId.startsWith('tt')) { 
    log.debug(`IMDB ID detected: ${baseImdbId}. Attempting metadata lookup.`);
    metadata = await fetchMetadataFromOmdbTmdb(baseImdbId, config.omdbApiKey, config.tmdbApiKey);
    metadata.imdbId = baseImdbId; 
    wasIdQuery = true; 

    // --- PRIORITIZED JACKETT QUERIES (Revised Strategy) ---
    let queriesToTry = [];
    const maxRelevantResultsThreshold = Math.max(config.maxResults, 10); // Stop if we get a decent number of relevant results

    // 1. Primary Title + Year (for both movies and series)
    if (metadata.title && metadata.year) {
        queriesToTry.push({ q: `${metadata.title} ${metadata.year}`, cat: category });
        if (type === 'series' && season && episode) {
            queriesToTry.push({ q: `${metadata.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`, cat: category });
            queriesToTry.push({ q: `${metadata.title} Season ${season} Episode ${episode}`, cat: category });
        }
    }
    // 2. Primary Title only
    if (metadata.title) {
        queriesToTry.push({ q: metadata.title, cat: category });
        if (type === 'series' && season && episode) {
            queriesToTry.push({ q: `${metadata.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`, cat: category });
        }
    }
    // 3. Alternative Titles + Year
    if (metadata.akaTitles && metadata.akaTitles.length > 0) {
        metadata.akaTitles.forEach(akaTitle => {
            if (metadata.year) {
                queriesToTry.push({ q: `${akaTitle} ${metadata.year}`, cat: category });
                if (type === 'series' && season && episode) {
                    queriesToTry.push({ q: `${akaTitle} ${metadata.year} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`, cat: category });
                }
            }
            // 4. Alternative Titles only
            queriesToTry.push({ q: akaTitle, cat: category });
            if (type === 'series' && season && episode) {
                queriesToTry.push({ q: `${akaTitle} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`, cat: category });
            }
        });
    }

    // Deduplicate query objects to avoid redundant API calls
    const uniqueQueries = [];
    const seenQueryStrings = new Set();
    for (const query of queriesToTry) {
        const queryString = JSON.stringify(query); 
        if (!seenQueryStrings.has(queryString)) {
            uniqueQueries.push(query);
            seenQueryStrings.add(queryString);
        }
    }

    // Execute title-based queries first
    for (const queryParams of uniqueQueries) {
        // Stop if we have enough raw results or if the number of relevant results is already good
        if (allJackettResults.length >= JACKETT_STREAM_FETCH_LIMIT || 
            allJackettResults.filter(item => validateJackettResult(item, metadata, wasIdQuery, config)).length >= maxRelevantResultsThreshold) {
            log.debug(`Stopping title-based queries. Enough raw results or relevant results already found.`);
            break;
        }

        try {
            const jackettResponse = await fetchJackettResults(queryParams, config.jackettUrl, config.jackettApiKey, JACKETT_STREAM_FETCH_LIMIT);
            if (jackettResponse && jackettResponse.Results) {
                allJackettResults = allJackettResults.concat(jackettResponse.Results);
            }
        } catch (error) {
            log.warn(`Failed to fetch Jackett results for title query ${JSON.stringify(queryParams)}: ${error.message}`);
        }
    }

    // 5. Fallback to ID-based search if title-based searches were insufficient
    //    Only if we haven't already hit our overall max fetch limit and don't have enough relevant results
    if (allJackettResults.length < JACKETT_STREAM_FETCH_LIMIT && 
        allJackettResults.filter(item => validateJackettResult(item, metadata, wasIdQuery, config)).length < maxRelevantResultsThreshold) {
        
        // Try IMDB ID search directly
        if (metadata.imdbId) {
            log.debug(`Falling back to Jackett search by IMDB ID: ${metadata.imdbId}`);
            try {
                const params = { imdbid: metadata.imdbId, cat: category };
                if (type === 'series' && season && episode) {
                    params.season = season;
                    params.ep = episode;
                }
                const jackettResponse = await fetchJackettResults(params, config.jackettUrl, config.jackettApiKey, JACKETT_STREAM_FETCH_LIMIT);
                if (jackettResponse && jackettResponse.Results) {
                    allJackettResults = allJackettResults.concat(jackettResponse.Results);
                }
            } catch (error) {
                log.warn(`Error during fallback IMDB ID search for ${metadata.imdbId}: ${error.message}`);
            }
        }
    }

    if (allJackettResults.length < JACKETT_STREAM_FETCH_LIMIT && 
        allJackettResults.filter(item => validateJackettResult(item, metadata, wasIdQuery, config)).length < maxRelevantResultsThreshold) {
        // Try TMDB ID search directly
        if (metadata.tmdbId) {
            log.debug(`Falling back to Jackett search by TMDB ID: ${metadata.tmdbId}`);
            try {
                const params = { tmdbid: metadata.tmdbId, cat: category };
                if (type === 'series' && season && episode) {
                    params.season = season;
                    params.ep = episode;
                }
                const jackettResponse = await fetchJackettResults(params, config.jackettUrl, config.jackettApiKey, JACKETT_STREAM_FETCH_LIMIT);
                if (jackettResponse && jackettResponse.Results) {
                    allJackettResults = allJackettResults.concat(jackettResponse.Results);
                }
            } catch (error) {
                log.warn(`Error during fallback TMDB ID search for ${metadata.tmdbId}: ${error.message}`);
            }
        }
    }
    
    // Final check/fallback: Original Stremio ID as a raw query if nothing else worked
    if (allJackettResults.length < JACKETT_STREAM_FETCH_LIMIT && 
        allJackettResults.filter(item => validateJackettResult(item, metadata, wasIdQuery, config)).length < maxRelevantResultsThreshold &&
        id && id.trim() !== '' && !id.startsWith('jackett:')) { 
        log.warn(`Still not enough results. Final fallback: using original Stremio ID "${id}" as general query.`);
        try {
            const params = { q: id, cat: category };
            if (type === 'series' && season && episode) {
                params.season = season;
                params.ep = episode;
            }
            const jackettResponse = await fetchJackettResults(params, config.jackettUrl, config.jackettApiKey, JACKETT_STREAM_FETCH_LIMIT);
            if (jackettResponse && jackettResponse.Results) {
                allJackettResults = allJackettResults.concat(jackettResponse.Results);
            }
        } catch (error) {
            log.warn(`Error during final fallback using raw Stremio ID as query: ${error.message}`);
        }
    }

  } else if (id.startsWith('jackett:')) {
    const originalTitle = decodeURIComponent(id.substring('jackett:'.length).split('-').slice(0, -1).join(' '));
    log.debug(`Custom Jackett ID detected. Searching by original title: "${originalTitle}"`);
    const jackettResponse = await fetchJackettResults({ q: originalTitle, cat: category }, config.jackettUrl, config.jackettApiKey, JACKETT_STREAM_FETCH_LIMIT);
    allJackettResults = jackettResponse?.Results || [];
    metadata = { title: originalTitle }; 
    wasIdQuery = false;
  } else {
    log.warn(`Non-IMDB/Jackett custom ID received: ${id}. Using ID directly as search query.`);
    const jackettResponse = await fetchJackettResults({ q: id, cat: category }, config.jackettUrl, config.jackettApiKey, JACKETT_STREAM_FETCH_LIMIT);
    allJackettResults = jackettResponse?.Results || [];
    metadata = { title: id }; 
    wasIdQuery = false;
  }

  // Deduplicate all results again after merging from multiple queries
  const finalSeenGuids = new Set();
  allJackettResults = allJackettResults.filter(item => {
      const uniqueIdentifier = item.guid || item.MagnetUri; 
      if (finalSeenGuids.has(uniqueIdentifier)) { 
          return false;
      }
      finalSeenGuids.add(uniqueIdentifier);
      return true;
  });


  let streams = [];
  if (allJackettResults.length > 0) {
    // Filter results for quality and preferences
    const validatedResults = allJackettResults.filter(item => 
      validateJackettResult(item, metadata, wasIdQuery, config)
    );

    // Filter by minimum seeders from config
    const filteredBySeeders = validatedResults.filter(item => item.Seeders >= config.filterBySeeders);
    log.info(`Filtered down to ${filteredBySeeders.length} results after min seeders (${config.filterBySeeders})`);

    const resultsWithScore = filteredBySeeders.map(item => ({
        item,
        score: calculateMatchScore(item, metadata), 
        resolution: extractResolution(item.Title) || 'Unknown',
        language: extractLanguage(item.Title) || 'Unknown',
        originalSeeders: item.Seeders || 0,
        originalSize: item.Size || 0,
        publishDate: new Date(item.PublishDate || 0)
    }));

    // Sort based on user's sortBy preference
    const sortedAndScoredResults = resultsWithScore.sort((a, b) => {
        if (config.sortBy === 'score') {
            if (b.score !== a.score) return b.score - a.score;
        }
        if (config.sortBy === 'seeders') {
            if (b.originalSeeders !== a.originalSeeders) return b.originalSeeders - a.originalSeeders;
        }
        if (config.sortBy === 'publishAt') {
            if (b.publishDate.getTime() !== a.publishDate.getTime()) return b.publishDate.getTime() - a.publishDate.getTime();
        }
        // Fallback for ties or if sortBy isn't one of the main options
        if (b.score !== a.score) return b.score - a.score;
        if (b.originalSeeders !== a.originalSeeders) return b.originalSeeders - a.originalSeeders;
        return b.publishDate.getTime() - a.publishDate.getTime();
    })
    .slice(0, config.maxResults); // Apply user's maxResults after full sorting and filtering

    // Fetch trackers once for all streams
    const currentTrackers = await fetchAndCachePublicTrackers(config.publicTrackersUrl);

    for (const link of sortedAndScoredResults) {
        const stremioStream = createStremioStream(link.item, type, link.item.MagnetUri, currentTrackers);
        if (stremioStream) {
            streams.push(stremioStream);
        }
    }
  }

  log.info(`[STREMIO RESPONSE] Sending ${streams.length} streams to Stremio for ID: ${id}`);
  log.debug(`[STREMIO RESPONSE] Full streams array for ID ${id}:`, JSON.stringify(streams, null, 2));
  res.json({ streams: streams });
});

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Start the server
app.listen(PORT, () => {
  log.info(`Stremio Jackett Addon (Node.js) listening on port ${PORT}`);
  log.info(`Manifest URL: http://localhost:${PORT}/manifest.json`);
  log.info(`Jackett URL: ${CURRENT_CONFIG.jackettUrl}`);
  log.info(`Jackett API Key: ${CURRENT_CONFIG.jackettApiKey.substring(0, Math.min(CURRENT_CONFIG.jackettApiKey.length, 5))}...`);
  log.info(`OMDB API Key: ${CURRENT_CONFIG.omdbApiKey === 'YOUR_OMDB_API_KEY' ? 'YOUR_OMDB_API_KEY' : CURRENT_CONFIG.omdbApiKey.substring(0, Math.min(CURRENT_CONFIG.omdbApiKey.length, 5)) + '...'}`);
  log.info(`TMDB API Key: ${CURRENT_CONFIG.tmdbApiKey === 'YOUR_TMDB_API_KEY' ? 'YOUR_TMDB_API_KEY' : CURRENT_CONFIG.tmdbApiKey.substring(0, Math.min(CURRENT_CONFIG.tmdbApiKey.length, 5)) + '...'}`);
  log.info(`Public Trackers URL: ${CURRENT_CONFIG.publicTrackersUrl}`);
  log.info(`Logging Level: ${CURRENT_CONFIG.logLevel}`);
});


