const BASE_URL = 'https://cx.indianoil.in';
const PAGE_URL = `${BASE_URL}/EPICIOCL/faces/GrievanceMainPage.jspx`;
const TIMEOUT = 25000;
const UA = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.137 Mobile Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en,en-IN;q=0.9,en-US;q=0.8',
  'Connection': 'keep-alive',
  'sec-ch-ua-platform': '"Android"',
  'sec-ch-ua': '"Android WebView";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'sec-ch-ua-mobile': '?1',
  'X-Requested-With': 'org.telegram.messenger',
};

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  set(name, value) {
    this.cookies.set(name, value);
  }
  get(name) {
    return this.cookies.get(name);
  }
  header() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  absorb(response) {
    const raw = response.headers.get('set-cookie');
    if (!raw) return;
    const parts = raw.split(/,(?=[^;]+=[^;]+)/);
    for (const line of parts) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }
}

async function httpRequest(url, { method = 'GET', body = null, extraHeaders = {}, jar = null } = {}) {
  const headers = { ...DEFAULT_HEADERS, ...extraHeaders };
  if (jar) {
    const c = jar.header();
    if (c) headers['Cookie'] = c;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (jar) jar.absorb(res);
    const text = await res.text();
    return { status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseLoopback(html) {
  const m = html.match(/AdfLoopbackUtils\.runLoopback\((.*?)\);/s);
  if (!m) throw new Error('could not find adf loopback script in initial page');

  const argRegex = /'([^']*)'|"([^"]*)"|(\d+)|(true|false)/g;
  const args = [];
  let match;
  while ((match = argRegex.exec(m[1])) !== null) {
    args.push(match[1] || match[2] || match[3] || match[4] || '');
  }

  return {
    afrLoop: args[2] || '',
    windowId: args[7] || '',
    jsessionid: args[8] || '',
  };
}

function parseViewState(html) {
  const m = html.match(/name="javax\.faces\.ViewState"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

function parsePageId(html) {
  const m = html.match(/AdfPage\.PAGE\.setPageId\('([^']+)'\)/);
  return m ? m[1] : null;
}

function parseXmlRedirect(xml) {
  const m = xml.match(/<redirect url="([^"]+)"/);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseRedirectCookies(xml, jar) {
  const m = xml.match(/<redirectCookie>(.*?)<\/redirectCookie>/s);
  if (!m) return;

  const expires = new Date(Date.now() + 30000).toUTCString();
  const parts = m[1].trim().split('$$');

  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    part = part.replace(/\$exp\$/g, expires);
    const cookieStr = part.split(';')[0].trim();
    const idx = cookieStr.indexOf('=');
    if (idx === -1) continue;
    const name = cookieStr.slice(0, idx).trim();
    const value = cookieStr.slice(idx + 1).trim();
    if (name) jar.set(name, value);
  }
}

class IOCLFetcher {
  constructor() {
    this.jar = new CookieJar();
    this.windowId = null;
    this.viewState = null;
    this.pageId = null;
  }

  async get(url, extraHeaders = {}) {
    const { status, body } = await httpRequest(url, {
      method: 'GET',
      extraHeaders,
      jar: this.jar,
    });
    if (status >= 400) throw new Error(`http ${status} for ${url}`);
    return body;
  }

  async post(url, data, extraHeaders = {}) {
    const body = new URLSearchParams(data).toString();
    const { status, body: responseBody } = await httpRequest(url, {
      method: 'POST',
      body,
      extraHeaders: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Adf-Rich-Message': 'true',
        'Accept': '*/*',
        'Origin': BASE_URL,
        'Referer': PAGE_URL,
        'Adf-Ads-Page-Id': '8',
        ...extraHeaders,
      },
      jar: this.jar,
    });
    if (status >= 400) throw new Error(`http ${status} for ${url}`);
    return responseBody;
  }

  async adfPost(eventSource, extraFields = {}) {
    const url = `${PAGE_URL}?Adf-Window-Id=${this.windowId}&Adf-Page-Id=${this.pageId}`;

    const data = { ...extraFields };
    data['org.apache.myfaces.trinidad.faces.FORM'] = 'f1';
    data['Adf-Window-Id'] = this.windowId;
    data['javax.faces.ViewState'] = this.viewState;
    data['Adf-Page-Id'] = this.pageId;
    data['event'] = eventSource;
    data[`event.${eventSource}`] = '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>';
    data['oracle.adf.view.rich.PROCESS'] = `pt1:r1,${eventSource}`;

    return this.post(url, data);
  }

  async followAdfRedirect(xml) {
    const redirectPath = parseXmlRedirect(xml);
    if (!redirectPath) {
      throw new Error('no redirect url found in adf response');
    }
    parseRedirectCookies(xml, this.jar);
    const body = await this.get(BASE_URL + redirectPath);
    this.viewState = parseViewState(body) || this.viewState;
    this.pageId = parsePageId(body) || this.pageId;
    return body;
  }

  async setupSession() {
    const body = await this.get(PAGE_URL);
    const lb = parseLoopback(body);
    this.windowId = lb.windowId;

    let redirectUrl = PAGE_URL;
    if (lb.jsessionid.startsWith(';')) {
      redirectUrl += lb.jsessionid;
    }

    const params = new URLSearchParams({
      _afrLoop: lb.afrLoop,
      _afrWindowMode: '2',
      'Adf-Window-Id': this.windowId,
    });
    redirectUrl += '?' + params.toString();

    const body2 = await this.get(redirectUrl);
    this.viewState = parseViewState(body2);
    this.pageId = parsePageId(body2);

    if (!this.viewState) {
      throw new Error('failed to obtain viewstate from session setup');
    }
  }

  async navigateToForm() {
    let xml = await this.adfPost('pt1:r1:0:cil2');
    await this.followAdfRedirect(xml);
    await sleep(250);

    xml = await this.adfPost('pt1:r1:0:i1:8:l1111');
    await this.followAdfRedirect(xml);
    await sleep(250);

    xml = await this.adfPost('pt1:r1:0:i2:0:l1311');
    return this.followAdfRedirect(xml);
  }

  async submitMobile(mobile) {
    const fields = {
      'pt1:r1:0:it2111': mobile,
      'pt1:r1:0:it1': '',
      'pt1:r1:0:it2': '',
      'pt1:r1:0:it3': '',
      'pt1:r1:0:it4': '',
      'pt1:r1:0:it211': '',
      'pt1:r1:0:it41ee1': '',
      'pt1:r1:0:it211111': '',
      'pt1:r1:0:it41ee1BLK': '',
    };
    const xml = await this.adfPost('pt1:r1:0:b11112', fields);
    return this.followAdfRedirect(xml);
  }

  async fetch(mobile) {
    await this.setupSession();
    await this.navigateToForm();
    const html = await this.submitMobile(mobile);
    return parseResults(html);
  }
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSpan(html, spanId) {
  const pattern = new RegExp(`id="${escapeRegex(spanId)}"[^>]*>(.*?)<\\/span>`, 's');
  const m = html.match(pattern);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]+>/g, '').trim());
}

function extractInputValue(html, inputName) {
  const pattern = new RegExp(`name="${escapeRegex(inputName)}"[^>]*value="([^"]*)"`);
  const m = html.match(pattern);
  return m ? decodeEntities(m[1]) : '';
}

function extractSelectValue(html, selectId) {
  const pattern = new RegExp(`id="${escapeRegex(selectId)}"[^>]*>(.*?)<\\/select>`, 's');
  const m = html.match(pattern);
  if (!m) return '';
  const opt = m[1].match(/<option[^>]*selected[^>]*>(.*?)<\/option>/s);
  if (!opt) return '';
  return decodeEntities(opt[1].replace(/<[^>]+>/g, '').trim());
}

function parseResults(html) {
  const result = {
    first_name: extractInputValue(html, 'pt1:r1:0:it7'),
    last_name: extractInputValue(html, 'pt1:r1:0:it21'),
    mobile: extractInputValue(html, 'pt1:r1:0:it22'),
    email: extractInputValue(html, 'pt1:r1:0:it23'),
    address: extractInputValue(html, 'pt1:r1:0:it25'),
    pincode: extractInputValue(html, 'pt1:r1:0:it3'),
    state: extractInputValue(html, 'pt1:r1:0:it4'),
    district: extractInputValue(html, 'pt1:r1:0:it5'),
    distributor: extractSelectValue(html, 'pt1:r1:0:soc2::content'),
    orders: [],
  };

  const rowMatches = [...html.matchAll(/_afrRK="(\d+)"/g)];
  const seen = new Set();

  for (const match of rowMatches) {
    const rowIdx = match[1];
    if (seen.has(rowIdx)) continue;
    seen.add(rowIdx);

    const prefix = `pt1:r1:0:t1:${rowIdx}:`;
    const order = {
      s_no: extractSpan(html, `${prefix}ot1211`),
      order_number: extractSpan(html, `${prefix}ot111`),
      order_date: extractSpan(html, `${prefix}ot211`),
      cyl_quantity: extractSpan(html, `${prefix}ot311`),
      delivery_date: extractSpan(html, `${prefix}ot21111`),
      subsidy_amount: extractSpan(html, `${prefix}ot21155`),
      cash_memo_no: extractSpan(html, `${prefix}ot211110`),
      cash_memo_date: extractSpan(html, `${prefix}ot211119`),
      subsidy_status: extractSpan(html, `${prefix}ot21116`),
      bank_dos: extractSpan(html, `${prefix}ot21114`),
      bank_account: extractSpan(html, `${prefix}ot21113`),
      bank_name: extractSpan(html, `${prefix}ot5`),
    };
    if (order.order_number) result.orders.push(order);
  }

  return result;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  setCors(res);
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(payload, null, 2));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, {
      success: false,
      error: 'method not allowed',
      allowed: ['GET', 'OPTIONS'],
    });
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');

  if (path === 'health') {
    sendJson(res, 200, {
      success: true,
      status: 'ok',
      service: 'iocl-api',
      timestamp: new Date().toISOString(),
      runtime: {
        node: process.version,
        region: process.env.VERCEL_REGION || 'local',
        environment: process.env.VERCEL_ENV || 'development',
      },
    });
    return;
  }

  if (path !== '' && path !== 'lpg') {
    sendJson(res, 404, {
      success: false,
      error: 'route not found',
      route: `/api/${path}`,
      available: ['/api', '/api/lpg?lpg_num=...', '/api/health'],
    });
    return;
  }

  const lpgNum = (url.searchParams.get('lpg_num') || url.searchParams.get('mobile') || '').trim();

  if (!lpgNum) {
    sendJson(res, 400, {
      success: false,
      error: 'missing required parameter: lpg_num',
      usage: '/api/lpg?lpg_num=9876543210',
    });
    return;
  }

  if (!/^\d{10}$/.test(lpgNum)) {
    sendJson(res, 400, {
      success: false,
      error: 'invalid mobile number, must be 10 digits',
    });
    return;
  }

  try {
    const fetcher = new IOCLFetcher();
    const data = await fetcher.fetch(lpgNum);

    if (!data.first_name && !data.mobile && !data.address && data.orders.length === 0) {
      sendJson(res, 404, {
        success: false,
        error: 'no customer data found for this mobile number',
        mobile: lpgNum,
      });
      return;
    }

    sendJson(res, 200, { success: true, data });
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown error';
    const isTimeout = message.includes('aborted') || message.includes('timeout');
    sendJson(res, isTimeout ? 504 : 500, {
      success: false,
      error: isTimeout ? 'upstream timeout' : 'fetch failed',
      message,
    });
  }
}
