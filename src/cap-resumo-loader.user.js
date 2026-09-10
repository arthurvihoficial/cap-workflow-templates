// ==UserScript==
// @name         CAP Workflow — Loader (Modelos de Resumo)
// @namespace    https://vcimentos.capworkflow.com/
// @version      1.0.0
// @description  Carrega o CAP Resumo a partir do GitHub
// @author       Arthur Vinícius
// @match        https://vcimentos.capworkflow.com/*
// @match        https://*.capworkflow.com/*
// @run-at       document-idle
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
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // URLs do repositório (script principal + version.json)
  var SCRIPT_URL =
    'https://raw.githubusercontent.com/arthurvihoficial/cap-workflow-templates/refs/heads/main/src/cap-resumo-atendimento.user.js';
  var VERSION_URL =
    'https://raw.githubusercontent.com/arthurvihoficial/cap-workflow-templates/refs/heads/main/src/version.json';

  var CACHE_SRC_KEY = 'cap_resumo_loader_src_v1';
  var CACHE_VER_KEY = 'cap_resumo_loader_ver_v1';
  var DISMISSED_KEY = 'cap_resumo_update_dismissed';

  var booted = false;
  var applying = false;

  function stripUserscriptHeader(source) {
    return String(source || '').replace(
      /\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==\s*/,
      ''
    );
  }

  function parseVersionFromSource(source) {
    var m = String(source || '').match(/\/\/\s*@version\s+([^\s]+)/);
    return m ? String(m[1]).trim() : '';
  }

  function executeCached(source) {
    if (booted) return;
    booted = true;
    var code = stripUserscriptHeader(source);
    if (!code.trim()) {
      booted = false;
      throw new Error('empty');
    }
    // Executa no sandbox do Tampermonkey (GM_* disponíveis)
    eval(code);
  }

  function saveCache(source, version) {
    GM_setValue(CACHE_SRC_KEY, String(source || ''));
    GM_setValue(CACHE_VER_KEY, String(version || parseVersionFromSource(source) || ''));
  }

  function applyUpdate(opts, cb) {
    if (applying) return;
    applying = true;
    var url = (opts && opts.url) || SCRIPT_URL;
    var hintVersion = (opts && opts.version) || '';

    GM_xmlhttpRequest({
      method: 'GET',
      url: url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(),
      onload: function (res) {
        applying = false;
        try {
          if (res.status < 200 || res.status >= 300) throw new Error('http ' + res.status);
          var source = res.responseText || '';
          if (source.indexOf('==UserScript==') < 0) throw new Error('invalid script');
          var version = hintVersion || parseVersionFromSource(source) || '';
          saveCache(source, version);
          try {
            GM_setValue(DISMISSED_KEY, '');
          } catch (e0) {}
          if (typeof cb === 'function') cb(null, version);
          setTimeout(function () {
            location.reload();
          }, 350);
        } catch (e) {
          if (typeof cb === 'function') cb(e);
        }
      },
      onerror: function () {
        applying = false;
        if (typeof cb === 'function') cb(new Error('network'));
      },
      ontimeout: function () {
        applying = false;
        if (typeof cb === 'function') cb(new Error('timeout'));
      }
    });
  }

  function fetchVersionInfo(cb) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: VERSION_URL + (VERSION_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(),
      headers: { Accept: 'application/json' },
      onload: function (res) {
        try {
          if (res.status < 200 || res.status >= 300) throw new Error('http');
          cb(null, JSON.parse(res.responseText));
        } catch (e) {
          cb(e);
        }
      },
      onerror: function () {
        cb(new Error('network'));
      }
    });
  }

  var api = {
    mode: 'loader',
    loaderVersion: '1.0.0',
    scriptUrl: SCRIPT_URL,
    versionUrl: VERSION_URL,
    getCachedVersion: function () {
      return String(GM_getValue(CACHE_VER_KEY, '') || '');
    },
    applyUpdate: applyUpdate,
    fetchVersionInfo: fetchVersionInfo
  };

  // Binding no escopo do loader: o eval do script principal enxerga esta variável
  var __CAP_RESUMO_LOADER__ = api;

  function exposeApi() {
    try {
      if (typeof globalThis !== 'undefined') globalThis.__CAP_RESUMO_LOADER__ = api;
    } catch (e0) {}
    try {
      window.__CAP_RESUMO_LOADER__ = api;
    } catch (e1) {}
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
        unsafeWindow.__CAP_RESUMO_LOADER__ = api;
      }
    } catch (e2) {}
  }

  function bootFromCacheOrNetwork() {
    exposeApi();

    try {
      GM_registerMenuCommand('CAP Resumo: forçar sincronização (loader)', function () {
        applyUpdate({ url: SCRIPT_URL }, function (err, ver) {
          if (err) alert('Falha ao sincronizar com o GitHub.');
          else alert('Sincronizado' + (ver ? ' (v' + ver + ')' : '') + '. Recarregando…');
        });
      });
    } catch (e) {}

    var cached = GM_getValue(CACHE_SRC_KEY, '');
    if (cached) {
      try {
        executeCached(cached);
        return;
      } catch (e2) {
        booted = false;
      }
    }

    // Primeira execução: baixa o principal e roda (sem tela do Tampermonkey)
    GM_xmlhttpRequest({
      method: 'GET',
      url: SCRIPT_URL + (SCRIPT_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(),
      onload: function (res) {
        try {
          if (res.status < 200 || res.status >= 300) throw new Error('http');
          var source = res.responseText || '';
          if (source.indexOf('==UserScript==') < 0) throw new Error('invalid');
          saveCache(source, parseVersionFromSource(source));
          executeCached(source);
        } catch (e3) {
          console.error('[CAP Resumo Loader] falha ao carregar script remoto', e3);
        }
      },
      onerror: function () {
        console.error('[CAP Resumo Loader] rede indisponível e sem cache local');
      }
    });
  }

  bootFromCacheOrNetwork();
})();
