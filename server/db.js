import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_DIR = path.resolve('db');
const DB_PATH = path.join(DB_DIR, 'typeahead.db');

// Ensure db directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Statistics tracking for db activity
export const dbStats = {
  reads: 0,
  writes: 0,
  writeTransactions: 0
};

// Initialize Tables and Indexes
export function initDb() {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      query TEXT PRIMARY KEY COLLATE NOCASE,
      count INTEGER DEFAULT 0
    );
  `);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_searches (
      query TEXT COLLATE NOCASE,
      timestamp INTEGER
    );
  `);

  // Create Indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_queries_query ON queries(query);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_queries_count ON queries(count);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recent_query ON recent_searches(query);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_recent_timestamp ON recent_searches(timestamp);`);
  
  dbStats.writes += 7; // DDL writes
}

// Automatically initialize database tables when loaded
initDb();

// Basic suggestion query
const selectBasicStmt = db.prepare(`
  SELECT query, count 
  FROM queries 
  WHERE query LIKE ? 
  ORDER BY count DESC 
  LIMIT ?
`);

export function getSuggestionsBasic(prefix, limit = 10) {
  dbStats.reads++;
  return selectBasicStmt.all(prefix + '%', limit);
}

// Get recent searches matching a prefix
const selectRecentStmt = db.prepare(`
  SELECT query, timestamp 
  FROM recent_searches 
  WHERE query LIKE ? AND timestamp >= ?
`);

export function getRecentSearchesForPrefix(prefix, sinceTimestamp) {
  dbStats.reads++;
  return selectRecentStmt.all(prefix + '%', sinceTimestamp);
}

// Batch write increments to queries table
export function incrementQueriesBatch(itemsMap) {
  if (itemsMap.size === 0) return;
  
  const insertOrUpdateStmt = db.prepare(`
    INSERT INTO queries (query, count) 
    VALUES (?, ?) 
    ON CONFLICT(query) 
    DO UPDATE SET count = count + excluded.count
  `);

  // Execute in a single transaction
  db.exec('BEGIN TRANSACTION');
  try {
    for (const [query, count] of itemsMap.entries()) {
      insertOrUpdateStmt.run(query, count);
      dbStats.writes++;
    }
    db.exec('COMMIT');
    dbStats.writeTransactions++;
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Failed to commit query increment batch:', error);
    throw error;
  }
}

// Batch insert recent search events
export function insertRecentSearchesBatch(recentSearches) {
  if (recentSearches.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO recent_searches (query, timestamp) 
    VALUES (?, ?)
  `);

  db.exec('BEGIN TRANSACTION');
  try {
    for (const item of recentSearches) {
      insertStmt.run(item.query, item.timestamp);
      dbStats.writes++;
    }
    db.exec('COMMIT');
    dbStats.writeTransactions++;
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Failed to commit recent searches batch:', error);
    throw error;
  }
}

// Prune old recent searches (e.g. older than 5 minutes)
const deleteOldRecentStmt = db.prepare(`
  DELETE FROM recent_searches WHERE timestamp < ?
`);

export function pruneRecentSearches(beforeTimestamp) {
  dbStats.writes++;
  dbStats.writeTransactions++;
  return deleteOldRecentStmt.run(beforeTimestamp);
}

// Helper to get total queries count
export function getDbTotalQueriesCount() {
  dbStats.reads++;
  const stmt = db.prepare('SELECT COUNT(*) as total FROM queries');
  const result = stmt.get();
  return result ? result.total : 0;
}
