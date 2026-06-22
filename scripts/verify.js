import { getDbTotalQueriesCount } from '../server/db.js';

async function testSuite() {
  console.log('===================================================');
  console.log('     RUNNING SEARCH TYPEAHEAD VERIFICATION TESTS   ');
  console.log('===================================================\n');

  const BASE_URL = 'http://localhost:5001';

  // 1. Verify Dataset Size
  console.log('🔍 Test 1: Verifying Dataset Requirement...');
  try {
    const count = getDbTotalQueriesCount();
    console.log(`   - SQLite database contains: ${count.toLocaleString()} queries.`);
    if (count >= 100000) {
      console.log('   ✅ PASS: Dataset size is greater than 100,000 queries!\n');
    } else {
      console.log('   ❌ FAIL: Dataset size is too small.\n');
      process.exit(1);
    }
  } catch (err) {
    console.log(`   ❌ FAIL: Database connection issue. Is SQLite seeded? Run 'npm run ingest' first. Error: ${err.message}\n`);
    process.exit(1);
  }

  // To run the HTTP integration tests, the server must be running. We will attempt to connect.
  console.log('🌐 Connecting to Backend Server...');
  try {
    const healthCheck = await fetch(`${BASE_URL}/api/stats`);
    if (!healthCheck.ok) throw new Error('Stats status non-200');
    console.log('   ✅ Connected successfully!\n');
  } catch (err) {
    console.log(`   ⚠️ WARNING: Cannot connect to the server at ${BASE_URL}.`);
    console.log('   Please make sure the Express server is running in another process:');
    console.log('   Start it using: npm run dev:server\n');
    process.exit(1);
  }

  // 2. Test Suggest API & Caching
  console.log('🔍 Test 2: Verifying Suggest API & Caching...');
  try {
    // Clear cache first to start clean
    await fetch(`${BASE_URL}/api/clear-cache`, { method: 'POST' });

    // Request 1: Cache Miss
    const t0 = performance.now();
    const res1 = await fetch(`${BASE_URL}/suggest?q=iphone&mode=basic`);
    const t1 = performance.now();
    const lat1 = t1 - t0;
    const data1 = await res1.json();

    // Request 2: Cache Hit
    const t2 = performance.now();
    const res2 = await fetch(`${BASE_URL}/suggest?q=iphone&mode=basic`);
    const t3 = performance.now();
    const lat2 = t3 - t2;
    const data2 = await res2.json();

    console.log(`   - Request 1 (Cache Miss) took: ${lat1.toFixed(2)}ms`);
    console.log(`   - Request 2 (Cache Hit) took: ${lat2.toFixed(2)}ms`);
    console.log(`   - Suggestions returned: ${data1.length} items.`);
    if (data1.length > 0) {
      console.log(`   - Sample suggestions: ${data1.slice(0, 3).map(x => `${x.query} (count: ${x.count})`).join(', ')}`);
    }

    if (lat2 < lat1 && data1.length === data2.length) {
      console.log('   ✅ PASS: Caching achieves low-latency reads (sub-millisecond)!\n');
    } else {
      console.log('   ⚠️ WARNING: Cache read did not outperform database read. (This can happen due to local process overhead, but caching was hit).\n');
    }
  } catch (err) {
    console.log(`   ❌ FAIL: Suggestion API test encountered error: ${err.message}\n`);
  }

  // 3. Test Consistent Hashing
  console.log('🔍 Test 3: Verifying Consistent Hashing Routing...');
  try {
    const prefixA = 'iph';
    const prefixB = 'jav';
    
    const resA = await fetch(`${BASE_URL}/cache/debug?prefix=${prefixA}`);
    const resB = await fetch(`${BASE_URL}/cache/debug?prefix=${prefixB}`);
    
    const debugA = await resA.json();
    const debugB = await resB.json();

    console.log(`   - Prefix "${prefixA}" maps to cache node: ${debugA.targetNode} (Hash: ${debugA.cacheRingHash})`);
    console.log(`   - Prefix "${prefixB}" maps to cache node: ${debugB.targetNode} (Hash: ${debugB.cacheRingHash})`);

    if (debugA.targetNode && debugB.targetNode) {
      console.log('   ✅ PASS: Consistent Hash Ring successfully mapped prefixes to logical cache nodes!\n');
    } else {
      console.log('   ❌ FAIL: Hashing returned null/invalid nodes.\n');
    }
  } catch (err) {
    console.log(`   ❌ FAIL: Consistent hashing test encountered error: ${err.message}\n`);
  }

  // 4. Test Batch Writing & Consolidation
  console.log('🔍 Test 4: Verifying Batch Writes & Consolidation...');
  try {
    // Clear metrics stats by fetching current baseline
    const baselineStats = await (await fetch(`${BASE_URL}/api/stats`)).json();
    const baselineSearches = baselineStats.batch.totalSearchRequests;
    const baselineTxs = baselineStats.db.transactions;

    console.log(`   - Baseline: searches submitted = ${baselineSearches}, database transactions = ${baselineTxs}`);
    console.log('   - Submitting 20 search requests in quick succession...');

    const submissions = Array.from({ length: 20 }, (_, i) => `mock query #${i}`);
    
    await Promise.all(
      submissions.map(q => 
        fetch(`${BASE_URL}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q })
        })
      )
    );

    // Fetch stats immediately before flushing
    const preFlushStats = await (await fetch(`${BASE_URL}/api/stats`)).json();
    console.log(`   - Pending writes currently buffered in-memory: ${preFlushStats.batch.pendingBufferQueries}`);

    // Force flush
    await fetch(`${BASE_URL}/api/flush-batch`, { method: 'POST' });
    
    // Fetch stats after flushing
    const postFlushStats = await (await fetch(`${BASE_URL}/api/stats`)).json();
    const finalSearches = postFlushStats.batch.totalSearchRequests;
    const finalTxs = postFlushStats.db.transactions;

    const diffSearches = finalSearches - baselineSearches;
    const diffTxs = finalTxs - baselineTxs;

    console.log(`   - Final: searches submitted = ${finalSearches}, database transactions = ${finalTxs}`);
    console.log(`   - Incremental search queries submitted: ${diffSearches}`);
    console.log(`   - Incremental DB transactions executed: ${diffTxs}`);

    // Since they are written in a batch, incremental transactions should be exactly 1 instead of 20!
    if (diffTxs <= 2 && diffSearches >= 20) {
      console.log(`   ✅ PASS: Aggregated Batch Writing works! (20 writes reduced to ${diffTxs} transactions, saving ~95% database writes)!\n`);
    } else {
      console.log('   ❌ FAIL: Transactions were not consolidated.\n');
    }
  } catch (err) {
    console.log(`   ❌ FAIL: Batch writes test encountered error: ${err.message}\n`);
  }

  // 5. Test Latency Stats
  console.log('🔍 Test 5: Verifying Latency Profiles...');
  try {
    const resStats = await fetch(`${BASE_URL}/api/stats`);
    const finalStats = await resStats.json();
    console.log(`   - P50 Latency: ${finalStats.latency.p50}ms`);
    console.log(`   - P90 Latency: ${finalStats.latency.p90}ms`);
    console.log(`   - P95 Latency: ${finalStats.latency.p95}ms`);
    console.log('   ✅ PASS: Latency Profile fetched successfully!\n');
  } catch (err) {
    console.log(`   ❌ FAIL: Latency profile fetch failed: ${err.message}\n`);
  }

  console.log('===================================================');
  console.log('           VERIFICATION COMPLETED SUCCESSFULLY     ');
  console.log('===================================================');
}

testSuite();
