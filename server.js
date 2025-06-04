// server.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fetch = require('node-fetch'); // Required for fetching trackers and Jackett API
const parseTorrent = require('parse-torrent'); // Required for parsing magnet URIs

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 7000; // Default port for Stremio addons

// Enable CORS for all routes
app.use(cors());
app.use(express.json()); // For parsing application/json

// Serve static files from the 'public' directory for the configuration UI
app.use(express.static('public'));

// --- Constants and Utility Functions ---

// Default configuration for the addon
// These can be overridden by environment variables in production
const DEFAULT_CONFIG = {
  jackettUrl: process.env.JACKETT_URL || 'http://localhost:9117',
  jackettApiKey: process.env.JACKETT_API_KEY || 'YOUR_JACKETT_API_KEY',
  omdbApiKey: process.env.OMDB_API_KEY || 'YOUR_OMDB_API_KEY', // New: OMDB API Key
  tmdbApiKey: process.env.TMDB_API_KEY || 'YOUR_TMDB_API_KEY', // New: TMDB API Key
  preferredResolutions: (process.env.PREFERRED_RESOLUTIONS || '2160p,1080p,720p').split(',').map(item => item.trim()).filter(Boolean),
  preferredLanguages: (process.env.PREFERRED_LANGUAGES || 'Tamil,Hindi,Malayalam,Telugu,English,Japanese,Korean,Chinese').split(',').map(item => item.trim()).filter(Boolean),
  maxResults: parseInt(process.env.MAX_RESULTS || '50', 10),
  maxSize: parseInt(process.env.MAX_SIZE || '0', 10), // New: Max size in bytes (0 means no restriction)
  // Logging level: 'debug', 'info', 'warn', 'error', 'silent'
  logLevel: process.env.LOG_LEVEL || 'info', 
  publicTrackersUrl: process.env.PUBLIC_TRACKERS_URL || 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt', // Default public trackers URL
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
    if (LOG_LEVELS[DEFAULT_CONFIG.logLevel] <= LOG_LEVELS.debug) console.log('[DEBUG]', ...args);
  },
  info: (...args) => {
    if (LOG_LEVELS[DEFAULT_CONFIG.logLevel] <= LOG_LEVELS.info) console.log('[INFO]', ...args);
  },
  warn: (...args) => {
    if (LOG_LEVELS[DEFAULT_CONFIG.logLevel] <= LOG_LEVELS.warn) console.warn('[WARN]', ...args);
  },
  error: (...args) => {
    if (LOG_LEVELS[DEFAULT_CONFIG.logLevel] <= LOG_LEVELS.error) console.error('[ERROR]', ...args);
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
const fetchAndCachePublicTrackers = async () => {
  const currentTime = Date.now();
  // If cache is not empty and still fresh, return cached trackers
  if (cachedPublicTrackers.length > 0 && (currentTime - lastTrackersFetchTime < TRACKER_CACHE_TTL)) {
    log.debug('Using cached public trackers (still fresh).');
    return cachedPublicTrackers;
  }

  log.info('Fetching public trackers from URL:', DEFAULT_CONFIG.publicTrackersUrl);

  try {
    const response = await fetch(DEFAULT_CONFIG.publicTrackersUrl);
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
      // If fetched list is empty, don't update cache time, and potentially use old cache
    }
    return cachedPublicTrackers; // Return the newly fetched or existing cached trackers
  } catch (error) {
    log.error('Error fetching public trackers:', error.message);
    // If fetch fails, use the existing cached list if available.
    // If cache is also empty (e.g., first run and fetch failed), it will be an empty array.
    log.warn('Using existing cached public trackers or empty list due to fetch error.');
    return cachedPublicTrackers; 
  }
};

// Initial fetch on startup
fetchAndCachePublicTrackers();

// Schedule periodic refresh of public trackers
setInterval(fetchAndCachePublicTrackers, TRACKER_CACHE_TTL);


// Regex patterns for resolution and language extraction from torrent titles
const RESOLUTION_PATTERNS = {
  '2160p': /(2160p|4K|UHD)/i,
  '1080p': /(1080p|FHD)/i,
  '720p': /(720p|HD)/i,
  '480p': /(480p|SD)/i,
};

const LANGUAGE_PATTERNS = {
  'English': /(eng|english)/i,
  'Hindi': /(hin|hindi|हिंदी)/i,
  'Tamil': /(tam|tamil|தமிழ்)/i,
  'Malayalam': /(mal|malayalam|മലയാളം)/i,
  'Telugu': /(tel|telugu|తెలుగు)/i,
  'Japanese': /(jpn|japanese|日本語)/i,
  'Korean': /(kor|korean|한국어)/i,
  'Chinese': /(chi|chinese|中文|普通话)/i,
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
    const newTrackers = trackersToUse.filter(tracker => !existingTrackers.includes(tracker));
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
 * @returns {Promise<object>} An object containing metadata like title, year, akaTitles, tmdbId.
 */
const fetchMetadataFromOmdbTmdb = async (imdbId) => {
  let metadata = { title: null, year: null, akaTitles: [], tmdbId: null };
  
  // 1. Try OMDB first
  if (DEFAULT_CONFIG.omdbApiKey && DEFAULT_CONFIG.omdbApiKey !== 'YOUR_OMDB_API_KEY') {
    log.debug(`Fetching OMDB metadata for IMDB ID: ${imdbId}`);
    try {
      const omdbUrl = `https://www.omdbapi.com/?i=${imdbId}&apikey=${DEFAULT_CONFIG.omdbApiKey}`;
      const omdbResponse = await fetch(omdbUrl);
      const omdbData = await omdbResponse.json();
      if (omdbData && omdbData.Response === 'True') {
        metadata.title = omdbData.Title;
        metadata.year = omdbData.Year;
        // OMDB doesn't typically provide 'aka titles' directly in a structured way for search
        log.debug(`OMDB metadata found: ${JSON.stringify(metadata)}`);
        return metadata; // Return immediately if OMDB provides enough info
      } else {
        log.warn(`OMDB did not return valid data for ${imdbId}: ${omdbData.Error || 'Unknown error'}`);
      }
    } catch (error) {
      log.error(`Error fetching from OMDB for ${imdbId}: ${error.message}`);
    }
  } else {
    log.warn('OMDB API Key not configured or is default. Skipping OMDB lookup.');
  }

  // 2. Fallback to TMDB if OMDB fails or not configured
  if (DEFAULT_CONFIG.tmdbApiKey && DEFAULT_CONFIG.tmdbApiKey !== 'YOUR_TMDB_API_KEY') {
    log.debug(`Fetching TMDB metadata for IMDB ID: ${imdbId}`);
    try {
      // TMDB requires a find endpoint to convert IMDB ID to TMDB ID
      const tmdbFindUrl = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${DEFAULT_CONFIG.tmdbApiKey}&external_source=imdb_id`;
      const tmdbFindResponse = await fetch(tmdbFindUrl);
      const tmdbFindData = await tmdbFindResponse.json();

      let tmdbId = null;
      let mediaType = null;

      if (tmdbFindData.movie_results && tmdbFindData.movie_results.length > 0) {
        tmdbId = tmdbFindData.movie_results[0].id;
        mediaType = 'movie';
        metadata.title = tmdbFindData.movie_results[0].title;
        metadata.year = tmdbFindData.movie_results[0].release_date ? tmdbFindData.movie_results[0].release_date.substring(0, 4) : null;
      } else if (tmdbFindData.tv_results && tmdbFindData.tv_results.length > 0) {
        tmdbId = tmdbFindData.tv_results[0].id;
        mediaType = 'tv';
        metadata.title = tmdbFindData.tv_results[0].name;
        metadata.year = tmdbFindData.tv_results[0].first_air_date ? tmdbFindData.tv_results[0].first_air_date.substring(0, 4) : null;
      }

      if (tmdbId && mediaType) {
        // Fetch alternative titles
        const tmdbAltTitlesUrl = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/alternative_titles?api_key=${DEFAULT_CONFIG.tmdbApiKey}`;
        const tmdbAltTitlesResponse = await fetch(tmdbAltTitlesUrl);
        const tmdbAltTitlesData = await tmdbAltTitlesResponse.json();
        if (tmdbAltTitlesData.results) {
          metadata.akaTitles = tmdbAltTitlesData.results.map(t => t.title).filter(Boolean);
        }
        metadata.tmdbId = tmdbId; // Store TMDB ID for potential Jackett query
        log.debug(`TMDB metadata found: ${JSON.stringify(metadata)}`);
      } else {
        log.warn(`TMDB did not find results for IMDB ID: ${imdbId}`);
      }
    } catch (error) {
      log.error(`Error fetching from TMDB for ${imdbId}: ${error.message}`);
    }
  } else {
    log.warn('TMDB API Key not configured or is default. Skipping TMDB lookup.');
  }

  return metadata; // Return whatever was found, or empty object
};


/**
 * Fetches results from the actual Jackett API.
 * @param {object} searchParams - An object containing parameters for the Jackett query (e.g., q, cat, imdbid, tmdbid).
 * @param {object} config - The addon configuration.
 * @returns {Promise<Array>} A promise that resolves to an array of Jackett torrent results.
 */
const fetchJackettResults = async (searchParams, config) => {
  if (!config.jackettUrl || config.jackettApiKey === 'YOUR_JACKETT_API_KEY') {
    log.error('Jackett URL or API Key not configured. Cannot fetch from Jackett.');
    throw new Error('Jackett URL or API Key is not configured.');
  }

  const jackettApiUrl = new URL(`${config.jackettUrl}/api/v2.0/indexers/all/results/torznab/api`);
  jackettApiUrl.searchParams.append('apikey', config.jackettApiKey);
  jackettApiUrl.searchParams.append('o', 'json');
  jackettApiUrl.searchParams.append('limit', config.maxResults); // Limit results from Jackett

  // Add search parameters dynamically
  if (searchParams.q) jackettApiUrl.searchParams.append('q', searchParams.q);
  if (searchParams.cat) jackettApiUrl.searchParams.append('cat', searchParams.cat);
  if (searchParams.imdbid) jackettApiUrl.searchParams.append('imdbid', searchParams.imdbid);
  if (searchParams.tmdbid) jackettApiUrl.searchParams.append('tmdbid', searchParams.tmdbid);
  // Jackett doesn't directly support 'year' or 'akaTitle' as separate parameters
  // These are handled by constructing the 'q' parameter in the calling function.

  log.debug(`Fetching from Jackett: ${jackettApiUrl.toString()}`);

  try {
    const response = await fetch(jackettApiUrl.toString());
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jackett API responded with status ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    log.debug('Jackett raw response:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    log.error('Error fetching from Jackett API:', error.message);
    throw error;
  }
};


/**
 * Utility function to create a Stremio stream object from a Jackett torrent item and magnet URI.
 * This function adheres to the provided code snippet for formatting.
 * @param {object} tor - The Jackett torrent item object.
 * @param {string} type - The Stremio content type ('movie' or 'series').
 * @param {string} magnetUri - The magnet URI for the torrent.
 * @returns {object|null} The formatted Stremio stream object or null if parsing fails.
 */
const createStremioStream = (tor, type, magnetUri) => {
    let parsedTorrent;
    try {
        parsedTorrent = parseTorrent(magnetUri);
    } catch (e) {
        log.error(`Error parsing magnet URI for stream: ${e.message}. URI: ${magnetUri}`);
        return null; // Return null if magnet URI is invalid
    }

    const infoHash = parsedTorrent.infoHash.toLowerCase();

    // Use Jackett's Title as the base for the stream's display title
    let title = tor.Title; 

    // Extract resolution and language for the subtitle
    const resolution = extractResolution(tor.Title) || 'Unknown';
    const language = extractLanguage(tor.Title) || 'Unknown';

    // Construct the subtitle string
    let subtitleParts = [];
    if (tor.Seeders !== undefined) subtitleParts.push(`S: ${tor.Seeders}`);
    if (tor.Leechers !== undefined) subtitleParts.push(`L: ${tor.Leechers}`);
    if (resolution !== 'Unknown') subtitleParts.push(resolution);
    if (language !== 'Unknown') subtitleParts.push(language);
    if (tor.Size) subtitleParts.push(formatBytes(tor.Size));

    const subtitle = subtitleParts.join(' / '); // Use '/' as in the example snippet for subtitle

    // Combine title and subtitle
    // The snippet uses '\r\n\r\n' for newlines, which is fine for display in Stremio
    title += (title.indexOf('\n') > -1 ? '\r\n' : '\r\n\r\n') + subtitle;

    // Prepare sources: existing announces from parsed torrent + enriched trackers
    const existingSources = (parsedTorrent.announce || []).map(x => `tracker:${x}`);
    const enrichedTrackers = enrichMagnetUri(magnetUri).split('&tr=')
                                .slice(1) // Remove the magnet:?xt=... part
                                .map(t => `tracker:${decodeURIComponent(t)}`);
    
    // Combine all sources and ensure uniqueness
    const allSources = [...new Set([...existingSources, ...enrichedTrackers, `dht:${infoHash}`])];

    return {
        name: tor.Tracker || 'Jackett', // Use the tracker name from Jackett result, or 'Jackett'
        type: type,
        infoHash: infoHash,
        sources: allSources,
        title: title
    };
};


// --- Stremio Addon Endpoints ---

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
  log.info('Manifest requested');
  res.json({
    id: 'community.stremio.jackettaddon',
    version: '1.0.0',
    name: 'Jackett Enhanced Addon (Node.js)',
    description: 'Advanced filtering for your Stremio experience via Jackett. (Node.js version)',
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
    idPrefixes: ['tt'], // Assuming we can extract IMDB IDs from Jackett results
    logo: 'https://placehold.co/256x256/007bff/ffffff?text=JA', // Placeholder logo
  });
});

// Endpoint to expose current configuration for the web UI
app.get('/config', (req, res) => {
  // Return a copy of the current effective configuration
  // Mask the API keys for security
  const displayConfig = { ...DEFAULT_CONFIG };
  displayConfig.jackettApiKey = displayConfig.jackettApiKey === 'YOUR_JACKETT_API_KEY' ? 'YOUR_JACKETT_API_KEY' : '******** (hidden)';
  displayConfig.omdbApiKey = displayConfig.omdbApiKey === 'YOUR_OMDB_API_KEY' ? 'YOUR_OMDB_API_KEY' : '******** (hidden)';
  displayConfig.tmdbApiKey = displayConfig.tmdbApiKey === 'YOUR_TMDB_API_KEY' ? 'YOUR_TMDB_API_KEY' : '******** (hidden)';
  res.json(displayConfig);
});


// Catalog endpoint (handles search)
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const { search, skip } = req.query; // Stremio sends 'search' and 'skip' parameters

  log.info(`Catalog requested: Type=${type}, ID=${id}, Search=${search}, Skip=${skip}`);

  let jackettSearchQuery = search;
  let jackettSearchParams = { cat: type === 'movie' ? '2000' : '5000' };

  // If Stremio provides an IMDB ID for the catalog, try to use it for a more precise search
  if (id.startsWith('tt') && !search) { 
    log.debug(`IMDB ID detected for catalog: ${id}. Attempting metadata lookup for initial search query.`);
    const metadata = await fetchMetadataFromOmdbTmdb(id);
    if (metadata.title) {
      jackettSearchQuery = metadata.title; // Use the main title for the catalog search
      jackettSearchParams.imdbid = id; // Also pass IMDB ID to Jackett if it supports it directly
    } else {
      log.warn(`Could not get title for IMDB ID ${id} for catalog. Falling back to using IMDB ID as query.`);
      jackettSearchQuery = id; // Fallback to IMDB ID itself as query
    }
  } else if (id.startsWith('jackett:')) {
     // Custom ID from our catalog, extract original title
     jackettSearchQuery = id.substring('jackett:'.length).split('-').slice(0, -1).join(' ');
  }

  if (!jackettSearchQuery) {
    log.debug('No effective search query for catalog, returning empty metas.');
    return res.json({ metas: [] });
  }

  jackettSearchParams.q = jackettSearchQuery; // Set the main query parameter

  try {
    const jackettResponse = await fetchJackettResults(jackettSearchParams, DEFAULT_CONFIG);

    let processedLinks = [];
    if (jackettResponse && jackettResponse.Results) {
      // First, sort by PublishDate (latest first)
      const sortedByDate = jackettResponse.Results.sort((a, b) => {
        const dateA = new Date(a.PublishDate || 0);
        const dateB = new Date(b.PublishDate || 0);
        return dateB.getTime() - dateA.getTime(); // Latest date first
      });

      processedLinks = sortedByDate
        .map(item => {
          // Ensure MagnetUri exists before processing
          if (!item.MagnetUri) {
              log.warn(`Skipping catalog item due to missing MagnetUri: ${item.Title}`);
              return null;
          }
          const resolution = extractResolution(item.Title);
          const language = extractLanguage(item.Title);
          
          return {
            id: `jackett:${item.Title.replace(/\s+/g, '-')}-${item.Seeders}`, // Unique ID for the item
            type: type,
            name: item.Title,
            poster: `https://placehold.co/200x300/007bff/ffffff?text=${encodeURIComponent(item.Title.substring(0,10))}`, // Placeholder poster
            description: `Size: ${formatBytes(item.Size || 0)} | Seeders: ${item.Seeders || 0} | Leechers: ${item.Leechers || 0} | Resolution: ${resolution || 'Unknown'} | Language: ${language || 'Unknown'}`,
            originalSeeders: item.Seeders || 0, // Keep original seeders for sorting
            originalSize: item.Size || 0, // Keep original size for filtering
            resolution: resolution, // Add resolution and language for filtering
            language: language,
          };
        })
        .filter(Boolean) // Remove nulls from map (items with missing MagnetUri)
        .filter(link => {
          // Apply size restriction filter
          const passesSize = DEFAULT_CONFIG.maxSize === 0 || link.originalSize <= DEFAULT_CONFIG.maxSize;

          // Apply resolution filter
          const passesResolution = DEFAULT_CONFIG.preferredResolutions.length === 0 ||
                                   DEFAULT_CONFIG.preferredResolutions.includes(link.resolution) ||
                                   link.resolution === 'Unknown';
          // Apply language filter
          const passesLanguage = DEFAULT_CONFIG.preferredLanguages.length === 0 ||
                                 DEFAULT_CONFIG.preferredLanguages.includes(link.language) ||
                                 link.language === 'Unknown';

          return passesSize && passesResolution && passesLanguage;
        })
        .sort((a, b) => {
          // Sort by preferred resolution first (higher preference first)
          const resOrder = DEFAULT_CONFIG.preferredResolutions.concat(['Unknown']).reverse(); // Reverse to put preferred resolutions first
          const aResIndex = resOrder.indexOf(a.resolution);
          const bResIndex = resOrder.indexOf(b.resolution);
          if (aResIndex !== bResIndex) {
            return aResIndex - bResIndex; // Lower index (higher preference) comes first
          }

          // Then by seeders (more seeders first)
          return b.originalSeeders - a.originalSeeders;
        })
        .slice(0, DEFAULT_CONFIG.maxResults); // Limit results

      // Implement pagination based on 'skip'
      const start = parseInt(skip || '0', 10);
      const end = start + 100; // Stremio requests 100 items per page
      const paginatedResults = processedLinks.slice(start, end);

      res.json({ metas: paginatedResults });
    } else {
      log.info('No results found from Jackett for catalog request.');
      res.json({ metas: [] });
    }
  } catch (error) {
    log.error('Error in catalog endpoint:', error);
    res.status(500).json({ error: 'Failed to retrieve catalog items.' });
  }
});

// Stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params; // id here is the videoId (e.g., 'tt1234567' or 'jackett:Movie-Title-1200')

  log.info(`Stream requested: Type=${type}, ID=${id}`);

  if (!DEFAULT_CONFIG.jackettUrl || DEFAULT_CONFIG.jackettApiKey === 'YOUR_JACKETT_API_KEY') {
    log.error('Jackett URL or API Key not configured. Cannot retrieve streams.');
    return res.status(500).json({ error: 'Jackett configuration missing.' });
  }

  let metadata = {};
  let jackettSearchQueries = []; // Array of search parameter objects for Jackett

  if (id.startsWith('tt')) { // IMDB ID
    log.debug(`IMDB ID detected: ${id}. Attempting metadata lookup.`);
    metadata = await fetchMetadataFromOmdbTmdb(id);
    
    // Construct search queries based on metadata with fallback strategy
    const category = type === 'movie' ? '2000' : '5000';

    // 1. Title
    if (metadata.title) {
        jackettSearchQueries.push({ q: metadata.title, cat: category });
        // 2. Title + Year
        if (metadata.year) {
            jackettSearchQueries.push({ q: `${metadata.title} ${metadata.year}`, cat: category });
        }
    }
    
    // 3. AKA Titles
    if (metadata.akaTitles && metadata.akaTitles.length > 0) {
        metadata.akaTitles.forEach(akaTitle => {
            jackettSearchQueries.push({ q: akaTitle, cat: category });
            // 4. AKA Titles + Year
            if (metadata.year) {
                jackettSearchQueries.push({ q: `${akaTitle} ${metadata.year}`, cat: category });
            }
        });
    }

    // 5. IMDB ID as direct search (Jackett supports this)
    jackettSearchQueries.push({ imdbid: id, cat: category });
    
    // 6. TMDB ID as direct search (Jackett supports this)
    if (metadata.tmdbId) {
        jackettSearchQueries.push({ tmdbid: metadata.tmdbId, cat: category });
    }

    // Ensure there's at least one query, even if metadata lookup fails
    if (jackettSearchQueries.length === 0) {
        log.warn(`No specific metadata found for IMDB ID ${id}. Falling back to using IMDB ID as query.`);
        jackettSearchQueries.push({ q: id, cat: category });
    }

  } else if (id.startsWith('jackett:')) {
    // Custom ID from our catalog, extract original title
    const originalTitle = id.substring('jackett:'.length).split('-').slice(0, -1).join(' ');
    jackettSearchQueries.push({ q: originalTitle, cat: type === 'movie' ? '2000' : '5000' });
  } else {
    // Fallback for other IDs (e.g., if Stremio sends a generic title directly)
    log.warn(`Non-IMDB/Jackett custom ID received: ${id}. Using ID directly as search query.`);
    jackettSearchQueries.push({ q: id, cat: type === 'movie' ? '2000' : '5000' });
  }

  let allJackettResults = [];
  // Iterate through search queries until enough results are found or all queries exhausted
  for (const queryParams of jackettSearchQueries) {
    try {
      const jackettResponse = await fetchJackettResults(queryParams, DEFAULT_CONFIG);
      if (jackettResponse && jackettResponse.Results) {
        allJackettResults = allJackettResults.concat(jackettResponse.Results);
        // Stop querying if we have enough results based on maxResults config
        if (allJackettResults.length >= DEFAULT_CONFIG.maxResults) {
            log.debug(`Reached maxResults (${DEFAULT_CONFIG.maxResults}) after query: ${JSON.stringify(queryParams)}`);
            break; 
        }
      }
    } catch (error) {
      log.warn(`Failed to fetch Jackett results for query ${JSON.stringify(queryParams)}: ${error.message}`);
    }
  }

  let streams = [];
  if (allJackettResults.length > 0) {
    // First, sort by PublishDate (latest first)
    const sortedByDate = allJackettResults.sort((a, b) => {
      const dateA = new Date(a.PublishDate || 0);
      const dateB = new Date(b.PublishDate || 0);
      return dateB.getTime() - dateA.getTime(); // Latest date first
    });

    const processedLinks = sortedByDate
      .map(item => {
        // Jackett's MagnetUri might sometimes be empty or invalid, filter these out early
        if (!item.MagnetUri) {
            log.warn(`Skipping stream item due to missing MagnetUri: ${item.Title}`);
            return null;
        }
        // Keep original item for other properties like Seeders, Size
        return {
          item, 
          resolution: extractResolution(item.Title) || 'Unknown',
          language: extractLanguage(item.Title) || 'Unknown',
          originalSeeders: item.Seeders || 0,
          originalSize: item.Size || 0, // Keep original size for filtering
        };
      })
      .filter(Boolean) // Remove nulls from map (items with missing MagnetUri)
      .filter(link => {
        // Apply size restriction filter
        const passesSize = DEFAULT_CONFIG.maxSize === 0 || link.originalSize <= DEFAULT_CONFIG.maxSize;

        // Apply resolution filter
        const passesResolution = DEFAULT_CONFIG.preferredResolutions.length === 0 ||
                                 DEFAULT_CONFIG.preferredResolutions.includes(link.resolution) ||
                                 link.resolution === 'Unknown';
        // Apply language filter
        const passesLanguage = DEFAULT_CONFIG.preferredLanguages.length === 0 ||
                               DEFAULT_CONFIG.preferredLanguages.includes(link.language) ||
                               link.language === 'Unknown';
        return passesSize && passesResolution && passesLanguage;
      })
      .sort((a, b) => {
        // Sort by preferred resolution first (higher preference first)
        const resOrder = DEFAULT_CONFIG.preferredResolutions.concat(['Unknown']).reverse();
        const aResIndex = resOrder.indexOf(a.resolution);
        const bResIndex = resOrder.indexOf(b.resolution);
        if (aResIndex !== bResIndex) {
          return aResIndex - bResIndex;
        }
        // Then by seeders (more seeders first)
        return b.originalSeeders - a.originalSeeders;
      })
      .slice(0, DEFAULT_CONFIG.maxResults); // Limit results

    for (const link of processedLinks) {
        // Use the createStremioStream utility to format the stream object
        const stremioStream = createStremioStream(link.item, type, link.item.MagnetUri);
        if (stremioStream) {
            streams.push(stremioStream);
        }
    }
  }

  res.json({ streams: streams });
});

// Start the server
app.listen(PORT, () => {
  log.info(`Stremio Jackett Addon (Node.js) listening on port ${PORT}`);
  log.info(`Manifest URL: http://localhost:${PORT}/manifest.json`);
  log.info(`Jackett URL: ${DEFAULT_CONFIG.jackettUrl}`);
  log.info(`Jackett API Key: ${DEFAULT_CONFIG.jackettApiKey.substring(0, 5)}...`);
  log.info(`OMDB API Key: ${DEFAULT_CONFIG.omdbApiKey === 'YOUR_OMDB_API_KEY' ? 'YOUR_OMDB_API_KEY' : DEFAULT_CONFIG.omdbApiKey.substring(0, 5) + '...'}`);
  log.info(`TMDB API Key: ${DEFAULT_CONFIG.tmdbApiKey === 'YOUR_TMDB_API_KEY' ? 'YOUR_TMDB_API_KEY' : DEFAULT_CONFIG.tmdbApiKey.substring(0, 5) + '...'}`);
  log.info(`Public Trackers URL: ${DEFAULT_CONFIG.publicTrackersUrl}`);
  log.info(`Logging Level: ${DEFAULT_CONFIG.logLevel}`);
});


