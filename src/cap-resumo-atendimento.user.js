// ==UserScript==
// @name         CAP Workflow — Modelos de Resumo
// @namespace    https://vcimentos.capworkflow.com/
// @version      1.2.0
// @description  Modelos de resumo e bloqueio Enviar Solicitação se Pré CAP estiver em andamento
// @author       Arthur Vinícius
// @match        https://vcimentos.capworkflow.com/*
// @match        https://*.capworkflow.com/*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/arthurvihoficial/cap-workflow-templates/refs/heads/main/src/cap-resumo-atendimento.user.js
// @downloadURL  https://raw.githubusercontent.com/arthurvihoficial/cap-workflow-templates/refs/heads/main/src/cap-resumo-atendimento.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      github.com
// ==/UserScript==

(function () {
  'use strict';

  var UPDATE = {
    versionUrl:
      'https://raw.githubusercontent.com/arthurvihoficial/cap-workflow-templates/refs/heads/main/src/version.json',
    downloadUrl:
      'https://raw.githubusercontent.com/arthurvihoficial/cap-workflow-templates/refs/heads/main/src/cap-resumo-atendimento.user.js',
    noticesUrl:
      'https://raw.githubusercontent.com/arthurvihoficial/cap-workflow-templates/refs/heads/main/src/notices.json',
    checkEveryMs: 6 * 60 * 60 * 1000, // 6h
    lastCheckKey: 'cap_resumo_update_last_check',
    noticesLastKey: 'cap_resumo_notices_last_fetch',
    noticesCacheKey: 'cap_resumo_notices_cache_v1',
    noticesDismissKey: 'cap_resumo_notices_dismissed_v1'
  };

  var CFG = {
    tplKey: 'cap_resumo_templates_v2',
    setKey: 'cap_resumo_settings_v4',
    panelId: 'cap-resumo-panel',
    fabId: 'cap-resumo-fab',
    bannerId: 'cap-resumo-pick-banner',
    suggestId: 'cap-resumo-suggest',
    updateBarId: 'cap-resumo-update-bar',
    updateFloatId: 'cap-resumo-update-float',
    modalId: 'cap-resumo-modal',
    folderModalId: 'cap-resumo-folder-modal',
    importModalId: 'cap-resumo-import-modal',
    dupModalId: 'cap-resumo-dup-modal',
    noticesHostId: 'cap-resumo-notices',
    foldersKey: 'cap_resumo_folders_v1',
    maxTpl: 100,
    version: '1.2.0',
    dupGatewayName: 'Pré CAP - mesmo número de pedido',
    dupServiceId: 2316
  };

  var DEFAULT_SETTINGS = {
    insertMode: 'replace',
    docked: false,
    minimized: false,
    targetSelector: '',
    targetLabel: ''
  };

  var templates = [];
  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var ui = null;
  var cachedField = null;
  var busy = false;
  var pendingDeleteId = null;
  var stopPickFn = null;
  var toastTimer = null;
  var suggestBoundField = null;
  var suggestTimer = null;
  var suggestHost = null;
  var watchTimer = null;
  var remoteUpdate = null; // { version, changelog, url }
  var folders = ['Geral'];
  var noticesConfig = null;
  var folderModalCtx = { mode: 'create', source: 'panel', oldName: '' };
  var importModalState = {
    fileName: '',
    items: null,
    mode: 'merge'
  };
  var noticesTimer = null;
  var contextWatchTimer = null;
  var lastContextKey = '';
  var dupCheck = {
    lastPedido: '',
    lastShownPedido: '',
    lastShownCapId: '',
    timer: null,
    wrapTimer: null,
    spyInstalled: false,
    swalWrapped: false,
    observer: null,
    inFlight: false,
    lastResult: null,
    suppressUntil: 0,
    statusCache: {},
    continuarBlocked: false,
    blockedPedido: '',
    continuarGuardInstalled: false,
    continuarWatchTimer: null
  };

  var state = {
    query: '',
    category: 'Todos',
    editingId: null,
    fieldHint: 'Caixa ainda não definida'
  };

  function normalizeFolderName(name) {
    var n = String(name || '').replace(/\s+/g, ' ').trim();
    if (!n) return '';
    return n.slice(0, 40);
  }

  function loadFolders() {
    var raw = GM_getValue(CFG.foldersKey, null);
    var list = [];
    try {
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch (e) {}
    var set = { Geral: true };
    for (var i = 0; i < list.length; i++) {
      var n = normalizeFolderName(list[i]);
      if (n) set[n] = true;
    }
    for (var j = 0; j < templates.length; j++) {
      var c = normalizeFolderName(templates[j].category || 'Geral') || 'Geral';
      set[c] = true;
    }
    folders = Object.keys(set).sort(function (a, b) {
      if (a === 'Geral') return -1;
      if (b === 'Geral') return 1;
      return a.localeCompare(b, 'pt-BR');
    });
    saveFolders();
  }

  function saveFolders() {
    GM_setValue(CFG.foldersKey, JSON.stringify(folders.filter(function (f) { return f && f !== 'Todos'; })));
  }

  function ensureFolder(name) {
    var n = normalizeFolderName(name) || 'Geral';
    if (folders.indexOf(n) < 0) {
      folders.push(n);
      folders.sort(function (a, b) {
        if (a === 'Geral') return -1;
        if (b === 'Geral') return 1;
        return a.localeCompare(b, 'pt-BR');
      });
      saveFolders();
    }
    return n;
  }

  function countInFolder(name) {
    var n = 0;
    for (var i = 0; i < templates.length; i++) {
      if ((templates[i].category || 'Geral') === name) n++;
    }
    return n;
  }

  function parseVersion(v) {
    return String(v || '0')
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map(function (p) {
        var n = parseInt(p, 10);
        return isNaN(n) ? 0 : n;
      });
  }

  // Qualquer versão diferente da local dispara sync (upgrade ou downgrade)
  function versionsDiffer(remote, local) {
    return String(remote || '').replace(/^v/i, '').trim() !== String(local || '').replace(/^v/i, '').trim();
  }

  function getLoaderApi() {
    try {
      if (
        typeof __CAP_RESUMO_LOADER__ !== 'undefined' &&
        __CAP_RESUMO_LOADER__ &&
        typeof __CAP_RESUMO_LOADER__.applyUpdate === 'function'
      ) {
        return __CAP_RESUMO_LOADER__;
      }
    } catch (e0) {}
    try {
      if (
        typeof unsafeWindow !== 'undefined' &&
        unsafeWindow &&
        unsafeWindow.__CAP_RESUMO_LOADER__ &&
        typeof unsafeWindow.__CAP_RESUMO_LOADER__.applyUpdate === 'function'
      ) {
        return unsafeWindow.__CAP_RESUMO_LOADER__;
      }
    } catch (e1) {}
    return null;
  }

  function openScriptUpdate() {
    var url = (remoteUpdate && remoteUpdate.url) || UPDATE.downloadUrl;
    var version = remoteUpdate && remoteUpdate.version;
    var loader = getLoaderApi();

    // Com o loader: baixa, grava no cache e recarrega — sem tela do Tampermonkey
    if (loader) {
      toast('Baixando v' + (version || '') + ' do GitHub…');
      loader.applyUpdate({ url: url, version: version }, function (err, ver) {
        if (err) {
          toast('Falha ao aplicar atualização. Tente de novo.');
          return;
        }
        toast('Aplicado' + (ver ? ' v' + ver : '') + '. Recarregando…');
      });
      return;
    }

    // Fallback (instalação direto pelo Tampermonkey)
    try {
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(url, { active: true, insert: true });
      } else {
        window.open(url, '_blank');
      }
    } catch (e) {
      window.open(url, '_blank');
    }
    toast('Confirme a atualização no Tampermonkey.');
  }

  function updateMessageText() {
    if (!remoteUpdate) return '';
    return (
      'Nova versão disponível: v' +
      remoteUpdate.version +
      ' (sua: v' +
      CFG.version +
      ')' +
      (remoteUpdate.changelog ? ' — ' + remoteUpdate.changelog : '')
    );
  }

  function ensureUpdateFloat() {
    var el = document.getElementById(CFG.updateFloatId);
    if (el) return el;
    el = document.createElement('div');
    el.id = CFG.updateFloatId;
    el.innerHTML =
      '<div class="capr-float-inner">' +
      '<div class="capr-float-text">' +
      '<div class="capr-float-title">Atualização do CAP · Modelos de Resumo</div>' +
      '<div class="capr-float-msg" data-role="float-msg"></div>' +
      '</div>' +
      '<div class="capr-float-actions">' +
      '<button type="button" class="capr-btn update" data-act="do-update">Atualizar agora</button>' +
      '</div></div>';
    document.body.appendChild(el);
    if (!document._capUpdateFloatBound) {
      el.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-act]');
        if (!btn || !el.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        var act = btn.getAttribute('data-act');
        if (act === 'do-update') openScriptUpdate();
      });
      document._capUpdateFloatBound = true;
    }
    return el;
  }

  function renderUpdateBar() {
    var show = !!(remoteUpdate && versionsDiffer(remoteUpdate.version, CFG.version));
    var msg = updateMessageText();

    var bar = document.getElementById(CFG.updateBarId);
    if (bar) {
      bar.style.display = show ? 'flex' : 'none';
      var barMsg = bar.querySelector('[data-role="upd-msg"]');
      if (barMsg && show) barMsg.textContent = msg;
    }

    var floatEl = ensureUpdateFloat();
    floatEl.classList.toggle('is-show', !!show);
    var floatMsg = floatEl.querySelector('[data-role="float-msg"]');
    if (floatMsg && show) floatMsg.textContent = msg;
  }

  function applyRemoteUpdateInfo(info) {
    if (!info || !info.version) return;
    if (!versionsDiffer(info.version, CFG.version)) {
      remoteUpdate = null;
      renderUpdateBar();
      return;
    }
    remoteUpdate = {
      version: String(info.version),
      changelog: String(info.changelog || '').slice(0, 120),
      url: String(info.downloadUrl || UPDATE.downloadUrl)
    };
    renderUpdateBar();
  }

  function checkForUpdates(force) {
    if (typeof GM_xmlhttpRequest !== 'function') return;
    if (/SEU_ORGAO/.test(UPDATE.versionUrl)) return; // ainda não configurado

    var now = Date.now();
    var last = Number(GM_getValue(UPDATE.lastCheckKey, 0)) || 0;
    if (!force && now - last < UPDATE.checkEveryMs) return;

    GM_setValue(UPDATE.lastCheckKey, now);

    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE.versionUrl + (UPDATE.versionUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + now,
      headers: { Accept: 'application/json' },
      onload: function (res) {
        try {
          if (res.status < 200 || res.status >= 300) throw new Error('http');
          var info = JSON.parse(res.responseText);
          applyRemoteUpdateInfo(info);
        } catch (e) {
          if (force) toast('Não foi possível verificar atualização.');
        }
      },
      onerror: function () {
        if (force) toast('Falha ao consultar o GitHub.');
      }
    });
  }

  function noticeTypeMeta(type) {
    var t = String(type || 'aviso').toLowerCase();
    if (t === 'atencao' || t === 'atenção' || t === 'attention' || t === 'warning') {
      return { key: 'atencao', label: 'Atenção' };
    }
    if (t === 'novidade' || t === 'news' || t === 'info-new') {
      return { key: 'novidade', label: 'Novidade' };
    }
    return { key: 'aviso', label: 'Aviso' };
  }

  var dismissedNoticesMem = {};

  function loadDismissedNotices() {
    return dismissedNoticesMem || {};
  }

  function saveDismissedNotices(map) {
    dismissedNoticesMem = map && typeof map === 'object' ? map : {};
  }

  function clearDismissedNotices() {
    dismissedNoticesMem = {};
    try {
      GM_setValue(UPDATE.noticesDismissKey, '{}');
    } catch (e2) {}
    try {
      sessionStorage.removeItem(UPDATE.noticesDismissKey);
    } catch (e3) {}
  }

  function cleanSelect2Text(text) {
    var t = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .trim();
    // remove × do clear do Select2, se aparecer
    t = t.replace(/^×\s*/, '').trim();
    if (!t) return '';
    if (/^selecione/i.test(t)) return '';
    if (/^select( an?)? option$/i.test(t)) return '';
    return t;
  }

  function readSelectLikeValue(root) {
    if (!root) return '';

    // 1) Texto visível do Select2 (caso do Centro/Expedição por exemplo, auto-preenchido)
    var rendered =
      root.querySelector('.select2-selection__rendered') ||
      root.querySelector('.select2-chosen') ||
      root.querySelector('[class*="select2-selection__rendered"]');
    if (rendered) {
      var title = cleanSelect2Text(rendered.getAttribute('title'));
      if (title) return title;
      var renderedText = cleanSelect2Text(rendered.textContent);
      if (renderedText) return renderedText;
    }

    var sel = root.querySelector('select');
    if (sel) {
      var opt = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      var label = opt ? cleanSelect2Text(opt.textContent) : '';
      var val = String(sel.value || '').trim();
      if (label) return label;
      if (val) return val;
    }

    var input =
      root.querySelector(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="button"]):not([type="submit"])'
      ) || null;
    if (input) {
      var iv = String(input.value || '').trim();
      if (iv) return iv;
    }

    var ta = root.querySelector('textarea, [contenteditable="true"]');
    if (ta) {
      if (ta.isContentEditable) return cleanSelect2Text(ta.innerText || ta.textContent);
      return String(ta.value || '').trim();
    }

    return '';
  }

  function readFieldValueFromColumn(columnId) {
    if (!columnId) return '';
    var col = document.getElementById(columnId);
    if (!col) return '';
    return readSelectLikeValue(col);
  }

  function defaultNoticeFields() {
    return {
      pedido: {
        labels: ['Numero do Pedido', 'Número do Pedido', 'Pedido']
      },
      emissor: {
        labels: ['Codigo emissor', 'Código emissor', 'Emissor']
      },
      centro: {
        labels: [
          'Centro/Expedicao',
          'Centro/Expedição',
          'Centro Expedicao',
          'Centro Expedição',
          'Centro Expedicao / Filial',
          'Centro Expedição / Filial',
          'Filial'
        ]
      }
    };
  }

  function labelListForField(cfg) {
    var list = [];
    if (!cfg) return list;
    if (Array.isArray(cfg.labels)) {
      for (var i = 0; i < cfg.labels.length; i++) list.push(String(cfg.labels[i] || ''));
    }
    if (cfg.label) list.push(String(cfg.label));
    return list.filter(Boolean);
  }

  function findFieldRootByLabels(labels) {
    var wanted = [];
    for (var i = 0; i < (labels || []).length; i++) {
      var n = normalizeLabel(labels[i]);
      if (n) wanted.push(n);
    }
    if (!wanted.length) return null;

    var nodes = document.querySelectorAll(
      'label, .control-label, .form-label, .cap-label, .caption, span, div, p, strong, b'
    );
    var best = null;
    var bestScore = -1;

    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j];
      if (!node || isOurUi(node)) continue;
      var raw = String(node.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!raw || raw.length > 80) continue;
      var lab = normalizeLabel(raw);
      if (!lab) continue;

      var score = -1;
      for (var k = 0; k < wanted.length; k++) {
        var w = wanted[k];
        if (lab === w) score = Math.max(score, 100);
        else if (lab.indexOf(w) >= 0) score = Math.max(score, 70 - Math.min(30, lab.length - w.length));
        else if (w.indexOf(lab) >= 0 && lab.length >= 5) score = Math.max(score, 40);
      }
      if (score < 40) continue;

      var root =
        node.closest('.cap-form-control') ||
        node.closest('.form-group') ||
        node.closest('.mb-3') ||
        node.closest('[id$="_column"]') ||
        node.parentElement;
      if (!root || isOurUi(root)) continue;

      // prefer roots that realmente têm input/select/select2
      var hasControl = !!(
        root.querySelector('input, select, textarea, .select2-container, [contenteditable="true"]')
      );
      if (!hasControl) score -= 20;

      if (score > bestScore) {
        bestScore = score;
        best = root;
      }
    }
    return best;
  }

  function resolveNoticeFieldRoot(fieldCfg) {
    if (!fieldCfg) return null;
    // columnId ainda funciona se existir, mas no CAP ele muda a cada reload
    if (fieldCfg.columnId) {
      var byId = document.getElementById(fieldCfg.columnId);
      if (byId) return byId;
    }
    return findFieldRootByLabels(labelListForField(fieldCfg));
  }

  function readNoticeFieldValue(fieldCfg) {
    var root = resolveNoticeFieldRoot(fieldCfg);
    if (!root) return '';
    return readSelectLikeValue(root);
  }

  function getFormContext() {
    var fields = Object.assign({}, defaultNoticeFields(), (noticesConfig && noticesConfig.fields) || {});
    return {
      pedido: readNoticeFieldValue(fields.pedido),
      emissor: readNoticeFieldValue(fields.emissor),
      centro: readNoticeFieldValue(fields.centro)
    };
  }

  function valueMatchesRule(fieldValue, rules) {
    var hay = normalizeLabel(fieldValue);
    if (!hay) return false;
    if (!Array.isArray(rules) || !rules.length) return false;
    for (var i = 0; i < rules.length; i++) {
      var needle = normalizeLabel(rules[i]);
      if (!needle) continue;
      if (hay === needle || hay.indexOf(needle) >= 0 || needle.indexOf(hay) >= 0) return true;
    }
    return false;
  }

  function noticeMatches(notice, ctx) {
    if (!notice || notice.enabled === false) return false;
    var match = notice.match || {};
    var keys = Object.keys(match).filter(function (k) {
      return Array.isArray(match[k]) && match[k].length;
    });
    if (!keys.length) return false;

    var mode = String(notice.matchMode || 'all').toLowerCase();
    var hits = 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var fieldVal = ctx[key];
      if (valueMatchesRule(fieldVal, match[key])) hits++;
    }
    if (mode === 'any') return hits > 0;
    return hits === keys.length;
  }

  function ensureNoticesHost() {
    var host = document.getElementById(CFG.noticesHostId);
    if (host) return host;
    host = document.createElement('div');
    host.id = CFG.noticesHostId;
    document.body.appendChild(host);
    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-notice-act]');
      if (!btn || !host.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      var act = btn.getAttribute('data-notice-act');
      var id = btn.getAttribute('data-notice-id');
      if (act === 'dismiss' && id) {
        var map = loadDismissedNotices();
        map[id] = Date.now();
        saveDismissedNotices(map);
        renderContextNotices();
      }
    });
    return host;
  }

  function renderContextNotices() {
    var host = ensureNoticesHost();
    if (!noticesConfig || !Array.isArray(noticesConfig.notices)) {
      host.innerHTML = '';
      host.classList.remove('is-show');
      return;
    }

    var ctx = getFormContext();
    var dismissed = loadDismissedNotices();
    var list = [];
    for (var i = 0; i < noticesConfig.notices.length; i++) {
      var n = noticesConfig.notices[i];
      if (!n || !n.id) continue;
      if (dismissed[n.id]) continue;
      if (!noticeMatches(n, ctx)) continue;
      list.push(n);
    }

    if (!list.length) {
      host.innerHTML = '';
      host.classList.remove('is-show');
      return;
    }

    var html = '';
    for (var j = 0; j < list.length; j++) {
      var item = list[j];
      var meta = noticeTypeMeta(item.type);
      var canDismiss = item.dismissible !== false;
      html +=
        '<article class="capn-card capn-' +
        meta.key +
        '" data-notice-id="' +
        escAttr(item.id) +
        '">' +
        '<div class="capn-head">' +
        '<span class="capn-badge">' +
        escHtml(meta.label) +
        '</span>' +
        (canDismiss
          ? '<button type="button" class="capn-close" data-notice-act="dismiss" data-notice-id="' +
            escAttr(item.id) +
            '" title="Dispensar">×</button>'
          : '') +
        '</div>' +
        '<div class="capn-title">' +
        escHtml(item.title || meta.label) +
        '</div>' +
        '<div class="capn-msg">' +
        escHtml(item.message || '') +
        '</div>' +
        '</article>';
    }
    host.innerHTML = html;
    host.classList.add('is-show');
  }

  function applyNoticesConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    noticesConfig = cfg;
    // fields do JSON sobrescrevem defaults
    renderContextNotices();
  }

  function loadNoticesFromCache() {
    try {
      var raw = GM_getValue(UPDATE.noticesCacheKey, null);
      if (!raw) return;
      applyNoticesConfig(JSON.parse(raw));
    } catch (e) {}
  }

  function fetchNotices(force) {
    if (typeof GM_xmlhttpRequest !== 'function') return;
    if (!UPDATE.noticesUrl) return;

    var now = Date.now();
    var every =
      (noticesConfig && Number(noticesConfig.refreshEveryMs)) || 5 * 60 * 1000;
    var last = Number(GM_getValue(UPDATE.noticesLastKey, 0)) || 0;
    if (!force && now - last < every) {
      renderContextNotices();
      return;
    }
    GM_setValue(UPDATE.noticesLastKey, now);

    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE.noticesUrl + (UPDATE.noticesUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + now,
      headers: { Accept: 'application/json' },
      onload: function (res) {
        try {
          if (res.status < 200 || res.status >= 300) throw new Error('http');
          var cfg = JSON.parse(res.responseText);
          GM_setValue(UPDATE.noticesCacheKey, JSON.stringify(cfg));
          applyNoticesConfig(cfg);
        } catch (e) {
          loadNoticesFromCache();
          renderContextNotices();
        }
      },
      onerror: function () {
        loadNoticesFromCache();
        renderContextNotices();
      }
    });
  }

  function watchFormContext() {
    var ctx = getFormContext();
    var key = [ctx.pedido, ctx.emissor, ctx.centro].join('|');
    if (key === lastContextKey) return;
    // mudou pedido/centro/emissor → libera avisos dispensados nesta sessão
    if (lastContextKey) clearDismissedNotices();
    lastContextKey = key;
    var p = normalizePedido(ctx.pedido);
    if (p) dupCheck.lastPedido = p;
    else if (dupCheck.lastPedido) {
      dupCheck.lastPedido = '';
      dupCheck.lastShownPedido = '';
      dupCheck.lastShownCapId = '';
      dupCheck.lastResult = null;
      setContinuarBlocked(false);
      closeDupModal();
    }
    renderContextNotices();
    // dispara a checagem nativa do CAP quando o pedido estiver completo
    scheduleDupCheck(ctx.pedido);
  }

  function observeContextColumns() {
    try {
      if (observeContextColumns._mo) {
        try {
          observeContextColumns._mo.disconnect();
        } catch (e0) {}
      }
      var fields = Object.assign({}, defaultNoticeFields(), (noticesConfig && noticesConfig.fields) || {});
      var roots = [
        resolveNoticeFieldRoot(fields.pedido),
        resolveNoticeFieldRoot(fields.emissor),
        resolveNoticeFieldRoot(fields.centro)
      ];
      var mo = new MutationObserver(function () {
        setTimeout(watchFormContext, 30);
      });
      for (var i = 0; i < roots.length; i++) {
        if (!roots[i]) continue;
        mo.observe(roots[i], {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'title', 'value', 'disabled', 'aria-disabled']
        });
      }
      observeContextColumns._mo = mo;
    } catch (e) {}
  }

  function bindSelect2Events() {
    // Select2 costuma disparar via jQuery quando o centro é preenchido após o pedido
    try {
      var w = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
      var $ = w.jQuery || w.$;
      if (!$ || !$.fn) return;
      $(document)
        .off('.capNotices')
        .on(
          'change.capNotices select2:select.capNotices select2:clear.capNotices select2:close.capNotices',
          'select',
          function () {
            setTimeout(watchFormContext, 40);
          }
        );
    } catch (e) {}
  }

  function startNoticesSystem() {
    // limpa dismiss antigo que ficava salvo no Tampermonkey
    clearDismissedNotices();
    loadNoticesFromCache();
    ensureNoticesHost();
    fetchNotices(true);
    clearInterval(noticesTimer);
    noticesTimer = setInterval(function () {
      fetchNotices(false);
    }, 60 * 1000);
    clearInterval(contextWatchTimer);
    // Centro Select2 é preenchido depois do pedido — poll curto ajuda para pegar o valor
    contextWatchTimer = setInterval(watchFormContext, 500);
    observeContextColumns();
    // CAP recria colunas com IDs novos — reposiciona o observer de tempos em tempos
    if (!observeContextColumns._rebindTimer) {
      observeContextColumns._rebindTimer = setInterval(observeContextColumns, 4000);
    }
    bindSelect2Events();

    try {
      document.addEventListener(
        'change',
        function () {
          setTimeout(watchFormContext, 50);
        },
        true
      );
      document.addEventListener(
        'input',
        function () {
          setTimeout(watchFormContext, 50);
          // após digitar pedido, o centro pode chegar alguns ms depois
          setTimeout(watchFormContext, 300);
          setTimeout(watchFormContext, 800);
        },
        true
      );
    } catch (e) {}
  }

  function getPageWindow() {
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
    } catch (e0) {}
    return window;
  }

  function normalizePedido(value) {
    return String(value || '')
      .replace(/\s+/g, '')
      .trim();
  }

  function pedidoLooksReady(pedido) {
    var p = normalizePedido(pedido);
    // pedidos SAP costumam ter 8–12 dígitos; evita lixo curto
    return /^\d{8,14}$/.test(p);
  }

  function isValidCapRequestId(id) {
    var s = String(id || '').replace(/\D/g, '');
    // IDs de solicitação CAP (ex.: 4594008) — nunca strings gigantes concatenadas
    return /^\d{5,10}$/.test(s);
  }

  function isClosedCapStatus(status) {
    var s = String(status || '').trim();
    if (!s) return false;
    return /^(Completed|Canceled|Cancelled|Interrupted)$/i.test(s) ||
      /conclu[ií]d|cancelad|finalizad|interromp/i.test(s);
  }

  function isOpenCapStatus(status) {
    var s = String(status || '').trim();
    if (!s) return false;
    if (isClosedCapStatus(s)) return false;
    return /^(Running|Uninitialized|Draft|Errored)$/i.test(s) ||
      /em andamento|running|aberto|rascunho|pendente|em aberto/i.test(s);
  }

  /** Só checa duplicidade em formulário Pré CAP editável (não em solicitação concluída). */
  function isEditablePreCapContext() {
    try {
      var fields = Object.assign({}, defaultNoticeFields(), (noticesConfig && noticesConfig.fields) || {});
      var pedidoRoot = resolveNoticeFieldRoot(fields.pedido);
      if (!pedidoRoot) return false;

      if (pedidoRoot.querySelector('.select2-container--disabled, .select2-container-disabled')) {
        return false;
      }

      var ctrl = pedidoRoot.querySelector(
        'input:not([type="hidden"]), select, textarea'
      );
      if (!ctrl) return false;
      if (ctrl.disabled || ctrl.readOnly) return false;
      if (ctrl.getAttribute('aria-disabled') === 'true') return false;

      // página de detalhes em modo leitura costuma desabilitar campos; se o pedido
      // ainda é editável, seguimos (novo Pré CAP / tarefa em andamento)
      return true;
    } catch (e2) {
      return false;
    }
  }

  function parseCapStatusFromSoap(xml) {
    var raw = String(xml || '');
    // Status da solicitação vem logo após o bloco </Service>
    var m = raw.match(/<\/Service>\s*<Status>\s*([^<]+)\s*<\/Status>/i);
    if (m) return String(m[1] || '').trim();
    var all = [];
    var re = /<Status>\s*([^<]+)\s*<\/Status>/gi;
    var x;
    while ((x = re.exec(raw))) {
      var v = String(x[1] || '').trim();
      if (/^(Running|Uninitialized|Completed|Canceled|Cancelled|Interrupted|Errored|Draft)$/i.test(v)) {
        all.push(v);
      }
    }
    // ignora Status do Service (Published/Disabled/Draft) quando possível
    for (var i = 0; i < all.length; i++) {
      if (!/^(Draft)$/i.test(all[i]) || all.length === 1) return all[i];
    }
    return all.length ? all[all.length - 1] : '';
  }

  function parseCapStatusFromDetailsHtml(html) {
    var raw = String(html || '');
    var m =
      raw.match(/WorkflowStatus["'\s:=]+([A-Za-zÀ-ÿ]+)/i) ||
      raw.match(/RequestStatus["'\s:=]+([A-Za-zÀ-ÿ]+)/i) ||
      raw.match(/"status"\s*:\s*"([^"]+)"/i) ||
      raw.match(/Status\s*<\/[^>]+>\s*<[^>]+>([^<]{3,40})</i);
    if (m) return String(m[1] || '').trim();
    if (/conclu[ií]d[oa]/i.test(raw) && /cancelad/i.test(raw) === false) {
      // heurística fraca — só usa se aparecer badge típico
      if (/badge[^>]*>\s*Conclu[ií]d/i.test(raw) || /label[^>]*>\s*Conclu[ií]d/i.test(raw)) {
        return 'Completed';
      }
    }
    if (/badge[^>]*>\s*Em andamento/i.test(raw) || /label[^>]*>\s*Em andamento/i.test(raw)) {
      return 'Running';
    }
    if (/badge[^>]*>\s*Cancelad/i.test(raw) || /label[^>]*>\s*Cancelad/i.test(raw)) {
      return 'Canceled';
    }
    return '';
  }

  /**
   * Descobre se a solicitação CAP ainda está aberta.
   * cb(isOpen): true=aberta, false=concluída/cancelada, null=não soube
   */
  function fetchCapRequestOpenState(capId, cb) {
    var id = String(capId || '').replace(/\D/g, '');
    if (!isValidCapRequestId(id)) return cb(null);
    var cached = dupCheck.statusCache[id];
    if (cached && Date.now() - cached.at < 90 * 1000) {
      return cb(cached.isOpen);
    }

    function finish(status) {
      var isOpen;
      if (isClosedCapStatus(status)) isOpen = false;
      else if (isOpenCapStatus(status)) isOpen = true;
      else isOpen = null;
      dupCheck.statusCache[id] = { isOpen: isOpen, status: status, at: Date.now() };
      cb(isOpen);
    }

    var origin = location.origin || 'https://vcimentos.capworkflow.com';
    var soap =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
      'xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
      '<soap12:Body><GetRequestDetails xmlns="http://iteris.cap.webservices">' +
      '<requestId>' +
      id +
      '</requestId><cultureName>pt-BR</cultureName>' +
      '</GetRequestDetails></soap12:Body></soap12:Envelope>';

    function tryDetailsHtml() {
      var url = buildCapRequestUrl(id);
      var w = getPageWindow();
      if (w.fetch) {
        w.fetch(url, { credentials: 'same-origin', method: 'GET' })
          .then(function (res) {
            return res.text();
          })
          .then(function (html) {
            finish(parseCapStatusFromDetailsHtml(html));
          })
          .catch(function () {
            finish('');
          });
        return;
      }
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.withCredentials = true;
        xhr.onload = function () {
          finish(parseCapStatusFromDetailsHtml(xhr.responseText || ''));
        };
        xhr.onerror = function () {
          finish('');
        };
        xhr.send();
      } catch (e0) {
        finish('');
      }
    }

    function trySoap() {
      var w = getPageWindow();
      var endpoint = origin + '/Services/CAPRequests.asmx';
      if (w.fetch) {
        w.fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
          body: soap
        })
          .then(function (res) {
            return res.text();
          })
          .then(function (xml) {
            var st = parseCapStatusFromSoap(xml);
            if (st) finish(st);
            else tryDetailsHtml();
          })
          .catch(function () {
            tryDetailsHtml();
          });
        return;
      }
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/soap+xml; charset=utf-8');
        xhr.onload = function () {
          var st = parseCapStatusFromSoap(xhr.responseText || '');
          if (st) finish(st);
          else tryDetailsHtml();
        };
        xhr.onerror = function () {
          tryDetailsHtml();
        };
        xhr.send(soap);
      } catch (e1) {
        tryDetailsHtml();
      }
    }

    trySoap();
  }

  /** Só abre o modal se o Pré CAP encontrado ainda estiver aberto. */
  function maybeShowDupModal(info) {
    if (!info) return;
    var capId = String(info.capId || (info.requestIds && info.requestIds[0]) || '').replace(/\D/g, '');
    if (!isValidCapRequestId(capId)) return;
    if (!isEditablePreCapContext()) {
      dismissNativeDupSwal();
      setEnviarBlocked(false);
      restoreEnviarSolicitacao();
      setTimeout(disableNativeSwalSuppress, 200);
      return;
    }
    fetchCapRequestOpenState(capId, function (isOpen) {
      // concluído/cancelado → não avisa, libera e restaura Enviar Solicitação
      if (isOpen === false) {
        setEnviarBlocked(false);
        closeDupModal();
        dismissNativeDupSwal();
        restoreEnviarSolicitacao();
        // CAP às vezes demora a recriar o rodapé
        setTimeout(restoreEnviarSolicitacao, 200);
        setTimeout(restoreEnviarSolicitacao, 800);
        setTimeout(disableNativeSwalSuppress, 200);
        return;
      }
      // só bloqueia Enviar quando confirmado em andamento
      showDupModal(info);
      if (isOpen === true) {
        setEnviarBlocked(true, info.pedido || dupCheck.lastPedido);
      } else {
        // status desconhecido: avisa, mas não trava o envio
        setEnviarBlocked(false);
      }
    });
  }

  function enviarButtonLabel(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT') return String(el.value || '').replace(/\s+/g, ' ').trim();
    var aria = String(el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    var title = String(el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    var txt = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    return (aria || title || txt).replace(/\s+/g, ' ').trim();
  }

  function isEnviarSolicitacaoButton(el) {
    if (!el || isOurUi(el)) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT') return false;
    var label = enviarButtonLabel(el);
    if (!label || label.length > 48) return false;
    return /enviar\s+solicita[cç][aã]o/i.test(label);
  }

  function findEnviarSolicitacaoButtons(includeHidden) {
    var out = [];
    var seen = {};
    var nodes = document.querySelectorAll(
      'button, a.btn, a.button, input[type="button"], input[type="submit"], [role="button"]'
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isEnviarSolicitacaoButton(el)) continue;
      if (!includeHidden) {
        var st = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if (el.hidden) continue;
        if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
      }
      if (seen[el]) continue;
      seen[el] = true;
      out.push(el);
    }
    return out;
  }

  function applyEnviarBlockedStyles(el, blocked) {
    if (!el) return;
    if (blocked) {
      el.classList.add('capr-enviar-blocked');
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('data-capr-enviar-blocked', '1');
      try {
        if ('disabled' in el) el.disabled = true;
      } catch (e0) {}
      try {
        el.setAttribute('tabindex', '-1');
      } catch (e1) {}
      if (!el.getAttribute('data-capr-title-prev')) {
        el.setAttribute('data-capr-title-prev', el.getAttribute('title') || '');
        el.setAttribute(
          'title',
          'Pré CAP em andamento para este pedido — Enviar Solicitação bloqueado'
        );
      }
    } else if (el.getAttribute('data-capr-enviar-blocked') === '1' || el.classList.contains('capr-enviar-blocked')) {
      el.classList.remove('capr-enviar-blocked');
      el.removeAttribute('aria-disabled');
      el.removeAttribute('data-capr-enviar-blocked');
      try {
        if ('disabled' in el) el.disabled = false;
      } catch (e2) {}
      try {
        el.removeAttribute('tabindex');
      } catch (e3) {}
      var prev = el.getAttribute('data-capr-title-prev');
      if (prev != null) {
        if (prev) el.setAttribute('title', prev);
        else el.removeAttribute('title');
        el.removeAttribute('data-capr-title-prev');
      }
    }
  }

  /** Quando o CAP existente está concluído, o native às vezes esconde o botão — reexibe. */
  function restoreEnviarSolicitacao() {
    var buttons = findEnviarSolicitacaoButtons(true);
    for (var i = 0; i < buttons.length; i++) {
      var el = buttons[i];
      applyEnviarBlockedStyles(el, false);
      try {
        el.hidden = false;
        el.removeAttribute('hidden');
        if (el.style) {
          if (el.style.display === 'none') el.style.display = '';
          if (el.style.visibility === 'hidden') el.style.visibility = '';
          if (el.style.opacity === '0') el.style.opacity = '';
        }
        el.classList.remove('hidden', 'd-none', 'hide', 'ng-hide', 'invisible');
        if ('disabled' in el) el.disabled = false;
      } catch (e0) {}
      // sobe um nível se o wrapper foi o escondido
      try {
        var wrap = el.closest('.btn-group, .form-actions, .workflow-actions, .modal-footer, .actions, footer');
        if (wrap && wrap !== document.body) {
          if (wrap.style && wrap.style.display === 'none' && /enviar\s+solicita/i.test(wrap.textContent || '')) {
            wrap.style.display = '';
          }
          wrap.classList.remove('hidden', 'd-none', 'hide');
        }
      } catch (e1) {}
    }
  }

  function refreshEnviarBlockedUi() {
    var buttons = findEnviarSolicitacaoButtons(true);
    for (var i = 0; i < buttons.length; i++) {
      applyEnviarBlockedStyles(buttons[i], !!dupCheck.continuarBlocked);
    }
    if (!dupCheck.continuarBlocked) {
      var stale = document.querySelectorAll('[data-capr-enviar-blocked="1"], .capr-enviar-blocked');
      for (var j = 0; j < stale.length; j++) {
        applyEnviarBlockedStyles(stale[j], false);
      }
      // limpa legado do nome antigo
      var legacy = document.querySelectorAll('[data-capr-continuar-blocked="1"], .capr-continuar-blocked');
      for (var k = 0; k < legacy.length; k++) {
        legacy[k].classList.remove('capr-continuar-blocked');
        legacy[k].removeAttribute('data-capr-continuar-blocked');
        try {
          if ('disabled' in legacy[k]) legacy[k].disabled = false;
        } catch (e0) {}
      }
    }
  }

  function setEnviarBlocked(blocked, pedido) {
    dupCheck.continuarBlocked = !!blocked;
    dupCheck.blockedPedido = blocked ? normalizePedido(pedido || dupCheck.lastPedido) : '';
    refreshEnviarBlockedUi();
    if (blocked) {
      clearInterval(dupCheck.continuarWatchTimer);
      dupCheck.continuarWatchTimer = setInterval(function () {
        if (!dupCheck.continuarBlocked) {
          clearInterval(dupCheck.continuarWatchTimer);
          dupCheck.continuarWatchTimer = null;
          return;
        }
        refreshEnviarBlockedUi();
      }, 800);
    } else {
      clearInterval(dupCheck.continuarWatchTimer);
      dupCheck.continuarWatchTimer = null;
      restoreEnviarSolicitacao();
    }
  }

  // aliases antigos (chamadas internas)
  function setContinuarBlocked(blocked, pedido) {
    setEnviarBlocked(blocked, pedido);
  }

  function installContinuarClickGuard() {
    if (dupCheck.continuarGuardInstalled) return;
    dupCheck.continuarGuardInstalled = true;
    document.addEventListener(
      'click',
      function (e) {
        if (!dupCheck.continuarBlocked) return;
        var t = e.target;
        if (!t || !t.closest) return;
        var btn = t.closest('button, a, input[type="button"], input[type="submit"], [role="button"]');
        if (!btn || !isEnviarSolicitacaoButton(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        refreshEnviarBlockedUi();
        if (dupCheck.lastResult) showDupModal(dupCheck.lastResult);
      },
      true
    );
    document.addEventListener(
      'keydown',
      function (e) {
        if (!dupCheck.continuarBlocked) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var t = e.target;
        if (!t || !isEnviarSolicitacaoButton(t)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      },
      true
    );
  }

  function isDupPedidoMessage(text) {
    var t = String(text || '');
    // frase exata do SweetAlert nativo do Pré CAP
    return (
      /utilizado no CAP/i.test(t) &&
      /abertura ser[aá] bloqueada/i.test(t)
    );
  }

  function buildCapRequestUrl(capId) {
    var id = String(capId || '').replace(/\D/g, '');
    if (!isValidCapRequestId(id)) return '';
    var origin = location.origin || 'https://vcimentos.capworkflow.com';
    return origin + '/Request/Details/' + id;
  }

  function extractCapLinkFromHtml(html) {
    var out = { capId: '', url: '', requestIds: [] };
    var raw = String(html || '');
    if (!raw) return out;

    function accept(id, url) {
      id = String(id || '').replace(/\D/g, '');
      if (!isValidCapRequestId(id)) return false;
      out.capId = id;
      out.requestIds = [id];
      out.url = url || '';
      return true;
    }

    try {
      if (typeof DOMParser !== 'undefined') {
        var doc = new DOMParser().parseFromString('<div id="capr-parse">' + raw + '</div>', 'text/html');
        var root = doc.getElementById('capr-parse') || doc.body;
        var anchors = root.querySelectorAll('a[href]');
        for (var i = 0; i < anchors.length; i++) {
          var a = anchors[i];
          var txt = String(a.textContent || '').trim();
          var href = a.getAttribute('href') || '';
          var txtId = txt.replace(/\D/g, '');
          // texto do link deve ser só o número do CAP (ex.: 4594008)
          if (txtId !== txt.replace(/\s+/g, '') && !/^\d{5,10}$/.test(txt)) {
            txtId = '';
          }
          if (!isValidCapRequestId(txtId)) txtId = '';
          var hrefId = '';
          var hm = href.match(/(?:RequestId|requestId|Details\/|Request\/(?:Details|Index)\/|id=)(\d{5,10})\b/i);
          if (hm) hrefId = hm[1];
          if (accept(txtId || hrefId, href)) break;
        }
      }
    } catch (e0) {}

    if (!out.capId) {
      var am = raw.match(
        /utilizado no CAP\s*<a[^>]*href=["']([^"']+)["'][^>]*>\s*(\d{5,10})\s*<\/a>/i
      );
      if (am) accept(am[2], am[1]);
    }
    if (!out.capId) {
      var am2 = raw.match(/<a[^>]*href=["']([^"']+)["'][^>]*>\s*(\d{5,10})\s*<\/a>/i);
      if (am2 && /utilizado no CAP/i.test(raw)) accept(am2[2], am2[1]);
    }
    if (!out.capId) {
      var m = raw.match(/utilizado no CAP\s*(?:<[^>]*>)?\s*(\d{5,10})\b/i);
      if (m) accept(m[1], '');
    }

    if (out.capId && (!out.url || out.url === '#' || out.url.indexOf('javascript:') === 0)) {
      out.url = buildCapRequestUrl(out.capId);
    } else if (out.url && out.url.charAt(0) === '/') {
      out.url = (location.origin || '') + out.url;
    }
    return out;
  }

  function parseDupGatewayPayload(raw, pedido) {
    if (raw == null) return null;
    var text = typeof raw === 'string' ? raw : '';
    var obj = null;
    if (typeof raw === 'object') {
      obj = raw;
      try {
        text = JSON.stringify(raw);
      } catch (e0) {
        text = String(raw);
      }
    } else {
      text = String(raw || '');
      try {
        if (/^\s*[\[{]/.test(text)) obj = JSON.parse(text);
      } catch (e1) {}
    }

    var lower = text.toLowerCase();
    if (
      lower.indexOf('mt_inf_cli') >= 0 ||
      lower.indexOf('<kunnr>') >= 0 ||
      lower.indexOf('inf_cliente') >= 0
    ) {
      return null;
    }

    // NÃO usar status/workflowStatus isolado — no CAP status 1 aparece em vários gateways
    if (!isDupPedidoMessage(text)) return null;

    var link = extractCapLinkFromHtml(text);
    var capId = link.capId;
    var capUrl = link.url;
    if (obj && !capId) {
      capId = String(
        obj.requestId ||
          obj.RequestId ||
          obj.idSolicitacao ||
          (obj.data && (obj.data.requestId || obj.data.RequestId)) ||
          ''
      ).replace(/\D/g, '');
      if (!isValidCapRequestId(capId)) capId = '';
      capUrl = String(obj.url || obj.link || obj.href || '') || capUrl;
    }
    if (!isValidCapRequestId(capId)) return null;
    if (!capUrl) capUrl = buildCapRequestUrl(capId);

    var ped = normalizePedido(pedido) || dupCheck.lastPedido;
    if (!pedidoLooksReady(ped)) ped = '';

    return {
      pedido: ped,
      status: 'bloqueado',
      capId: capId,
      capUrl: capUrl,
      requestIds: [capId]
    };
  }

  function enableNativeSwalSuppress() {
    // desativado: esconder TODOS os SweetAlerts quebrava o "Continuar" em qualquer fluxo
  }

  function disableNativeSwalSuppress() {
    dupCheck.suppressUntil = 0;
    try {
      document.documentElement.classList.remove('capr-dup-suppress-swal');
      document.body.classList.remove('capr-dup-suppress-swal');
    } catch (e1) {}
  }

  function dismissNativeDupSwal(root) {
    try {
      var nodes = root
        ? [root]
        : Array.prototype.slice.call(
            document.querySelectorAll('.swal2-container, .sweet-alert, .swal2-popup')
          );
      var removed = false;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n || !n.parentNode) continue;
        var host = n.classList.contains('swal2-container') ? n : n.closest('.swal2-container') || n;
        var txt = String(host.textContent || '');
        // só remove o SweetAlert de pedido duplicado — nunca outros avisos do CAP
        if (!isDupPedidoMessage(txt)) continue;
        try {
          host.remove();
        } catch (e0) {
          try {
            host.style.display = 'none';
          } catch (e1) {}
        }
        removed = true;
      }
      // NÃO chama Swal.close() global — isso fecha o feedback do Continuar
      if (removed) {
        try {
          var w = getPageWindow();
          if (w.Swal && typeof w.Swal.isVisible === 'function' && w.Swal.isVisible()) {
            var parts = [];
            try {
              if (typeof w.Swal.getHtmlContainer === 'function' && w.Swal.getHtmlContainer()) {
                parts.push(w.Swal.getHtmlContainer().textContent || '');
              }
              if (typeof w.Swal.getTitle === 'function' && w.Swal.getTitle()) {
                parts.push(w.Swal.getTitle().textContent || '');
              }
            } catch (e2) {}
            if (isDupPedidoMessage(parts.join(' ')) && typeof w.Swal.close === 'function') {
              w.Swal.close();
            }
          }
        } catch (e3) {}
      }
    } catch (e4) {}
  }

  function ensureDupModal() {
    if (document.getElementById(CFG.dupModalId)) return;
    var wrap = document.createElement('div');
    wrap.id = CFG.dupModalId;
    wrap.innerHTML =
      '<div class="capr-dup-modal" role="dialog" aria-modal="true" aria-labelledby="capr-dup-title">' +
      '<div class="capr-dup-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 52 52" width="52" height="52">' +
      '<circle cx="26" cy="26" r="24" fill="none" stroke="#e07470" stroke-width="2"/>' +
      '<path d="M18 18l16 16M34 18L18 34" fill="none" stroke="#e07470" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg></div>' +
      '<div class="capr-dup-title" id="capr-dup-title">Pré CAP já existente</div>' +
      '<div class="capr-dup-msg" data-role="dup-msg">Este pedido já está sendo utilizado. A abertura será bloqueada.</div>' +
      '<div class="capr-dup-card">' +
      '<div class="capr-dup-row"><span>Pedido</span><strong data-role="dup-pedido">—</strong></div>' +
      '<div class="capr-dup-row" data-role="dup-cap-row" hidden>' +
      '<span>Pré CAP</span>' +
      '<a class="capr-dup-link" data-role="dup-cap-link" href="#" target="_blank" rel="noopener noreferrer">—</a>' +
      '</div></div>' +
      '<div class="capr-dup-foot">' +
      '<a class="capr-btn primary" data-role="dup-open" data-dup-act="open" href="#" target="_blank" rel="noopener noreferrer" hidden>Abrir Pré CAP</a>' +
      '<button type="button" class="capr-btn ghost" data-dup-act="close">OK</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) {
        e.preventDefault();
        return closeDupModal();
      }
      var btn = e.target.closest('[data-dup-act]');
      if (!btn || !wrap.contains(btn)) return;
      var act = btn.getAttribute('data-dup-act');
      if (act === 'close') {
        e.preventDefault();
        closeDupModal();
      }
      // act === 'open' → deixa o <a> navegar normalmente
    });
  }

  function closeDupModal() {
    var modal = document.getElementById(CFG.dupModalId);
    if (modal) modal.classList.remove('is-open');
    setTimeout(disableNativeSwalSuppress, 300);
  }

  function showDupModal(info) {
    if (!info) return;
    var pedido = normalizePedido(info.pedido) || dupCheck.lastPedido || '';
    if (pedido && !pedidoLooksReady(pedido)) pedido = '';
    var capId = String(info.capId || (info.requestIds && info.requestIds[0]) || '').replace(/\D/g, '');
    // IDs concatenados / barcode / lixo de gateway → nunca abrir modal
    if (!isValidCapRequestId(capId)) return;
    var capUrl = info.capUrl || buildCapRequestUrl(capId);
    if (!capUrl || !isValidCapRequestId(capId)) return;

    // evita spam do mesmo aviso
    if (
      pedido &&
      pedido === dupCheck.lastShownPedido &&
      capId === dupCheck.lastShownCapId
    ) {
      ensureDupModal();
      var existing = document.getElementById(CFG.dupModalId);
      if (existing && !existing.classList.contains('is-open')) existing.classList.add('is-open');
      dismissNativeDupSwal();
      // bloqueio do Enviar fica a cargo do maybeShowDupModal (só se em andamento)
      return;
    }

    ensureDupModal();
    dismissNativeDupSwal();
    var modal = document.getElementById(CFG.dupModalId);
    if (!modal) return;

    var pedidoEl = modal.querySelector('[data-role="dup-pedido"]');
    var msgEl = modal.querySelector('[data-role="dup-msg"]');
    var capRow = modal.querySelector('[data-role="dup-cap-row"]');
    var capLink = modal.querySelector('[data-role="dup-cap-link"]');
    var openBtn = modal.querySelector('[data-role="dup-open"]');

    if (pedidoEl) pedidoEl.textContent = pedido || '—';
    if (msgEl) {
      msgEl.innerHTML =
        'Este pedido está sendo utilizado no CAP ' +
        '<a class="capr-dup-link" href="' +
        escAttr(capUrl) +
        '" target="_blank" rel="noopener noreferrer">' +
        escHtml(capId) +
        '</a>. A abertura será bloqueada.';
    }
    if (capRow && capLink && openBtn) {
      capLink.textContent = capId;
      capLink.href = capUrl;
      openBtn.href = capUrl;
      openBtn.hidden = false;
      capRow.hidden = false;
    }

    dupCheck.lastShownPedido = pedido;
    dupCheck.lastShownCapId = capId;
    dupCheck.lastResult = {
      pedido: pedido,
      capId: capId,
      capUrl: capUrl,
      requestIds: [capId],
      status: info.status
    };
    modal.classList.add('is-open');
  }

  function handleDupPayload(raw, pedido) {
    var info = parseDupGatewayPayload(raw, pedido || dupCheck.lastPedido);
    if (!info) return false;
    maybeShowDupModal(info);
    return true;
  }

  function handleDupFromSwalOpts(opts) {
    var html = '';
    var text = '';
    var title = '';
    if (typeof opts === 'string') {
      html = opts;
      text = opts;
    } else if (opts && typeof opts === 'object') {
      html = String(opts.html || '');
      text = String(opts.text || '');
      title = String(opts.title || '');
    }
    var blob = [title, html, text].join(' ');
    if (!isDupPedidoMessage(blob) && !isDupPedidoMessage(html) && !isDupPedidoMessage(text)) {
      return false;
    }
    var link = extractCapLinkFromHtml(html || text || title);
    if (!isValidCapRequestId(link.capId)) {
      // tenta no texto puro (às vezes o número vem sem <a>)
      link = extractCapLinkFromHtml(String(html || text || '').replace(/<[^>]+>/g, ' '));
    }
    if (!isValidCapRequestId(link.capId)) return false;
    var cached = dupCheck.statusCache[link.capId];
    if (cached && cached.isOpen === false && Date.now() - cached.at < 90 * 1000) {
      // já sabemos que está concluído — engole o Oops e restaura Enviar
      setEnviarBlocked(false);
      setTimeout(restoreEnviarSolicitacao, 0);
      setTimeout(restoreEnviarSolicitacao, 250);
      setTimeout(restoreEnviarSolicitacao, 900);
      return true;
    }
    // intercepta o nativo; só bloqueia Enviar se o Pré CAP existente ainda estiver aberto
    maybeShowDupModal({
      pedido: dupCheck.lastPedido || normalizePedido(getFormContext().pedido),
      capId: link.capId,
      capUrl: link.url,
      requestIds: link.requestIds,
      status: 'bloqueado'
    });
    return true;
  }

  function normalizeSwalArgs(args) {
    if (!args || !args.length) return {};
    if (args.length === 1) {
      if (typeof args[0] === 'string') return { title: args[0] };
      return args[0] || {};
    }
    // Swal.fire(title, text, icon)
    return {
      title: args[0],
      text: args[1],
      icon: args[2]
    };
  }

  function installSwalInterceptor() {
    var w = getPageWindow();

    function wrapFire(owner, key) {
      if (!owner || typeof owner[key] !== 'function' || owner[key]._capDupWrapped) return false;
      var original = owner[key];
      var wrapped = function () {
        var opts = normalizeSwalArgs(arguments);
        if (handleDupFromSwalOpts(opts)) {
          // remove só o Swal de duplicidade (se já renderizou); não mexe nos demais
          setTimeout(function () {
            dismissNativeDupSwal();
          }, 0);
          return Promise.resolve({
            isConfirmed: true,
            isDenied: false,
            isDismissed: false,
            value: true
          });
        }
        return original.apply(this, arguments);
      };
      wrapped._capDupWrapped = true;
      wrapped._capDupOriginal = original;
      owner[key] = wrapped;
      return true;
    }

    // Só envolve .fire — NÃO substitui o objeto Swal por proxy (quebrava Continuar)
    if (w.Swal && typeof w.Swal.fire === 'function') {
      wrapFire(w.Swal, 'fire');
      try {
        w.Swal._capDupFireWrapped = true;
      } catch (e0) {}
    }
    if (w.swal && w.swal !== w.Swal && typeof w.swal.fire === 'function') {
      wrapFire(w.swal, 'fire');
    }
    // swal legado global (função), sem trocar referência se já envolvido
    if (typeof w.swal === 'function' && !w.swal._capDupWrapped && !(w.swal.fire && w.swal.fire._capDupWrapped)) {
      // só se for a API antiga swal(title, text, type) sem .fire
      if (typeof w.swal.fire !== 'function') wrapFire(w, 'swal');
    }

    dupCheck.swalWrapped = !!(w.Swal && w.Swal.fire && w.Swal.fire._capDupWrapped);
  }

  function installSwalDomGuard() {
    if (dupCheck.observer) return;
    try {
      dupCheck.observer = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var nodes = mutations[i].addedNodes;
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (!n || n.nodeType !== 1) continue;
            var host =
              n.matches && n.matches('.swal2-container, .sweet-alert')
                ? n
                : n.querySelector && n.querySelector('.swal2-container, .swal2-popup, .sweet-alert');
            if (!host) continue;
            var txt = String(host.textContent || '');
            if (!isDupPedidoMessage(txt)) continue;
            var html = '';
            try {
              var htmlBox = host.querySelector('.swal2-html-container, .swal2-content, p');
              html = htmlBox ? htmlBox.innerHTML : host.innerHTML;
            } catch (e0) {
              html = txt;
            }
            var link = extractCapLinkFromHtml(html);
            if (!isValidCapRequestId(link.capId)) continue;
            maybeShowDupModal({
              pedido: dupCheck.lastPedido || normalizePedido(getFormContext().pedido),
              capId: link.capId,
              capUrl: link.url,
              requestIds: link.requestIds,
              status: 'bloqueado'
            });
            dismissNativeDupSwal(
              host.classList.contains('swal2-container') ? host : host.closest('.swal2-container') || host
            );
          }
        }
      });
      dupCheck.observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e1) {}
  }

  function wrapBuiltInDupCheck() {
    var w = getPageWindow();
    var ws = w.WorkflowScript || w.workflowScript;
    if (!ws) return false;
    var name = 'verificaNumeroDePedido';
    if (typeof ws[name] !== 'function') {
      if (typeof ws.VerificaNumeroDePedido === 'function') name = 'VerificaNumeroDePedido';
      else return false;
    }
    if (ws[name]._capDupWrapped) return true;
    var original = ws[name];
    ws[name] = function () {
      var pedido = normalizePedido(arguments[0]) || normalizePedido(getFormContext().pedido);
      if (pedido) dupCheck.lastPedido = pedido;
      installSwalInterceptor();
      return original.apply(this, arguments);
    };
    ws[name]._capDupWrapped = true;
    return true;
  }

  function runDupCheck(pedido) {
    var p = normalizePedido(pedido);
    if (!pedidoLooksReady(p)) return;
    if (!isEditablePreCapContext()) return;
    if (dupCheck.inFlight && dupCheck.lastPedido === p) return;
    // trocou o pedido → libera Continuar até confirmar nova duplicidade aberta
    if (dupCheck.continuarBlocked && p !== dupCheck.blockedPedido) {
      setContinuarBlocked(false);
    }
    if (
      p === dupCheck.lastShownPedido &&
      dupCheck.lastResult &&
      isValidCapRequestId(dupCheck.lastResult.capId)
    ) {
      maybeShowDupModal(dupCheck.lastResult);
      return;
    }
    dupCheck.lastPedido = p;
    dupCheck.inFlight = true;
    installSwalInterceptor();
    wrapBuiltInDupCheck();
    // chama só a função nativa do CAP — NÃO invoca gateway genérico (falso positivo)
    var ws = getPageWindow().WorkflowScript || getPageWindow().workflowScript;
    if (ws) {
      var fn = ws.verificaNumeroDePedido || ws.VerificaNumeroDePedido;
      if (typeof fn === 'function') {
        try {
          fn.call(ws, p);
        } catch (e0) {
          try {
            fn.call(ws);
          } catch (e1) {}
        }
      }
    }
    setTimeout(function () {
      dupCheck.inFlight = false;
    }, 2000);
  }

  function scheduleDupCheck(pedido) {
    var p = normalizePedido(pedido);
    if (!isEditablePreCapContext()) return;
    if (!pedidoLooksReady(p)) {
      if (!p && dupCheck.lastPedido) {
        dupCheck.lastPedido = '';
        dupCheck.lastShownPedido = '';
        dupCheck.lastShownCapId = '';
        dupCheck.lastResult = null;
        setContinuarBlocked(false);
        closeDupModal();
      }
      return;
    }
    if (
      p === dupCheck.lastShownPedido &&
      dupCheck.lastResult &&
      isValidCapRequestId(dupCheck.lastResult.capId)
    ) {
      return;
    }
    clearTimeout(dupCheck.timer);
    dupCheck.timer = setTimeout(function () {
      runDupCheck(p);
    }, 550);
  }

  function startDupCheckSystem() {
    // limpa suppress antigo que podia ficar grudado na página
    disableNativeSwalSuppress();
    setContinuarBlocked(false);
    installContinuarClickGuard();
    installSwalInterceptor();
    installSwalDomGuard();
    wrapBuiltInDupCheck();
    ensureDupModal();
    clearInterval(dupCheck.wrapTimer);
    // só reinsere o wrap se o CAP recriou o Swal (sem empilhar proxies)
    dupCheck.wrapTimer = setInterval(function () {
      var w = getPageWindow();
      var needs =
        !w.Swal ||
        typeof w.Swal.fire !== 'function' ||
        !w.Swal.fire._capDupWrapped;
      if (needs) {
        dupCheck.swalWrapped = false;
        installSwalInterceptor();
      }
      wrapBuiltInDupCheck();
      if (dupCheck.continuarBlocked) refreshEnviarBlockedUi();
    }, 4000);
    try {
      document.addEventListener(
        'keydown',
        function (e) {
          if (e.key === 'Escape') {
            var modal = document.getElementById(CFG.dupModalId);
            if (modal && modal.classList.contains('is-open')) {
              e.stopPropagation();
              closeDupModal();
            }
          }
        },
        true
      );
    } catch (e0) {}
  }

  function uid() {
    return 'tpl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function loadTemplates() {
    var raw = GM_getValue(CFG.tplKey, null);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveTemplates() {
    GM_setValue(CFG.tplKey, JSON.stringify(templates));
  }

  function loadSettings() {
    var raw = GM_getValue(CFG.setKey, null);
    if (!raw) {
      // migra seletor antigo se existir
      try {
        var old = GM_getValue('cap_resumo_settings_v3', null);
        if (old) {
          var parsedOld = JSON.parse(old);
          return Object.assign({}, DEFAULT_SETTINGS, parsedOld);
        }
      } catch (e0) {}
      return Object.assign({}, DEFAULT_SETTINGS);
    }
    try {
      return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    GM_setValue(CFG.setKey, JSON.stringify(settings));
  }

  function normalizeLabel(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function labelLooksLikeResumo(text) {
    var t = normalizeLabel(text);
    if (!t) return false;
    if (t.indexOf('resumo do atendimento') >= 0) return true;
    if (t.indexOf('resumo atendimento') >= 0) return true;
    if (/\bresumo\b/.test(t) && /\batendimento\b/.test(t)) return true;
    return false;
  }

  function labelLooksLikeComments(text) {
    var t = normalizeLabel(text);
    if (!t) return false;
    if (labelLooksLikeResumo(t)) return false;
    return (
      /\bcoment/.test(t) ||
      /\bcomment/.test(t) ||
      /\bobserv/.test(t) ||
      /\banota/.test(t) ||
      /\bhistorico\b/.test(t) ||
      t.indexOf('mensagem interna') >= 0 ||
      t.indexOf('nota interna') >= 0
    );
  }

  function nearestFieldShell(el) {
    if (!el || !el.closest) return null;
    var shell = el.closest('.cap-form-control');
    if (shell) return shell;
    shell = el.closest('.form-group');
    if (shell) return shell;
    shell = el.closest('.mb-3');
    if (shell) {
      var tas = shell.querySelectorAll('textarea, [contenteditable="true"]');
      if (tas.length <= 1) return shell;
    }
    return el.parentElement;
  }

  function textOfLabelNode(node) {
    if (!node) return '';
    return String(node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function primaryLabel(el) {
    if (!el) return '';

    if (el.id) {
      try {
        var byFor = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        var tFor = textOfLabelNode(byFor);
        if (tFor && tFor.length < 100) return tFor;
      } catch (e) {}
    }

    var wrap = el.closest && el.closest('label');
    if (wrap) {
      var clone = wrap.cloneNode(true);
      var nested = clone.querySelectorAll('textarea, input, select, button');
      for (var n = 0; n < nested.length; n++) nested[n].remove();
      var tw = textOfLabelNode(clone);
      if (tw && tw.length < 100) return tw;
    }

    var shell = nearestFieldShell(el);
    if (shell) {
      var kids = shell.children;
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (kid === el || (kid.contains && kid.contains(el))) continue;
        var cls = String(kid.className || '');
        var isLab =
          kid.tagName === 'LABEL' ||
          /(^|\s)(control-label|form-label|cap-label|caption)(\s|$)/i.test(cls);
        if (!isLab) continue;
        var tk = textOfLabelNode(kid);
        if (tk && tk.length < 100) return tk;
      }

      var prev = el.previousElementSibling;
      var hops = 0;
      while (prev && hops < 4) {
        var pcls = String(prev.className || '');
        if (
          prev.tagName === 'LABEL' ||
          /(^|\s)(control-label|form-label|cap-label|caption)(\s|$)/i.test(pcls)
        ) {
          var tp = textOfLabelNode(prev);
          if (tp && tp.length < 100) return tp;
        }
        prev = prev.previousElementSibling;
        hops++;
      }

      var onlyFields = shell.querySelectorAll('textarea, [contenteditable="true"]');
      if (onlyFields.length === 1) {
        var any = shell.querySelector('label, .control-label, .form-label, .cap-label, .caption');
        var ta = textOfLabelNode(any);
        if (ta && ta.length < 100) return ta;
      }
    }

    var aria = el.getAttribute('aria-label');
    if (aria) return String(aria).trim();
    return '';
  }

  function fieldAttrBlob(el) {
    return [el.name, el.id, el.className, el.getAttribute('placeholder'), el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function attrsLookLikeComments(el) {
    var a = fieldAttrBlob(el);
    return /\bcoment|\bcomment|\bobserv|\banota|\bhistorico|\bnote\b/.test(a);
  }

  function attrsLookLikeResumo(el) {
    var a = fieldAttrBlob(el);
    if (attrsLookLikeComments(el)) return false;
    if (a.indexOf('resumo') >= 0) return true;
    return false;
  }

  function stillValid(el) {
    return !!(el && el.isConnected && document.contains(el));
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  function isOurUi(el) {
    if (!el || !el.closest) return true;
    return !!(
      el.closest('#' + CFG.panelId) ||
      el.closest('#' + CFG.fabId) ||
      el.closest('#' + CFG.bannerId) ||
      el.closest('#' + CFG.suggestId) ||
      el.closest('#' + CFG.updateFloatId) ||
      el.closest('#' + CFG.modalId) ||
      el.closest('#' + CFG.dupModalId) ||
      el.closest('#' + CFG.folderModalId) ||
      el.closest('#' + CFG.importModalId) ||
      el.closest('#' + CFG.noticesHostId) ||
      el.closest('#cap-resumo-toast')
    );
  }

  function isResumoField(el) {
    if (!el || !stillValid(el) || el.disabled) return false;
    if (isOurUi(el)) return false;
    if (attrsLookLikeComments(el)) return false;

    var lab = primaryLabel(el);
    if (labelLooksLikeComments(lab)) return false;
    if (labelLooksLikeResumo(lab)) return true;
    if (attrsLookLikeResumo(el) && !labelLooksLikeComments(lab)) return true;
    return false;
  }

  function scoreField(el) {
    if (!el || el.disabled || el.readOnly) return -1;
    if (isOurUi(el)) return -1;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'checkbox', 'radio', 'file', 'button', 'submit'].indexOf(type) >= 0) return -1;

    var lab = primaryLabel(el);
    if (labelLooksLikeComments(lab) || attrsLookLikeComments(el)) return -200;

    var score = 0;
    if (el.tagName === 'TEXTAREA') score += 35;
    if (el.isContentEditable) score += 25;
    if (el.tagName === 'INPUT' && (!type || type === 'text')) score += 4;
    if (isVisible(el)) score += 30;

    if (labelLooksLikeResumo(lab)) score += 160;
    else if (normalizeLabel(lab).indexOf('resumo') >= 0) score += 35;

    if (attrsLookLikeResumo(el)) score += 40;

    try {
      if (el.tagName === 'TEXTAREA' && (el.rows >= 4 || el.offsetHeight > 80)) score += 12;
    } catch (e2) {}

    return score;
  }

  function pickBestEditable(root) {
    if (!root) return null;
    var list = [];
    if (root.matches && root.matches('textarea, input:not([type]), input[type="text"], [contenteditable="true"]')) {
      list.push(root);
    }
    if (root.querySelectorAll) {
      var found = root.querySelectorAll(
        'textarea, [contenteditable="true"], input[type="text"], input:not([type])'
      );
      for (var i = 0; i < found.length; i++) list.push(found[i]);
    }
    var best = null;
    var bestScore = -1;
    for (var j = 0; j < list.length; j++) {
      var el = list[j];
      if (!stillValid(el) || el.disabled || isOurUi(el)) continue;
      var s = scoreField(el);
      if (s > bestScore) {
        bestScore = s;
        best = el;
      }
    }
    return bestScore >= 20 ? best : null;
  }

  function unwrapEditable(el) {
    if (!el || !stillValid(el)) return null;
    return pickBestEditable(el) || (scoreField(el) >= 20 ? el : null);
  }

  function buildSelector(el) {
    if (!el) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    var tag = el.tagName.toLowerCase();
    var name = el.getAttribute('name');
    if (name) {
      var byName = tag + '[name="' + CSS.escape(name) + '"]';
      if (document.querySelectorAll(byName).length === 1) return byName;
    }
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var same = 0;
        var idx = 1;
        var kids = parent.children;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].tagName === node.tagName) {
            same++;
            if (kids[i] === node) idx = same;
          }
        }
        if (same > 1) part += ':nth-of-type(' + idx + ')';
      }
      parts.unshift(part);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function resolveConfigured() {
    if (!settings.targetSelector) return null;
    try {
      var el = document.querySelector(settings.targetSelector);
      var field = unwrapEditable(el) || (stillValid(el) ? el : null);
      if (!field) return null;
      if (!isResumoField(field)) {
        // seletor antigo apontava para Comentários (Removido)
        settings.targetSelector = '';
        settings.targetLabel = '';
        saveSettings();
        return null;
      }
      return field;
    } catch (e) {
      return null;
    }
  }

  function findByResumoLabel() {
    var nodes = document.querySelectorAll('label, .control-label, .form-label, .cap-label, .caption');
    var candidates = [];

    for (var i = 0; i < nodes.length; i++) {
      var raw = textOfLabelNode(nodes[i]);
      if (!raw || raw.length > 90) continue;
      if (!labelLooksLikeResumo(raw)) continue;
      if (labelLooksLikeComments(raw)) continue;

      var field = null;
      var forId = nodes[i].getAttribute && nodes[i].getAttribute('for');
      if (forId) {
        try {
          var byFor = document.getElementById(forId);
          if (byFor) field = unwrapEditable(byFor) || byFor;
        } catch (e) {}
      }

      var shell =
        nodes[i].closest('.cap-form-control') ||
        nodes[i].closest('.form-group') ||
        nodes[i].closest('.mb-3');

      if (!field && shell) {
        var fields = shell.querySelectorAll('textarea, [contenteditable="true"]');
        if (fields.length === 1) {
          field = fields[0];
        } else {
          for (var j = 0; j < fields.length; j++) {
            if (isResumoField(fields[j])) {
              field = fields[j];
              break;
            }
          }
        }
      }

      if (!field) {
        var sib = nodes[i].nextElementSibling;
        var guard = 0;
        while (sib && !field && guard < 5) {
          field = pickBestEditable(sib);
          sib = sib.nextElementSibling;
          guard++;
        }
      }

      if (!field || isOurUi(field)) continue;
      if (attrsLookLikeComments(field)) continue;
      if (labelLooksLikeComments(primaryLabel(field)) && !labelLooksLikeResumo(primaryLabel(field))) {
        continue;
      }

      // exige vínculo real com Resumo
      if (!isResumoField(field) && !(shell && shell.querySelectorAll('textarea').length === 1)) {
        continue;
      }

      candidates.push({ field: field, score: scoreField(field) + 80 });
    }

    candidates.sort(function (a, b) {
      return b.score - a.score;
    });
    return candidates.length ? candidates[0].field : null;
  }

  function findTargetField() {
    var byLabel = findByResumoLabel();
    if (byLabel && isResumoField(byLabel)) {
      cachedField = byLabel;
      return { field: byLabel, source: 'label' };
    }

    var configured = resolveConfigured();
    if (configured) {
      cachedField = configured;
      return { field: configured, source: 'config' };
    }

    if (stillValid(cachedField) && isResumoField(cachedField)) {
      return { field: unwrapEditable(cachedField) || cachedField, source: 'cache' };
    }

    var best = null;
    var bestScore = -1;
    var all = document.querySelectorAll('textarea, [contenteditable="true"]');
    for (var k = 0; k < all.length; k++) {
      if (isOurUi(all[k])) continue;
      if (!isResumoField(all[k])) continue;
      var sc = scoreField(all[k]);
      if (sc > bestScore) {
        bestScore = sc;
        best = all[k];
      }
    }

    if (best && bestScore >= 100) {
      cachedField = best;
      return { field: best, source: 'auto' };
    }

    cachedField = null;
    return { field: null, source: 'none' };
  }

  function getFieldText(field) {
    if (!field) return '';
    if (field.isContentEditable) return field.innerText || field.textContent || '';
    return field.value || '';
  }

  function pageWindow() {
    try {
      return typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;
    } catch (e) {
      return window;
    }
  }

  function tryEditorApis(field, next) {
    var w = pageWindow();
    try {
      if (w.tinymce && w.tinymce.editors) {
        for (var i = 0; i < w.tinymce.editors.length; i++) {
          var ed = w.tinymce.editors[i];
          if (!ed) continue;
          var target = ed.getElement && ed.getElement();
          if (target === field || (ed.id && field.id && ed.id === field.id)) {
            ed.setContent(String(next).replace(/\n/g, '<br>'));
            ed.fire('change');
            return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  function fireInputEvents(field, text, withBlur) {
    try {
      field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      field.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    } catch (e) {
      field.dispatchEvent(new Event('focus', { bubbles: true }));
    }
    try {
      field.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (e2) {
      field.dispatchEvent(new Event('click', { bubbles: true }));
    }
    var data = text == null ? null : String(text);
    try {
      field.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          composed: true,
          inputType: 'insertFromPaste',
          data: data
        })
      );
    } catch (e3) {
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    field.dispatchEvent(new Event('change', { bubbles: true }));
    if (withBlur) {
      try {
        field.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      } catch (e4) {
        field.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    }
  }

  function writeNativeValue(field, next) {
    if (field.isContentEditable) {
      field.focus();
      while (field.firstChild) field.removeChild(field.firstChild);
      field.appendChild(document.createTextNode(next));
      return;
    }
    field.focus();
    field.removeAttribute('readonly');
    field.readOnly = false;
    var proto =
      field.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try {
      if (field._valueTracker && field._valueTracker.setValue) field._valueTracker.setValue('');
    } catch (e) {}
    if (desc && desc.set) {
      desc.set.call(field, '');
      desc.set.call(field, next);
    } else {
      field.value = next;
    }
    try {
      field.defaultValue = next;
    } catch (e2) {}
  }

  function writeByExecCommand(field, next) {
    try {
      field.focus();
      if (typeof field.setSelectionRange === 'function') {
        field.setSelectionRange(0, (field.value || '').length);
      } else if (typeof field.select === 'function') {
        field.select();
      } else if (field.isContentEditable) {
        document.execCommand('selectAll', false, null);
      }
      return !!document.execCommand('insertText', false, next);
    } catch (e) {
      return false;
    }
  }

  function looksFilled(field, next) {
    var got = getFieldText(field).replace(/\r/g, '');
    var want = String(next).replace(/\r/g, '');
    if (!want) return true;
    if (got === want) return true;
    var sample = want.slice(0, Math.min(40, want.length));
    return sample.length > 0 && got.indexOf(sample) >= 0;
  }

  function setFieldValue(field, text, mode) {
    field = unwrapEditable(field) || field;
    if (!field) return false;
    var current = getFieldText(field);
    var next = text;
    if (mode === 'append') next = current ? current.replace(/\s*$/, '') + '\n\n' + text : text;
    if (mode === 'prepend') next = current ? text + '\n\n' + current.replace(/^\s*/, '') : text;

    if (tryEditorApis(field, next) && looksFilled(field, next)) return true;
    if (writeByExecCommand(field, next) && looksFilled(field, next)) {
      fireInputEvents(field, next, false);
      return true;
    }
    writeNativeValue(field, next);
    fireInputEvents(field, next, false);
    if (looksFilled(field, next)) return true;
    writeNativeValue(field, next);
    fireInputEvents(field, next, true);
    return looksFilled(field, next);
  }

  function applyVars(body) {
    var now = new Date();
    function pad(n) {
      return String(n).padStart(2, '0');
    }
    var data = pad(now.getDate()) + '/' + pad(now.getMonth() + 1) + '/' + now.getFullYear();
    var hora = pad(now.getHours()) + ':' + pad(now.getMinutes());
    var map = {
      data: data,
      hora: hora,
      datahora: data + ' ' + hora,
      solicitante: '',
      canal: '',
      status: 'Em andamento'
    };
    return String(body).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function (_, key) {
      var k = key.toLowerCase();
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : '{{' + key + '}}';
    });
  }

  function toast(msg) {
    var el = document.getElementById('cap-resumo-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cap-resumo-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-show');
    }, 2200);
  }

  function showPickBanner(on) {
    var el = document.getElementById(CFG.bannerId);
    if (!el) {
      el = document.createElement('div');
      el.id = CFG.bannerId;
      el.textContent = 'Clique dentro da caixa Resumo do Atendimento. Esc cancela.';
      document.body.appendChild(el);
    }
    el.classList.toggle('is-show', !!on);
  }

  function categories() {
    return ['Todos'].concat(folders.slice());
  }

  function filtered() {
    var q = state.query.trim().toLowerCase();
    var list = templates.filter(function (t) {
      if (state.category !== 'Todos' && (t.category || 'Geral') !== state.category) return false;
      if (!q) return true;
      return (t.title + ' ' + t.category + ' ' + (t.tags || []).join(' ') + ' ' + t.body)
        .toLowerCase()
        .indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return list;
  }

  function refreshHint() {
    var found = findTargetField();
    if (found.field) {
      var lab = primaryLabel(found.field) || 'Resumo do Atendimento';
      state.fieldHint = lab.slice(0, 48);
    } else if (settings.targetSelector) {
      state.fieldHint = 'Caixa salva não encontrada';
    } else {
      state.fieldHint = 'Caixa não definida';
    }
    return found;
  }

  function injectStyles() {
    GM_addStyle(
      '#' +
        CFG.fabId +
        ',#' +
        CFG.panelId +
        ',#' +
        CFG.bannerId +
        ',#' +
        CFG.suggestId +
        ',#' +
        CFG.noticesHostId +
        ',#cap-resumo-toast{' +
        'box-sizing:border-box;' +
        'font-family:"Segoe UI",Tahoma,"Helvetica Neue",Arial,sans-serif;' +
        '-webkit-font-smoothing:antialiased;}' +
        '#' +
        CFG.fabId +
        '{' +
        'position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;' +
        'border:0;border-radius:18px;cursor:pointer;color:#fff;' +
        'background:linear-gradient(160deg,#3d7eb3 0%,#2f6b9a 55%,#255a84 100%);' +
        'box-shadow:0 10px 28px rgba(31,74,110,.38),0 2px 6px rgba(15,23,42,.12);' +
        'display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease,filter .15s ease;}' +
        '#' +
        CFG.fabId +
        ':hover{filter:brightness(1.05);transform:translateY(-1px);' +
        'box-shadow:0 14px 32px rgba(31,74,110,.42),0 3px 8px rgba(15,23,42,.14);}' +
        '#' +
        CFG.fabId +
        ':active{transform:translateY(0);}' +
        '#' +
        CFG.fabId +
        ' svg{width:22px;height:22px;}' +
        '#' +
        CFG.panelId +
        '{' +
        'position:fixed;right:20px;bottom:90px;width:min(400px,calc(100vw - 24px));' +
        'max-height:min(720px,calc(100vh - 110px));z-index:2147483001;display:none;flex-direction:column;' +
        'overflow:hidden;border-radius:14px;border:1px solid #d5dee8;background:#fff;color:#1f2937;' +
        'box-shadow:0 18px 48px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.06);}' +
        '#' +
        CFG.panelId +
        '.is-open{display:flex;}' +
        '#' +
        CFG.panelId +
        '.is-min .capr-body,#' +
        CFG.panelId +
        '.is-min .capr-footer{display:none !important;}' +
        '#' +
        CFG.panelId +
        '.is-dock{right:0;bottom:0;top:0;width:min(400px,100vw);max-height:none;border-radius:0;' +
        'border:0;border-left:1px solid #b8c4d1;}' +
        '#' +
        CFG.panelId +
        ' .capr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:14px 14px 12px;background:linear-gradient(160deg,#3d7eb3,#2f6b9a);color:#fff;}' +
        '#' +
        CFG.panelId +
        ' .capr-brand{display:flex;flex-direction:column;gap:1px;min-width:0;}' +
        '#' +
        CFG.panelId +
        ' .capr-brand-name{font-size:14px;font-weight:700;letter-spacing:.01em;}' +
        '#' +
        CFG.panelId +
        ' .capr-brand-sub{font-size:11px;opacity:.85;}' +
        '#' +
        CFG.panelId +
        ' .capr-head-actions{display:flex;gap:4px;align-items:center;flex:0 0 auto;}' +
        '#' +
        CFG.updateBarId +
        '{display:none;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:8px 10px;background:#fff8e6;border-bottom:1px solid #f0d9a0;font-size:12px;color:#7a5b00;}' +
        '#' +
        CFG.updateBarId +
        ' .capr-upd-msg{flex:1;min-width:0;line-height:1.35;}' +
        '#' +
        CFG.updateBarId +
        ' .capr-upd-actions{display:flex;gap:6px;flex:0 0 auto;}' +
        '#' +
        CFG.updateBarId +
        ' .capr-btn.update{background:#c47a00;border-color:#a86600;color:#fff;padding:5px 9px;}' +
        '#' +
        CFG.updateBarId +
        ' .capr-btn.update:hover{background:#a86600;}' +
        '#' +
        CFG.updateFloatId +
        '{position:fixed;top:14px;left:50%;transform:translateX(-50%) translateY(-8px);z-index:2147483010;' +
        'width:min(520px,calc(100vw - 24px));opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;}' +
        '#' +
        CFG.updateFloatId +
        '.is-show{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0);}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-float-inner{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
        'padding:12px 14px;border-radius:4px;border:1px solid #c9a227;background:#fffdf5;' +
        'box-shadow:0 10px 28px rgba(33,37,41,.18);font-family:"Segoe UI",Tahoma,Arial,sans-serif;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-float-title{font-size:13px;font-weight:700;color:#1f3b57;margin-bottom:2px;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-float-msg{font-size:12px;color:#7a5b00;line-height:1.35;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-float-actions{display:flex;gap:6px;flex:0 0 auto;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-btn{border:1px solid transparent;border-radius:8px;padding:8px 11px;font-size:12.5px;' +
        'font-weight:600;cursor:pointer;line-height:1.2;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-btn.update{background:#2f6b9a;border-color:#2a5f86;color:#fff;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-btn.update:hover{background:#275a82;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-btn.ghost{background:#fff;border-color:#c5ced8;color:#495057;}' +
        '#' +
        CFG.updateFloatId +
        ' .capr-btn.ghost:hover{background:#eef2f6;}' +
        '@media (max-width:640px){#' +
        CFG.updateFloatId +
        ' .capr-float-inner{flex-direction:column;align-items:stretch;}#' +
        CFG.updateFloatId +
        ' .capr-float-actions{width:100%;}#' +
        CFG.updateFloatId +
        ' .capr-float-actions .capr-btn{flex:1;}}' +
        '#' +
        CFG.panelId +
        ' .capr-ico{width:28px;height:28px;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.08);' +
        'border-radius:8px;color:#fff;cursor:pointer;font-size:13px;line-height:1;}' +
        '#' +
        CFG.panelId +
        ' .capr-ico:hover{background:rgba(255,255,255,.12);}' +
        '#' +
        CFG.panelId +
        ' .capr-body{display:flex;flex-direction:column;gap:10px;padding:12px;overflow:hidden;flex:1;min-height:0;' +
        'background:#f5f7fa;}' +
        '#' +
        CFG.panelId +
        ' .capr-toolbar{display:grid;grid-template-columns:1fr 1fr;gap:6px;}' +
        '#' +
        CFG.panelId +
        ' .capr-btn{border:1px solid transparent;border-radius:3px;padding:7px 10px;font-size:12.5px;' +
        'font-weight:600;cursor:pointer;line-height:1.2;}' +
        '#' +
        CFG.panelId +
        ' .capr-btn.primary{background:#2f6b9a;border-color:#2a5f86;color:#fff;}' +
        '#' +
        CFG.panelId +
        ' .capr-btn.primary:hover{background:#275a82;}' +
        '#' +
        CFG.panelId +
        ' .capr-btn.secondary{background:#fff;border-color:#c5ced8;color:#374151;}' +
        '#' +
        CFG.panelId +
        ' .capr-btn.secondary:hover{background:#eef2f6;}' +
        '#' +
        CFG.panelId +
        ' .capr-btn.danger{background:#c82333;border-color:#bd2130;color:#fff;}' +
        '#' +
        CFG.panelId +
        ' .capr-btn.ghost{background:#fff;border-color:#c5ced8;color:#495057;}' +
        '#' +
        CFG.panelId +
        ' .capr-status{display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:8px 10px;border:1px solid #d5dde6;border-radius:3px;background:#fff;font-size:12px;}' +
        '#' +
        CFG.panelId +
        ' .capr-status-label{color:#6c757d;}' +
        '#' +
        CFG.panelId +
        ' .capr-hint-ok{color:#1e7e34;font-weight:600;}' +
        '#' +
        CFG.panelId +
        ' .capr-hint-warn{color:#9a6700;font-weight:600;}' +
        '#' +
        CFG.panelId +
        ' .capr-filters{display:grid;grid-template-columns:1fr;gap:6px;}' +
        '#' +
        CFG.panelId +
        ' .capr-folders-wrap{display:flex;flex-direction:column;gap:6px;}' +
        '#' +
        CFG.panelId +
        ' .capr-folders{display:flex;gap:6px;overflow:auto;padding:2px 0 4px;scrollbar-width:thin;}' +
        '#' +
        CFG.panelId +
        ' .capr-folder{flex:0 0 auto;border:1px solid #c5ced8;background:#fff;color:#374151;' +
        'border-radius:3px;padding:5px 9px;font-size:12px;font-weight:600;cursor:pointer;line-height:1.2;}' +
        '#' +
        CFG.panelId +
        ' .capr-folder:hover{background:#eef2f6;}' +
        '#' +
        CFG.panelId +
        ' .capr-folder.is-active{background:#2f6b9a;border-color:#2a5f86;color:#fff;}' +
        '#' +
        CFG.panelId +
        ' .capr-folder-count{opacity:.75;font-weight:500;}' +
        '#' +
        CFG.panelId +
        ' .capr-folder-tools{display:flex;gap:6px;}' +
        '#' +
        CFG.panelId +
        ' .capr-folder-tools .capr-btn{flex:1;padding:6px 8px;font-size:12px;}' +
        '#' +
        CFG.panelId +
        ' .capr-search,#' +
        CFG.panelId +
        ' .capr-select,#' +
        CFG.panelId +
        ' .capr-input,#' +
        CFG.panelId +
        ' .capr-textarea{' +
        'width:100%;border:1px solid #ced4da;border-radius:3px;padding:7px 9px;font-size:13px;outline:none;' +
        'box-sizing:border-box;color:#212529;background:#fff;}' +
        '#' +
        CFG.panelId +
        ' .capr-search:focus,#' +
        CFG.panelId +
        ' .capr-select:focus,#' +
        CFG.panelId +
        ' .capr-input:focus,#' +
        CFG.panelId +
        ' .capr-textarea:focus{' +
        'border-color:#80abd0;box-shadow:0 0 0 .15rem rgba(47,107,154,.18);}' +
        '#' +
        CFG.panelId +
        ' .capr-meta{font-size:12px;color:#6c757d;}' +
        '#' +
        CFG.panelId +
        ' .capr-list{overflow:auto;display:flex;flex-direction:column;gap:8px;flex:1;min-height:120px;' +
        'border:0;border-radius:0;background:transparent;padding:2px;}' +
        '#' +
        CFG.panelId +
        ' .capr-row{border:1px solid #e5edf5;border-radius:10px;padding:11px 12px;background:#fff;' +
        'box-shadow:0 1px 2px rgba(15,23,42,.04);}' +
        '#' +
        CFG.panelId +
        ' .capr-row:last-child{border-bottom:1px solid #e5edf5;}' +
        '#' +
        CFG.panelId +
        ' .capr-row:hover{background:#f8fbff;border-color:#c9daf0;}' +
        '#' +
        CFG.panelId +
        ' .capr-row-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px;}' +
        '#' +
        CFG.panelId +
        ' .capr-row-title{font-size:13px;font-weight:650;color:#1f3b57;}' +
        '#' +
        CFG.panelId +
        ' .capr-row-cat{font-size:11px;color:#6c757d;white-space:nowrap;}' +
        '#' +
        CFG.panelId +
        ' .capr-preview{font-size:12px;color:#495057;white-space:pre-wrap;line-height:1.35;max-height:52px;overflow:hidden;margin-bottom:8px;}' +
        '#' +
        CFG.panelId +
        ' .capr-row-actions{display:flex;gap:6px;}' +
        '#' +
        CFG.panelId +
        ' .capr-row-actions .capr-btn{flex:1;text-align:center;padding:6px 8px;}' +
        '#' +
        CFG.panelId +
        ' .capr-empty{padding:28px 14px;text-align:center;color:#6c757d;font-size:13px;}' +
        '#' +
        CFG.panelId +
        ' .capr-confirm{margin-top:8px;padding:8px;border-radius:3px;background:#fff5f5;border:1px solid #f1c0c0;font-size:12px;color:#842029;}' +
        '#' +
        CFG.panelId +
        ' .capr-footer{border-top:1px solid #e5edf5;padding:12px;background:#fff;}' +
        '#' +
        CFG.panelId +
        ' .capr-footer-btn{width:100%;border:0;background:#2f6b9a;color:#fff;border-radius:8px;' +
        'font-size:13px;font-weight:650;cursor:pointer;padding:10px 12px;}' +
        '#' +
        CFG.panelId +
        ' .capr-footer-btn:hover{background:#275a82;}' +
        '#' +
        CFG.panelId +
        ' .capr-textarea{min-height:150px;resize:vertical;line-height:1.4;font-family:Consolas,"Courier New",monospace;}' +
        '#' +
        CFG.panelId +
        ' .capr-footer-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
        '#' +
        CFG.modalId +
        '{position:fixed;inset:0;z-index:2147483020;display:none;align-items:center;justify-content:center;' +
        'padding:18px;background:rgba(18,28,40,.45);backdrop-filter:blur(2px);}' +
        '#' +
        CFG.modalId +
        '.is-open{display:flex;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal{width:min(560px,100%);max-height:min(86vh,720px);display:flex;flex-direction:column;border-radius:14px;overflow:hidden;' +
        'background:#fff;border:1px solid #b8c4d1;border-radius:6px;overflow:hidden;' +
        'box-shadow:0 18px 50px rgba(15,23,42,.28);font-family:"Segoe UI",Tahoma,Arial,sans-serif;color:#212529;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;' +
        'padding:14px 16px;background:linear-gradient(180deg,#3474a4 0%,#2f6b9a 100%);color:#fff;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-title{font-size:15px;font-weight:700;letter-spacing:.01em;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-sub{font-size:12px;opacity:.88;margin-top:2px;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-close{width:30px;height:30px;border:1px solid rgba(255,255,255,.35);background:transparent;' +
        'color:#fff;border-radius:3px;cursor:pointer;font-size:18px;line-height:1;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-close:hover{background:rgba(255,255,255,.12);}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-body{display:grid;gap:10px;padding:16px;overflow:auto;background:#f5f7fa;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-body label{font-size:12px;color:#495057;font-weight:650;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-body .capr-input,#' +
        CFG.modalId +
        ' .capr-modal-body .capr-select,#' +
        CFG.modalId +
        ' .capr-modal-body .capr-textarea{width:100%;border:1px solid #ced4da;border-radius:3px;padding:8px 10px;' +
        'font-size:13px;outline:none;box-sizing:border-box;color:#212529;background:#fff;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-body .capr-textarea{min-height:190px;resize:vertical;line-height:1.45;' +
        'font-family:Consolas,"Courier New",monospace;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-body .capr-input:focus,#' +
        CFG.modalId +
        ' .capr-modal-body .capr-select:focus,#' +
        CFG.modalId +
        ' .capr-modal-body .capr-textarea:focus{border-color:#80abd0;box-shadow:0 0 0 .15rem rgba(47,107,154,.18);}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-hint{font-size:12px;color:#6c757d;line-height:1.4;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-folder-row{display:grid;grid-template-columns:1fr auto;gap:6px;}' +
        '#' +
        CFG.modalId +
        ' .capr-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;background:#fff;' +
        'border-top:1px solid #d5dde6;}' +
        '#' +
        CFG.modalId +
        ' .capr-btn{border:1px solid transparent;border-radius:3px;padding:8px 12px;font-size:13px;' +
        'font-weight:600;cursor:pointer;line-height:1.2;}' +
        '#' +
        CFG.modalId +
        ' .capr-btn.primary{background:#2f6b9a;border-color:#2a5f86;color:#fff;}' +
        '#' +
        CFG.modalId +
        ' .capr-btn.primary:hover{background:#275a82;}' +
        '#' +
        CFG.modalId +
        ' .capr-btn.ghost{background:#fff;border-color:#c5ced8;color:#495057;}' +
        '#' +
        CFG.modalId +
        ' .capr-btn.ghost:hover{background:#eef2f6;}' +
        '#' +
        CFG.folderModalId +
        '{position:fixed;inset:0;z-index:2147483030;display:none;align-items:center;justify-content:center;' +
        'padding:18px;background:rgba(18,28,40,.5);backdrop-filter:blur(2px);}' +
        '#' +
        CFG.folderModalId +
        '.is-open{display:flex;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal{width:min(420px,100%);display:flex;flex-direction:column;overflow:hidden;' +
        'background:#fff;border:1px solid #b8c4d1;border-radius:14px;' +
        'box-shadow:0 18px 50px rgba(15,23,42,.32);font-family:"Segoe UI",Tahoma,Arial,sans-serif;color:#212529;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;' +
        'padding:14px 16px;background:linear-gradient(180deg,#3474a4 0%,#2f6b9a 100%);color:#fff;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-title{font-size:15px;font-weight:700;letter-spacing:.01em;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-sub{font-size:12px;opacity:.88;margin-top:2px;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-close{width:30px;height:30px;border:1px solid rgba(255,255,255,.35);background:transparent;' +
        'color:#fff;border-radius:3px;cursor:pointer;font-size:18px;line-height:1;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-close:hover{background:rgba(255,255,255,.12);}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-body{display:grid;gap:10px;padding:16px;background:#f5f7fa;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-body label{font-size:12px;color:#495057;font-weight:650;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-body .capr-input{width:100%;border:1px solid #ced4da;border-radius:3px;padding:8px 10px;' +
        'font-size:13px;outline:none;box-sizing:border-box;color:#212529;background:#fff;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-body .capr-input:focus{border-color:#80abd0;box-shadow:0 0 0 .15rem rgba(47,107,154,.18);}' +
        '#' +
        CFG.folderModalId +
        ' .capr-folder-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;background:#fff;' +
        'border-top:1px solid #d5dde6;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-btn{border:1px solid transparent;border-radius:3px;padding:8px 12px;font-size:13px;' +
        'font-weight:600;cursor:pointer;line-height:1.2;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-btn.primary{background:#2f6b9a;border-color:#2a5f86;color:#fff;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-btn.primary:hover{background:#275a82;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-btn.ghost{background:#fff;border-color:#c5ced8;color:#495057;}' +
        '#' +
        CFG.folderModalId +
        ' .capr-btn.ghost:hover{background:#eef2f6;}' +
        '#' +
        CFG.importModalId +
        '{position:fixed;inset:0;z-index:2147483035;display:none;align-items:center;justify-content:center;' +
        'padding:18px;background:rgba(18,28,40,.5);backdrop-filter:blur(2px);}' +
        '#' +
        CFG.importModalId +
        '.is-open{display:flex;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal{width:min(480px,100%);display:flex;flex-direction:column;overflow:hidden;' +
        'background:#fff;border:1px solid #b8c4d1;border-radius:14px;' +
        'box-shadow:0 18px 50px rgba(15,23,42,.32);font-family:"Segoe UI",Tahoma,Arial,sans-serif;color:#212529;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;' +
        'padding:14px 16px;background:linear-gradient(180deg,#3474a4 0%,#2f6b9a 100%);color:#fff;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal-title{font-size:15px;font-weight:700;letter-spacing:.01em;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal-sub{font-size:12px;opacity:.88;margin-top:2px;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal-close{width:30px;height:30px;border:1px solid rgba(255,255,255,.35);background:transparent;' +
        'color:#fff;border-radius:3px;cursor:pointer;font-size:18px;line-height:1;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal-close:hover{background:rgba(255,255,255,.12);}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal-body{display:grid;gap:12px;padding:16px;background:#f5f7fa;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-drop{border:1.5px dashed #b7c5d4;border-radius:10px;background:#fff;padding:22px 16px;' +
        'text-align:center;cursor:pointer;transition:.15s ease;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-drop:hover,#' +
        CFG.importModalId +
        ' .capr-import-drop.is-drag{border-color:#2f6b9a;background:#f3f8fc;box-shadow:0 0 0 3px rgba(47,107,154,.12);}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-drop-icon{width:42px;height:42px;margin:0 auto 10px;border-radius:10px;display:flex;' +
        'align-items:center;justify-content:center;background:#e8f1f8;color:#2f6b9a;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-drop-title{font-size:14px;font-weight:700;color:#1f3b57;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-drop-sub{font-size:12px;color:#6c757d;margin-top:4px;line-height:1.4;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-file{display:none;align-items:center;gap:10px;padding:12px;border:1px solid #d5dde6;' +
        'border-radius:10px;background:#fff;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-file.is-show{display:flex;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-file-ico{width:36px;height:36px;border-radius:8px;background:#eef5fb;color:#2f6b9a;' +
        'display:flex;align-items:center;justify-content:center;flex:0 0 auto;font-weight:700;font-size:11px;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-file-meta{min-width:0;flex:1;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-file-name{font-size:13px;font-weight:650;color:#1f2937;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-file-info{font-size:12px;color:#6b7280;margin-top:2px;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-clear{border:0;background:transparent;color:#9ca3af;cursor:pointer;font-size:18px;line-height:1;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-clear:hover{color:#b91c1c;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modes{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-mode{border:1px solid #d5dde6;border-radius:10px;background:#fff;padding:12px;cursor:pointer;' +
        'text-align:left;transition:.15s ease;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-mode:hover{border-color:#93b7d4;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-mode.is-active{border-color:#2f6b9a;background:#f3f8fc;box-shadow:0 0 0 2px rgba(47,107,154,.14);}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-mode-title{font-size:13px;font-weight:700;color:#1f3b57;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-mode-desc{font-size:11px;color:#6b7280;margin-top:4px;line-height:1.4;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-warn{display:none;font-size:12px;color:#9a3412;background:#fff7ed;border:1px solid #fdba74;' +
        'border-radius:8px;padding:8px 10px;line-height:1.4;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-warn.is-show{display:block;}' +
        '#' +
        CFG.importModalId +
        ' .capr-import-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;background:#fff;' +
        'border-top:1px solid #d5dde6;}' +
        '#' +
        CFG.importModalId +
        ' .capr-btn{border:1px solid transparent;border-radius:3px;padding:8px 12px;font-size:13px;' +
        'font-weight:600;cursor:pointer;line-height:1.2;}' +
        '#' +
        CFG.importModalId +
        ' .capr-btn.primary{background:#2f6b9a;border-color:#2a5f86;color:#fff;}' +
        '#' +
        CFG.importModalId +
        ' .capr-btn.primary:hover{background:#275a82;}' +
        '#' +
        CFG.importModalId +
        ' .capr-btn.primary:disabled{opacity:.55;cursor:not-allowed;}' +
        '#' +
        CFG.importModalId +
        ' .capr-btn.ghost{background:#fff;border-color:#c5ced8;color:#495057;}' +
        '#' +
        CFG.importModalId +
        ' .capr-btn.ghost:hover{background:#eef2f6;}' +
        '#' +
        CFG.bannerId +
        '{' +
        'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483003;' +
        'background:#1f2a37;color:#fff;border-radius:3px;padding:10px 14px;font-size:13px;' +
        'box-shadow:0 6px 18px rgba(0,0,0,.2);display:none;max-width:90vw;}' +
        '#' +
        CFG.bannerId +
        '.is-show{display:block;}' +
        '#cap-resumo-toast{position:fixed;left:20px;bottom:20px;z-index:2147483002;max-width:min(340px,calc(100vw - 40px));' +
        'background:#fff;color:#1f2937;border:1px solid #e5edf5;border-radius:12px;padding:12px 14px;font-size:13px;' +
        'box-shadow:0 12px 28px rgba(15,23,42,.16);opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s ease;}' +
        '#cap-resumo-toast.is-show{opacity:1;transform:translateY(0);}' +
        '#' +
        CFG.noticesHostId +
        '{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483008;' +
        'width:min(560px,calc(100vw - 24px));display:none;flex-direction:column;gap:8px;' +
        'font-family:"Segoe UI",Tahoma,Arial,sans-serif;pointer-events:none;}' +
        '#' +
        CFG.noticesHostId +
        '.is-show{display:flex;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-card{pointer-events:auto;border-radius:6px;padding:12px 14px;border:1px solid #c5ced8;' +
        'background:#fff;box-shadow:0 10px 28px rgba(33,37,41,.16);}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.02em;' +
        'text-transform:uppercase;padding:3px 8px;border-radius:3px;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-close{border:0;background:transparent;color:#6c757d;font-size:18px;line-height:1;cursor:pointer;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-title{font-size:14px;font-weight:700;color:#1f3b57;margin-bottom:4px;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-msg{font-size:13px;line-height:1.45;color:#374151;white-space:pre-wrap;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-aviso{border-color:#8eb6d8;background:#f3f8fc;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-aviso .capn-badge{background:#2f6b9a;color:#fff;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-atencao{border-color:#e2b65c;background:#fff8e8;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-atencao .capn-badge{background:#c47a00;color:#fff;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-atencao .capn-title{color:#7a5b00;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-novidade{border-color:#8fcaa0;background:#f2faf4;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-novidade .capn-badge{background:#1e7e34;color:#fff;}' +
        '#' +
        CFG.noticesHostId +
        ' .capn-novidade .capn-title{color:#145523;}' +
        '@media (max-width:960px){#' +
        CFG.noticesHostId +
        '{top:96px;left:50%;transform:translateX(-50%);width:min(560px,calc(100vw - 24px));}}' +
        '#' +
        CFG.dupModalId +
        '{position:fixed;inset:0;z-index:2147483710;display:none;align-items:center;justify-content:center;' +
        'padding:16px;background:rgba(15,23,42,.48);font-family:"Segoe UI",Tahoma,Arial,sans-serif;}' +
        '#' +
        CFG.dupModalId +
        '.is-open{display:flex;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-modal{width:min(420px,100%);background:#fff;border-radius:8px;overflow:hidden;' +
        'box-shadow:0 20px 50px rgba(15,23,42,.28);border:1px solid #d7e0ea;padding:28px 24px 20px;text-align:center;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-icon{display:flex;justify-content:center;margin-bottom:12px;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-title{font-size:22px;font-weight:700;color:#595959;margin:0 0 10px;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-msg{font-size:15px;line-height:1.45;color:#545454;margin:0 0 16px;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-card{display:grid;gap:8px;margin:0 0 18px;text-align:left;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-row{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
        'padding:10px 12px;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:6px;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-row span{font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.03em;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-row strong{font-size:14px;color:#1f2937;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-link{font-size:14px;font-weight:700;color:#2f6b9a;text-decoration:none;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-link:hover{text-decoration:underline;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-dup-foot{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-btn{border-radius:4px;border:1px solid #c5ced8;padding:8px 16px;font-size:14px;cursor:pointer;' +
        'text-decoration:none;display:inline-flex;align-items:center;justify-content:center;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-btn.ghost{background:#fff;color:#374151;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-btn.ghost:hover{background:#eef2f6;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-btn.primary{background:#2f6b9a;border-color:#2a5f86;color:#fff;}' +
        '#' +
        CFG.dupModalId +
        ' .capr-btn.primary:hover{background:#275a82;}' +
        'html.capr-dup-suppress-swal .swal2-container,' +
        'body.capr-dup-suppress-swal .swal2-container,' +
        'html.capr-dup-suppress-swal .sweet-alert,' +
        'body.capr-dup-suppress-swal .sweet-alert{' +
        '/* suppress global removido — escondia o Continuar de todos os fluxos */}' +
        '.capr-enviar-blocked,' +
        '.capr-enviar-blocked:hover,' +
        '.capr-enviar-blocked:focus,' +
        '.capr-enviar-blocked:active{' +
        'opacity:.58 !important;filter:grayscale(.75) !important;' +
        'background:#c8c8c8 !important;border-color:#b3b3b3 !important;color:#666 !important;' +
        'cursor:not-allowed !important;box-shadow:none !important;}' +
        '.capr-pick-hover{outline:2px solid #2f6b9a !important;outline-offset:2px !important;cursor:crosshair !important;}' +
        '#' +
        CFG.suggestId +
        '{' +
        'margin-top:6px;border:1px solid #b8c4d1;border-radius:3px;background:#fff;' +
        'box-shadow:0 2px 10px rgba(33,37,41,.12);overflow:hidden;font-family:"Segoe UI",Tahoma,Arial,sans-serif;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-head{display:flex;align-items:center;justify-content:space-between;' +
        'padding:6px 10px;border-bottom:1px solid #d5dde6;background:#eef3f8;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-title{font-size:12px;font-weight:650;color:#2f6b9a;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-close{border:0;background:transparent;color:#6c757d;cursor:pointer;font-size:13px;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-list{max-height:190px;overflow:auto;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-item{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;' +
        'padding:8px 10px;border-bottom:1px solid #eef2f6;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-item:last-child{border-bottom:0;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-item:hover{background:#f7fafc;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-name{font-size:13px;font-weight:650;color:#1f3b57;margin-bottom:2px;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-meta{font-size:11px;color:#6c757d;margin-bottom:2px;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-preview{font-size:12px;color:#495057;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:290px;}' +
        '#' +
        CFG.suggestId +
        ' .capr-sug-use{flex:0 0 auto;border:1px solid #2a5f86;border-radius:3px;background:#2f6b9a;color:#fff;' +
        'font-size:12px;font-weight:600;padding:5px 10px;cursor:pointer;}' +
        '@media (max-width:640px){#' +
        CFG.panelId +
        '{right:8px;left:8px;width:auto;bottom:66px;}#' +
        CFG.fabId +
        '{right:10px;bottom:10px;}}'
    );
  }

  function buildShell() {
    if (document.getElementById(CFG.panelId)) return;

    var fab = document.createElement('button');
    fab.id = CFG.fabId;
    fab.type = 'button';
    fab.title = 'Modelos de resumo (Alt+M)';
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M7 4.5h10A2.5 2.5 0 0 1 19.5 7v7A2.5 2.5 0 0 1 17 16.5h-4.1L9.2 19.4a.75.75 0 0 1-1.2-.6v-2.3H7A2.5 2.5 0 0 1 4.5 14V7A2.5 2.5 0 0 1 7 4.5Z" fill="rgba(255,255,255,.16)" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M8.5 9h7M8.5 12h4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
      '</svg>';
    fab.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });

    var panel = document.createElement('aside');
    panel.id = CFG.panelId;
    panel.innerHTML =
      '<div class="capr-head">' +
      '<div class="capr-brand">' +
      '<div class="capr-brand-name">CAP · Modelos de Resumo</div>' +
      '<div class="capr-brand-sub">v' +
      CFG.version +
      ' · Pré CAP</div>' +
      '</div>' +
      '<div class="capr-head-actions">' +
      '<button type="button" class="capr-ico" data-act="check-update" title="Verificar atualização">↻</button>' +
      '<button type="button" class="capr-ico" data-act="dock" title="Acoplar">☰</button>' +
      '<button type="button" class="capr-ico" data-act="minimize" title="Minimizar">–</button>' +
      '<button type="button" class="capr-ico" data-act="close" title="Fechar">×</button>' +
      '</div></div>' +
      '<div id="' +
      CFG.updateBarId +
      '">' +
      '<div class="capr-upd-msg" data-role="upd-msg">Versão do servidor diferente</div>' +
      '<div class="capr-upd-actions">' +
      '<button type="button" class="capr-btn update" data-act="do-update">Atualizar agora</button>' +
      '</div></div>' +
      '<div class="capr-body" data-view="list">' +
      '<div class="capr-toolbar">' +
      '<button type="button" class="capr-btn primary" data-act="pick">Definir caixa</button>' +
      '<button type="button" class="capr-btn secondary" data-act="detect">Detectar resumo</button>' +
      '</div>' +
      '<div class="capr-status">' +
      '<span class="capr-status-label">Campo alvo</span>' +
      '<span data-role="hint" class="capr-hint-warn">Caixa não definida</span>' +
      '</div>' +
      '<div class="capr-filters">' +
      '<input class="capr-search" type="search" placeholder="Pesquisar modelo..." data-role="search" />' +
      '</div>' +
      '<div class="capr-folders-wrap">' +
      '<div class="capr-folders" data-role="folders"></div>' +
      '<div class="capr-folder-tools">' +
      '<button type="button" class="capr-btn secondary" data-act="folder-new">+ Pasta</button>' +
      '<button type="button" class="capr-btn ghost" data-act="folder-rename">Renomear</button>' +
      '<button type="button" class="capr-btn ghost" data-act="folder-del">Excluir pasta</button>' +
      '</div></div>' +
      '<div class="capr-meta"><span data-role="count">0 modelos</span> · Alt+M</div>' +
      '<div class="capr-list" data-role="list"></div>' +
      '</div>' +
      '<div class="capr-footer" data-view="list">' +
      '<button type="button" class="capr-footer-btn" data-act="new">+ Novo modelo</button>' +
      '<div class="capr-footer-row" style="margin-top:8px">' +
      '<button type="button" class="capr-btn secondary" data-act="export" style="width:100%">Exportar</button>' +
      '<button type="button" class="capr-btn secondary" data-act="import" style="width:100%">Importar</button>' +
      '</div></div>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);
    ensureModal();
    ensureFolderModal();
    ensureImportModal();

    ui = {
      fab: fab,
      panel: panel,
      list: panel.querySelector('[data-role="list"]'),
      search: panel.querySelector('[data-role="search"]'),
      folders: panel.querySelector('[data-role="folders"]'),
      hint: panel.querySelector('[data-role="hint"]'),
      count: panel.querySelector('[data-role="count"]'),
      modal: document.getElementById(CFG.modalId),
      folderModal: document.getElementById(CFG.folderModalId),
      importModal: document.getElementById(CFG.importModalId)
    };

    ui.search.addEventListener('input', function () {
      state.query = ui.search.value;
      pendingDeleteId = null;
      renderList();
    });
    panel.addEventListener('click', onPanelClick);
  }

  function ensureModal() {
    if (document.getElementById(CFG.modalId)) return;
    var wrap = document.createElement('div');
    wrap.id = CFG.modalId;
    wrap.innerHTML =
      '<div class="capr-modal" role="dialog" aria-modal="true">' +
      '<div class="capr-modal-head">' +
      '<div>' +
      '<div class="capr-modal-title" data-role="modal-title">Novo modelo</div>' +
      '<div class="capr-modal-sub">Pré CAP · Atendimento</div>' +
      '</div>' +
      '<button type="button" class="capr-modal-close" data-act="cancel-edit" title="Fechar">×</button>' +
      '</div>' +
      '<div class="capr-modal-body">' +
      '<label for="capr-modal-title">Nome do modelo</label>' +
      '<input class="capr-input" id="capr-modal-title" data-f="title" placeholder="Nome do modelo" />' +
      '<label for="capr-modal-folder">Pasta</label>' +
      '<div class="capr-modal-folder-row">' +
      '<select class="capr-select" id="capr-modal-folder" data-f="category"></select>' +
      '<button type="button" class="capr-btn ghost" data-act="modal-folder-new">Nova</button>' +
      '</div>' +
      '<label for="capr-modal-body">Conteúdo do resumo</label>' +
      '<textarea class="capr-textarea" id="capr-modal-body" data-f="body" placeholder="Texto do resumo"></textarea>' +
      '</div>' +
      '<div class="capr-modal-foot">' +
      '<button type="button" class="capr-btn ghost" data-act="cancel-edit">Cancelar</button>' +
      '<button type="button" class="capr-btn primary" data-act="save-edit">Salvar modelo</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) closeModal();
      var btn = e.target.closest('[data-act]');
      if (!btn || !wrap.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      var act = btn.getAttribute('data-act');
      if (act === 'cancel-edit') return closeModal();
      if (act === 'save-edit') return saveEditor();
      if (act === 'modal-folder-new') return createFolderFromModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var importModal = document.getElementById(CFG.importModalId);
      if (importModal && importModal.classList.contains('is-open')) {
        e.preventDefault();
        e.stopPropagation();
        closeImportModal();
        return;
      }
      var folderModal = document.getElementById(CFG.folderModalId);
      if (folderModal && folderModal.classList.contains('is-open')) {
        e.preventDefault();
        e.stopPropagation();
        closeFolderModal();
        return;
      }
      if (wrap.classList.contains('is-open')) {
        e.preventDefault();
        closeModal();
      }
    });
  }

  function ensureFolderModal() {
    if (document.getElementById(CFG.folderModalId)) return;
    var wrap = document.createElement('div');
    wrap.id = CFG.folderModalId;
    wrap.innerHTML =
      '<div class="capr-folder-modal" role="dialog" aria-modal="true">' +
      '<div class="capr-folder-modal-head">' +
      '<div>' +
      '<div class="capr-folder-modal-title" data-role="folder-modal-title">Nova pasta</div>' +
      '<div class="capr-folder-modal-sub" data-role="folder-modal-sub">Organize seus modelos</div>' +
      '</div>' +
      '<button type="button" class="capr-folder-modal-close" data-act="folder-modal-cancel" title="Fechar">×</button>' +
      '</div>' +
      '<div class="capr-folder-modal-body">' +
      '<label for="capr-folder-modal-name">Nome da pasta</label>' +
      '<input class="capr-input" id="capr-folder-modal-name" data-f="folder-name" placeholder="Nome da pasta" autocomplete="off" />' +
      '</div>' +
      '<div class="capr-folder-modal-foot">' +
      '<button type="button" class="capr-btn ghost" data-act="folder-modal-cancel">Cancelar</button>' +
      '<button type="button" class="capr-btn primary" data-act="folder-modal-save">Salvar pasta</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) {
        e.preventDefault();
        e.stopPropagation();
        closeFolderModal();
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (!btn || !wrap.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      var act = btn.getAttribute('data-act');
      if (act === 'folder-modal-cancel') return closeFolderModal();
      if (act === 'folder-modal-save') return submitFolderModal();
    });
    var input = wrap.querySelector('[data-f="folder-name"]');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          submitFolderModal();
        }
      });
    }
  }

  function closeFolderModal() {
    var modal = document.getElementById(CFG.folderModalId);
    if (modal) modal.classList.remove('is-open');
    folderModalCtx = { mode: 'create', source: 'panel', oldName: '' };
  }

  function ensureImportModal() {
    if (document.getElementById(CFG.importModalId)) return;
    var wrap = document.createElement('div');
    wrap.id = CFG.importModalId;
    wrap.innerHTML =
      '<div class="capr-import-modal" role="dialog" aria-modal="true">' +
      '<div class="capr-import-modal-head">' +
      '<div>' +
      '<div class="capr-import-modal-title">Importar modelos</div>' +
      '<div class="capr-import-modal-sub">Traga modelos de um arquivo JSON</div>' +
      '</div>' +
      '<button type="button" class="capr-import-modal-close" data-act="import-cancel" title="Fechar">×</button>' +
      '</div>' +
      '<div class="capr-import-modal-body">' +
      '<div class="capr-import-drop" data-role="import-drop">' +
      '<div class="capr-import-drop-icon" aria-hidden="true">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none">' +
      '<path d="M12 16V4m0 0l4 4m-4-4L8 8M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg></div>' +
      '<div class="capr-import-drop-title">Arraste o arquivo JSON aqui</div>' +
      '<div class="capr-import-drop-sub">ou clique para escolher · exportado pelo CAP Resumo</div>' +
      '</div>' +
      '<input type="file" data-role="import-file-input" accept="application/json,.json,text/plain,.txt" hidden />' +
      '<div class="capr-import-file" data-role="import-file">' +
      '<div class="capr-import-file-ico">JSON</div>' +
      '<div class="capr-import-file-meta">' +
      '<div class="capr-import-file-name" data-role="import-file-name">arquivo.json</div>' +
      '<div class="capr-import-file-info" data-role="import-file-info">0 modelos</div>' +
      '</div>' +
      '<button type="button" class="capr-import-clear" data-act="import-clear" title="Remover arquivo">×</button>' +
      '</div>' +
      '<div class="capr-import-modes">' +
      '<button type="button" class="capr-import-mode is-active" data-act="import-mode" data-mode="merge">' +
      '<div class="capr-import-mode-title">Mesclar</div>' +
      '<div class="capr-import-mode-desc">Mantém os atuais e adiciona/atualiza os do arquivo</div>' +
      '</button>' +
      '<button type="button" class="capr-import-mode" data-act="import-mode" data-mode="replace">' +
      '<div class="capr-import-mode-title">Substituir</div>' +
      '<div class="capr-import-mode-desc">Apaga os modelos atuais e usa só os do arquivo</div>' +
      '</button>' +
      '</div>' +
      '<div class="capr-import-warn" data-role="import-warn">Atenção: substituir remove todos os modelos atuais deste navegador.</div>' +
      '</div>' +
      '<div class="capr-import-modal-foot">' +
      '<button type="button" class="capr-btn ghost" data-act="import-cancel">Cancelar</button>' +
      '<button type="button" class="capr-btn primary" data-act="import-confirm" disabled>Importar</button>' +
      '</div></div>';
    document.body.appendChild(wrap);

    var drop = wrap.querySelector('[data-role="import-drop"]');
    var fileInput = wrap.querySelector('[data-role="import-file-input"]');

    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) {
        closeImportModal();
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (!btn || !wrap.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      var act = btn.getAttribute('data-act');
      if (act === 'import-cancel') return closeImportModal();
      if (act === 'import-clear') return resetImportModalFile();
      if (act === 'import-mode') {
        importModalState.mode = btn.getAttribute('data-mode') === 'replace' ? 'replace' : 'merge';
        refreshImportModalUi();
        return;
      }
      if (act === 'import-confirm') return confirmImportModal();
    });

    drop.addEventListener('click', function () {
      fileInput.click();
    });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) readImportFile(file);
    });

    ['dragenter', 'dragover'].forEach(function (evName) {
      drop.addEventListener(evName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add('is-drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (evName) {
      drop.addEventListener(evName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove('is-drag');
      });
    });
    drop.addEventListener('drop', function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) readImportFile(file);
    });
  }

  function resetImportModalFile() {
    importModalState.fileName = '';
    importModalState.items = null;
    refreshImportModalUi();
  }

  function refreshImportModalUi() {
    var modal = document.getElementById(CFG.importModalId);
    if (!modal) return;
    var drop = modal.querySelector('[data-role="import-drop"]');
    var fileBox = modal.querySelector('[data-role="import-file"]');
    var nameEl = modal.querySelector('[data-role="import-file-name"]');
    var infoEl = modal.querySelector('[data-role="import-file-info"]');
    var warn = modal.querySelector('[data-role="import-warn"]');
    var confirmBtn = modal.querySelector('[data-act="import-confirm"]');
    var hasFile = !!(importModalState.items && importModalState.items.length);
    drop.style.display = hasFile ? 'none' : 'block';
    fileBox.classList.toggle('is-show', hasFile);
    if (hasFile) {
      nameEl.textContent = importModalState.fileName || 'arquivo.json';
      infoEl.textContent =
        importModalState.items.length +
        ' modelo' +
        (importModalState.items.length === 1 ? '' : 's') +
        ' · ' +
        templates.length +
        ' atual' +
        (templates.length === 1 ? '' : 'is') +
        ' neste navegador';
    }
    modal.querySelectorAll('[data-act="import-mode"]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-mode') === importModalState.mode);
    });
    warn.classList.toggle('is-show', importModalState.mode === 'replace' && hasFile);
    confirmBtn.disabled = !hasFile;
    confirmBtn.textContent = importModalState.mode === 'replace' ? 'Substituir modelos' : 'Mesclar modelos';
  }

  function openImportModal() {
    ensureImportModal();
    importModalState = { fileName: '', items: null, mode: templates.length ? 'merge' : 'replace' };
    refreshImportModalUi();
    var modal = document.getElementById(CFG.importModalId);
    modal.classList.add('is-open');
  }

  function closeImportModal() {
    var modal = document.getElementById(CFG.importModalId);
    if (modal) modal.classList.remove('is-open');
    importModalState = { fileName: '', items: null, mode: 'merge' };
  }

  function readImportFile(file) {
    if (!file) return;
    var name = String(file.name || 'arquivo.json');
    if (!/\.(json|txt)$/i.test(name) && file.type && file.type.indexOf('json') < 0 && file.type.indexOf('text') < 0) {
      return toast('Selecione um arquivo JSON.');
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = parseImportJson(String(reader.result || ''));
        var normalized = normalizeImportedTemplates(parsed);
        importModalState.fileName = name;
        importModalState.items = normalized;
        if (!templates.length) importModalState.mode = 'replace';
        refreshImportModalUi();
      } catch (e) {
        toast('JSON inválido. Use o arquivo exportado pelo CAP.');
        console.warn('[CAP Resumo] import parse:', e);
      }
    };
    reader.onerror = function () {
      toast('Não foi possível ler o arquivo.');
    };
    reader.readAsText(file);
  }

  function confirmImportModal() {
    if (!importModalState.items || !importModalState.items.length) {
      return toast('Escolha um arquivo para importar.');
    }
    var mode = importModalState.mode === 'replace' ? 'replace' : 'merge';
    applyImportedTemplates(importModalState.items, mode);
    closeImportModal();
  }

  function openFolderModal(opts) {
    ensureFolderModal();
    opts = opts || {};
    folderModalCtx = {
      mode: opts.mode === 'rename' ? 'rename' : 'create',
      source: opts.source === 'editor' ? 'editor' : 'panel',
      oldName: opts.oldName || ''
    };
    var modal = document.getElementById(CFG.folderModalId);
    var titleEl = modal.querySelector('[data-role="folder-modal-title"]');
    var subEl = modal.querySelector('[data-role="folder-modal-sub"]');
    var input = modal.querySelector('[data-f="folder-name"]');
    var saveBtn = modal.querySelector('[data-act="folder-modal-save"]');
    if (folderModalCtx.mode === 'rename') {
      titleEl.textContent = 'Renomear pasta';
      subEl.textContent = 'Atualize o nome da pasta selecionada';
      saveBtn.textContent = 'Renomear';
      input.value = folderModalCtx.oldName || '';
    } else {
      titleEl.textContent = 'Nova pasta';
      subEl.textContent =
        folderModalCtx.source === 'editor'
          ? 'A pasta será selecionada neste modelo'
          : 'Organize seus modelos por pasta';
      saveBtn.textContent = 'Criar pasta';
      input.value = '';
    }
    modal.classList.add('is-open');
    setTimeout(function () {
      try {
        input.focus();
        input.select();
      } catch (e) {}
    }, 30);
  }

  function submitFolderModal() {
    var modal = document.getElementById(CFG.folderModalId);
    if (!modal || !modal.classList.contains('is-open')) return;
    var raw = modal.querySelector('[data-f="folder-name"]').value;
    var name = normalizeFolderName(raw);
    if (!name) return toast('Informe um nome para a pasta.');
    if (name.toLowerCase() === 'todos') return toast('Nome de pasta inválido.');

    if (folderModalCtx.mode === 'rename') {
      var oldName = folderModalCtx.oldName;
      if (!oldName || name === oldName) {
        closeFolderModal();
        return;
      }
      if (folders.indexOf(name) >= 0) return toast('Já existe uma pasta com esse nome.');
      for (var i = 0; i < templates.length; i++) {
        if ((templates[i].category || 'Geral') === oldName) templates[i].category = name;
      }
      folders = folders.map(function (f) {
        return f === oldName ? name : f;
      });
      saveFolders();
      saveTemplates();
      state.category = name;
      closeFolderModal();
      renderAll();
      var editorModal = document.getElementById(CFG.modalId);
      if (editorModal && editorModal.classList.contains('is-open')) {
        fillModalFolderSelect(name);
      }
      toast('Pasta renomeada.');
      return;
    }

    ensureFolder(name);
    var fromEditor = folderModalCtx.source === 'editor';
    closeFolderModal();
    if (fromEditor) {
      fillModalFolderSelect(name);
      renderFolders();
    } else {
      state.category = name;
      renderAll();
    }
    toast('Pasta criada: ' + name);
  }

  function closeModal() {
    var folderModal = document.getElementById(CFG.folderModalId);
    if (folderModal && folderModal.classList.contains('is-open')) {
      closeFolderModal();
      return;
    }
    var modal = document.getElementById(CFG.modalId);
    if (modal) modal.classList.remove('is-open');
    state.editingId = null;
  }

  function fillModalFolderSelect(selected) {
    var modal = document.getElementById(CFG.modalId);
    if (!modal) return;
    var sel = modal.querySelector('[data-f="category"]');
    var html = '';
    for (var i = 0; i < folders.length; i++) {
      html +=
        '<option value="' +
        escAttr(folders[i]) +
        '"' +
        (folders[i] === selected ? ' selected' : '') +
        '>' +
        escHtml(folders[i]) +
        '</option>';
    }
    sel.innerHTML = html;
  }

  function createFolderFromModal() {
    openFolderModal({ mode: 'create', source: 'editor' });
  }

  function applyWindowState() {
    ui.panel.classList.toggle('is-dock', !!settings.docked);
    ui.panel.classList.toggle('is-min', !!settings.minimized);
  }

  function togglePanel(force) {
    if (busy) return;
    busy = true;
    try {
      var open = typeof force === 'boolean' ? force : !ui.panel.classList.contains('is-open');
      ui.panel.classList.toggle('is-open', open);
      if (open) {
        settings.minimized = false;
        applyWindowState();
        requestAnimationFrame(function () {
          try {
            refreshHint();
            renderAll();
            renderUpdateBar();
            try {
              ui.search.focus();
            } catch (e) {}
          } finally {
            busy = false;
          }
        });
      } else {
        busy = false;
      }
    } catch (e) {
      busy = false;
    }
  }

  function onPanelClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || !ui.panel.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();

    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');

    if (act === 'close') return togglePanel(false);
    if (act === 'check-update') {
      toast('Verificando atualização…');
      checkForUpdates(true);
      return;
    }
    if (act === 'do-update') {
      openScriptUpdate();
      return;
    }
    if (act === 'minimize') {
      settings.minimized = !settings.minimized;
      saveSettings();
      applyWindowState();
      return;
    }
    if (act === 'dock') {
      settings.docked = !settings.docked;
      saveSettings();
      applyWindowState();
      return;
    }
    if (act === 'new') return openEditor(null);
    if (act === 'import') return importTemplates();
    if (act === 'export') return exportTemplates();
    if (act === 'edit') return openEditor(id);
    if (act === 'insert') return insertTemplate(id);
    if (act === 'folder-new') return createFolder();
    if (act === 'folder-rename') return renameFolder();
    if (act === 'folder-del') return deleteFolder();
    if (act === 'folder-select') {
      state.category = btn.getAttribute('data-folder') || 'Todos';
      pendingDeleteId = null;
      renderFolders();
      renderList();
      return;
    }
    if (act === 'ask-del') {
      pendingDeleteId = id;
      renderList();
      return;
    }
    if (act === 'do-del') return doDelete(id);
    if (act === 'cancel-del') {
      pendingDeleteId = null;
      renderList();
      return;
    }
    if (act === 'pick') return startPick();
    if (act === 'detect') return detectBox();
  }

  function createFolder() {
    openFolderModal({ mode: 'create', source: 'panel' });
  }

  function renameFolder() {
    if (!state.category || state.category === 'Todos' || state.category === 'Geral') {
      return toast('Selecione uma pasta personalizada para renomear.');
    }
    openFolderModal({ mode: 'rename', source: 'panel', oldName: state.category });
  }

  function deleteFolder() {
    if (!state.category || state.category === 'Todos' || state.category === 'Geral') {
      return toast('Selecione uma pasta personalizada para excluir.');
    }
    var name = state.category;
    var n = countInFolder(name);
    var ok = window.confirm(
      'Excluir a pasta "' + name + '"?' + (n ? '\n' + n + ' modelo(s) vão para Geral.' : '')
    );
    if (!ok) return;
    for (var i = 0; i < templates.length; i++) {
      if ((templates[i].category || 'Geral') === name) templates[i].category = 'Geral';
    }
    folders = folders.filter(function (f) { return f !== name; });
    ensureFolder('Geral');
    saveFolders();
    saveTemplates();
    state.category = 'Todos';
    renderAll();
    toast('Pasta excluída.');
  }

  function renderAll() {
    applyWindowState();
    renderFolders();
    renderList();
  }

  function renderFolders() {
    if (!ui.folders) return;
    if (state.category !== 'Todos' && folders.indexOf(state.category) < 0) state.category = 'Todos';
    var cats = categories();
    var html = '';
    for (var i = 0; i < cats.length; i++) {
      var name = cats[i];
      var count = name === 'Todos' ? templates.length : countInFolder(name);
      html +=
        '<button type="button" class="capr-folder' +
        (state.category === name ? ' is-active' : '') +
        '" data-act="folder-select" data-folder="' +
        escAttr(name) +
        '">' +
        escHtml(name) +
        ' <span class="capr-folder-count">(' +
        count +
        ')</span></button>';
    }
    ui.folders.innerHTML = html;
  }

  function renderList() {
    var found = refreshHint();
    ui.hint.textContent = state.fieldHint;
    ui.hint.className = found.field ? 'capr-hint-ok' : 'capr-hint-warn';

    var list = filtered();
    ui.count.textContent = list.length + (list.length === 1 ? ' modelo' : ' modelos');

    if (!list.length) {
      ui.list.innerHTML =
        '<div class="capr-empty">Nenhum modelo nesta pasta.<br>Use "+ Novo modelo" para criar.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var preview = String(t.body || '').trim().slice(0, 150);
      var asking = pendingDeleteId === t.id;

      html +=
        '<article class="capr-row">' +
        '<div class="capr-row-top">' +
        '<div class="capr-row-title">' +
        escHtml(t.title) +
        '</div>' +
        '<div class="capr-row-cat">' +
        escHtml(t.category || 'Geral') +
        '</div>' +
        '</div>' +
        '<div class="capr-preview">' +
        escHtml(preview || '(sem conteúdo)') +
        '</div>' +
        '<div class="capr-row-actions">' +
        '<button type="button" class="capr-btn primary" data-act="insert" data-id="' +
        escAttr(t.id) +
        '">Usar</button>' +
        '<button type="button" class="capr-btn ghost" data-act="edit" data-id="' +
        escAttr(t.id) +
        '">Editar</button>' +
        '<button type="button" class="capr-btn danger" data-act="ask-del" data-id="' +
        escAttr(t.id) +
        '">Apagar</button>' +
        '</div>';

      if (asking) {
        html +=
          '<div class="capr-confirm">' +
          'Apagar este modelo?' +
          '<div class="capr-row-actions" style="margin-top:8px">' +
          '<button type="button" class="capr-btn danger" data-act="do-del" data-id="' +
          escAttr(t.id) +
          '">Sim, apagar</button>' +
          '<button type="button" class="capr-btn ghost" data-act="cancel-del">Cancelar</button>' +
          '</div></div>';
      }
      html += '</article>';
    }
    ui.list.innerHTML = html;
  }

  function openEditor(id) {
    pendingDeleteId = null;
    ensureModal();
    var item = null;
    if (id) {
      for (var i = 0; i < templates.length; i++) {
        if (templates[i].id === id) {
          item = templates[i];
          break;
        }
      }
    }
    state.editingId = item ? item.id : null;
    var modal = document.getElementById(CFG.modalId);
    var titleEl = modal.querySelector('[data-role="modal-title"]');
    titleEl.textContent = item ? 'Editar modelo' : 'Novo modelo';
    var preferredFolder =
      item ? item.category || 'Geral' : state.category !== 'Todos' ? state.category : 'Geral';
    ensureFolder(preferredFolder);
    fillModalFolderSelect(preferredFolder);
    modal.querySelector('[data-f="title"]').value = item ? item.title : '';
    modal.querySelector('[data-f="body"]').value = item ? item.body : '';
    modal.classList.add('is-open');
    setTimeout(function () {
      try {
        modal.querySelector('[data-f="title"]').focus();
      } catch (e) {}
    }, 30);
  }

  function saveEditor() {
    var modal = document.getElementById(CFG.modalId);
    if (!modal) return;
    var title = modal.querySelector('[data-f="title"]').value.trim();
    var category = ensureFolder(modal.querySelector('[data-f="category"]').value || 'Geral');
    var body = modal.querySelector('[data-f="body"]').value;
    if (!title) return toast('Informe um nome para o modelo.');
    if (!body.trim()) return toast('O conteúdo não pode ficar vazio.');
    if (!state.editingId && templates.length >= CFG.maxTpl) {
      return toast('Limite de ' + CFG.maxTpl + ' modelos.');
    }

    if (state.editingId) {
      for (var i = 0; i < templates.length; i++) {
        if (templates[i].id === state.editingId) {
          templates[i].title = title;
          templates[i].category = category;
          templates[i].body = body;
          templates[i].updatedAt = Date.now();
          break;
        }
      }
    } else {
      templates.unshift({
        id: uid(),
        title: title,
        category: category,
        tags: [],
        body: body,
        updatedAt: Date.now()
      });
    }

    saveTemplates();
    state.category = category;
    closeModal();
    renderAll();
    toast('Modelo salvo.');
  }

  function insertTemplate(id) {
    var item = null;
    for (var i = 0; i < templates.length; i++) {
      if (templates[i].id === id) {
        item = templates[i];
        break;
      }
    }
    if (!item) return;

    var found = refreshHint();
    if (!found.field || !isResumoField(found.field)) {
      toast('Defina a caixa Resumo do Atendimento primeiro.');
      renderList();
      return;
    }

    var field = found.field;
    var text = applyVars(item.body);
    var ok = setFieldValue(field, text, settings.insertMode);
    if (ok && !looksFilled(field, text)) ok = setFieldValue(field, text, settings.insertMode);

    if (ok && looksFilled(field, text)) {
      item.updatedAt = Date.now();
      saveTemplates();
      try {
        field.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {}
      try {
        field.focus();
      } catch (e2) {}
      highlight(field);
      cachedField = field;
      hideSuggestions();
      renderList();
      toast('Inserido no Resumo do Atendimento.');
      setTimeout(function () {
        if (!looksFilled(field, text)) setFieldValue(field, text, settings.insertMode);
      }, 120);
    } else {
      toast('Não consegui escrever no campo. Use Definir caixa no Resumo.');
    }
  }

  function doDelete(id) {
    var before = templates.length;
    templates = templates.filter(function (t) {
      return t.id !== id;
    });
    pendingDeleteId = null;
    if (templates.length === before) {
      toast('Modelo não encontrado.');
      renderList();
      return;
    }
    saveTemplates();
    renderAll();
    toast('Modelo apagado.');
  }

  function detectBox() {
    settings.targetSelector = '';
    settings.targetLabel = '';
    cachedField = null;
    var found = findTargetField();
    if (!found.field || !isResumoField(found.field)) {
      saveSettings();
      renderList();
      toast('Não encontrei o Resumo do Atendimento.');
      return;
    }
    settings.targetSelector = buildSelector(found.field);
    settings.targetLabel = primaryLabel(found.field).slice(0, 80) || 'Resumo do Atendimento';
    cachedField = found.field;
    saveSettings();
    highlight(found.field);
    bindSuggestField(found.field);
    renderList();
    toast('Detectado: ' + settings.targetLabel);
  }

  function editableFrom(target) {
    if (!target || !target.closest) return null;
    if (isOurUi(target)) return null;
    return target.closest('textarea, input:not([type]), input[type="text"], [contenteditable="true"]');
  }

  function startPick() {
    if (stopPickFn) stopPickFn();
    togglePanel(false);
    showPickBanner(true);
    toast('Clique dentro de Resumo do Atendimento');

    var lastHover = null;
    function onMove(e) {
      var el = editableFrom(e.target);
      if (lastHover && lastHover !== el) lastHover.classList.remove('capr-pick-hover');
      if (el) {
        el.classList.add('capr-pick-hover');
        lastHover = el;
      } else {
        lastHover = null;
      }
    }
    function onClick(e) {
      var el = editableFrom(e.target);
      if (!el) {
        var around =
          e.target.closest &&
          e.target.closest('.cap-form-control, .form-group, .mb-3');
        el = pickBestEditable(around);
      }
      if (!el) {
        toast('Clique dentro da caixa de texto do Resumo.');
        return;
      }

      var lab = primaryLabel(el);
      if (labelLooksLikeComments(lab) || attrsLookLikeComments(el)) {
        toast('Esse parece ser Comentários. Clique no Resumo do Atendimento.');
        return;
      }
      if (!labelLooksLikeResumo(lab) && !attrsLookLikeResumo(el)) {
        var conf = window.confirm(
          'O rotulo deste campo e "' +
            (lab || '(sem rotulo)') +
            '".\nConfirma que e o Resumo do Atendimento?'
        );
        if (!conf) return;
      }

      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();

      settings.targetSelector = buildSelector(el);
      settings.targetLabel = lab.slice(0, 80) || 'Resumo do Atendimento';
      saveSettings();
      cachedField = el;
      cleanup();
      highlight(el);
      bindSuggestField(el);
      togglePanel(true);
      toast('Caixa definida: ' + settings.targetLabel);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        cleanup();
        togglePanel(true);
        toast('Seleção cancelada.');
      }
    }
    function cleanup() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (lastHover) lastHover.classList.remove('capr-pick-hover');
      showPickBanner(false);
      stopPickFn = null;
    }
    stopPickFn = cleanup;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function sanitizeImportText(input) {
    var t = String(input || '').replace(/^\uFEFF/, '');
    t = t
      .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    t = t.replace(/,\s*([}\]])/g, '$1');
    return t.trim();
  }

  function escapeControlsInsideJsonStrings(src) {
    var out = '';
    var inString = false;
    var escaped = false;
    for (var i = 0; i < src.length; i++) {
      var c = src.charAt(i);
      var code = src.charCodeAt(i);
      if (inString) {
        if (escaped) {
          out += c;
          escaped = false;
          continue;
        }
        if (c === '\\') {
          out += c;
          escaped = true;
          continue;
        }
        if (c === '"') {
          inString = false;
          out += c;
          continue;
        }
        if (code < 0x20) {
          if (c === '\n') out += '\\n';
          else if (c === '\r') out += '\\r';
          else if (c === '\t') out += '\\t';
          else {
            var hex = code.toString(16);
            while (hex.length < 4) hex = '0' + hex;
            out += '\\u' + hex;
          }
          continue;
        }
        out += c;
      } else {
        if (c === '"') inString = true;
        out += c;
      }
    }
    return out;
  }

  function parseImportJson(raw) {
    var cleaned = sanitizeImportText(raw);
    var attempts = [cleaned, escapeControlsInsideJsonStrings(cleaned)];
    var lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      try {
        return JSON.parse(attempts[i]);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('JSON inválido');
  }

  function normalizeImportedTemplates(parsed) {
    var list = parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (Array.isArray(parsed.templates)) list = parsed.templates;
      else if (Array.isArray(parsed.items)) list = parsed.items;
      else if (Array.isArray(parsed.modelos)) list = parsed.modelos;
    }
    if (!Array.isArray(list)) throw new Error('JSON inválido');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t) continue;
      var title = String(t.title || t.nome || t.name || '')
        .replace(/[\u0000-\u001F]/g, '')
        .trim();
      var body = String(t.body || t.text || t.mensagem || '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .trim();
      if (!title || !body) continue;
      out.push({
        id: t.id || uid(),
        title: title.slice(0, 120),
        category: String(t.category || t.tag || t.pasta || 'Geral')
          .replace(/[\u0000-\u001F]/g, '')
          .slice(0, 60),
        tags: Array.isArray(t.tags) ? t.tags.map(String).slice(0, 12) : [],
        body: body,
        updatedAt: t.updatedAt || Date.now()
      });
      ensureFolder(out[out.length - 1].category);
    }
    if (!out.length) throw new Error('Nenhum modelo válido');
    return out;
  }

  function applyImportedTemplates(normalized, mode) {
    if (mode === 'replace') {
      templates = normalized.slice(0, CFG.maxTpl);
    } else {
      for (var n = 0; n < normalized.length; n++) {
        var incoming = normalized[n];
        var found = false;
        for (var j = 0; j < templates.length; j++) {
          if (String(templates[j].title || '').toLowerCase() === String(incoming.title || '').toLowerCase()) {
            incoming.id = templates[j].id;
            templates[j] = incoming;
            found = true;
            break;
          }
        }
        if (!found) templates.push(incoming);
      }
      if (templates.length > CFG.maxTpl) templates = templates.slice(0, CFG.maxTpl);
    }
    saveTemplates();
    renderAll();
    toast(mode === 'replace' ? 'Modelos substituídos.' : 'Importação concluída.');
  }

  function exportTemplates() {
    var payload = {
      version: CFG.version,
      exportedAt: new Date().toISOString(),
      templates: templates
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cap-modelos-resumo.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 800);
    toast('Arquivo exportado.');
  }

  function importTemplatesFromRaw(raw) {
    try {
      var parsed = parseImportJson(raw);
      var normalized = normalizeImportedTemplates(parsed);
      var mode = 'merge';
      if (templates.length) {
        var merge = window.confirm(
          'Encontrei ' +
            normalized.length +
            ' modelo(s) no arquivo.\n\nOK = mesclar com os atuais\nCancelar = substituir tudo'
        );
        if (merge) {
          mode = 'merge';
        } else {
          var sure = window.confirm('Substituir TODOS os modelos atuais pelos do arquivo?');
          if (!sure) {
            toast('Importação cancelada.');
            return;
          }
          mode = 'replace';
        }
      }
      applyImportedTemplates(normalized, mode);
    } catch (e) {
      toast('Falha ao importar JSON. Use o arquivo exportado.');
      console.warn('[CAP Resumo] import:', e);
    }
  }

  function importTemplates() {
    openImportModal();
  }

  function highlight(el) {
    var prev = el.style.outline;
    el.style.outline = '2px solid #2f6b9a';
    setTimeout(function () {
      el.style.outline = prev;
    }, 1100);
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(str) {
    return escHtml(str).replace(/'/g, '&#39;');
  }

  function normalizeText(s) {
    return normalizeLabel(s);
  }

  function matchSuggestions(query) {
    var q = normalizeText(query);
    if (!q || q.length < 2) return [];
    var tokens = q.split(' ').filter(function (t) {
      return t.length > 1;
    });
    if (!tokens.length) tokens = [q];

    var scored = [];
    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];
      var hay = normalizeText(
        (t.title || '') + ' ' + (t.category || '') + ' ' + (t.tags || []).join(' ') + ' ' + (t.body || '')
      );
      var score = 0;
      for (var k = 0; k < tokens.length; k++) {
        if (hay.indexOf(tokens[k]) >= 0) score += 10;
      }
      if (normalizeText(t.title).indexOf(q) >= 0) score += 25;
      if (normalizeText(t.category).indexOf(q) >= 0) score += 12;
      if (score > 0) scored.push({ item: t, score: score + Math.min(20, Math.floor((t.updatedAt || 0) / 1e12)) });
    }
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.slice(0, 5).map(function (x) {
      return x.item;
    });
  }

  function hideSuggestions() {
    if (suggestHost && suggestHost.parentNode) suggestHost.parentNode.removeChild(suggestHost);
    suggestHost = null;
  }

  function ensureSuggestHost(field) {
    if (!field || !field.parentNode) return null;
    if (!isResumoField(field) && !(settings.targetSelector && field === cachedField)) {
      // só permite se for o campo configurado manualmente
      if (!(stillValid(cachedField) && field === cachedField && settings.targetSelector)) return null;
    }

    var existing = document.getElementById(CFG.suggestId);
    if (existing) {
      // reposiciona logo após o textarea do resumo
      if (field.nextSibling) field.parentNode.insertBefore(existing, field.nextSibling);
      else field.parentNode.appendChild(existing);
      suggestHost = existing;
      return existing;
    }
    var host = document.createElement('div');
    host.id = CFG.suggestId;
    if (field.nextSibling) field.parentNode.insertBefore(host, field.nextSibling);
    else field.parentNode.appendChild(host);
    suggestHost = host;
    return host;
  }

  function renderSuggestions(field, query) {
    if (!templates.length) {
      hideSuggestions();
      return;
    }
    if (!stillValid(field)) {
      hideSuggestions();
      return;
    }
    if (!isResumoField(field) && !(settings.targetSelector && field === cachedField)) {
      hideSuggestions();
      return;
    }

    var matches = matchSuggestions(query);
    if (!matches.length) {
      hideSuggestions();
      return;
    }

    var host = ensureSuggestHost(field);
    if (!host) return;

    var html =
      '<div class="capr-sug-head">' +
      '<div class="capr-sug-title">Sugestões · Resumo do Atendimento</div>' +
      '<button type="button" class="capr-sug-close" data-sug="close" title="Fechar">×</button>' +
      '</div><div class="capr-sug-list">';

    for (var i = 0; i < matches.length; i++) {
      var t = matches[i];
      var preview = String(t.body || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);
      html +=
        '<div class="capr-sug-item">' +
        '<div style="min-width:0;flex:1">' +
        '<div class="capr-sug-name">' +
        escHtml(t.title) +
        '</div>' +
        '<div class="capr-sug-meta">' +
        escHtml(t.category || 'Geral') +
        '</div>' +
        '<div class="capr-sug-preview">' +
        escHtml(preview || '(sem conteúdo)') +
        '</div>' +
        '</div>' +
        '<button type="button" class="capr-sug-use" data-sug="use" data-id="' +
        escAttr(t.id) +
        '">Usar</button>' +
        '</div>';
    }
    html += '</div>';
    host.innerHTML = html;
  }

  function onSuggestClick(e) {
    var btn = e.target.closest('[data-sug]');
    if (!btn || !suggestHost || !suggestHost.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    var act = btn.getAttribute('data-sug');
    if (act === 'close') {
      hideSuggestions();
      return;
    }
    if (act === 'use') {
      insertTemplate(btn.getAttribute('data-id'));
      hideSuggestions();
    }
  }

  function scheduleSuggestions(field) {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(function () {
      if (!stillValid(field)) {
        hideSuggestions();
        return;
      }
      if (!isResumoField(field) && !(settings.targetSelector && field === cachedField)) {
        hideSuggestions();
        return;
      }
      renderSuggestions(field, getFieldText(field));
    }, 160);
  }

  function unbindSuggestField() {
    if (!suggestBoundField) return;
    try {
      suggestBoundField.removeEventListener('input', suggestBoundField._capSugInput);
      suggestBoundField.removeEventListener('focus', suggestBoundField._capSugFocus);
      suggestBoundField.removeEventListener('blur', suggestBoundField._capSugBlur);
    } catch (e) {}
    suggestBoundField = null;
  }

  function bindSuggestField(field) {
    if (!field) return;
    // nunca deve integrar com Comentários
    if (labelLooksLikeComments(primaryLabel(field)) || attrsLookLikeComments(field)) return;
    if (!isResumoField(field) && !(settings.targetSelector && settings.targetSelector === buildSelector(field))) {
      return;
    }

    if (suggestBoundField === field) return;
    unbindSuggestField();

    function onInput() {
      scheduleSuggestions(field);
    }
    function onFocus() {
      scheduleSuggestions(field);
    }
    function onBlur() {
      setTimeout(function () {
        if (!suggestHost) return;
        var active = document.activeElement;
        if (active && suggestHost.contains(active)) return;
        hideSuggestions();
      }, 180);
    }

    field._capSugInput = onInput;
    field._capSugFocus = onFocus;
    field._capSugBlur = onBlur;
    field.addEventListener('input', onInput);
    field.addEventListener('focus', onFocus);
    field.addEventListener('blur', onBlur);
    suggestBoundField = field;
    cachedField = field;

    if (!document._capSugClickBound) {
      document.addEventListener('click', onSuggestClick, true);
      document._capSugClickBound = true;
    }
  }

  function watchResumoField() {
    var found = findTargetField();
    if (found.field && (isResumoField(found.field) || settings.targetSelector)) {
      bindSuggestField(found.field);
    } else {
      unbindSuggestField();
      hideSuggestions();
    }
  }

  function boot() {
    templates = loadTemplates();
    settings = loadSettings();
    loadFolders();
    injectStyles();
    buildShell();
    ensureUpdateFloat();
    renderUpdateBar();
    // Sempre consulta ao abrir o CAP para o card suspenso aparecer sem depender do botão de verificar
    checkForUpdates(true);
    startNoticesSystem();
    startDupCheckSystem();
    watchResumoField();
    clearInterval(watchTimer);
    watchTimer = setInterval(watchResumoField, 2200);

    // observer leve: só reagenda, não varre sincronamente
    try {
      var moTimer = null;
      var mo = new MutationObserver(function () {
        if (moTimer) return;
        moTimer = setTimeout(function () {
          moTimer = null;
          watchResumoField();
          watchFormContext();
        }, 400);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e0) {}

    try {
      GM_registerMenuCommand('CAP Resumo: abrir painel', function () {
        togglePanel(true);
      });
      GM_registerMenuCommand('CAP Resumo: definir caixa', function () {
        startPick();
      });
      GM_registerMenuCommand('CAP Resumo: verificar atualização', function () {
        checkForUpdates(true);
      });
      GM_registerMenuCommand('CAP Resumo: recarregar avisos (JSON)', function () {
        clearDismissedNotices();
        fetchNotices(true);
        toast('Avisos atualizados do GitHub.');
      });
      GM_registerMenuCommand('CAP Resumo: restaurar avisos dispensados', function () {
        clearDismissedNotices();
        lastContextKey = '';
        watchFormContext();
        toast('Avisos dispensados restaurados.');
      });
      GM_registerMenuCommand('CAP Resumo: testar aviso Pré CAP duplicado', function () {
        var pedido = normalizePedido(getFormContext().pedido) || '2052938720';
        showDupModal({
          pedido: pedido,
          capId: '4594008',
          capUrl: buildCapRequestUrl('4594008'),
          requestIds: ['4594008'],
          status: 'bloqueado'
        });
      });
    } catch (e) {}

    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        togglePanel();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
