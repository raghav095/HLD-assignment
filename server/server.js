import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  getSuggestionsBasic,
  getRecentSearchesForPrefix,
  incrementQueriesBatch,
  insertRecentSearchesBatch,
  pruneRecentSearches,
  getDbTotalQueriesCount,
  dbStats
} from './db.js';

import {
  getCacheNodeForPrefix,
  cacheNodes,
  cacheRing,
  clearAllCaches,
  invalidateCacheForQuery,
  hashString
} from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// In-memory batch write buffers
let batchBuffer = new Map(); // query -> count increment
let recentSearchesBuffer = []; // array of { query, timestamp }
let totalSearchRequests = 0; // Telemetry: total searches requested by client

// Latency tracking (sliding window of last 1000 queries)
const latencyHistory = [];
const MAX_LATENCY_HISTORY = 1000;

function recordLatency(ms) {
  latencyHistory.push(ms);
  if (latencyHistory.length > MAX_LATENCY_HISTORY) {
    latencyHistory.shift();
  }
}

function getLatencyPercentile(percentile) {
  if (latencyHistory.length === 0) return 0;
  const sorted = [...latencyHistory].sort((a, b) => a - b);
  const index = Math.floor((percentile / 100) * sorted.length);
  return sorted[Math.min(index, sorted.length - 1)];
}

// Batch Writer Flush logic
export function flushBatchWrites() {
  if (batchBuffer.size === 0 && recentSearchesBuffer.length === 0) return;

  const copiedBatch = new Map(batchBuffer);
  const copiedRecent = [...recentSearchesBuffer];

  // Clear buffers
  batchBuffer.clear();
  recentSearchesBuffer = [];

  try {
    // 1. Bulk update query counts
    incrementQueriesBatch(copiedBatch);

    // 2. Bulk insert recent searches
    insertRecentSearchesBatch(copiedRecent);

    // 3. Cache Invalidation: Invalidate cache for prefix segments of queries updated
    for (const query of copiedBatch.keys()) {
      invalidateCacheForQuery(query);
    }
  } catch (error) {
    console.error('Failed to flush batch writes to database:', error);
  }
}

// Background batch writer flush interval (every 5 seconds)
const FLUSH_INTERVAL_MS = 5000;
const flushTimer = setInterval(flushBatchWrites, FLUSH_INTERVAL_MS);

// Background pruning of recent searches (older than 5 minutes, run every 30 seconds)
const PRUNE_INTERVAL_MS = 30000;
const pruneTimer = setInterval(() => {
  const cutoff = Date.now() - 300000; // 5 minutes ago
  pruneRecentSearches(cutoff);
}, PRUNE_INTERVAL_MS);

// Recency-Aware (Enhanced) Ranking Implementation
function getSuggestionsEnhanced(prefix, limit = 10) {
  // 1. Fetch matches starting with the prefix (larger sample to allow sorting decay)
  const baseQueries = getSuggestionsBasic(prefix, 100);

  // 2. Fetch recent searches matching prefix in the last 5 minutes (300,000 ms)
  const fiveMinutesAgo = Date.now() - 300000;
  const recentSearches = getRecentSearchesForPrefix(prefix, fiveMinutesAgo);

  // 3. Aggregate recent search timestamps by query
  const recentTimestampsMap = new Map();
  for (const s of recentSearches) {
    const q = s.query.toLowerCase();
    if (!recentTimestampsMap.has(q)) {
      recentTimestampsMap.set(q, []);
    }
    recentTimestampsMap.get(q).push(s.timestamp);
  }

  // 4. Merge candidates
  const candidatesMap = new Map(); // query -> { query, baseCount, recentTimestamps }
  
  for (const b of baseQueries) {
    const q = b.query.toLowerCase();
    candidatesMap.set(q, {
      query: b.query, // preserve original casing
      baseCount: b.count,
      recentTimestamps: recentTimestampsMap.get(q) || []
    });
  }

  // Add any queries that were recently searched but are not in the top 100 base queries yet
  for (const [q, timestamps] of recentTimestampsMap.entries()) {
    if (!candidatesMap.has(q)) {
      candidatesMap.set(q, {
        query: q,
        baseCount: 0, // not in top base queries, start count at 0
        recentTimestamps: timestamps
      });
    }
  }

  // 5. Score candidates using exponential decay formula:
  // Score = baseCount * 0.05 + Sum( 100 * e^(-0.01 * delta_t_seconds) )
  const now = Date.now();
  const decayConstant = 0.01; // half-life is ~69.3 seconds (ln(2) / 0.01)

  const scoredList = Array.from(candidatesMap.values()).map(c => {
    let recentScore = 0;
    for (const ts of c.recentTimestamps) {
      const deltaSeconds = Math.max(0, (now - ts) / 1000);
      recentScore += 100 * Math.exp(-decayConstant * deltaSeconds);
    }
    
    const score = (c.baseCount * 0.05) + recentScore;
    return {
      query: c.query,
      count: c.baseCount,
      recentCount: c.recentTimestamps.length,
      score: score
    };
  });

  // 6. Sort by score descending and return top suggestions
  scoredList.sort((a, b) => b.score - a.score);
  return scoredList.slice(0, limit);
}

// Suggest API Endpoint
app.get('/suggest', (req, res) => {
  const startTime = process.hrtime();
  
  const rawPrefix = req.query.q || '';
  const mode = req.query.mode || 'basic'; // 'basic' | 'enhanced'
  const limit = parseInt(req.query.limit) || 10;

  const prefix = rawPrefix.trim().toLowerCase().replace(/\s+/g, ' ');

  let suggestions = [];

  if (prefix === '') {
    // Return overall popular searches (no prefix filter)
    const cacheNode = getCacheNodeForPrefix('__overall__');
    const cacheKey = `${mode}:__overall__`;
    const cachedData = cacheNode.get(cacheKey);

    if (cachedData) {
      suggestions = cachedData;
    } else {
      if (mode === 'enhanced') {
        suggestions = getSuggestionsEnhanced('', limit);
      } else {
        suggestions = getSuggestionsBasic('', limit);
      }
      cacheNode.set(cacheKey, suggestions, 15); // Cache overall trending for 15s
    }
  } else {
    const cacheNode = getCacheNodeForPrefix(prefix);
    const cacheKey = `${mode}:${prefix}`;
    const cachedData = cacheNode.get(cacheKey);

    if (cachedData) {
      suggestions = cachedData;
    } else {
      if (mode === 'enhanced') {
        suggestions = getSuggestionsEnhanced(prefix, limit);
      } else {
        suggestions = getSuggestionsBasic(prefix, limit);
      }
      // Store in node cache for 15 seconds
      cacheNode.set(cacheKey, suggestions, 15);
    }
  }

  // Record metrics latency
  const diff = process.hrtime(startTime);
  const diffMs = (diff[0] * 1000) + (diff[1] / 1000000);
  recordLatency(diffMs);

  res.json(suggestions);
});

// Search Submission API Endpoint
app.post('/search', (req, res) => {
  const query = req.body.query;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Query is required.' });
  }

  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  totalSearchRequests++;

  // Add search increments to batch buffer
  batchBuffer.set(normalizedQuery, (batchBuffer.get(normalizedQuery) || 0) + 1);
  recentSearchesBuffer.push({
    query: normalizedQuery,
    timestamp: Date.now()
  });

  // If buffer becomes too large, flush immediately (avoid memory bloat, ensure low write latency)
  if (batchBuffer.size >= 50) {
    flushBatchWrites();
  }

  res.json({ message: 'Searched' });
});

// Debug Cache Routing Endpoint
app.get('/cache/debug', (req, res) => {
  const rawPrefix = req.query.prefix || '';
  const prefix = rawPrefix.trim().toLowerCase().replace(/\s+/g, ' ');

  if (!prefix) {
    return res.status(400).json({ error: 'Prefix is required.' });
  }

  const cacheNode = getCacheNodeForPrefix(prefix);
  
  // Look up if either basic or enhanced is cached
  const isBasicCached = cacheNode.store.has(`basic:${prefix}`);
  const isEnhancedCached = cacheNode.store.has(`enhanced:${prefix}`);
  const isCached = isBasicCached || isEnhancedCached;

  res.json({
    prefix: rawPrefix,
    normalizedPrefix: prefix,
    targetNode: cacheNode.name,
    status: isCached ? 'hit' : 'miss',
    cacheRingHash: hashString(prefix)
  });
});

// Telemetry Stats Endpoint
app.get('/api/stats', (req, res) => {
  let cacheHits = 0;
  let cacheMisses = 0;
  const nodesStats = [];

  for (const node of Object.values(cacheNodes)) {
    const s = node.getStats();
    cacheHits += s.hits;
    cacheMisses += s.misses;
    nodesStats.push(s);
  }

  const cacheTotal = cacheHits + cacheMisses;
  const hitRate = cacheTotal > 0 ? (cacheHits / cacheTotal) * 100 : 0;

  // Compute write reduction: (Incoming search requests - Actual DB write operations)
  // Actual write statements are recorded in dbStats.writes
  const writeReductionPercentage = totalSearchRequests > 0 
    ? Math.max(0, ((totalSearchRequests - dbStats.writeTransactions) / totalSearchRequests) * 100)
    : 0;

  res.json({
    db: {
      totalQueriesCount: getDbTotalQueriesCount(),
      reads: dbStats.reads,
      writes: dbStats.writes,
      transactions: dbStats.writeTransactions
    },
    cache: {
      hitRate: hitRate.toFixed(2),
      hits: cacheHits,
      misses: cacheMisses,
      nodes: nodesStats
    },
    batch: {
      pendingBufferQueries: batchBuffer.size,
      totalSearchRequests: totalSearchRequests,
      writeReduction: writeReductionPercentage.toFixed(2)
    },
    latency: {
      p50: getLatencyPercentile(50).toFixed(2),
      p90: getLatencyPercentile(90).toFixed(2),
      p95: getLatencyPercentile(95).toFixed(2),
      historyLength: latencyHistory.length
    }
  });
});

// Clear Cache endpoint
app.post('/api/clear-cache', (req, res) => {
  clearAllCaches();
  res.json({ success: true, message: 'All caches cleared successfully.' });
});

// Force flush batch buffer endpoint
app.post('/api/flush-batch', (req, res) => {
  flushBatchWrites();
  res.json({ success: true, message: 'Batch writes flushed successfully.' });
});

// Traffic Simulator Endpoint
app.post('/api/mock-search', (req, res) => {
  const mockQueries = [
    'iphone', 'iphone 15', 'iphone charger', 'java tutorial',
    'javascript arrays', 'react hooks', 'nodejs api', 'python',
    'nba scores', 'marvel movies', 'weather today', 'meditation guide',
    'skincare routine', 'bitcoin price', 'adidas shoes', 'flights to paris'
  ];

  const count = parseInt(req.body.count) || 20;

  // Simulate requests asynchronously to simulate natural traffic spikes
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const q = mockQueries[Math.floor(Math.random() * mockQueries.length)];
      totalSearchRequests++;
      batchBuffer.set(q, (batchBuffer.get(q) || 0) + 1);
      recentSearchesBuffer.push({
        query: q,
        timestamp: Date.now()
      });
      if (batchBuffer.size >= 50) {
        flushBatchWrites();
      }
    }, Math.random() * 2000); // spread over 2 seconds
  }

  res.json({ success: true, message: `Dispatched ${count} mock search events.` });
});

// Serve frontend assets in production
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

app.get('*', (req, res, next) => {
  // If it's an API route or suggest, don't fallback to index.html
  if (req.url.startsWith('/suggest') || req.url.startsWith('/search') || req.url.startsWith('/api') || req.url.startsWith('/cache')) {
    return next();
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

// Graceful Shutdown
process.on('SIGINT', () => {
  clearInterval(flushTimer);
  clearInterval(pruneTimer);
  flushBatchWrites();
  console.log('Shutting down backend server...');
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
