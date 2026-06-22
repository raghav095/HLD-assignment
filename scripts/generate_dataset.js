import { initDb, incrementQueriesBatch, getDbTotalQueriesCount } from '../server/db.js';

// Pre-defined words for generating combinations
const adjs = [
  'best', 'new', 'top', 'cheap', 'free', 'latest', 'how to', 'easy', 'online', 'fast',
  'simple', 'ultimate', 'modern', 'custom', 'secure', 'quick', 'local', 'global'
];

const nouns = [
  'iphone 15', 'laptop', 'java tutorial', 'python programming', 'shoes', 'adidas sneakers',
  'flight tickets', 'pizza recipe', 'nba scores', 'marvel movie', 'css tutorial',
  'javascript array', 'react hooks', 'nodejs api', 'sql query', 'html form', 'weather update',
  'stock market', 'news today', 'workout plan', 'weight loss', 'diet tips', 'hotels in tokyo',
  'travel guide', 'flights to paris', 'chocolate cake', 'chicken pasta', 'yoga for beginners',
  'meditation guide', 'machine learning', 'data science', 'chatgpt prompt', 'gemini ai',
  'smart watch', 'wireless headphones', 'gaming mouse', 'mechanical keyboard', 'bluetooth speaker',
  'coffee maker', 'air fryer', 'vacuum cleaner', 'sofa bed', 'office chair', 'standing desk',
  'hiking boots', 'sleeping bag', 'camping tent', 'acoustic guitar', 'digital piano', 'cardio workout',
  'docker container', 'kubernetes cluster', 'rust language', 'golang microservice', 'taylor swift tickets',
  'bitcoin price', 'ethereum wallet', 'cat foods', 'dog training', 'gardening tools', 'home decor',
  'skincare routine', 'sunscreen review', 'haircut styles', 'makeup tutorial', 'dental care',
  'mental health', 'sleep meditation', 'stress management', 'guitar tabs', 'piano chords',
  'sudoku solver', 'chess opening', 'minecraft mods', 'fortnite codes', 'steam sales', 'playstation 5'
];

const suffixes = [
  'review', 'tutorial', 'guide', 'download', 'online', 'price', 'specifications',
  'comparison', 'code', 'example', 'classes', 'jobs', 'for beginners', 'near me',
  'coupon code', 'deals', 'tips', 'tricks', 'trends', 'ideas', 'best practices',
  'documentation', 'templates', 'generator', 'builder', 'design', 'installation',
  'problems', 'fixes', 'solutions', 'alternatives', 'pros and cons', 'cost'
];

function generateUniqueQueries(countNeeded) {
  console.log(`Generating ${countNeeded} unique queries...`);
  const querySet = new Set();
  
  // Hand-add some specific target queries from the assignment prompt to guarantee their presence
  const explicitQueries = ['iphone', 'iphone 15', 'iphone charger', 'java tutorial'];
  for (const q of explicitQueries) {
    querySet.add(q);
  }

  // Generate combinations
  let dupCount = 0;
  while (querySet.size < countNeeded) {
    const adj = adjs[Math.floor(Math.random() * adjs.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
    
    // Mix and match query patterns
    const r = Math.random();
    let query = '';
    if (r < 0.2) {
      query = `${adj} ${noun}`;
    } else if (r < 0.4) {
      query = `${noun} ${suffix}`;
    } else if (r < 0.7) {
      query = `${adj} ${noun} ${suffix}`;
    } else if (r < 0.9) {
      query = noun;
    } else {
      // Create random two-word query from nouns
      const noun2 = nouns[Math.floor(Math.random() * nouns.length)];
      if (noun !== noun2) {
        query = `${noun} ${noun2}`;
      } else {
        query = noun;
      }
    }
    
    // Standardize spacing and casing
    query = query.trim().toLowerCase().replace(/\s+/g, ' ');
    if (query.length > 2 && query.length < 50) {
      if (querySet.has(query)) {
        query = `${query} ${dupCount++}`;
      }
      querySet.add(query);
    }
  }

  return Array.from(querySet);
}

function run() {
  console.log('--- Initializing Ingestion ---');
  initDb();

  const totalQueries = 105000; // Generate slightly more than 100k to be safe
  const queries = generateUniqueQueries(totalQueries);

  // Assign search counts using Zipf's Law: count = C / (rank + offset)^s
  // This creates a few extremely popular queries and a long tail of less popular ones.
  console.log('Assigning Zipfian-distributed counts...');
  const C = 8000000; // scale factor
  const s = 0.85;    // distribution exponent
  const offset = 2;

  // Shuffle queries so categories are mixed across popularities
  for (let i = queries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }

  const batchMap = new Map();
  const batchSize = 10000;
  let totalInserted = 0;
  
  console.log('Ingesting queries into SQLite...');
  const startTime = Date.now();

  for (let rank = 0; rank < queries.length; rank++) {
    const q = queries[rank];
    // Zipfian count
    const count = Math.round(C / Math.pow(rank + offset, s));
    
    // Explicit queries override to match assignment expected format counts approximately
    if (q === 'iphone') batchMap.set(q, 100000);
    else if (q === 'iphone 15') batchMap.set(q, 85000);
    else if (q === 'iphone charger') batchMap.set(q, 60000);
    else if (q === 'java tutorial') batchMap.set(q, 40000);
    else batchMap.set(q, Math.max(1, count)); // Ensure at least 1 count

    if (batchMap.size >= batchSize || rank === queries.length - 1) {
      incrementQueriesBatch(batchMap);
      totalInserted += batchMap.size;
      batchMap.clear();
      console.log(`Ingested ${totalInserted} / ${queries.length} queries...`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const finalCount = getDbTotalQueriesCount();
  console.log(`\nSuccess! Ingestion completed in ${duration} seconds.`);
  console.log(`Total active queries in SQLite: ${finalCount}`);
  console.log('------------------------------');
}

run();
