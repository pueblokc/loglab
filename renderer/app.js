// ============================================================
// LogLab — Renderer
// ============================================================

(() => {
  'use strict';

  // ---- State ----
  const state = {
    tabs: [],           // { id, name, path, entries, filteredEntries, stats, bookmarks, tailing, scrollPos }
    activeTabId: null,
    searchQuery: '',
    searchRegex: false,
    searchCaseSensitive: false,
    searchMatches: [],   // indices into filteredEntries
    searchCurrentIdx: -1,
    levelFilter: 'all',
    autoScroll: false,
    sidebarPanel: null,  // 'stats' | 'bookmarks' | null
    timelineVisible: false,
  };

  let tabIdCounter = 0;

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    titleFile: $('#title-file'),
    toolbar: $('#toolbar'),
    searchInput: $('#search-input'),
    searchRegex: $('#search-regex'),
    searchCase: $('#search-case'),
    searchCount: $('#search-count'),
    tabsContainer: $('#tabs-container'),
    sidebar: $('#sidebar'),
    statsPanel: $('#stats-panel'),
    bookmarksPanel: $('#bookmarks-panel'),
    logArea: $('#log-area'),
    logViewer: $('#log-viewer'),
    scrollContainer: $('#log-scroll-container'),
    spacer: $('#log-spacer'),
    viewport: $('#log-viewport'),
    timelineBar: $('#timeline-bar'),
    timelineCanvas: $('#timeline-canvas'),
    dropOverlay: $('#drop-overlay'),
    welcomeScreen: $('#welcome-screen'),
    statusText: $('#status-text'),
    statusLines: $('#status-lines'),
    statusFiltered: $('#status-filtered'),
    statusTail: $('#status-tail'),
    statusEncoding: $('#status-encoding'),
    exportMenu: $('#export-menu'),
    levelChart: $('#level-chart'),
    hourlyChart: $('#hourly-chart'),
    errorPatterns: $('#error-patterns'),
    sourceList: $('#source-list'),
    bookmarksBody: $('#bookmarks-body'),
    recentSection: $('#recent-files-section'),
    recentList: $('#recent-files-list'),
  };

  // ============================================================
  // Virtual Scroll Engine
  // ============================================================
  const LINE_HEIGHT = 20;
  const BUFFER_LINES = 20; // extra lines above/below viewport

  function getActiveTab() {
    return state.tabs.find(t => t.id === state.activeTabId);
  }

  function getVisibleRange() {
    const scrollTop = dom.scrollContainer.scrollTop;
    const viewHeight = dom.logViewer.clientHeight;
    const tab = getActiveTab();
    if (!tab) return { start: 0, end: 0 };

    const totalLines = tab.filteredEntries.length;
    const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - BUFFER_LINES);
    const end = Math.min(totalLines, Math.ceil((scrollTop + viewHeight) / LINE_HEIGHT) + BUFFER_LINES);
    return { start, end };
  }

  function renderLogLines() {
    const tab = getActiveTab();
    if (!tab) {
      dom.viewport.innerHTML = '';
      dom.spacer.style.height = '0px';
      return;
    }

    const entries = tab.filteredEntries;
    const totalHeight = entries.length * LINE_HEIGHT;
    dom.spacer.style.height = totalHeight + 'px';

    const { start, end } = getVisibleRange();
    dom.viewport.style.top = (start * LINE_HEIGHT) + 'px';

    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const entry = entries[i];
      if (!entry) continue;
      fragment.appendChild(createLogLine(entry, i));
    }

    dom.viewport.innerHTML = '';
    dom.viewport.appendChild(fragment);
  }

  function createLogLine(entry, idx) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.dataset.idx = idx;
    div.dataset.lineNum = entry.line;

    // Level class
    if (entry.level === 'ERROR' || entry.level === 'FATAL' || entry.level === 'WARN' || entry.level === 'DEBUG') {
      div.classList.add('level-' + entry.level);
    }

    // Bookmark
    const tab = getActiveTab();
    if (tab && tab.bookmarks.includes(entry.line)) {
      div.classList.add('bookmarked');
    }

    // Search match
    if (state.searchMatches.includes(idx)) {
      div.classList.add('search-match');
      if (idx === state.searchMatches[state.searchCurrentIdx]) {
        div.classList.add('search-current');
      }
    }

    // Gutter
    const gutter = document.createElement('div');
    gutter.className = 'log-gutter';
    gutter.textContent = entry.line >= 0 ? entry.line : '';

    const bmBtn = document.createElement('button');
    bmBtn.className = 'bookmark-btn';
    bmBtn.innerHTML = '&#9654;'; // triangle
    bmBtn.title = 'Toggle bookmark';
    bmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBookmark(entry.line);
    });
    gutter.appendChild(bmBtn);

    // Content
    const content = document.createElement('div');
    content.className = 'log-content';
    content.innerHTML = highlightLogLine(entry);

    div.appendChild(gutter);
    div.appendChild(content);

    // Click to select
    div.addEventListener('click', () => {
      $$('.log-line.selected').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
    });

    return div;
  }

  function highlightLogLine(entry) {
    let text = escapeHtml(entry.raw);

    // Highlight timestamp
    if (entry.timestamp) {
      const escaped = escapeHtml(entry.timestamp);
      text = text.replace(escaped, `<span class="ts">${escaped}</span>`);
    }

    // Highlight source
    if (entry.source) {
      const escaped = escapeHtml(entry.source);
      text = text.replace(escaped, `<span class="src">${escaped}</span>`);
    }

    // Highlight level keyword
    const levelPatterns = {
      FATAL: /\b(FATAL|CRITICAL|CRIT)\b/gi,
      ERROR: /\b(ERROR|ERR)\b/gi,
      WARN: /\b(WARNING|WARN)\b/gi,
      INFO: /\b(INFO|INFORMATION|NOTICE)\b/gi,
      DEBUG: /\b(DEBUG|TRACE|VERBOSE)\b/gi,
    };
    const pat = levelPatterns[entry.level];
    if (pat) {
      text = text.replace(pat, `<span class="level-tag level-${entry.level}">$1</span>`);
    }

    // Highlight search matches
    if (state.searchQuery) {
      try {
        let searchRe;
        if (state.searchRegex) {
          searchRe = new RegExp(`(${state.searchQuery})`, state.searchCaseSensitive ? 'g' : 'gi');
        } else {
          const escaped = escapeRegex(state.searchQuery);
          searchRe = new RegExp(`(${escaped})`, state.searchCaseSensitive ? 'g' : 'gi');
        }
        text = text.replace(searchRe, '<span class="search-highlight">$1</span>');
      } catch { /* invalid regex */ }
    }

    return text;
  }

  // ============================================================
  // Filtering
  // ============================================================
  function applyFilters() {
    const tab = getActiveTab();
    if (!tab) return;

    let entries = tab.entries;

    // Level filter
    if (state.levelFilter !== 'all') {
      entries = entries.filter(e => e.level === state.levelFilter);
    }

    // Search filter (don't filter, just mark matches)
    tab.filteredEntries = entries;

    // Compute search matches
    computeSearchMatches();

    // Update display
    renderLogLines();
    updateStatusBar();
    updateTimeline();
  }

  function computeSearchMatches() {
    state.searchMatches = [];
    state.searchCurrentIdx = -1;

    const tab = getActiveTab();
    if (!tab || !state.searchQuery) {
      dom.searchCount.textContent = '';
      return;
    }

    try {
      let searchRe;
      if (state.searchRegex) {
        searchRe = new RegExp(state.searchQuery, state.searchCaseSensitive ? '' : 'i');
      } else {
        const escaped = escapeRegex(state.searchQuery);
        searchRe = new RegExp(escaped, state.searchCaseSensitive ? '' : 'i');
      }

      tab.filteredEntries.forEach((entry, idx) => {
        if (searchRe.test(entry.raw)) {
          state.searchMatches.push(idx);
        }
      });

      if (state.searchMatches.length > 0) {
        state.searchCurrentIdx = 0;
        dom.searchCount.textContent = `1/${state.searchMatches.length}`;
      } else {
        dom.searchCount.textContent = '0 results';
      }
    } catch {
      dom.searchCount.textContent = 'Invalid regex';
    }
  }

  function navigateSearch(direction) {
    if (state.searchMatches.length === 0) return;

    if (direction === 'next') {
      state.searchCurrentIdx = (state.searchCurrentIdx + 1) % state.searchMatches.length;
    } else {
      state.searchCurrentIdx = (state.searchCurrentIdx - 1 + state.searchMatches.length) % state.searchMatches.length;
    }

    dom.searchCount.textContent = `${state.searchCurrentIdx + 1}/${state.searchMatches.length}`;

    // Scroll to match
    const matchIdx = state.searchMatches[state.searchCurrentIdx];
    scrollToLine(matchIdx);
    renderLogLines();
  }

  function scrollToLine(idx) {
    const scrollTop = idx * LINE_HEIGHT - dom.logViewer.clientHeight / 2;
    dom.scrollContainer.scrollTop = Math.max(0, scrollTop);
  }

  // ============================================================
  // Tabs
  // ============================================================
  function createTab(name, filePath) {
    const id = 'tab-' + (++tabIdCounter);
    const tab = {
      id, name, path: filePath,
      entries: [], filteredEntries: [], stats: null,
      bookmarks: [], tailing: false, scrollPos: 0,
    };
    state.tabs.push(tab);
    renderTabs();
    switchTab(id);
    return tab;
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;

    const tab = state.tabs[idx];
    if (tab.tailing) window.loglab.stopTail(id);

    state.tabs.splice(idx, 1);

    if (state.activeTabId === id) {
      if (state.tabs.length > 0) {
        switchTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
      } else {
        state.activeTabId = null;
        showWelcome(true);
        dom.titleFile.textContent = '';
        dom.statusLines.textContent = '';
        dom.statusFiltered.textContent = '';
        dom.viewport.innerHTML = '';
        dom.spacer.style.height = '0px';
      }
    }
    renderTabs();
  }

  function switchTab(id) {
    // Save scroll position of current tab
    const current = getActiveTab();
    if (current) current.scrollPos = dom.scrollContainer.scrollTop;

    state.activeTabId = id;
    const tab = getActiveTab();
    if (!tab) return;

    dom.titleFile.textContent = tab.path || tab.name;
    showWelcome(false);

    // Update tail status
    dom.statusTail.classList.toggle('hidden', !tab.tailing);

    // Restore scroll position
    applyFilters();
    renderTabs();

    requestAnimationFrame(() => {
      dom.scrollContainer.scrollTop = tab.scrollPos;
      renderLogLines();
    });

    // Update stats if sidebar visible
    if (state.sidebarPanel === 'stats') renderStats();
    if (state.sidebarPanel === 'bookmarks') renderBookmarks();
  }

  function renderTabs() {
    dom.tabsContainer.innerHTML = '';
    state.tabs.forEach(tab => {
      const el = document.createElement('button');
      el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '');

      let html = `<span class="tab-name">${escapeHtml(tab.name)}</span>`;
      if (tab.tailing) html = `<span class="tab-tail-indicator"></span>` + html;
      html += `<button class="tab-close" data-tab="${tab.id}">&times;</button>`;

      el.innerHTML = html;
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          closeTab(e.target.dataset.tab);
        } else {
          switchTab(tab.id);
        }
      });
      dom.tabsContainer.appendChild(el);
    });
  }

  // ============================================================
  // File Loading
  // ============================================================
  async function loadFile(filePath) {
    dom.statusText.textContent = `Loading ${filePath}...`;

    const result = await window.loglab.readLogFile(filePath);
    if (result.error) {
      dom.statusText.textContent = `Error: ${result.error}`;
      return;
    }

    // Add to recent files
    window.loglab.addRecentFile(filePath);

    // Create or reuse tab
    let tab = state.tabs.find(t => t.path === filePath);
    if (tab) {
      // Reload into existing tab
      tab.entries = result.entries;
      tab.stats = result.stats;
      tab.filteredEntries = result.entries;
      switchTab(tab.id);
    } else {
      tab = createTab(result.name, filePath);
      tab.entries = result.entries;
      tab.stats = result.stats;
      tab.filteredEntries = result.entries;
    }

    // Load bookmarks
    const bookmarks = await window.loglab.getBookmarks(filePath);
    tab.bookmarks = bookmarks || [];

    applyFilters();
    dom.statusText.textContent = `Loaded ${result.name} (${formatSize(result.fileStats?.size || 0)})`;
    dom.statusEncoding.textContent = 'UTF-8';

    // Auto-scroll to bottom if enabled
    if (state.autoScroll) {
      scrollToLine(tab.filteredEntries.length - 1);
    }
  }

  async function openFile() {
    const paths = await window.loglab.openFileDialog();
    if (!paths || paths.length === 0) return;
    for (const fp of paths) await loadFile(fp);
  }

  async function openWatchDir() {
    const dir = await window.loglab.openDirDialog();
    if (!dir) return;
    dom.statusText.textContent = `Watching ${dir}...`;
    await window.loglab.watchDirectory(dir);
  }

  // ============================================================
  // Tail Mode
  // ============================================================
  async function toggleTail() {
    const tab = getActiveTab();
    if (!tab || !tab.path) return;

    if (tab.tailing) {
      await window.loglab.stopTail(tab.id);
      tab.tailing = false;
      dom.statusTail.classList.add('hidden');
      dom.statusText.textContent = 'Tail stopped';
    } else {
      await window.loglab.startTail(tab.path, tab.id);
      tab.tailing = true;
      state.autoScroll = true;
      $('#btn-autoscroll').classList.add('active');
      dom.statusTail.classList.remove('hidden');
      dom.statusText.textContent = `Tailing ${tab.name}...`;
    }

    $('#btn-tail').classList.toggle('active', tab.tailing);
    renderTabs();
  }

  // Handle incoming tail data
  window.loglab.onTailData(({ tabId, entries }) => {
    const tab = state.tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Assign line numbers
    const startLine = tab.entries.length + 1;
    entries.forEach((e, i) => { e.line = startLine + i; });

    tab.entries.push(...entries);

    // Re-filter
    if (state.levelFilter !== 'all') {
      const newFiltered = entries.filter(e => e.level === state.levelFilter);
      tab.filteredEntries.push(...newFiltered);
    } else {
      tab.filteredEntries.push(...entries);
    }

    // Update stats
    if (tab.stats) {
      for (const e of entries) {
        if (tab.stats.levelCounts[e.level] !== undefined) tab.stats.levelCounts[e.level]++;
      }
      tab.stats.totalLines = tab.entries.length;
    }

    if (tab.id === state.activeTabId) {
      if (state.autoScroll) {
        renderLogLines();
        scrollToLine(tab.filteredEntries.length - 1);
      } else {
        renderLogLines();
      }
      updateStatusBar();
      if (state.sidebarPanel === 'stats') renderStats();
    }
  });

  // Handle directory file discovery
  window.loglab.onDirFileFound(({ path: fp, name }) => {
    dom.statusText.textContent = `Found: ${name}`;
    // Auto-open the first few
    if (state.tabs.length < 5) loadFile(fp);
  });

  // ============================================================
  // Bookmarks
  // ============================================================
  function toggleBookmark(lineNum) {
    const tab = getActiveTab();
    if (!tab) return;

    const idx = tab.bookmarks.indexOf(lineNum);
    if (idx >= 0) {
      tab.bookmarks.splice(idx, 1);
    } else {
      tab.bookmarks.push(lineNum);
      tab.bookmarks.sort((a, b) => a - b);
    }

    // Save
    if (tab.path) window.loglab.setBookmarks(tab.path, tab.bookmarks);

    renderLogLines();
    if (state.sidebarPanel === 'bookmarks') renderBookmarks();
  }

  function renderBookmarks() {
    const tab = getActiveTab();
    if (!tab || tab.bookmarks.length === 0) {
      dom.bookmarksBody.innerHTML = '<div class="empty-state">No bookmarks yet. Click the marker on any line gutter.</div>';
      return;
    }

    dom.bookmarksBody.innerHTML = '';
    tab.bookmarks.forEach(lineNum => {
      const entry = tab.entries.find(e => e.line === lineNum);
      if (!entry) return;

      const div = document.createElement('div');
      div.className = 'bookmark-item';
      div.innerHTML = `
        <span class="bookmark-line">${lineNum}</span>
        <span class="bookmark-text">${escapeHtml(entry.raw.substring(0, 120))}</span>
        <button class="bookmark-remove" data-line="${lineNum}">&times;</button>
      `;
      div.addEventListener('click', (e) => {
        if (e.target.classList.contains('bookmark-remove')) {
          toggleBookmark(parseInt(e.target.dataset.line));
          return;
        }
        const idx = tab.filteredEntries.findIndex(fe => fe.line === lineNum);
        if (idx >= 0) scrollToLine(idx);
      });
      dom.bookmarksBody.appendChild(div);
    });
  }

  // ============================================================
  // Statistics Panel
  // ============================================================
  function renderStats() {
    const tab = getActiveTab();
    if (!tab || !tab.stats) {
      dom.levelChart.innerHTML = '<div class="empty-state">No data</div>';
      dom.hourlyChart.innerHTML = '';
      dom.errorPatterns.innerHTML = '';
      dom.sourceList.innerHTML = '';
      return;
    }

    const s = tab.stats;
    const total = Object.values(s.levelCounts).reduce((a, b) => a + b, 0) || 1;

    // Level chart
    const levels = [
      { key: 'FATAL', label: 'FATAL', cls: 'fatal', color: 'var(--maroon)' },
      { key: 'ERROR', label: 'ERROR', cls: 'error', color: 'var(--red)' },
      { key: 'WARN', label: 'WARN', cls: 'warn', color: 'var(--yellow)' },
      { key: 'INFO', label: 'INFO', cls: 'info', color: 'var(--blue)' },
      { key: 'DEBUG', label: 'DEBUG', cls: 'debug', color: 'var(--overlay0)' },
    ];

    dom.levelChart.innerHTML = levels.map(l => {
      const count = s.levelCounts[l.key] || 0;
      const pct = (count / total * 100).toFixed(1);
      return `<div class="level-bar-row">
        <span class="level-bar-label" style="color:${l.color}">${l.label}</span>
        <div class="level-bar-track"><div class="level-bar-fill ${l.cls}" style="width:${pct}%"></div></div>
        <span class="level-bar-count">${formatNum(count)}</span>
      </div>`;
    }).join('');

    // Hourly chart
    if (s.hourlyData.length > 0) {
      const maxCount = Math.max(...s.hourlyData.map(h => h.count)) || 1;
      dom.hourlyChart.innerHTML = s.hourlyData.map(h => {
        const pct = (h.count / maxCount * 100);
        return `<div class="hourly-bar" style="height:${Math.max(2, pct)}%">
          <div class="tooltip">${h.hour}: ${formatNum(h.count)} msgs</div>
        </div>`;
      }).join('');
    } else {
      dom.hourlyChart.innerHTML = '<div class="empty-state" style="height:100%;display:flex;align-items:center;justify-content:center">No timestamp data</div>';
    }

    // Error patterns
    if (s.topErrors.length > 0) {
      dom.errorPatterns.innerHTML = s.topErrors.map(e =>
        `<div class="error-pattern-item">
          <span class="error-pattern-count">${e.count}</span>
          <span class="error-pattern-text" title="${escapeHtml(e.pattern)}">${escapeHtml(e.pattern)}</span>
        </div>`
      ).join('');
    } else {
      dom.errorPatterns.innerHTML = '<div class="empty-state">No errors found</div>';
    }

    // Sources
    const srcEntries = Object.entries(s.sources).sort((a, b) => b[1] - a[1]).slice(0, 30);
    if (srcEntries.length > 0) {
      dom.sourceList.innerHTML = srcEntries.map(([name, count]) =>
        `<div class="source-item">
          <span class="source-name">${escapeHtml(name)}</span>
          <span class="source-count">${formatNum(count)}</span>
        </div>`
      ).join('');
    } else {
      dom.sourceList.innerHTML = '<div class="empty-state">No source data</div>';
    }
  }

  // ============================================================
  // Timeline
  // ============================================================
  function updateTimeline() {
    if (!state.timelineVisible) return;

    const tab = getActiveTab();
    if (!tab || !tab.stats || tab.stats.hourlyData.length === 0) return;

    const canvas = dom.timelineCanvas;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const data = tab.stats.hourlyData;
    const maxCount = Math.max(...data.map(h => h.count)) || 1;
    const barWidth = Math.max(2, canvas.width / data.length - 1);

    // Color based on density
    data.forEach((h, i) => {
      const x = (i / data.length) * canvas.width;
      const height = (h.count / maxCount) * (canvas.height - 8);
      const intensity = h.count / maxCount;

      if (intensity > 0.7) ctx.fillStyle = '#f38ba8';
      else if (intensity > 0.4) ctx.fillStyle = '#f9e2af';
      else ctx.fillStyle = '#89b4fa';

      ctx.fillRect(x, canvas.height - height - 4, barWidth, height);
    });

    // Draw labels
    ctx.fillStyle = '#6c7086';
    ctx.font = '9px Consolas';
    if (data.length > 0) {
      ctx.fillText(data[0].hour, 4, 10);
      ctx.fillText(data[data.length - 1].hour, canvas.width - 80, 10);
    }
  }

  // ============================================================
  // Export
  // ============================================================
  async function exportFiltered(format) {
    const tab = getActiveTab();
    if (!tab) return;

    const ok = await window.loglab.exportData(tab.filteredEntries, format);
    dom.statusText.textContent = ok ? `Exported as ${format.toUpperCase()}` : 'Export cancelled';
    dom.exportMenu.classList.add('hidden');
  }

  // ============================================================
  // UI Updates
  // ============================================================
  function updateStatusBar() {
    const tab = getActiveTab();
    if (!tab) return;
    dom.statusLines.textContent = `${formatNum(tab.entries.length)} lines`;
    if (tab.filteredEntries.length !== tab.entries.length) {
      dom.statusFiltered.textContent = `(${formatNum(tab.filteredEntries.length)} shown)`;
    } else {
      dom.statusFiltered.textContent = '';
    }
  }

  function showWelcome(show) {
    dom.welcomeScreen.classList.toggle('hidden', !show);
    dom.logViewer.style.display = show ? 'none' : '';
  }

  function toggleSidebar(panel) {
    if (state.sidebarPanel === panel) {
      // Close
      state.sidebarPanel = null;
      dom.sidebar.classList.add('hidden');
      dom.statsPanel.classList.add('hidden');
      dom.bookmarksPanel.classList.add('hidden');
      $('#btn-stats-toggle').classList.remove('active');
      $('#btn-bookmark-toggle').classList.remove('active');
    } else {
      state.sidebarPanel = panel;
      dom.sidebar.classList.remove('hidden');
      dom.statsPanel.classList.toggle('hidden', panel !== 'stats');
      dom.bookmarksPanel.classList.toggle('hidden', panel !== 'bookmarks');
      $('#btn-stats-toggle').classList.toggle('active', panel === 'stats');
      $('#btn-bookmark-toggle').classList.toggle('active', panel === 'bookmarks');

      if (panel === 'stats') renderStats();
      if (panel === 'bookmarks') renderBookmarks();
    }
  }

  function toggleTimeline() {
    state.timelineVisible = !state.timelineVisible;
    dom.timelineBar.classList.toggle('hidden', !state.timelineVisible);
    $('#btn-timeline-toggle').classList.toggle('active', state.timelineVisible);
    if (state.timelineVisible) updateTimeline();
  }

  // ============================================================
  // Recent Files
  // ============================================================
  async function loadRecentFiles() {
    const recent = await window.loglab.getRecentFiles();
    if (recent.length === 0) {
      dom.recentSection.classList.add('hidden');
      return;
    }

    dom.recentSection.classList.remove('hidden');
    dom.recentList.innerHTML = '';
    recent.slice(0, 8).forEach(fp => {
      const div = document.createElement('div');
      div.className = 'recent-file-item';
      div.textContent = fp;
      div.addEventListener('click', () => loadFile(fp));
      dom.recentList.appendChild(div);
    });
  }

  // ============================================================
  // Drag & Drop
  // ============================================================
  function setupDragDrop() {
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropOverlay.classList.remove('hidden');
    });

    dom.dropOverlay.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dom.dropOverlay.classList.add('hidden');
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dom.dropOverlay.classList.add('hidden');

      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (file.path) await loadFile(file.path);
      }
    });
  }

  // ============================================================
  // Event Handlers
  // ============================================================
  function setupEvents() {
    // Window controls
    $('#btn-minimize').addEventListener('click', () => window.loglab.minimizeWindow());
    $('#btn-maximize').addEventListener('click', () => window.loglab.maximizeWindow());
    $('#btn-close').addEventListener('click', () => window.loglab.closeWindow());

    // Toolbar buttons
    $('#btn-open').addEventListener('click', openFile);
    $('#btn-add-tab').addEventListener('click', openFile);
    $('#btn-watch-dir').addEventListener('click', openWatchDir);
    $('#btn-tail').addEventListener('click', toggleTail);
    $('#btn-stats-toggle').addEventListener('click', () => toggleSidebar('stats'));
    $('#btn-bookmark-toggle').addEventListener('click', () => toggleSidebar('bookmarks'));
    $('#btn-timeline-toggle').addEventListener('click', toggleTimeline);

    // Auto-scroll
    $('#btn-autoscroll').addEventListener('click', () => {
      state.autoScroll = !state.autoScroll;
      $('#btn-autoscroll').classList.toggle('active', state.autoScroll);
      if (state.autoScroll) {
        const tab = getActiveTab();
        if (tab) scrollToLine(tab.filteredEntries.length - 1);
      }
    });

    // Export
    $('#btn-export').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      dom.exportMenu.style.top = (rect.bottom + 4) + 'px';
      dom.exportMenu.style.left = rect.left + 'px';
      dom.exportMenu.classList.toggle('hidden');
    });
    $$('.dropdown-item[data-format]').forEach(btn => {
      btn.addEventListener('click', () => exportFiltered(btn.dataset.format));
    });

    // Close export menu on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#btn-export') && !e.target.closest('#export-menu')) {
        dom.exportMenu.classList.add('hidden');
      }
    });

    // Search
    dom.searchInput.addEventListener('input', debounce(() => {
      state.searchQuery = dom.searchInput.value;
      computeSearchMatches();
      renderLogLines();
    }, 150));

    dom.searchRegex.addEventListener('change', () => {
      state.searchRegex = dom.searchRegex.checked;
      computeSearchMatches();
      renderLogLines();
    });

    dom.searchCase.addEventListener('change', () => {
      state.searchCaseSensitive = dom.searchCase.checked;
      computeSearchMatches();
      renderLogLines();
    });

    $('#search-next').addEventListener('click', () => navigateSearch('next'));
    $('#search-prev').addEventListener('click', () => navigateSearch('prev'));

    // Level filter buttons
    $$('.level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.level-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.levelFilter = btn.dataset.level;
        applyFilters();
      });
    });

    // Sidebar close buttons
    $$('.sidebar-close').forEach(btn => {
      btn.addEventListener('click', () => toggleSidebar(btn.dataset.panel));
    });

    // Virtual scroll
    dom.scrollContainer.addEventListener('scroll', () => {
      renderLogLines();

      // Disable auto-scroll if user scrolls up
      if (state.autoScroll) {
        const tab = getActiveTab();
        if (tab) {
          const maxScroll = tab.filteredEntries.length * LINE_HEIGHT - dom.logViewer.clientHeight;
          if (dom.scrollContainer.scrollTop < maxScroll - LINE_HEIGHT * 3) {
            state.autoScroll = false;
            $('#btn-autoscroll').classList.remove('active');
          }
        }
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'o') { e.preventDefault(); openFile(); }
      if (e.ctrlKey && e.key === 'f') { e.preventDefault(); dom.searchInput.focus(); dom.searchInput.select(); }
      if (e.ctrlKey && e.key === 'b') { e.preventDefault(); toggleSidebar('bookmarks'); }
      if (e.key === 'F3' || (e.ctrlKey && e.key === 'g')) { e.preventDefault(); navigateSearch(e.shiftKey ? 'prev' : 'next'); }
      if (e.key === 'Escape') {
        dom.searchInput.blur();
        dom.exportMenu.classList.add('hidden');
      }
      if (e.ctrlKey && e.key === 'w') { e.preventDefault(); if (state.activeTabId) closeTab(state.activeTabId); }
    });

    // Resize -> re-render
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        renderLogLines();
        if (state.timelineVisible) updateTimeline();
      }, 100);
    });
  }

  // ============================================================
  // Utilities
  // ============================================================
  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatNum(n) {
    return n.toLocaleString();
  }

  // ============================================================
  // Init
  // ============================================================
  async function init() {
    setupEvents();
    setupDragDrop();
    showWelcome(true);
    await loadRecentFiles();
    dom.statusText.textContent = 'Ready — drag files or press Ctrl+O';
  }

  init();
})();
