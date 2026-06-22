import React, { useState, useEffect, useRef, useCallback } from 'react';

export default function App() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [mode, setMode] = useState('enhanced'); // default to enhanced/recency
  const [searchResult, setSearchResult] = useState(null);
  const [trending, setTrending] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [simulatorCount, setSimulatorCount] = useState(25);
  const [simulatorLoading, setSimulatorLoading] = useState(false);
  
  // Dashboard states
  const [stats, setStats] = useState({
    db: { totalQueriesCount: 0, reads: 0, writes: 0, transactions: 0 },
    cache: { hitRate: '0.00', hits: 0, misses: 0, nodes: [] },
    batch: { pendingBufferQueries: 0, totalSearchRequests: 0, writeReduction: '0.00' },
    latency: { p50: '0.00', p90: '0.00', p95: '0.00' }
  });
  const [debugRouting, setDebugRouting] = useState(null);
  const [logs, setLogs] = useState([]);

  const debounceTimer = useRef(null);
  const dropdownRef = useRef(null);

  // Helper to add log messages in UI
  const addLog = useCallback((message) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 49)]);
  }, []);

  // Fetch Dashboard Stats
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/stats');
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, []);

  // Fetch Trending Queries (overall popular)
  const fetchTrending = useCallback(async () => {
    try {
      const res = await fetch(`/suggest?q=&mode=${mode}&limit=5`);
      if (res.ok) {
        const data = await res.json();
        setTrending(data);
      }
    } catch (err) {
      console.error('Failed to fetch trending:', err);
    }
  }, [mode]);

  // Initial load and stats polling
  useEffect(() => {
    fetchStats();
    fetchTrending();
    const interval = setInterval(fetchStats, 1500);
    return () => clearInterval(interval);
  }, [fetchStats, fetchTrending]);

  // Handle outside click to close dropdown
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch debug cache routing details
  const fetchCacheDebug = async (prefix) => {
    if (!prefix) {
      setDebugRouting(null);
      return;
    }
    try {
      const res = await fetch(`/cache/debug?prefix=${encodeURIComponent(prefix)}`);
      if (res.ok) {
        const data = await res.json();
        setDebugRouting(data);
        addLog(`Routed "${prefix}" -> Cache Node: ${data.targetNode} (${data.status.toUpperCase()}) | Ring Hash: ${data.cacheRingHash}`);
      }
    } catch (err) {
      console.error('Debug cache error:', err);
    }
  };

  // Fetch Suggestions (Debounced)
  const getSuggestions = useCallback(async (prefix) => {
    if (!prefix) {
      setSuggestions([]);
      setIsLoading(false);
      setDebugRouting(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    
    // Debug routing lookup parallel to main query
    fetchCacheDebug(prefix);

    try {
      const res = await fetch(`/suggest?q=${encodeURIComponent(prefix)}&mode=${mode}&limit=10`);
      if (!res.ok) throw new Error('Failed to load suggestions');
      const data = await res.json();
      setSuggestions(data);
      setActiveSuggestionIndex(-1);
      setDropdownOpen(true);
    } catch (err) {
      setError(err.message);
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  }, [mode, addLog]);

  // Trigger suggestions query on input change (debounced)
  const handleInputChange = (e) => {
    const value = e.target.value;
    setQuery(value);

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(() => {
      getSuggestions(value);
    }, 200);
  };

  // Submit Search Query
  const submitSearch = async (searchQuery) => {
    if (!searchQuery || !searchQuery.trim()) return;

    const queryToSubmit = searchQuery.trim();
    setDropdownOpen(false);
    setSearchResult({ loading: true });

    try {
      const res = await fetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: queryToSubmit })
      });
      
      if (!res.ok) throw new Error('Search API error');
      const data = await res.json();
      
      setSearchResult(data);
      addLog(`Submitted search: "${queryToSubmit}" -> Queued to batch buffer.`);
      
      // Update UI elements immediately
      setQuery('');
      fetchStats();
      fetchTrending();
    } catch (err) {
      setSearchResult({ error: err.message });
      addLog(`Error submitting search "${queryToSubmit}": ${err.message}`);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e) => {
    if (!dropdownOpen || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestionIndex((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestionIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSuggestionIndex >= 0 && activeSuggestionIndex < suggestions.length) {
        const selected = suggestions[activeSuggestionIndex].query;
        setQuery(selected);
        submitSearch(selected);
      } else {
        submitSearch(query);
      }
    } else if (e.key === 'Escape') {
      setDropdownOpen(false);
    }
  };

  // Clear cache action
  const clearCaches = async () => {
    try {
      const res = await fetch('/api/clear-cache', { method: 'POST' });
      if (res.ok) {
        addLog('Cleared all Cache Nodes.');
        fetchStats();
        if (query) getSuggestions(query);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Flush writes action
  const flushWrites = async () => {
    try {
      const res = await fetch('/api/flush-batch', { method: 'POST' });
      if (res.ok) {
        addLog('Forced batch writer flush. DB counts updated.');
        fetchStats();
        fetchTrending();
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Trigger Traffic Simulator
  const triggerSimulator = async () => {
    setSimulatorLoading(true);
    addLog(`Traffic Simulator: Dispatching ${simulatorCount} concurrent search requests...`);
    try {
      const res = await fetch('/api/mock-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: simulatorCount })
      });
      if (res.ok) {
        setTimeout(() => {
          addLog(`Traffic Simulator: Dispatched successfully. Buffers filling...`);
          fetchStats();
          setSimulatorLoading(false);
        }, 1000);
      }
    } catch (err) {
      console.error(err);
      setSimulatorLoading(false);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <h1>Search Typeahead System</h1>
        </div>
      </header>

      <main className="dashboard-grid">
        {/* Left Column: Search & Trending */}
        <section className="column-left">
          {/* Main Search Panel */}
          <div className="card search-card">
            <h2>Interactive Search Console</h2>
            
            <div className="search-group" ref={dropdownRef}>
              <div className="search-input-wrapper">
                <input
                  type="text"
                  placeholder="Type to search (e.g. iphone, java, python, react)..."
                  value={query}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onFocus={() => { if (suggestions.length > 0) setDropdownOpen(true); }}
                  autoComplete="off"
                  className="search-input"
                  id="search-box-input"
                />
                <button 
                  onClick={() => submitSearch(query)} 
                  disabled={!query.trim()}
                  className="search-button"
                  id="search-btn-submit"
                >
                  Search
                </button>
              </div>

              {/* Suggestions Dropdown */}
              {dropdownOpen && (suggestions.length > 0 || error || isLoading) && (
                <div className="suggestions-dropdown" id="suggest-dropdown">
                  {isLoading && suggestions.length === 0 && (
                    <div className="dropdown-info">Loading suggestions...</div>
                  )}
                  {error && <div className="dropdown-error">Error: {error}</div>}
                  
                  {suggestions.map((item, idx) => (
                    <div
                      key={item.query}
                      className={`suggestion-item ${idx === activeSuggestionIndex ? 'active' : ''}`}
                      onClick={() => {
                        setQuery(item.query);
                        submitSearch(item.query);
                      }}
                      onMouseEnter={() => setActiveSuggestionIndex(idx)}
                    >
                      <span className="suggestion-text">{item.query}</span>
                      <div className="suggestion-badges">
                        {item.recentCount > 0 && (
                          <span className="badge recent">+{item.recentCount} recent</span>
                        )}
                        <span className="badge count">
                          Score: {item.score ? item.score.toFixed(1) : item.count}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Dummy API Response Panel */}
            {searchResult && (
              <div className="api-response-panel" id="search-result-panel">
                <div className="panel-header">
                  <span className="status-dot green"></span>
                  <strong>POST /search Response:</strong>
                </div>
                <pre>{JSON.stringify(searchResult, null, 2)}</pre>
              </div>
            )}
          </div>

          {/* Trending Searches Section */}
          <div className="card trending-card">
            <h2>Trending Searches</h2>
            <div className="trending-tags">
              {trending.length === 0 ? (
                <span className="no-tags">No trending data yet</span>
              ) : (
                trending.map((t) => (
                  <button
                    key={t.query}
                    onClick={() => {
                      setQuery(t.query);
                      submitSearch(t.query);
                    }}
                    className="trending-tag-btn"
                  >
                    {t.query} <span className="tag-count">({t.score ? t.score.toFixed(0) : t.count})</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Right Column: Engine Config & Telemetry */}
        <section className="column-right">
          {/* Controls Card */}
          <div className="card controls-card">
            <h2>Engine Configuration</h2>
            <div className="control-groups">
              {/* Ranking Toggle */}
              <div className="control-item">
                <span className="control-label">Suggestion Ranking Mode</span>
                <div className="toggle-group">
                  <button
                    className={`toggle-btn ${mode === 'basic' ? 'active' : ''}`}
                    onClick={() => {
                      setMode('basic');
                      addLog('Switched suggestions mode to Basic (overall count).');
                    }}
                  >
                    Basic (Counts)
                  </button>
                  <button
                    className={`toggle-btn ${mode === 'enhanced' ? 'active' : ''}`}
                    onClick={() => {
                      setMode('enhanced');
                      addLog('Switched suggestions mode to Enhanced (recency decay).');
                    }}
                  >
                    Enhanced (Recency)
                  </button>
                </div>
              </div>

              {/* Maintenance Tools */}
              <div className="control-item">
                <span className="control-label">System Operations</span>
                <div className="button-row">
                  <button onClick={clearCaches} className="secondary-btn">
                    Clear Cache
                  </button>
                  <button onClick={flushWrites} className="secondary-btn">
                    Flush DB Batch
                  </button>
                </div>
              </div>

              {/* Traffic Simulator */}
              <div className="control-item">
                <span className="control-label">Load Simulator</span>
                <div className="simulator-row">
                  <div className="slider-container">
                    <label>Count: {simulatorCount}</label>
                    <input
                      type="range"
                      min="10"
                      max="100"
                      step="5"
                      value={simulatorCount}
                      onChange={(e) => setSimulatorCount(parseInt(e.target.value))}
                      className="slider"
                    />
                  </div>
                  <button onClick={triggerSimulator} disabled={simulatorLoading} className="primary-btn">
                    {simulatorLoading ? 'Generating...' : 'Generate Traffic'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Statistics Grid */}
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Cache Hit Rate</span>
              <div className="stat-value">{stats.cache.hitRate}%</div>
              <div className="stat-sub">
                Hits: {stats.cache.hits} • Misses: {stats.cache.misses}
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-label">DB Operations</span>
              <div className="stat-value">{stats.db.writes} Writes</div>
              <div className="stat-sub">
                Reads: {stats.db.reads} • TXs: {stats.db.transactions}
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-label">Write reduction</span>
              <div className="stat-value">{stats.batch.writeReduction}%</div>
              <div className="stat-sub">
                Searches: {stats.batch.totalSearchRequests} • Buffer: {stats.batch.pendingBufferQueries}
              </div>
            </div>

            <div className="stat-card">
              <span className="stat-label">P95 Latency</span>
              <div className="stat-value">{stats.latency.p95}ms</div>
              <div className="stat-sub">
                p50: {stats.latency.p50}ms • p90: {stats.latency.p90}ms
              </div>
            </div>
          </div>

          {/* Consistent Hash Cache Routing */}
          <div className="card cluster-card">
            <h2>Logical Cache Partitions</h2>
            <div className="cache-nodes-table-wrapper">
              <table className="cache-nodes-table">
                <thead>
                  <tr>
                    <th>Node ID</th>
                    <th>Keys</th>
                    <th>Hits</th>
                    <th>Misses</th>
                    <th>Hit Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.cache.nodes.map(node => {
                    const total = node.hits + node.misses;
                    const rate = total > 0 ? ((node.hits / total) * 100).toFixed(0) + '%' : '0%';
                    const isTarget = debugRouting && debugRouting.targetNode === node.name;
                    return (
                      <tr key={node.name} className={isTarget ? 'active-node-row' : ''}>
                        <td>
                          <span className={`node-indicator ${isTarget ? 'target' : ''}`}></span>
                          {node.name}
                        </td>
                        <td>{node.keysCount}</td>
                        <td>{node.hits}</td>
                        <td>{node.misses}</td>
                        <td>{rate}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Micro Debug Panel for Active Hashing */}
            {debugRouting && (
              <div className="routing-debug-info">
                <div className="debug-header">
                  <span className="label">ACTIVE HASH ROUTING</span>
                  <span className={`status-badge ${debugRouting.status}`}>
                    {debugRouting.status.toUpperCase()}
                  </span>
                </div>
                <div className="debug-body">
                  <div className="debug-cell">
                    <span className="cell-label">Prefix:</span>
                    <span className="cell-val">{debugRouting.prefix}</span>
                  </div>
                  <div className="debug-cell">
                    <span className="cell-label">Hash Coordinate:</span>
                    <span className="cell-val font-mono">{debugRouting.cacheRingHash}</span>
                  </div>
                  <div className="debug-cell">
                    <span className="cell-label">Target Node:</span>
                    <span className="cell-val text-white">{debugRouting.targetNode}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* System Event Logs */}
          <div className="card logs-card">
            <div className="logs-header">
              <h2>Real-Time System Log</h2>
              <button onClick={() => setLogs([])} className="text-btn">Clear</button>
            </div>
            <div className="logs-console" id="log-console-box">
              {logs.length === 0 ? (
                <div className="log-empty">System idle. Waiting for events...</div>
              ) : (
                logs.map((log, index) => (
                  <div key={index} className="log-line">
                    <span className="log-arrow">&gt;</span> {log}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
