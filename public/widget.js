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
  function joinNames(names) {
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
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
          founders: (Array.isArray(c.founders) ? c.founders : []).filter(function (f) { return f && f.name; })
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
    var isNarrow = global.matchMedia && global.matchMedia('(max-width: 899px)').matches;
    var pageSize = options.pageSize || (isNarrow ? 6 : 12);
    var state = { cause: null, region: null, cohort: null, query: '', shown: pageSize, expanded: {} };
    var data = normaliseData(options.data);

    function resolve(src) { return /^(https?:)?\/\//i.test(src) || src.charAt(0) === '/' && !imageBase ? src : imageBase + src; }

    /* shell: title, search, filters, results (CSS grid places them) */
    var titleEl = el('h2', { class: 'aim-dir__title', id: rootId + '-title' });
    var searchInput = el('input', {
      type: 'search', id: rootId + '-search', class: 'aim-dir__reset',
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
      onchange: function (e) { state.cohort = e.target.value || null; state.shown = pageSize; render(); }
    });
    var filtersEl = el('div', { class: 'aim-dir__filters' },
      el('div', { class: 'aim-dir__group' }, el('p', { class: 'aim-dir__label', id: rootId + '-cause-label', text: 'Cause area' }), causeList),
      el('div', { class: 'aim-dir__group' }, el('p', { class: 'aim-dir__label', id: rootId + '-region-label', text: 'Implementation region' }), regionList),
      el('div', { class: 'aim-dir__group' }, el('label', { class: 'aim-dir__label', for: rootId + '-cohort', text: 'Cohort' }), cohortSelect));
    var statusEl = el('p', { class: 'aim-dir__sr', id: rootId + '-status', role: 'status', 'aria-live': 'polite' });
    var gridEl = el('ul', { class: 'aim-dir__grid' });
    var footerEl = el('div', { class: 'aim-dir__footer' });
    var resultsEl = el('div', { class: 'aim-dir__results' }, statusEl, gridEl, footerEl);
    clear(root);
    append(root, [titleEl, searchEl, filtersEl, resultsEl]);

    /* filtering */
    function matchesRegion(c, region) {
      if (!region) return true;
      if (region === GLOBAL) return c.countries.indexOf(GLOBAL) !== -1;
      return c.countries.some(function (k) { return data.countryContinent[k] === region; });
    }
    function haystack(c) {
      if (!c._hay) {
        c._hay = fold([c.name, c.blurb, c.cohort, c.url ? hostOf(c.url) : '', c.causes.join(' '), c.countries.join(' '),
          c.founders.map(function (f) { return f.name + ' ' + (f.role || ''); }).join(' ')].join(' '));
      }
      return c._hay;
    }
    function filtered(skip) {
      var terms = fold(state.query).split(/\s+/).filter(Boolean);
      return data.charities.filter(function (c) {
        if (skip !== 'cause' && state.cause && c.causes.indexOf(state.cause) === -1) return false;
        if (skip !== 'region' && !matchesRegion(c, state.region)) return false;
        if (skip !== 'cohort' && state.cohort && c.cohort !== state.cohort) return false;
        if (terms.length) { var hay = haystack(c); for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) === -1) return false; }
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
      return function () { state[facet] = state[facet] === value ? null : value; state.shown = pageSize; render({ focus: this.id }); };
    }
    function renderFilters() {
      var all = data.charities;
      var causeBase = countBy(all, function (c) { return c.causes; });
      var causeCounts = countBy(filtered('cause'), function (c) { return c.causes; });
      var causeItems = [optionItem({ id: rootId + '-cause-all', label: 'All cause areas', count: filtered('cause').length, pressed: !state.cause, onClick: pick('cause', null) })];
      data.causes.filter(function (cause) { return causeBase[cause]; })
        .sort(function (a, b) { return causeBase[b] - causeBase[a] || data.causes.indexOf(a) - data.causes.indexOf(b); })
        .forEach(function (cause) {
        var s = CAUSE_STYLES[cause] || FALLBACK_STYLE;
        causeItems.push(optionItem({ id: rootId + '-cause-' + idPart(cause), label: cause, count: causeCounts[cause] || 0, pressed: state.cause === cause, dot: s.dot, onClick: pick('cause', cause) }));
      });
      clear(causeList); append(causeList, causeItems);

      var regionBase = countBy(all, regionsOf);
      var regionCounts = countBy(filtered('region'), regionsOf);
      var regionItems = [optionItem({ id: rootId + '-region-all', label: 'All', count: filtered('region').length, pressed: !state.region, onClick: pick('region', null) })];
      var regionOrder = (regionBase[GLOBAL] ? [GLOBAL] : []).concat(data.continents.filter(function (r) { return regionBase[r]; }));
      regionOrder.forEach(function (region) {
        regionItems.push(optionItem({ id: rootId + '-region-' + idPart(region), label: region, count: regionCounts[region] || 0, pressed: state.region === region, onClick: pick('region', region) }));
      });
      clear(regionList); append(regionList, regionItems);

      var cohortCounts = countBy(filtered('cohort'), function (c) { return c.cohort ? [c.cohort] : []; });
      var cohorts = Object.keys(countBy(all, function (c) { return c.cohort ? [c.cohort] : []; })).sort(cohortCompare);
      if (state.cohort && cohorts.indexOf(state.cohort) === -1) state.cohort = null;
      clear(cohortSelect);
      append(cohortSelect, el('option', { value: '', text: 'All cohorts' }));
      cohorts.forEach(function (label) {
        append(cohortSelect, el('option', { value: label, text: label + ' (' + (cohortCounts[label] || 0) + ')', selected: state.cohort === label }));
      });
      cohortSelect.value = state.cohort || '';
    }
    function countryTags(c) {
      var region = state.region;
      var inRegion = function (k) { return !region || (region === GLOBAL ? k === GLOBAL : data.countryContinent[k] === region); };
      var list = c.countries.slice();
      if (region) list = list.filter(inRegion).concat(list.filter(function (k) { return !inRegion(k); }));
      var expanded = !!state.expanded[c.id];
      var shown = expanded ? list : list.slice(0, MAX_COUNTRIES);
      var items = shown.map(function (k) {
        var continent = data.countryContinent[k];
        return el('li', {
          class: 'aim-dir__tag aim-dir__tag--country' + (region && !inRegion(k) ? ' aim-dir__tag--dim' : ''),
          title: continent && continent !== k ? continent : null, text: k
        });
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
        c.founders.slice(0, MAX_AVATARS).forEach(function (f) {
          append(avatars, el('li', { class: 'aim-dir__avatar', title: f.role ? f.name + ', ' + f.role : f.name },
            f.photo && f.photo.src ? el('img', { src: resolve(f.photo.src), alt: '', loading: 'lazy', decoding: 'async' }) : initials(f.name)));
        });
        if (c.founders.length > MAX_AVATARS) append(avatars, el('li', { class: 'aim-dir__avatar', text: '+' + (c.founders.length - MAX_AVATARS) }));
        append(logo, avatars);
      }
      var body = el('div', { class: 'aim-dir__body' });
      append(body, el('h3', { class: 'aim-dir__name', id: cardId + '-name' },
        c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener', text: c.name }) : c.name));
      if (c.founders.length) {
        append(body, el('p', { class: 'aim-dir__founders' },
          el('strong', { text: (c.founders.length > 1 ? 'Co-founders:' : 'Founder:') + ' ' }),
          joinNames(c.founders.map(function (f) { return f.name; }))));
      }
      if (c.blurb) append(body, el('p', { class: 'aim-dir__blurb', text: c.blurb }));
      var tags = el('ul', { class: 'aim-dir__tags', 'aria-label': 'Cause, cohort and countries' });
      c.causes.forEach(function (cause) {
        var s = CAUSE_STYLES[cause] || FALLBACK_STYLE;
        append(tags, el('li', { class: 'aim-dir__tag aim-dir__tag--cause', style: '--chip-bg:' + s.bg + ';--chip-text:' + s.text, text: cause }));
      });
      if (c.cohort) append(tags, el('li', { class: 'aim-dir__tag aim-dir__tag--cohort', title: 'Cohort', text: c.cohort }));
      append(tags, countryTags(c));
      if (STATUS_LABELS[c.status]) append(tags, el('li', { class: 'aim-dir__tag aim-dir__tag--status', text: STATUS_LABELS[c.status] }));
      if (tags.childNodes.length) append(body, tags);
      if (c.url) {
        append(body, el('a', { class: 'aim-dir__site', href: c.url, target: '_blank', rel: 'noopener' },
          hostOf(c.url), el('span', { class: 'aim-dir__sr', text: ' (opens in a new tab)' })));
      }
      return el('li', { class: 'aim-dir__card', id: cardId, tabindex: '-1', 'aria-labelledby': cardId + '-name' }, logo, body);
    }
    function renderResults(opts) {
      var list = filtered();
      var visible = list.slice(0, state.shown);
      clear(gridEl); clear(footerEl);
      append(gridEl, visible.map(card));
      if (!list.length) {
        append(footerEl, el('div', { class: 'aim-dir__empty' },
          el('p', { text: state.query ? 'No charities match "' + state.query + '" with these filters.' : 'No charities match these filters.' }),
          el('button', { type: 'button', class: 'aim-dir__clear', text: 'Clear filters', onclick: function () {
            state.cause = state.region = state.cohort = null; state.query = ''; searchInput.value = ''; state.shown = pageSize; render({ focus: rootId + '-search' });
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
      var active = document.activeElement && document.activeElement.id;
      renderFilters();
      renderResults(opts);
      var target = opts.focus ? document.getElementById(opts.focus) : (active ? document.getElementById(active) : null);
      if (target && target !== document.activeElement) target.focus({ preventScroll: !opts.focus });
    }
    function refresh(url) {
      if (!global.fetch) return Promise.resolve(false);
      return fetch(url, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (fresh) {
          fresh = normaliseData(fresh);
          if (comparable(fresh) === comparable(data)) return false;
          data = fresh; render(); return true;
        })
        .catch(function () { return false; });
    }

    render();
    if (options.dataUrl) refresh(options.dataUrl);
    return { refresh: refresh, setData: function (d) { data = normaliseData(d); render(); }, getState: function () { return state; } };
  }

  /* Auto-mount: <div data-aim-dir data-aim-src="charities.json" data-aim-image-base=""></div> */
  function autoMount() {
    var nodes = document.querySelectorAll('[data-aim-dir][data-aim-src]');
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.getAttribute('data-aim-mounted')) return;
      node.setAttribute('data-aim-mounted', '1');
      var src = node.getAttribute('data-aim-src');
      fetch(src).then(function (r) { return r.json(); }).then(function (d) {
        mount(node, { data: d, imageBase: node.getAttribute('data-aim-image-base') || src.replace(/[^/]*$/, ''), title: node.getAttribute('data-aim-title') || undefined });
      }).catch(function () {
        node.textContent = 'The charity directory could not be loaded.';
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount); else autoMount();

  global.AimDirectory = { mount: mount, version: '0.2.0' };
})(window);
