/* AIM charity directory widget. No dependencies, no network calls except the optional live-data
   refresh. Usage:
     AimDirectory.mount(rootElement, { data, dataUrl, imageBase, title, pageSize })
   - data:      charities.json content (rendered immediately, e.g. the inline snapshot)
   - dataUrl:   optional URL of the live charities.json; fetched in the background and only
                re-rendered when its content differs from `data`
   - imageBase: prefix for relative image paths (the GitHub Pages URL when embedded elsewhere)
   - title:     heading text; "{n}" is replaced with the number of charities
   Everything rendered is built with DOM APIs and textContent, never innerHTML. */
(function (global) {
  'use strict';

  var CAUSE_STYLES = {
    'Global health':                      { dot: '#20709F', bg: '#E1EBF3', text: '#1B5578' },
    "Family planning and women's health": { dot: '#AF4080', bg: '#F5E3EC', text: '#7E2B5B' },
    'Animal welfare':                     { dot: '#507A30', bg: '#E6ECE2', text: '#3F6529' },
    'Policy':                             { dot: '#70509F', bg: '#EAE5F2', text: '#4F3876' },
    'Livelihoods and growth':             { dot: '#8D6A12', bg: '#F2ECD9', text: '#6B5010' },
    'Mental health':                      { dot: '#16786E', bg: '#DFEEEC', text: '#125C54' },
    'Effective giving':                   { dot: '#B7643C', bg: '#F6E6DD', text: '#874426' },
    'Research':                           { dot: '#5D6C8C', bg: '#E5E9F0', text: '#3E4B66' },
    'Talent and capacity building':       { dot: '#4C5C68', bg: '#E4E8EB', text: '#37454F' }
  };
  var FALLBACK_STYLE = { dot: '#8A7674', bg: '#EEE8E3', text: '#5F524F' };
  var CAUSE_TAG_LABELS = { "Family planning and women's health": "Family planning & women's health" };
  var GLOBAL = 'Global';
  var MAX_COUNTRIES = 3;
  var MAX_AVATARS = 3;
  var STATUS_LABELS = { Shutdown: 'Closed', Merged: 'Merged' };

  /* ---------- tiny DOM helpers ---------- */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'class') node.className = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(parent, c); }); return; }
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function svgIcon(pathD) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', pathD); p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#4E3F40'); p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round');
    svg.appendChild(p);
    return svg;
  }

  /* ---------- text helpers ---------- */
  function fold(s) {
    return String(s === null || s === undefined ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  function idPart(s) { return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }
  function initials(name) {
    var parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    var first = parts[0].charAt(0), last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
  }
  function monogram(name) {
    var m = /\(([^)]{2,8})\)\s*$/.exec(name);
    if (m) return m[1];
    var words = String(name).split(/\s+/).filter(function (w) { return /^[A-Za-z0-9]/.test(w) && !/^(for|of|the|and|to|de|la|del|&)$/i.test(w); });
    if (words.length === 1) return words[0].length <= 10 ? words[0] : words[0].slice(0, 1);
    return words.slice(0, 3).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }
  /** "A, B & C" where each item is a text node or a LinkedIn link. */
  function founderNodes(founders) {
    var nodes = [];
    founders.forEach(function (f, i) {
      if (i > 0) nodes.push(i === founders.length - 1 ? ' & ' : ', ');
      nodes.push(f.linkedin
        ? el('a', { href: f.linkedin, target: '_blank', rel: 'noopener', text: f.name },
            el('span', { class: 'aim-dir__sr', text: ' (LinkedIn, opens in a new tab)' }))
        : f.name);
    });
    return nodes;
  }
  /** Blurbs may contain [text](https://url) links; render them as anchors, everything else as text. */
  var LINK_RE = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]{1,300})\)/g;
  function blurbNodes(text) {
    var nodes = [], last = 0, m;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(text))) {
      if (m.index > last) nodes.push(text.slice(last, m.index));
      nodes.push(el('a', { href: m[2], target: '_blank', rel: 'noopener', text: m[1] }, el('span', { class: 'aim-dir__sr', text: ' (opens in a new tab)' })));
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }
  function plainText(text) { return String(text || '').replace(LINK_RE, '$1'); }
  /** Squarespace themes often set the body font on <p> rather than <body>; read it from a probe paragraph. */
  function adoptHostFont(root) {
    try {
      var probe = el('p', { class: 'aim-dir__probe', 'aria-hidden': 'true', text: 'x' });
      root.appendChild(probe);
      var pFont = getComputedStyle(probe).fontFamily;
      var rootFont = getComputedStyle(root).fontFamily;
      root.removeChild(probe);
      if (pFont && pFont !== rootFont) root.style.setProperty('--aim-font-body', pFont);
    } catch (e) { /* leave fonts as they are */ }
  }
  function cohortCompare(a, b) {
    var ya = parseInt(a, 10) || 0, yb = parseInt(b, 10) || 0;
    if (ya !== yb) return yb - ya; // newest first
    return a.localeCompare(b);
  }
  function debounce(fn, ms) {
    var t;
    return function () { var args = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, args); }, ms); };
  }
  function normaliseData(raw) {
    var d = raw && typeof raw === 'object' ? raw : {};
    var charities = Array.isArray(d.charities) ? d.charities : [];
    return {
      causes: Array.isArray(d.causes) ? d.causes : Object.keys(CAUSE_STYLES),
      continents: Array.isArray(d.continents) ? d.continents : [],
      countryContinent: d.countryContinent && typeof d.countryContinent === 'object' ? d.countryContinent : {},
      charities: charities.map(function (c) {
        return {
          id: String(c.id || idPart(c.name || 'charity')),
          name: String(c.name || ''),
          blurb: c.blurb ? String(c.blurb) : null,
          url: /^https?:\/\//i.test(c.url || '') ? c.url : null,
          causes: Array.isArray(c.causes) ? c.causes : [],
          countries: Array.isArray(c.countries) ? c.countries : [],
          cohort: c.cohort ? String(c.cohort) : null,
          status: c.status ? String(c.status) : null,
          logo: c.logo && c.logo.src ? c.logo : null,
          founders: (Array.isArray(c.founders) ? c.founders : []).filter(function (f) { return f && f.name; }).map(function (f) {
            return { name: String(f.name), role: f.role ? String(f.role) : null, photo: f.photo && f.photo.src ? f.photo : null,
              linkedin: /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(f.linkedin || '') ? f.linkedin : null };
          })
        };
      })
    };
  }
  function comparable(d) {
    return JSON.stringify({ c: d.charities, cc: d.countryContinent, co: d.continents, ca: d.causes });
  }

  /* ---------- the widget ---------- */
  function mount(root, options) {
    options = options || {};
    if (!root) throw new Error('AimDirectory.mount: root element is required');
    root.classList.add('aim-dir');
    if (!root.id) root.id = 'aim-dir-' + Math.random().toString(36).slice(2, 8);
    var rootId = root.id;
    var imageBase = options.imageBase || '';
    var pageSize = options.pageSize || 6;
    var snapshotDelay = typeof options.snapshotDelay === 'number' ? options.snapshotDelay : 1500;
    var state = { cause: null, region: null, cohort: null, query: '', shown: pageSize, expanded: {} };
    var snapshot = options.data ? normaliseData(options.data) : null;
    var data = null;

    if (options.fontBody) root.style.setProperty('--aim-font-body', options.fontBody);
    else adoptHostFont(root);
    if (options.fontHeading) root.style.setProperty('--aim-font-heading', options.fontHeading);

    function resolve(src) { return /^(https?:)?\/\//i.test(src) || (src.charAt(0) === '/' && !imageBase) ? src : imageBase + src; }
    function clearSearch() { state.query = ''; searchInput.value = ''; }

    /* shell: title, search, filters, results (CSS grid places them) */
    var titleEl = el('h2', { class: 'aim-dir__title', id: rootId + '-title' });
    var searchInput = el('input', {
      type: 'search', id: rootId + '-search',
      placeholder: 'Search by charity, founder, type of work...', autocomplete: 'off', spellcheck: 'false',
      'aria-describedby': rootId + '-status',
      oninput: debounce(function (e) { state.query = e.target.value; state.shown = pageSize; render(); }, 120)
    });
    var searchEl = el('div', { class: 'aim-dir__search' },
      el('label', { class: 'aim-dir__sr', for: rootId + '-search', text: 'Search charities' }),
      searchInput,
      svgIcon('M15.5 15.5 21 21M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z'));
    var causeList = el('ul', { class: 'aim-dir__options', 'aria-labelledby': rootId + '-cause-label' });
    var regionList = el('ul', { class: 'aim-dir__options', 'aria-labelledby': rootId + '-region-label' });
    var cohortSelect = el('select', {
      class: 'aim-dir__select', id: rootId + '-cohort',
      onchange: function (e) {
        // A cohort is shown in its entirety: it replaces any cause/region selection and any search.
        state.cohort = e.target.value || null; state.cause = null; state.region = null; clearSearch();
        state.shown = pageSize; render({ focus: cohortSelect.id });
      }
    });
    var filtersEl = el('div', { class: 'aim-dir__filters' },
      el('div', { class: 'aim-dir__group' }, el('label', { class: 'aim-dir__label', for: rootId + '-cohort', text: 'Cohort' }), cohortSelect),
      el('div', { class: 'aim-dir__group' }, el('p', { class: 'aim-dir__label', id: rootId + '-cause-label', text: 'Cause area' }), causeList),
      el('div', { class: 'aim-dir__group' }, el('p', { class: 'aim-dir__label', id: rootId + '-region-label', text: 'Implementation region' }), regionList));
    var statusEl = el('p', { class: 'aim-dir__sr', id: rootId + '-status', role: 'status', 'aria-live': 'polite' });
    var gridEl = el('ul', { class: 'aim-dir__grid' });
    var footerEl = el('div', { class: 'aim-dir__footer' });
    var resultsEl = el('div', { class: 'aim-dir__results' }, statusEl, gridEl, footerEl);
    clear(root);
    append(root, [titleEl, searchEl, filtersEl, resultsEl]);

    /* filtering. Precedence: a search ignores every filter; a chosen cohort is shown whole; otherwise cause + region. */
    function mode() { return fold(state.query).trim() ? 'search' : (state.cohort ? 'cohort' : 'facets'); }
    function matchesRegion(c, region) {
      if (!region) return true;
      if (region === GLOBAL) return c.countries.indexOf(GLOBAL) !== -1;
      return c.countries.some(function (k) { return data.countryContinent[k] === region; });
    }
    function haystack(c) {
      if (!c._hay) {
        c._hay = fold([c.name, plainText(c.blurb), c.cohort, c.url ? hostOf(c.url) : '', c.causes.join(' '), c.countries.join(' '),
          c.founders.map(function (f) { return f.name + ' ' + (f.role || ''); }).join(' ')].join(' '));
      }
      return c._hay;
    }
    function searchResults() {
      var terms = fold(state.query).split(/\s+/).filter(Boolean);
      return data.charities.filter(function (c) {
        var hay = haystack(c);
        for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false;
        return true;
      });
    }
    function filtered(skip) {
      var m = mode();
      if (m === 'search') return searchResults();
      if (m === 'cohort') return data.charities.filter(function (c) { return c.cohort === state.cohort; });
      return data.charities.filter(function (c) {
        if (skip !== 'cause' && state.cause && c.causes.indexOf(state.cause) === -1) return false;
        if (skip !== 'region' && !matchesRegion(c, state.region)) return false;
        return true;
      });
    }
    /** The list a facet's counts are computed over: the other facet applied, cohort and search ignored. */
    function facetBase(skip) {
      return data.charities.filter(function (c) {
        if (skip !== 'cause' && state.cause && c.causes.indexOf(state.cause) === -1) return false;
        if (skip !== 'region' && !matchesRegion(c, state.region)) return false;
        return true;
      });
    }
    function regionsOf(c) {
      var set = {};
      c.countries.forEach(function (k) { if (k === GLOBAL) set[GLOBAL] = true; else if (data.countryContinent[k]) set[data.countryContinent[k]] = true; });
      return Object.keys(set);
    }
    function countBy(list, keysOf) {
      var counts = {};
      list.forEach(function (c) { keysOf(c).forEach(function (k) { counts[k] = (counts[k] || 0) + 1; }); });
      return counts;
    }

    /* rendering */
    function optionItem(opts) {
      var pressed = !!opts.pressed;
      return el('li', null, el('button', {
        type: 'button', id: opts.id,
        class: 'aim-dir__opt' + (opts.count === 0 && !pressed ? ' is-zero' : ''),
        'aria-pressed': pressed ? 'true' : 'false',
        'aria-label': opts.label + ', ' + opts.count + (opts.count === 1 ? ' charity' : ' charities'),
        onclick: opts.onClick
      },
      opts.dot ? el('span', { class: 'aim-dir__dot', style: '--dot:' + opts.dot, 'aria-hidden': 'true' }) : null,
      el('span', { class: 'aim-dir__opt-text', text: opts.label }),
      el('span', { class: 'aim-dir__count', 'aria-hidden': 'true', text: String(opts.count) })));
    }
    function pick(facet, value) {
      return function () {
        // Choosing a cause or region leaves any cohort or search behind.
        clearSearch(); state.cohort = null;
        state[facet] = state[facet] === value ? null : value;
        state.shown = pageSize; render({ focus: this.id });
      };
    }
    function renderFilters() {
      var all = data.charities;
      var facets = mode() === 'facets';
      filtersEl.classList.toggle('is-muted', mode() === 'search');

      var causeBase = countBy(all, function (c) { return c.causes; });
      var causeCounts = countBy(facetBase('cause'), function (c) { return c.causes; });
      var causeItems = [optionItem({ id: rootId + '-cause-all', label: 'All cause areas', count: facetBase('cause').length, pressed: !(facets && state.cause), onClick: pick('cause', null) })];
      data.causes.filter(function (cause) { return causeBase[cause]; })
        .sort(function (a, b) { return causeBase[b] - causeBase[a] || data.causes.indexOf(a) - data.causes.indexOf(b); })
        .forEach(function (cause) {
          var s = CAUSE_STYLES[cause] || FALLBACK_STYLE;
          causeItems.push(optionItem({ id: rootId + '-cause-' + idPart(cause), label: cause, count: causeCounts[cause] || 0, pressed: facets && state.cause === cause, dot: s.dot, onClick: pick('cause', cause) }));
        });
      clear(causeList); append(causeList, causeItems);

      var regionBase = countBy(all, regionsOf);
      var regionCounts = countBy(facetBase('region'), regionsOf);
      var regionItems = [optionItem({ id: rootId + '-region-all', label: 'All', count: facetBase('region').length, pressed: !(facets && state.region), onClick: pick('region', null) })];
      var regionOrder = (regionBase[GLOBAL] ? [GLOBAL] : []).concat(data.continents.filter(function (r) { return regionBase[r]; }));
      regionOrder.forEach(function (region) {
        regionItems.push(optionItem({ id: rootId + '-region-' + idPart(region), label: region, count: regionCounts[region] || 0, pressed: facets && state.region === region, onClick: pick('region', region) }));
      });
      clear(regionList); append(regionList, regionItems);

      var cohorts = Object.keys(countBy(all, function (c) { return c.cohort ? [c.cohort] : []; })).sort(cohortCompare);
      if (state.cohort && cohorts.indexOf(state.cohort) === -1) state.cohort = null;
      clear(cohortSelect);
      append(cohortSelect, el('option', { value: '', text: 'All cohorts' }));
      cohorts.forEach(function (label) {
        append(cohortSelect, el('option', { value: label, text: label, selected: mode() === 'cohort' && state.cohort === label }));
      });
      cohortSelect.value = mode() === 'cohort' ? state.cohort : '';
    }
    /** A tag that applies a filter when clicked (cause, cohort, or a country's continent). */
    function filterTag(opts) {
      return el('li', null, el('button', {
        type: 'button', class: 'aim-dir__tag aim-dir__tag--filter ' + opts.className, style: opts.style || null,
        title: opts.title || null, 'aria-label': opts.ariaLabel, text: opts.label, onclick: opts.onClick
      }));
    }
    function applyCause(cause) { clearSearch(); state.cohort = null; state.cause = cause; state.shown = pageSize; render({ focus: rootId + '-cause-' + idPart(cause) }); }
    function applyRegion(region) { clearSearch(); state.cohort = null; state.region = region; state.shown = pageSize; render({ focus: rootId + '-region-' + idPart(region) }); }
    function applyCohort(cohort) { clearSearch(); state.cohort = cohort; state.cause = null; state.region = null; state.shown = pageSize; render({ focus: cohortSelect.id }); }
    function countryTags(c) {
      var region = mode() === 'facets' ? state.region : null;
      var inRegion = function (k) { return !region || (region === GLOBAL ? k === GLOBAL : data.countryContinent[k] === region); };
      var list = c.countries.slice();
      if (region) list = list.filter(inRegion).concat(list.filter(function (k) { return !inRegion(k); }));
      var expanded = !!state.expanded[c.id];
      var shown = expanded ? list : list.slice(0, MAX_COUNTRIES);
      var items = shown.map(function (k) {
        var continent = k === GLOBAL ? GLOBAL : data.countryContinent[k];
        var cls = 'aim-dir__tag--country' + (region && !inRegion(k) ? ' aim-dir__tag--dim' : '');
        if (!continent) return el('li', { class: 'aim-dir__tag ' + cls, text: k });
        return filterTag({ className: cls, label: k, title: continent !== k ? continent : null,
          ariaLabel: 'Show charities in ' + continent, onClick: function () { applyRegion(continent); } });
      });
      var hidden = list.length - shown.length;
      if (hidden > 0 || (expanded && list.length > MAX_COUNTRIES)) {
        var id = rootId + '-more-' + c.id;
        items.push(el('li', null, el('button', {
          type: 'button', id: id, class: 'aim-dir__tag aim-dir__tag--more',
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-label': expanded ? 'Show fewer countries for ' + c.name : 'Show ' + hidden + ' more ' + (hidden === 1 ? 'country' : 'countries') + ' for ' + c.name,
          text: expanded ? 'Show fewer' : '+' + hidden + ' more',
          onclick: function () { state.expanded[c.id] = !expanded; render({ focus: id }); }
        })));
      }
      return items;
    }
    function avatar(f) {
      var face = f.photo && f.photo.src
        ? el('img', { src: resolve(f.photo.src), alt: '', loading: 'lazy', decoding: 'async' })
        : el('span', { class: 'aim-dir__initials', text: initials(f.name) });
      var label = f.role ? f.name + ', ' + f.role : f.name;
      // Redundant with the name links below, so hidden from assistive tech (tabindex -1, aria-hidden on the list).
      return el('li', { class: 'aim-dir__avatar' + (f.linkedin ? ' aim-dir__avatar--link' : ''), title: label },
        f.linkedin ? el('a', { href: f.linkedin, target: '_blank', rel: 'noopener', tabindex: '-1' }, face) : face);
    }
    function card(c) {
      var cardId = rootId + '-card-' + c.id;
      var logo = el('div', { class: 'aim-dir__logo' });
      if (c.logo) {
        append(logo, el('img', { src: resolve(c.logo.src), alt: c.name + ' logo', loading: 'lazy', decoding: 'async', width: c.logo.width || null, height: c.logo.height || null }));
      } else {
        append(logo, el('span', { class: 'aim-dir__monogram', 'aria-hidden': 'true', text: monogram(c.name) }));
      }
      if (c.founders.length) {
        var avatars = el('ul', { class: 'aim-dir__avatars', 'aria-hidden': 'true' });
        c.founders.slice(0, MAX_AVATARS).forEach(function (f) { append(avatars, avatar(f)); });
        if (c.founders.length > MAX_AVATARS) append(avatars, el('li', { class: 'aim-dir__avatar' }, el('span', { class: 'aim-dir__initials', text: '+' + (c.founders.length - MAX_AVATARS) })));
        append(logo, avatars);
      }
      var body = el('div', { class: 'aim-dir__body' });
      append(body, el('h3', { class: 'aim-dir__name', id: cardId + '-name' },
        c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener', text: c.name }) : c.name));
      if (c.founders.length) {
        append(body, el('p', { class: 'aim-dir__founders' },
          el('strong', { text: (c.founders.length > 1 ? 'Co-founders:' : 'Founder:') + ' ' }),
          founderNodes(c.founders)));
      }
      if (c.blurb) append(body, el('p', { class: 'aim-dir__blurb' }, blurbNodes(c.blurb)));
      var tags = el('ul', { class: 'aim-dir__tags', 'aria-label': 'Cause, cohort and countries (click to filter)' });
      c.causes.forEach(function (cause) {
        var s = CAUSE_STYLES[cause] || FALLBACK_STYLE;
        append(tags, filterTag({ className: 'aim-dir__tag--cause', style: '--chip-bg:' + s.bg + ';--chip-text:' + s.text, label: CAUSE_TAG_LABELS[cause] || cause,
          ariaLabel: 'Show ' + cause + ' charities', onClick: function () { applyCause(cause); } }));
      });
      if (c.cohort) append(tags, filterTag({ className: 'aim-dir__tag--cohort', label: c.cohort, title: 'Cohort',
        ariaLabel: 'Show the ' + c.cohort + ' cohort', onClick: function () { applyCohort(c.cohort); } }));
      append(tags, countryTags(c));
      if (STATUS_LABELS[c.status]) append(tags, el('li', { class: 'aim-dir__tag aim-dir__tag--status', text: STATUS_LABELS[c.status] }));
      if (tags.childNodes.length) append(body, tags);
      if (c.url) {
        append(body, el('a', { class: 'aim-dir__site', href: c.url, target: '_blank', rel: 'noopener' },
          hostOf(c.url), el('span', { class: 'aim-dir__sr', text: ' (opens in a new tab)' })));
      }
      var li = el('li', { class: 'aim-dir__card' + (c.url ? ' aim-dir__card--link' : ''), id: cardId, tabindex: '-1', 'aria-labelledby': cardId + '-name' }, logo, body);
      if (c.url) {
        // Convenience only: the name and website links remain the accessible way in. Links/buttons inside keep their own behaviour.
        li.addEventListener('click', function (e) {
          if (e.defaultPrevented || e.button !== 0) return;
          if (e.target.closest && e.target.closest('a, button, select, input')) return;
          if (global.getSelection && String(global.getSelection()).length) return;
          global.open(c.url, '_blank', 'noopener');
        });
      }
      return li;
    }
    function renderResults(opts) {
      var list = filtered();
      var visible = list.slice(0, state.shown);
      clear(gridEl); clear(footerEl);
      append(gridEl, visible.map(card));
      if (!list.length) {
        append(footerEl, el('div', { class: 'aim-dir__empty' },
          el('p', { text: mode() === 'search' ? 'No charities match "' + state.query.trim() + '".' : 'No charities match these filters.' }),
          el('button', { type: 'button', class: 'aim-dir__clear', text: mode() === 'search' ? 'Clear search' : 'Clear filters', onclick: function () {
            state.cause = state.region = state.cohort = null; clearSearch(); state.shown = pageSize; render({ focus: rootId + '-search' });
          } })));
      } else if (list.length > visible.length) {
        var nextId = rootId + '-card-' + list[visible.length].id;
        append(footerEl, el('button', { type: 'button', id: rootId + '-more', class: 'aim-dir__more', onclick: function () {
          state.shown += pageSize; render({ focus: nextId });
        } }, 'Show more', el('span', { class: 'aim-dir__sr', text: ' (' + (list.length - visible.length) + ' more)' })));
      }
      statusEl.textContent = list.length
        ? 'Showing ' + visible.length + ' of ' + list.length + (list.length === 1 ? ' charity' : ' charities')
        : 'No charities match';
      var n = data.charities.length;
      var tpl = options.title || (n >= 10 ? 'Meet all {n} charities' : 'Meet our charities');
      titleEl.textContent = tpl.replace('{n}', String(n));
    }
    function render(opts) {
      opts = opts || {};
      root.classList.remove('is-loading');
      var active = document.activeElement && document.activeElement.id;
      renderFilters();
      renderResults(opts);
      var target = opts.focus ? document.getElementById(opts.focus) : (active ? document.getElementById(active) : null);
      if (target && target !== document.activeElement) target.focus({ preventScroll: !opts.focus });
    }
    /** Placeholder shown while the live JSON loads: reserves the layout so nothing jumps. */
    function renderSkeleton() {
      root.classList.add('is-loading');
      titleEl.textContent = '';
      statusEl.textContent = 'Loading charities';
      clear(gridEl); clear(footerEl);
      for (var i = 0; i < pageSize; i += 1) gridEl.appendChild(el('li', { class: 'aim-dir__card aim-dir__card--skeleton', 'aria-hidden': 'true' }));
    }
    function showData(fresh) {
      if (data && comparable(fresh) === comparable(data)) return false;
      data = fresh; render(); return true;
    }
    function fetchLive(url) {
      if (!global.fetch) return Promise.reject(new Error('no fetch'));
      return fetch(url, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(normaliseData);
    }

    /* Load order: live JSON first; the inline snapshot only if the network is slow (after snapshotDelay) or fails. */
    if (options.dataUrl) {
      renderSkeleton();
      var fallbackTimer = snapshot ? setTimeout(function () { if (!data) showData(snapshot); }, snapshotDelay) : null;
      fetchLive(options.dataUrl).then(function (fresh) {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        showData(fresh);
      }).catch(function () {
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (data) return;
        if (snapshot) showData(snapshot);
        else {
          root.classList.remove('is-loading'); clear(gridEl);
          titleEl.textContent = options.title ? options.title.replace('{n}', '') : 'Our charities';
          append(footerEl, el('div', { class: 'aim-dir__empty' }, el('p', { text: 'The charity directory could not be loaded. Please try again later.' })));
        }
      });
    } else if (snapshot) {
      showData(snapshot);
    } else {
      throw new Error('AimDirectory.mount: provide data and/or dataUrl');
    }

    return {
      refresh: function () { return options.dataUrl ? fetchLive(options.dataUrl).then(showData).catch(function () { return false; }) : Promise.resolve(false); },
      setData: function (d) { showData(normaliseData(d)); },
      getState: function () { return state; }
    };
  }

  /* Auto-mount: <div data-aim-dir data-aim-src="charities.json" data-aim-image-base=""></div> */
  function autoMount() {
    var nodes = document.querySelectorAll('[data-aim-dir][data-aim-src]');
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.getAttribute('data-aim-mounted')) return;
      node.setAttribute('data-aim-mounted', '1');
      var src = node.getAttribute('data-aim-src');
      mount(node, { dataUrl: src, imageBase: node.getAttribute('data-aim-image-base') || src.replace(/[^/]*$/, ''), title: node.getAttribute('data-aim-title') || undefined });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount); else autoMount();

  global.AimDirectory = { mount: mount, version: '0.5.1' };
})(window);
