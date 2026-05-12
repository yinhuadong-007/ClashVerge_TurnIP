#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const tls = require('tls');

const DEFAULT_CONTROLLER = '127.0.0.1:9097';
const DEFAULT_GROUP_PRIORITY = ['GLOBAL', 'Proxy'];
const MAX_ACCEPTABLE_DELAY_MS = Number(process.env.MAX_ACCEPTABLE_DELAY_MS || 300);
const ROTATE_INTERVAL_MS = Number(process.env.ROTATE_INTERVAL_MS || 5 * 60 * 1000);
const ROTATE_ON_START = !['0', 'false', 'no', 'off'].includes(String(process.env.ROTATE_ON_START || '1').toLowerCase());
const DISCOVER_SETTLE_MS = Number(process.env.DISCOVER_SETTLE_MS || 1200);
const STATE_PATH = path.resolve(__dirname, '..', 'data', 'ip-state.json');
const PROXIES_RAW_PATH = path.resolve(__dirname, '..', 'data', 'proxies-raw.json');
const FETCH_TIMEOUT_MS = 12000;
const CLASH_PROXY = process.env.CLASH_PROXY || 'http://127.0.0.1:7897';
const DELAY_TEST_URL = process.env.DELAY_TEST_URL || 'https://www.gstatic.com/generate_204';
const DELAY_TEST_TIMEOUT_MS = Number(process.env.DELAY_TEST_TIMEOUT_MS || 5000);
const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
const API_BIND = process.env.API_BIND || '127.0.0.1';
const API_PORT = Number(process.env.API_PORT || 8787);
const API_TOKEN = (process.env.API_TOKEN || '').trim();
const NON_HK_DISABLE_HK_FALLBACK_THRESHOLD = 20;
const ipCountryCache = new Map();

function ts() {
  return new Date().toISOString();
}

function debugLog(message) {
  if (DEBUG_LOGS) {
    console.log(message);
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours} h ${minutes} m ${seconds} s`;
}

function clearCountdownLine() {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
}

function normalizeController(input) {
  const value = (input || '').trim() || DEFAULT_CONTROLLER;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return `http://${value}`;
}

function authHeaders(secret) {
  return {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json'
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function parseProxyUrl(proxyUrl) {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== 'http:') {
    throw new Error(`Only http proxy is supported for CLASH_PROXY, got: ${proxyUrl}`);
  }
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 80)
  };
}

async function fetchTextViaHttpProxy(targetUrl, proxyUrl, timeoutMs = 9000) {
  const target = new URL(targetUrl);
  if (target.protocol !== 'https:') {
    throw new Error(`Only https target is supported, got: ${targetUrl}`);
  }

  const proxy = parseProxyUrl(proxyUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let secureSocket = null;
    let response = '';

    const finish = (err, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (secureSocket) {
        secureSocket.destroy();
      }
      if (socket) {
        socket.destroy();
      }
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`public IP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket = net.connect(proxy.port, proxy.host, () => {
      socket.write(
        `CONNECT ${target.hostname}:443 HTTP/1.1\r\n` +
        `Host: ${target.hostname}:443\r\n` +
        'Proxy-Connection: keep-alive\r\n' +
        '\r\n'
      );
    });

    socket.once('error', finish);
    socket.once('data', (chunk) => {
      const header = chunk.toString('latin1');
      if (!header.includes(' 200 ')) {
        finish(new Error(`proxy CONNECT failed: ${header.split('\r\n')[0] || 'unknown response'}`));
        return;
      }

      secureSocket = tls.connect({
        socket,
        servername: target.hostname
      }, () => {
        secureSocket.write(
          `GET ${target.pathname || '/'}${target.search || ''} HTTP/1.1\r\n` +
          `Host: ${target.hostname}\r\n` +
          'User-Agent: ClashVergeTurnIP/1.0\r\n' +
          'Accept: text/plain\r\n' +
          'Connection: close\r\n' +
          '\r\n'
        );
      });

      secureSocket.on('data', (data) => {
        response += data.toString('utf8');
      });
      secureSocket.once('error', finish);
      secureSocket.once('end', () => {
        const separator = response.indexOf('\r\n\r\n');
        if (separator === -1) {
          finish(new Error('invalid HTTP response from public IP endpoint'));
          return;
        }
        const statusLine = response.slice(0, response.indexOf('\r\n'));
        if (!statusLine.includes(' 200 ')) {
          finish(new Error(`public IP endpoint failed: ${statusLine}`));
          return;
        }
        finish(null, response.slice(separator + 4).trim());
      });
    });
  });
}

async function holdHttpsConnectViaProxy(targetUrl, proxyUrl, timeoutMs = 5000) {
  const target = new URL(targetUrl);
  const proxy = parseProxyUrl(proxyUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect(proxy.port, proxy.host);

    const finish = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`proxy CONNECT probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('connect', () => {
      socket.write(
        `CONNECT ${target.hostname}:443 HTTP/1.1\r\n` +
        `Host: ${target.hostname}:443\r\n` +
        'Proxy-Connection: keep-alive\r\n' +
        '\r\n'
      );
    });
    socket.once('error', finish);
    socket.once('data', (chunk) => {
      const header = chunk.toString('latin1');
      if (!header.includes(' 200 ')) {
        finish(new Error(`proxy CONNECT probe failed: ${header.split('\r\n')[0] || 'unknown response'}`));
        return;
      }
      finish();
    });
  });
}

async function clashGet(baseUrl, secret, endpoint) {
  const res = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
    method: 'GET',
    headers: authHeaders(secret)
  });
  if (!res.ok) {
    throw new Error(`GET ${endpoint} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function clashPut(baseUrl, secret, endpoint, body) {
  const res = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
    method: 'PUT',
    headers: authHeaders(secret),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`PUT ${endpoint} failed: ${res.status} ${res.statusText}`);
  }
  return res.json().catch(() => ({}));
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.lastIps)) {
      parsed.lastIps = [];
    }
    if (!Number.isInteger(parsed.historyResetCount) || parsed.historyResetCount < 0) {
      parsed.historyResetCount = 0;
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { lastIps: [], lastNode: null, updatedAt: null, historyResetCount: 0 };
    }
    throw err;
  }
}

async function writeState(state) {
  const dir = path.dirname(STATE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function writeProxiesRaw(payload) {
  const dir = path.dirname(PROXIES_RAW_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(PROXIES_RAW_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function pickGroupName(proxies, preferredGroup) {
  if (preferredGroup) {
    if (!proxies[preferredGroup]) {
      throw new Error(`Configured group not found: ${preferredGroup}`);
    }
    return preferredGroup;
  }
  for (const name of DEFAULT_GROUP_PRIORITY) {
    if (proxies[name]) {
      return name;
    }
  }
  throw new Error(
    `No proxy group found. Tried ${DEFAULT_GROUP_PRIORITY.join(', ')}. Set CLASH_GROUP explicitly.`
  );
}

async function detectPublicIpRouteGroup(baseUrl, secret, proxies) {
  const socket = await holdHttpsConnectViaProxy('https://api.ipify.org', CLASH_PROXY);
  try {
    await sleep(1500);
    const connectionsResp = await clashGet(baseUrl, secret, '/connections');
    const match = (connectionsResp.connections || []).find((conn) => conn.metadata && conn.metadata.host === 'api.ipify.org');
    if (!match || !Array.isArray(match.chains)) {
      debugLog(`${ts()} result=route-detect-miss host=api.ipify.org msg="no active connection found"`);
      return null;
    }
    for (let idx = match.chains.length - 1; idx >= 0; idx -= 1) {
      const name = match.chains[idx];
      if (proxies[name] && Array.isArray(proxies[name].all)) {
        debugLog(`${ts()} route-detected host=api.ipify.org rule=${match.rule || '-'} group="${name}" chains="${match.chains.join(' -> ')}"`);
        return name;
      }
    }
    debugLog(`${ts()} result=route-detect-miss host=api.ipify.org chains="${match.chains.join(' -> ')}" msg="no selector group found in chains"`);
    return null;
  } finally {
    socket.destroy();
  }
}

function isConcreteProxy(proxy) {
  if (!proxy || proxy.alive === false) {
    return false;
  }
  const type = String(proxy.type || '').toLowerCase();
  return !['selector', 'urltest', 'fallback', 'loadbalance', 'relay', 'direct', 'reject', 'rejectdrop', 'compatible', 'pass'].includes(type);
}

function getCandidates(groupObj, proxies) {
  if (!groupObj || !Array.isArray(groupObj.all)) {
    return [];
  }
  const reject = new Set(['DIRECT', 'REJECT']);
  return groupObj.all.filter((name) => {
    if (typeof name !== 'string' || !name.trim() || reject.has(name.toUpperCase())) {
      return false;
    }
    return isConcreteProxy(proxies[name]);
  });
}

function getLatestDelay(proxy) {
  if (!proxy || !Array.isArray(proxy.history) || proxy.history.length === 0) {
    return null;
  }
  for (let idx = proxy.history.length - 1; idx >= 0; idx -= 1) {
    const delay = Number(proxy.history[idx] && proxy.history[idx].delay);
    if (Number.isFinite(delay) && delay > 0) {
      return delay;
    }
  }
  return null;
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getPublicIp() {
  const endpoints = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://ipv4.icanhazip.com'
  ];
  let lastError = null;
  for (const url of endpoints) {
    try {
      const txt = (await fetchTextViaHttpProxy(url, CLASH_PROXY, 9000)).trim();
      if (txt) {
        debugLog(`${ts()} public-ip=${txt} source=${url} viaProxy=${CLASH_PROXY}`);
        return txt;
      }
      throw new Error('empty ip response');
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Failed to query public IP from all endpoints: ${lastError ? lastError.message : 'unknown error'}`);
}

async function getCountryCodeByIp(ip) {
  if (ipCountryCache.has(ip)) {
    return ipCountryCache.get(ip);
  }

  const endpoints = [
    `https://ipapi.co/${ip}/country/`,
    `https://ipwho.is/${ip}`
  ];
  let lastError = null;
  for (const url of endpoints) {
    try {
      const txt = (await fetchTextViaHttpProxy(url, CLASH_PROXY, 9000)).trim();
      if (!txt) {
        throw new Error('empty geoip response');
      }
      let countryCode = null;
      if (url.includes('ipapi.co')) {
        countryCode = txt.toUpperCase();
      } else {
        const parsed = JSON.parse(txt);
        countryCode = String(parsed.country_code || '').toUpperCase();
      }
      if (!countryCode) {
        throw new Error('missing country code');
      }
      ipCountryCache.set(ip, countryCode);
      return countryCode;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`failed to resolve country code for ip=${ip}: ${lastError ? lastError.message : 'unknown error'}`);
}

async function isHongKongIp(ip) {
  const countryCode = await getCountryCodeByIp(ip);
  return countryCode === 'HK';
}

function formatLog({ group, attempt, node, oldIp, newIp, result, message }) {
  return `${ts()} group=${group} attempt=${attempt} node="${node}" oldIP=${oldIp || '-'} newIP=${newIp || '-'} result=${result} msg="${message}"`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function isApiAuthorized(req) {
  if (!API_TOKEN) {
    return true;
  }
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const headerToken = String(req.headers['x-api-token'] || '').trim();
  return bearer === API_TOKEN || headerToken === API_TOKEN;
}

async function discoverNodeIps({ baseUrl, secret, groupName, candidates, oldIp }) {
  const discovered = [];
  for (let idx = 0; idx < candidates.length; idx += 1) {
    const node = candidates[idx];
    try {
      await clashPut(baseUrl, secret, `/proxies/${encodeURIComponent(groupName)}`, { name: node });
      await sleep(DISCOVER_SETTLE_MS);
      const ip = await getPublicIp();
      discovered.push({ node, ip });
      debugLog(formatLog({
        group: groupName,
        attempt: idx + 1,
        node,
        oldIp,
        newIp: ip,
        result: 'discover',
        message: 'node-ip-discovered'
      }));
    } catch (err) {
      debugLog(formatLog({
        group: groupName,
        attempt: idx + 1,
        node,
        oldIp,
        newIp: null,
        result: 'discover-skip',
        message: err.message
      }));
    }
  }
  return discovered;
}

async function findAndAcceptNode({ baseUrl, secret, groupName, candidates, proxies, previousIps, oldIp }) {
  const nonHkUniqueIps = new Set();
  let firstNonHkCandidate = null;
  let firstHkCandidate = null;

  for (let idx = 0; idx < candidates.length; idx += 1) {
    const node = candidates[idx];
    const delay = getLatestDelay(proxies[node]);
    if (delay === null || delay > MAX_ACCEPTABLE_DELAY_MS) {
      debugLog(formatLog({
        group: groupName,
        attempt: idx + 1,
        node,
        oldIp,
        newIp: null,
        result: 'discover-skip',
        message: `delay-not-acceptable: ${delay === null ? 'unknown' : delay}`
      }));
      continue;
    }

    try {
      await clashPut(baseUrl, secret, `/proxies/${encodeURIComponent(groupName)}`, { name: node });
      await sleep(DISCOVER_SETTLE_MS);
      const ip = await getPublicIp();
      const isHk = await isHongKongIp(ip).catch((err) => {
        debugLog(formatLog({
          group: groupName,
          attempt: idx + 1,
          node,
          oldIp,
          newIp: ip,
          result: 'discover-warn',
          message: `geoip-check-failed, treated-as-non-hk: ${err.message}`
        }));
        return false;
      });

      if (!isHk) {
        nonHkUniqueIps.add(ip);
      }

      if (previousIps.includes(ip)) {
        debugLog(formatLog({
          group: groupName,
          attempt: idx + 1,
          node,
          oldIp,
          newIp: ip,
          result: 'discover-skip',
          message: 'ip matched recent history'
        }));
        continue;
      }

      const candidate = {
        attempt: idx + 1,
        node,
        ip,
        delay
      };

      if (isHk) {
        debugLog(formatLog({
          group: groupName,
          attempt: idx + 1,
          node,
          oldIp,
          newIp: ip,
          result: 'discover-skip',
          message: 'hong-kong-ip-deferred'
        }));
        if (!firstHkCandidate) {
          firstHkCandidate = candidate;
        }
      } else if (!firstNonHkCandidate) {
        firstNonHkCandidate = candidate;
        return {
          accepted: firstNonHkCandidate,
          nonHkUniqueCount: nonHkUniqueIps.size,
          hkFallbackAllowed: false,
          historyResetTriggered: false
        };
      }
    } catch (err) {
      debugLog(formatLog({
        group: groupName,
        attempt: idx + 1,
        node,
        oldIp,
        newIp: null,
        result: 'discover-skip',
        message: err.message
      }));
    }
  }

  const nonHkUniqueCount = nonHkUniqueIps.size;
  const hkFallbackAllowed = nonHkUniqueCount <= NON_HK_DISABLE_HK_FALLBACK_THRESHOLD;

  if (firstNonHkCandidate) {
    return {
      accepted: firstNonHkCandidate,
      nonHkUniqueCount,
      hkFallbackAllowed,
      historyResetTriggered: false
    };
  }

  if (hkFallbackAllowed && firstHkCandidate) {
    return {
      accepted: { ...firstHkCandidate, hkFallback: true },
      nonHkUniqueCount,
      hkFallbackAllowed,
      historyResetTriggered: false
    };
  }

  return {
    accepted: null,
    nonHkUniqueCount,
    hkFallbackAllowed,
    historyResetTriggered: nonHkUniqueCount > NON_HK_DISABLE_HK_FALLBACK_THRESHOLD
  };
}

async function main() {
  const secret = process.env.CLASH_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error('Missing required environment variable: CLASH_SECRET');
  }
  if (!Number.isInteger(MAX_ACCEPTABLE_DELAY_MS) || MAX_ACCEPTABLE_DELAY_MS < 1) {
    throw new Error(`MAX_ACCEPTABLE_DELAY_MS must be a positive integer, got: ${process.env.MAX_ACCEPTABLE_DELAY_MS}`);
  }
  if (!Number.isInteger(ROTATE_INTERVAL_MS) || ROTATE_INTERVAL_MS < 1000) {
    throw new Error(`ROTATE_INTERVAL_MS must be an integer >= 1000, got: ${process.env.ROTATE_INTERVAL_MS}`);
  }
  if (!Number.isInteger(DISCOVER_SETTLE_MS) || DISCOVER_SETTLE_MS < 500) {
    throw new Error(`DISCOVER_SETTLE_MS must be an integer >= 500, got: ${process.env.DISCOVER_SETTLE_MS}`);
  }
  if (!Number.isInteger(DELAY_TEST_TIMEOUT_MS) || DELAY_TEST_TIMEOUT_MS < 1000) {
    throw new Error(`DELAY_TEST_TIMEOUT_MS must be an integer >= 1000, got: ${process.env.DELAY_TEST_TIMEOUT_MS}`);
  }
  if (!Number.isInteger(API_PORT) || API_PORT < 1 || API_PORT > 65535) {
    throw new Error(`API_PORT must be an integer between 1 and 65535, got: ${process.env.API_PORT}`);
  }

  const baseUrl = normalizeController(process.env.CLASH_CONTROLLER);
  const desiredGroup = process.env.CLASH_GROUP ? process.env.CLASH_GROUP.trim() : '';

  let stopping = false;
  let timer = null;
  let countdownTimer = null;
  let loadingTimer = null;
  let cycleRunning = false;
  let cycleNo = 0;
  let lastCycleAt = null;
  let nextRunAt = null;
  let apiServer = null;
  let countdownLastLen = 0;

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      clearCountdownLine();
      countdownLastLen = 0;
    }
  }

  function startCountdown(nextRunAt) {
    if (!process.stdout.isTTY || DEBUG_LOGS) {
      return;
    }
    stopCountdown();
    const render = () => {
      const remaining = nextRunAt - Date.now();
      const text = `距离下次更新 IP 还剩 ${formatDuration(remaining)}`;
      const pad = countdownLastLen > text.length ? ' '.repeat(countdownLastLen - text.length) : '';
      process.stdout.write(`\r${text}${pad}`);
      countdownLastLen = text.length;
    };
    render();
    countdownTimer = setInterval(render, 1000);
  }

  function stopLoading() {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
      clearCountdownLine();
    }
  }

  function startLoading(message) {
    if (!process.stdout.isTTY || DEBUG_LOGS) {
      return;
    }
    stopLoading();
    const frames = ['|', '/', '-', '\\'];
    let idx = 0;
    const render = () => {
      process.stdout.write(`\r${message}${frames[idx % frames.length]}`);
      idx += 1;
    };
    render();
    loadingTimer = setInterval(render, 150);
  }

  async function rotateOnce() {
    const state = await readState();
    const previousIps = Array.isArray(state.lastIps) ? [...state.lastIps] : [];
    let historyResetCount = state.historyResetCount || 0;

    const beforeIp = await getPublicIp().catch(() => null);
    let proxiesResp = await clashGet(baseUrl, secret, '/proxies');
    let proxies = proxiesResp.proxies || {};
    const detectedGroup = desiredGroup ? null : await detectPublicIpRouteGroup(baseUrl, secret, proxies).catch((err) => {
      debugLog(`${ts()} result=route-detect-warn msg="${err.message}"`);
      return null;
    });
    const groupName = pickGroupName(proxies, desiredGroup || detectedGroup);
    let groupObj = proxies[groupName];

    const encodedGroup = encodeURIComponent(groupName);
    const encodedUrl = encodeURIComponent(DELAY_TEST_URL);
    try {
      await clashGet(
        baseUrl,
        secret,
        `/group/${encodedGroup}/delay?url=${encodedUrl}&timeout=${DELAY_TEST_TIMEOUT_MS}`
      );
      debugLog(`${ts()} group=${groupName} result=delay-test msg="group delay test triggered"`);
    } catch (err) {
      debugLog(`${ts()} group=${groupName} result=delay-test-warn msg="${err.message}"`);
    }

    proxiesResp = await clashGet(baseUrl, secret, '/proxies');
    proxies = proxiesResp.proxies || {};
    groupObj = proxies[groupName];
    await writeProxiesRaw({
      updatedAt: ts(),
      group: groupName,
      delayTestUrl: DELAY_TEST_URL,
      delayTestTimeoutMs: DELAY_TEST_TIMEOUT_MS,
      data: proxiesResp
    });
    debugLog(`${ts()} group=${groupName} result=raw-saved path="${PROXIES_RAW_PATH}"`);

    const currentNode = groupObj.now || null;
    const candidates = getCandidates(groupObj, proxies);
    if (candidates.length === 0) {
      throw new Error(`No candidate nodes available in group ${groupName}`);
    }

    let pool = candidates.filter((node) => node !== currentNode && node !== state.lastNode);
    if (pool.length === 0) {
      pool = candidates.filter((node) => node !== currentNode);
    }
    if (pool.length === 0) {
      pool = candidates;
    }
    const orderedCandidates = shuffled(pool);
    let decision = await findAndAcceptNode({
      baseUrl,
      secret,
      groupName,
      candidates: orderedCandidates,
      proxies,
      previousIps,
      oldIp: beforeIp
    });
    let accepted = decision.accepted;

    if (!accepted) {
      historyResetCount += 1;
      await writeState({
        lastIps: [],
        lastNode: state.lastNode || null,
        updatedAt: ts(),
        group: groupName,
        historyResetCount
      });
      console.log(`${ts()} group=${groupName} result=history-reset oldIP=${beforeIp || '-'} nonHkUniqueCount=${decision.nonHkUniqueCount} hkFallbackAllowed=${decision.hkFallbackAllowed} msg="no acceptable candidate found, history cleared and retrying"`);
      decision = await findAndAcceptNode({
        baseUrl,
        secret,
        groupName,
        candidates: orderedCandidates,
        proxies,
        previousIps: [],
        oldIp: beforeIp
      });
      accepted = decision.accepted;
    }

    if (!accepted) {
      console.log(`${ts()} group=${groupName} result=unchanged oldIP=${beforeIp || '-'} nonHkUniqueCount=${decision.nonHkUniqueCount} hkFallbackAllowed=${decision.hkFallbackAllowed} msg="no node matched constraints after history reset retry"`);
      return;
    }

    await clashPut(baseUrl, secret, `/proxies/${encodeURIComponent(groupName)}`, { name: accepted.node });
    await sleep(DISCOVER_SETTLE_MS);

    const historyBase = previousIps.includes(accepted.ip) ? [] : previousIps;
    const newLastIps = [...historyBase, accepted.ip];
    await writeState({
      lastIps: newLastIps,
      lastNode: accepted.node,
      updatedAt: ts(),
      group: groupName,
      historyResetCount
    });

    console.log(formatLog({
      group: groupName,
      attempt: accepted.attempt,
      node: accepted.node,
      oldIp: beforeIp,
      newIp: accepted.ip,
      result: 'success',
      message: `ip switched and accepted, delay=${accepted.delay}ms${accepted.hkFallback ? ', fallback=hong-kong-only' : ''}`
    }));
  }

  async function runCycle(source = 'timer') {
    if (stopping) {
      return { ok: false, error: 'service is stopping' };
    }
    if (cycleRunning) {
      return { ok: false, error: 'rotation cycle already running', busy: true };
    }
    stopCountdown();
    cycleRunning = true;
    cycleNo += 1;
    console.log(`${ts()} service=running cycle=${cycleNo} source=${source} msg="rotation cycle started"`);
    startLoading('获取可用IP中 ');
    let cycleError = null;
    try {
      await rotateOnce();
    } catch (err) {
      cycleError = err;
      console.error(`${ts()} service=running cycle=${cycleNo} result=error msg="${err.message}"`);
    } finally {
      stopLoading();
      cycleRunning = false;
      lastCycleAt = ts();
      if (!stopping) {
        timer = setTimeout(runCycle, ROTATE_INTERVAL_MS);
        nextRunAt = Date.now() + ROTATE_INTERVAL_MS;
        console.log(`${ts()} service=running cycle=${cycleNo} msg="next cycle scheduled in ${ROTATE_INTERVAL_MS}ms"`);
        startCountdown(nextRunAt);
      }
    }
    return { ok: !cycleError, error: cycleError ? cycleError.message : null, cycle: cycleNo };
  }

  function shutdown(signal) {
    if (stopping) {
      return;
    }
    stopping = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    stopCountdown();
    stopLoading();
    if (apiServer) {
      apiServer.close();
      apiServer = null;
    }
    console.log(`${ts()} service=stopping signal=${signal} msg="shutdown requested, no further cycles will be scheduled"`);
    if (!cycleRunning) {
      process.exit(0);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  apiServer = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

    if (requestUrl.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: stopping ? 'stopping' : 'running',
        cycleRunning,
        cycleNo,
        lastCycleAt,
        nextRunAt
      });
      return;
    }

    if (requestUrl.pathname === '/rotate' && req.method === 'POST') {
      if (!isApiAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const result = await runCycle('api');
      if (!result.ok) {
        sendJson(res, result.busy ? 409 : 503, result);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  });

  await new Promise((resolve, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(API_PORT, API_BIND, resolve);
  });
  console.log(`${ts()} service=started msg="api server listening" bind=${API_BIND} port=${API_PORT}`);

  console.log(`${ts()} service=started msg="rotate-ip service started, press Ctrl+C to stop" intervalMs=${ROTATE_INTERVAL_MS}`);
  if (ROTATE_ON_START) {
    await runCycle('startup');
  } else {
    timer = setTimeout(runCycle, ROTATE_INTERVAL_MS);
    nextRunAt = Date.now() + ROTATE_INTERVAL_MS;
    console.log(`${ts()} service=running cycle=0 msg="startup rotation skipped, first cycle scheduled in ${ROTATE_INTERVAL_MS}ms"`);
    startCountdown(nextRunAt);
  }
}

main().catch((err) => {
  console.error(`${ts()} result=error msg="${err.message}"`);
  process.exitCode = 1;
});
