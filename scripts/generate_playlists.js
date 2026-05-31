/**
 * generate_playlists.js
 * Parses AJN RSS feed and generates JSON/M3U8 playlists for Clapper UI
 * Runs via GitHub Actions on schedule
 * * Features:
 * - Fetches RSS feed from rss.alexjones.media
 * - Generates JSON and M3U8 formats (matched to Clapper frontend schema)
 * - Maintains 300-file rolling window (database and JSON array)
 * - Archives old playlists to GitHub
 * - Updates SQLite tracking database
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const { Octokit } = require('@octokit/rest');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  RSS_FEED_URL: 'https://rss.alexjones.media/AJNHourlyVideo.html',
  VIDEO_BASE_URL: 'https://media.alexjones.media', 
  
  DATABASE_PATH: './data/playlists.db',
  OUTPUT_DIR: './playlists',
  ARCHIVE_DIR: './playlists/archive',
  
  MAX_VIDEOS: 300,
  TARGET_VIDEO_DURATION: 3600, // 1 hour
};

// ============================================================================
// LOGGER & UTILS
// ============================================================================

class Logger {
  log(level, message, data = null) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level}]`, message, data ? JSON.stringify(data) : '');
  }
  info(msg, data) { this.log('INFO', msg, data); }
  warn(msg, data) { this.log('WARN', msg, data); }
  error(msg, data) { this.log('ERROR', msg, data); }
}
const logger = new Logger();

function fetchUrl(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseAJNDate(dateString) {
  try {
    const match = dateString.match(/(\d{4})-(\w+)-(\d{2})/);
    if (!match) return new Date();
    const [, year, month, day] = match;
    const monthMap = { 'Jan':0, 'Feb':1, 'Mar':2, 'Apr':3, 'May':4, 'Jun':5, 'Jul':6, 'Aug':7, 'Sep':8, 'Oct':9, 'Nov':10, 'Dec':11 };
    return new Date(year, monthMap[month], day);
  } catch (e) { return new Date(); }
}

function generateVideoId(title, date) {
  const dateStr = new Date(date).toISOString().slice(0, 10);
  return `${dateStr}-${title.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 30)}`;
}

function constructVideoUrl(title, date) {
  try {
    const dateObj = parseAJNDate(date);
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    
    const titleLower = title.toLowerCase();
    let showCode = 'alex'; 
    if (titleLower.includes('warroom')) showCode = 'warroom';
    if (titleLower.includes('sundaylive')) showCode = 'sundaylive';
    if (titleLower.includes('tnt')) showCode = 'tnt';
    if (titleLower.includes('americanjournal')) showCode = 'americanjournal';
    
    const hourMatch = title.match(/Hr(\d+)/i) || title.match(/Hour\s*(\d+)/i);
    const hour = hourMatch ? hourMatch[1] : '1';
    
    return `${CONFIG.VIDEO_BASE_URL}/${year}/${month}/${day}/${showCode}-${year}${month}${day}-hr${hour}.m4v`;
  } catch (e) { return null; }
}

// ============================================================================
// DATABASE LOGIC
// ============================================================================

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(CONFIG.DATABASE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    const db = new sqlite3.Database(CONFIG.DATABASE_PATH, (err) => {
      if (err) return reject(err);
      
      db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS videos (
          id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL, m4v_url TEXT NOT NULL, duration INTEGER DEFAULT 3600,
          published_date TIMESTAMP, added_to_cache TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        db.run(`CREATE TABLE IF NOT EXISTS playlists (
          id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_name TEXT UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, video_count INTEGER
        )`);
      });
      resolve(db);
    });
  });
}

function insertVideo(db, videoData) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO videos (video_id, title, m4v_url, duration, published_date) VALUES (?, ?, ?, ?, ?)`,
      [videoData.video_id, videoData.title, videoData.m4v_url, videoData.duration, videoData.published_date],
      function(err) { err ? reject(err) : resolve(this.lastID); }
    );
  });
}

// Enforces the 300-file rolling window inside SQLite
function enforce300Limit(db) {
  return new Promise((resolve, reject) => {
    db.run(
      `DELETE FROM videos WHERE id NOT IN (
        SELECT id FROM videos ORDER BY published_date DESC LIMIT ?
      )`,
      [CONFIG.MAX_VIDEOS],
      function(err) {
        if (err) reject(err);
        else {
          logger.info(`Enforced rolling window. Removed ${this.changes} old videos from DB.`);
          resolve();
        }
      }
    );
  });
}

function getLatestVideos(db) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM videos ORDER BY published_date DESC LIMIT ?`, [CONFIG.MAX_VIDEOS], (err, rows) => {
      err ? reject(err) : resolve(rows || []);
    });
  });
}

function insertPlaylistMetadata(db, playlistName, videoCount) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO playlists (playlist_name, video_count) VALUES (?, ?)`,
      [playlistName, videoCount],
      function(err) { err ? reject(err) : resolve(this.lastID); }
    );
  });
}

// ============================================================================
// PLAYLIST FORMATTERS & ARCHIVING
// ============================================================================

async function parseAJNFeed(htmlContent) {
  const videos = [];
  const linePattern = /(\d{4}-\w+-\d{2},\s+\w+)\s+(.+?)(?=\n|$)/g;
  let match;
  
  while ((match = linePattern.exec(htmlContent)) !== null) {
    const [, dateStr, titleStr] = match;
    const title = titleStr.trim();
    if (!title || title.length < 3) continue;
    
    const published_date = parseAJNDate(dateStr);
    const m4v_url = constructVideoUrl(title, dateStr);
    if (!m4v_url) continue;
    
    videos.push({
      video_id: generateVideoId(title, published_date),
      title: `${dateStr} ${title}`,
      m4v_url,
      duration: CONFIG.TARGET_VIDEO_DURATION,
      published_date: published_date.toISOString()
    });
  }
  return videos;
}

function generateM3U8Playlist(videos) {
  let m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3600\n#EXT-X-MEDIA-SEQUENCE:0\n';
  videos.forEach(v => { m3u8 += `#EXTINF:${v.duration},${v.title}\n${v.m4v_url}\n`; });
  return m3u8 + '#EXT-X-ENDLIST\n';
}

// Adjusted to perfectly match the Clapper UI frontend expectations
function generateJSONPlaylist(videos) {
  return videos.map(v => ({
    title: v.title,
    url: v.m4v_url,
    group: "AJN", 
    geoBlocked: false, // Hardcoded false as this feed likely doesn't have geo-blocks, adjust if needed
    duration: v.duration
  }));
}

function rotateAndSavePlaylists(videos) {
  if (!fs.existsSync(CONFIG.OUTPUT_DIR)) fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG.ARCHIVE_DIR)) fs.mkdirSync(CONFIG.ARCHIVE_DIR, { recursive: true });

  const activeJsonPath = path.join(CONFIG.OUTPUT_DIR, 'AJNHourly_ACTIVE.json');
  const activeM3u8Path = path.join(CONFIG.OUTPUT_DIR, 'AJNHourly_ACTIVE.m3u8');
  
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const archiveJsonPath = path.join(CONFIG.ARCHIVE_DIR, `AJNHourly_${today}.json`);
  const archiveM3u8Path = path.join(CONFIG.ARCHIVE_DIR, `AJNHourly_${today}.m3u8`);

  // 1. Archive yesterday's ACTIVE if it exists
  if (fs.existsSync(activeJsonPath)) fs.copyFileSync(activeJsonPath, archiveJsonPath);
  if (fs.existsSync(activeM3u8Path)) fs.copyFileSync(activeM3u8Path, archiveM3u8Path);

  // 2. Generate new formats
  const jsonContent = JSON.stringify(generateJSONPlaylist(videos), null, 2);
  const m3u8Content = generateM3U8Playlist(videos);

  // 3. Save as current ACTIVE
  fs.writeFileSync(activeJsonPath, jsonContent);
  fs.writeFileSync(activeM3u8Path, m3u8Content);
  
  logger.info(`Playlists successfully generated and archived for ${today}`);
}

// ============================================================================
// MAIN EXECUTION PIPELINE
// ============================================================================

async function main() {
  logger.info('Starting AJN Playlist Generator...');
  let db;
  
  try {
    db = await initializeDatabase();
    
    // 1. Fetch & Parse RSS
    const rawHtml = await fetchUrl(CONFIG.RSS_FEED_URL);
    const incomingVideos = await parseAJNFeed(rawHtml);
    logger.info(`Parsed ${incomingVideos.length} videos from remote.`);

    // 2. Insert into SQLite Cache
    let newAdditions = 0;
    for (const vid of incomingVideos) {
      try {
        await insertVideo(db, vid);
        newAdditions++;
      } catch (err) {
        // Ignore UNIQUE constraint errors (already in DB)
      }
    }
    logger.info(`Added ${newAdditions} new unique videos to SQLite.`);

    // 3. Enforce 300-file rolling limit
    await enforce300Limit(db);

    // 4. Retrieve the latest robust 300 from SQLite to build the list
    const robustVideoList = await getLatestVideos(db);

    // 5. Generate, Archive, and Save Files
    rotateAndSavePlaylists(robustVideoList);
    await insertPlaylistMetadata(db, 'AJNHourly_ACTIVE', robustVideoList.length);

    logger.info('Pipeline completed successfully.');
  } catch (error) {
    logger.error('Pipeline failed', { error: error.message });
    process.exit(1);
  } finally {
    if (db) db.close();
  }
}

// Execute
main();
