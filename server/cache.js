import crypto from 'node:crypto';

// Hash function mapping a string to a 32-bit unsigned integer
export function hashString(str) {
  const hash = crypto.createHash('sha256').update(str).digest();
  return hash.readUInt32BE(0); // [0, 4294967295]
}

// Logical Cache Node representing an isolated cache partition
export class CacheNode {
  constructor(name) {
    this.name = name;
    this.store = new Map(); // key -> { data, expiresAt }
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.data;
  }

  set(key, data, ttlSeconds = 60) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { data, expiresAt });
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats() {
    return {
      name: this.name,
      hits: this.hits,
      misses: this.misses,
      keysCount: this.store.size
    };
  }
}

// Consistent Hash Ring managing node distribution
export class ConsistentHashRing {
  constructor(virtualNodesCount = 50) {
    this.virtualNodesCount = virtualNodesCount;
    this.ring = []; // sorted array of { hash, nodeName }
    this.nodes = new Set(); // set of unique logical node names
  }

  addNode(nodeName) {
    if (this.nodes.has(nodeName)) return;
    this.nodes.add(nodeName);

    for (let i = 0; i < this.virtualNodesCount; i++) {
      const virtualNodeName = `${nodeName}#${i}`;
      const hash = hashString(virtualNodeName);
      this.ring.push({ hash, nodeName });
    }

    // Sort the ring by hash value ascending
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(nodeName) {
    if (!this.nodes.has(nodeName)) return;
    this.nodes.delete(nodeName);
    this.ring = this.ring.filter(item => item.nodeName !== nodeName);
  }

  getNode(key) {
    if (this.ring.length === 0) return null;
    const hash = hashString(key);
    
    // Binary search on ring
    let low = 0;
    let high = this.ring.length - 1;
    let idx = 0;

    if (hash > this.ring[high].hash) {
      // Wrap around
      return this.ring[0].nodeName;
    }

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid].hash >= hash) {
        idx = mid;
        high = mid - 1; // Look for even smaller hash >= key hash
      } else {
        low = mid + 1;
      }
    }

    return this.ring[idx].nodeName;
  }

  getRingLayout() {
    return this.ring.map(entry => ({
      hash: entry.hash,
      node: entry.nodeName
    }));
  }
}

// Instantiate default cluster
export const cacheRing = new ConsistentHashRing(50);
export const cacheNodes = {
  'cache-node-0': new CacheNode('cache-node-0'),
  'cache-node-1': new CacheNode('cache-node-1'),
  'cache-node-2': new CacheNode('cache-node-2')
};

// Add default nodes to the hash ring
cacheRing.addNode('cache-node-0');
cacheRing.addNode('cache-node-1');
cacheRing.addNode('cache-node-2');

// Helper to routing prefix query
export function getCacheNodeForPrefix(prefix) {
  const nodeName = cacheRing.getNode(prefix);
  return cacheNodes[nodeName];
}

// Invalidate prefix suggestions
export function invalidateCacheForQuery(query) {
  // A query update might affect suggestions of all its prefixes.
  // E.g. search for 'iphone' might affect prefix suggestion caches for 'i', 'ip', 'iph', 'ipho', 'iphon', 'iphone'
  const normalized = query.toLowerCase().trim();
  for (let i = 1; i <= normalized.length; i++) {
    const prefix = normalized.substring(0, i);
    const node = getCacheNodeForPrefix(prefix);
    if (node) {
      node.delete(`basic:${prefix}`);
      node.delete(`enhanced:${prefix}`);
    }
  }
  
  // Also invalidate overall trending cache keys since counts changed
  for (const node of Object.values(cacheNodes)) {
    node.delete('basic:__overall__');
    node.delete('enhanced:__overall__');
  }
}

// Reset stats for all cache nodes
export function clearAllCaches() {
  for (const node of Object.values(cacheNodes)) {
    node.clear();
  }
}
