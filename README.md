# Video Player Archive

Offline-capable video player with SQLite caching. Load videos from RSS feeds or playlists, watch offline with local cache.

## Features
- 📺 Drag & drop video loading
- 🔄 Automatic CORS proxy handling
- 💾 SQLite offline caching
- 🌐 Works on GitHub Pages
- ⚡ Fast fallback to cached videos
- 📱 Responsive design

## Quick Start
1. Visit: https://yourusername.github.io/video-player-archive/
2. Drag the button to load videos
3. Select a video to play
4. Videos automatically cache for offline access

## How to Use
- **Fetch Fresh**: Click "Fetch Fresh Data" to load latest RSS
- **Use Cache**: Switch to cached videos if remote is slow
- **Offline**: All previously watched videos work without internet

The script will:

Auto-install requests, beautifulsoup4, flask, flask-cors

Create all directories and files

Generate the initial playlist JSON

Start a local server at http://localhost:8080

Open your browser automatically

2. GitHub Actions Automation
The script creates .github/workflows/update_playlist.yml that:

Runs every 6 hours automatically

Can be triggered manually from GitHub Actions tab

Fetches the latest RSS and commits updated JSON
