import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const siteScript = await readFile(new URL('../assets/site.js', import.meta.url), 'utf8');
const siteHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const helpHtml = await readFile(new URL('../help/index.html', import.meta.url), 'utf8');
const siteCss = await readFile(new URL('../assets/site.css', import.meta.url), 'utf8');
const sectionIds = ['top', 'pipeline', 'vision', 'download'];

class FakeClassList {
  constructor(tokens = []) {
    this.tokens = new Set(tokens);
  }

  add(token) {
    this.tokens.add(token);
  }

  contains(token) {
    return this.tokens.has(token);
  }

  remove(token) {
    this.tokens.delete(token);
  }

  toggle(token, force) {
    const enabled = force ?? !this.contains(token);
    if (enabled) {
      this.add(token);
    } else {
      this.tokens.delete(token);
    }
    return enabled;
  }
}

class FakeElement {
  constructor(viewport, { hash = '', top = 0, left = 0, width = 100, classes = [] } = {}) {
    this.viewport = viewport;
    this.hash = hash;
    this.top = top;
    this.offsetTop = top;
    this.left = left;
    this.width = width;
    this.classList = new FakeClassList(classes);
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {
      properties: new Map(),
      setProperty: (name, value) => this.style.properties.set(name, value),
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  getBoundingClientRect() {
    const top = this.top - this.viewport.scrollY;
    return {
      top,
      bottom: top + 100,
      left: this.left,
      width: this.width,
      height: 40,
    };
  }

  scrollIntoView(options) {
    this.scrollOptions = options;
  }
}

function createHarness({
  hasHeader = true,
  hasNavigation = true,
  hasIntersectionObserver = true,
  releaseManifest = null,
  releaseStatus = 200,
  cachedRelease = null,
  prefersReducedMotion = false,
  revealTops = [50, 2_000],
} = {}) {
  const viewport = { scrollY: 0 };
  const header = hasHeader ? new FakeElement(viewport) : null;
  const indicator = new FakeElement(viewport);
  const sections = new Map(
    sectionIds.map((id, index) => [id, new FakeElement(viewport, { top: index * 500 })]),
  );
  const links = sectionIds.map(
    (id, index) => new FakeElement(viewport, { hash: `#${id}`, left: index * 110 }),
  );
  const linksBySection = new Map(sectionIds.map((id, index) => [id, links[index]]));
  const revealItems = revealTops.map(
    (top) => new FakeElement(viewport, { top, classes: ['reveal'] }),
  );
  const releaseVersions = [new FakeElement(viewport), new FakeElement(viewport)];
  const releaseSizes = [new FakeElement(viewport)];
  const releaseDownloads = [new FakeElement(viewport)];
  releaseVersions.forEach((element) => { element.textContent = '获取中…'; });
  releaseSizes[0].textContent = '获取中…';
  releaseDownloads[0].textContent = '下载 Windows 安装包';
  releaseDownloads[0].setAttribute('aria-disabled', 'true');
  const nav = hasNavigation ? new FakeElement(viewport, { width: 500 }) : null;

  if (nav) {
    nav.querySelector = (selector) => (selector === '.nav-indicator' ? indicator : null);
    nav.querySelectorAll = (selector) => (selector === 'a[href^="#"]' ? links : []);
  }

  const animationFrames = [];
  const fetchRequests = [];
  const warnings = [];
  const windowListeners = new Map();
  let nextAnimationFrameId = 1;
  let nextTimerId = 1;
  const location = { hash: '' };
  const storage = new Map();
  if (cachedRelease) {
    storage.set('videoautocut.release.v1', JSON.stringify(cachedRelease));
  }

  const window = {
    scrollY: 0,
    innerHeight: 800,
    location,
    URL,
    localStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    history: {
      hash: '',
      replaceState(_state, _title, hash) {
        this.hash = hash;
        location.hash = hash;
      },
    },
    matchMedia() {
      return { matches: prefersReducedMotion };
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return nextAnimationFrameId++;
    },
    setTimeout() {
      return nextTimerId++;
    },
    clearTimeout() {},
    getComputedStyle() {
      return { display: 'block' };
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
  };

  if (releaseManifest !== null) {
    window.fetch = async (url, options) => {
      fetchRequests.push({ url, options });
      return {
        ok: releaseStatus >= 200 && releaseStatus < 300,
        status: releaseStatus,
        text: async () => releaseManifest,
      };
    };
  }

  const document = {
    querySelector(selector) {
      if (selector === '[data-header]') return header;
      if (selector === '.nav') return nav;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.reveal') return revealItems;
      if (selector === '[data-release-version]') return releaseVersions;
      if (selector === '[data-release-size]') return releaseSizes;
      if (selector === '[data-release-download]') return releaseDownloads;
      return [];
    },
    getElementById(id) {
      return sections.get(id) ?? null;
    },
  };

  class MockIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
    }

    observe(element) {
      this.observed.add(element);
    }

    unobserve(element) {
      this.observed.delete(element);
    }
  }

  if (hasIntersectionObserver) {
    window.IntersectionObserver = MockIntersectionObserver;
  }

  const dispatchWindowEvent = (type, event = {}) => {
    for (const listener of windowListeners.get(type) ?? []) {
      listener(event);
    }
  };

  const flushAnimationFrames = () => {
    let batches = 0;
    while (animationFrames.length) {
      if (batches++ > 20) throw new Error('Animation frame queue did not settle');
      const callbacks = animationFrames.splice(0);
      callbacks.forEach((callback) => callback());
    }
  };

  const run = () => {
    const context = {
      console: { warn: (...args) => warnings.push(args) },
      document,
      window,
    };
    if (hasIntersectionObserver) {
      context.IntersectionObserver = MockIntersectionObserver;
    }
    vm.runInNewContext(siteScript, context, { filename: 'assets/site.js' });
  };

  const setScrollY = (scrollY) => {
    viewport.scrollY = scrollY;
    window.scrollY = scrollY;
  };

  return {
    dispatchWindowEvent,
    fetchRequests,
    flushAnimationFrames,
    header,
    linksBySection,
    nav,
    revealItems,
    releaseDownloads,
    releaseSizes,
    releaseVersions,
    run,
    sections,
    setScrollY,
    settle: () => new Promise((resolve) => setImmediate(resolve)),
    storedRelease: () => storage.get('videoautocut.release.v1') ?? null,
    warnings,
    window,
  };
}

test('release markup exposes all dynamic bindings', () => {
  assert.equal((siteHtml.match(/data-release-version/g) ?? []).length, 2);
  assert.match(siteHtml, /data-release-size/);
  assert.match(siteHtml, /data-release-download/);
  assert.match(siteHtml, /assets\/site\.js\?v=\d{8}-\d+/);
  assert.match(helpHtml, /assets\/site\.js\?v=\d{8}-\d+/);
  assert.doesNotMatch(siteHtml, /VideoAutoCutStudioUserSetup-x64-[\d.]+\.exe/);
  assert.doesNotMatch(siteHtml, />v\d+\.\d+\.\d+</);
});

test('homepage links to the standalone help guide', () => {
  assert.match(siteHtml, /<a href="\.\/help\/">使用帮助<\/a>/);
  assert.match(helpHtml, /<a class="active active-link" href="#guide">使用帮助<\/a>/);
  assert.match(siteCss, /\.nav\.is-ready \.nav-indicator/);
});

test('homepage and help guide expose the support email', () => {
  const contactLink = /href="mailto:sales@evsrobot\.com">(?:发送邮件：)?sales@evsrobot\.com<\/a>/;

  assert.match(siteHtml, contactLink);
  assert.equal((helpHtml.match(/mailto:sales@evsrobot\.com/g) ?? []).length, 2);
  assert.match(helpHtml, contactLink);
});

test('help guide exposes the complete user workflow', () => {
  const requiredSections = [
    'before-start',
    'quick-start',
    'scripts',
    'material-settings',
    'shots',
    'generation',
    'materials',
    'history',
    'voice',
    'settings',
    'troubleshooting',
  ];

  requiredSections.forEach((id) => {
    assert.match(helpHtml, new RegExp(`id="${id}"`));
  });
  assert.match(helpHtml, /data-help-select/);
  assert.match(helpHtml, /data-release-version/);
  assert.match(helpHtml, /<a href="\.\.\/index\.html#download">下载<\/a>/);
  assert.match(helpHtml, /<title>使用帮助 - VideoAutoCut Studio<\/title>/);
});

test('release manifest updates version, size, and download URL', async () => {
  const page = createHarness({
    releaseManifest: [
      'version: 0.5.0',
      'files:',
      '  - url: VideoAutoCutStudioUserSetup-x64-0.5.0.exe',
      '    size: 104857600',
      'path: VideoAutoCutStudioUserSetup-x64-0.5.0.exe',
      "releaseDate: '2026-07-16T08:00:00.000Z'",
    ].join('\n'),
  });

  page.run();
  await page.settle();

  assert.equal(page.fetchRequests.length, 1);
  assert.equal(page.fetchRequests[0].options.cache, 'no-store');
  assert.equal(page.releaseVersions.every((element) => element.textContent === 'v0.5.0'), true);
  assert.equal(page.releaseSizes[0].textContent, '约 100.0 MB');
  assert.equal(
    page.releaseDownloads[0].getAttribute('href'),
    'https://auto-cut-public-package-1453657051.cos.ap-chengdu.myqcloud.com/updates/VideoAutoCutStudioUserSetup-x64-0.5.0.exe',
  );
  assert.equal(page.releaseDownloads[0].getAttribute('aria-disabled'), undefined);
  assert.equal(page.releaseDownloads[0].textContent, '下载 Windows 安装包');
  assert.deepEqual(JSON.parse(page.storedRelease()), {
    version: '0.5.0',
    path: 'VideoAutoCutStudioUserSetup-x64-0.5.0.exe',
    size: 104857600,
    releaseDate: '2026-07-16T08:00:00.000Z',
  });
  assert.equal(page.warnings.length, 0);
});

test('failed release request keeps the last successful release information', async () => {
  const page = createHarness({
    releaseManifest: '',
    releaseStatus: 503,
    cachedRelease: {
      version: '0.4.9',
      path: 'VideoAutoCutStudioUserSetup-x64-0.4.9.exe',
      size: 94371840,
    },
  });

  page.run();
  await page.settle();

  assert.equal(page.releaseVersions.every((element) => element.textContent === 'v0.4.9'), true);
  assert.equal(page.releaseSizes[0].textContent, '约 90.0 MB');
  assert.equal(
    page.releaseDownloads[0].getAttribute('href'),
    'https://auto-cut-public-package-1453657051.cos.ap-chengdu.myqcloud.com/updates/VideoAutoCutStudioUserSetup-x64-0.4.9.exe',
  );
  assert.equal(page.releaseDownloads[0].getAttribute('aria-disabled'), undefined);
  assert.equal(page.warnings.length, 1);
});

test('invalid release manifests do not expose stale release information', async () => {
  const page = createHarness({
    releaseManifest: [
      'version: 0.5.0',
      'files:',
      '  - url: installer.exe',
      '    size: 104857600',
      'path: https://example.com/installer.exe',
    ].join('\n'),
  });

  page.run();
  await page.settle();

  assert.equal(page.releaseVersions[0].textContent, '暂不可用');
  assert.equal(page.releaseSizes[0].textContent, '暂不可用');
  assert.equal(page.releaseDownloads[0].getAttribute('href'), undefined);
  assert.equal(page.releaseDownloads[0].getAttribute('aria-disabled'), 'true');
  assert.equal(page.releaseDownloads[0].textContent, '下载信息暂不可用');
  assert.equal(page.warnings.length, 1);
});

test('initializes safely when optional page elements are absent', () => {
  const page = createHarness({
    hasHeader: false,
    hasNavigation: false,
    revealTops: [],
  });

  assert.doesNotThrow(() => {
    page.run();
    page.flushAnimationFrames();
  });
});

test('navigation click updates URL, ARIA state, and scroll target', () => {
  const page = createHarness();
  page.run();
  page.flushAnimationFrames();

  assert.equal(page.linksBySection.get('top').getAttribute('aria-current'), 'page');
  assert.equal(page.linksBySection.get('download').getAttribute('aria-current'), undefined);

  const clickEvent = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  page.linksBySection.get('download').dispatch('click', clickEvent);
  page.flushAnimationFrames();

  assert.equal(clickEvent.defaultPrevented, true);
  assert.equal(page.window.history.hash, '#download');
  assert.equal(page.linksBySection.get('download').getAttribute('aria-current'), 'page');
  assert.equal(page.linksBySection.get('top').getAttribute('aria-current'), undefined);
  assert.equal(page.sections.get('download').scrollOptions.behavior, 'smooth');
  assert.equal(page.sections.get('download').scrollOptions.block, 'start');
});

test('scroll synchronizes the sticky header and active navigation item', () => {
  const page = createHarness();
  page.run();
  page.flushAnimationFrames();

  assert.equal(page.header.classList.contains('is-scrolled'), false);

  page.setScrollY(900);
  page.dispatchWindowEvent('scroll');
  page.flushAnimationFrames();

  assert.equal(page.header.classList.contains('is-scrolled'), true);
  assert.equal(page.linksBySection.get('vision').getAttribute('aria-current'), 'page');
  assert.equal(page.linksBySection.get('top').getAttribute('aria-current'), undefined);
});

test('page restore positions the indicator without carrying its previous transition state', () => {
  const page = createHarness();
  page.run();
  page.flushAnimationFrames();

  assert.equal(page.nav.classList.contains('is-ready'), true);

  page.window.location.hash = '#download';
  page.dispatchWindowEvent('pagehide');
  assert.equal(page.nav.classList.contains('is-ready'), false);

  page.dispatchWindowEvent('pageshow');
  page.flushAnimationFrames();

  assert.equal(page.linksBySection.get('download').getAttribute('aria-current'), 'page');
  assert.equal(page.nav.classList.contains('is-ready'), true);
});

test('reveals all content when IntersectionObserver is unavailable', () => {
  const page = createHarness({ hasIntersectionObserver: false });

  page.run();

  assert.ok(page.revealItems.length > 0);
  assert.equal(
    page.revealItems.every((item) => item.classList.contains('is-visible')),
    true,
  );
});
