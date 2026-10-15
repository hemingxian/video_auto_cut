(() => {
  'use strict';

  const HEADER_SCROLL_THRESHOLD = 24;
  const NAV_ARRIVAL_THRESHOLD = 28;
  const NAV_LOCK_TIMEOUT_MS = 1300;
  const RELEASE_MANIFEST_URL =
    'https://auto-cut-public-package-1453657051.cos.ap-chengdu.myqcloud.com/updates/latest.yml';
  const RELEASE_CACHE_KEY = 'videoautocut.release.v1';

  const yamlValue = (value) => {
    const trimmed = value.trim();
    const quote = trimmed[0];
    return trimmed.length > 1 && quote === trimmed.at(-1) && (quote === '"' || quote === "'")
      ? trimmed.slice(1, -1)
      : trimmed;
  };

  const normalizeRelease = (release) => {
    if (
      !release ||
      typeof release.version !== 'string' ||
      !release.version.trim() ||
      typeof release.path !== 'string' ||
      !release.path.trim() ||
      !Number.isSafeInteger(release.size) ||
      release.size <= 0
    ) {
      throw new Error('发布信息缺少必要字段');
    }

    return {
      version: release.version.trim(),
      path: release.path.trim(),
      size: release.size,
      ...(typeof release.releaseDate === 'string' ? { releaseDate: release.releaseDate } : {}),
    };
  };

  const parseReleaseManifest = (text) => {
    const release = {};

    text.split(/\r?\n/).forEach((line) => {
      const field = line.match(/^([a-zA-Z][\w]*):\s*(.+?)\s*$/);
      if (field && ['version', 'path', 'releaseDate'].includes(field[1])) {
        release[field[1]] = yamlValue(field[2]);
      }

      const size = line.match(/^\s+size:\s*(\d+)\s*$/);
      if (size && !release.size) release.size = Number(size[1]);
    });

    return normalizeRelease(release);
  };

  const releaseDownloadUrl = (filePath) => {
    const manifestUrl = new window.URL(RELEASE_MANIFEST_URL);
    const downloadUrl = new window.URL(filePath, manifestUrl);
    const updatePath = manifestUrl.pathname.slice(0, manifestUrl.pathname.lastIndexOf('/') + 1);

    if (
      downloadUrl.origin !== manifestUrl.origin ||
      !downloadUrl.pathname.startsWith(updatePath) ||
      !downloadUrl.pathname.toLowerCase().endsWith('.exe')
    ) {
      throw new Error('发布清单中的下载地址无效');
    }
    return downloadUrl.href;
  };

  const formatReleaseSize = (bytes) => `约 ${(bytes / 1024 / 1024).toFixed(1)} MB`;

  const updateReleaseDownloadState = ({ href, label, disabled }) => {
    document.querySelectorAll('[data-release-download]').forEach((element) => {
      element.textContent = label;
      if (href) {
        element.setAttribute('href', href);
      } else {
        element.removeAttribute('href');
      }
      if (disabled) {
        element.setAttribute('aria-disabled', 'true');
      } else {
        element.removeAttribute('aria-disabled');
      }
    });
  };

  const markReleaseInfoUnavailable = () => {
    document.querySelectorAll('[data-release-version]').forEach((element) => {
      element.textContent = '暂不可用';
    });
    document.querySelectorAll('[data-release-size]').forEach((element) => {
      element.textContent = '暂不可用';
    });
    updateReleaseDownloadState({ label: '下载信息暂不可用', disabled: true });
  };

  const applyReleaseInfo = (release) => {
    const downloadUrl = releaseDownloadUrl(release.path);
    document.querySelectorAll('[data-release-version]').forEach((element) => {
      element.textContent = `v${release.version}`;
    });
    document.querySelectorAll('[data-release-size]').forEach((element) => {
      element.textContent = formatReleaseSize(release.size);
    });
    updateReleaseDownloadState({
      href: downloadUrl,
      label: '下载 Windows 安装包',
      disabled: false,
    });
  };

  const readCachedRelease = () => {
    try {
      const cached = window.localStorage?.getItem(RELEASE_CACHE_KEY);
      if (!cached) return null;
      const release = normalizeRelease(JSON.parse(cached));
      releaseDownloadUrl(release.path);
      return release;
    } catch {
      try {
        window.localStorage?.removeItem(RELEASE_CACHE_KEY);
      } catch {
        // Storage may be unavailable in private browsing or restricted contexts.
      }
      return null;
    }
  };

  const cacheRelease = (release) => {
    try {
      window.localStorage?.setItem(RELEASE_CACHE_KEY, JSON.stringify(release));
    } catch {
      // The live release remains usable even when browser storage is unavailable.
    }
  };

  const initializeReleaseInfo = async () => {
    if (typeof window.URL !== 'function') return;

    const cachedRelease = readCachedRelease();
    if (cachedRelease) applyReleaseInfo(cachedRelease);
    if (typeof window.fetch !== 'function') return;

    try {
      const response = await window.fetch(RELEASE_MANIFEST_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`发布清单请求失败：HTTP ${response.status}`);

      const release = parseReleaseManifest(await response.text());
      applyReleaseInfo(release);
      cacheRelease(release);
    } catch (error) {
      if (!cachedRelease) markReleaseInfoUnavailable();
      console.warn(
        cachedRelease
          ? '无法从 COS 更新官网发布信息，继续使用上次成功获取的信息。'
          : '无法从 COS 获取官网发布信息。',
        error,
      );
    }
  };

  const initializeNavigation = () => {
    const header = document.querySelector('[data-header]');
    const nav = document.querySelector('.nav');
    const indicator = nav?.querySelector('.nav-indicator');
    const links = nav ? [...nav.querySelectorAll('a[href^="#"]')] : [];
    const entries = links
      .map((link) => {
        const targetId = link.hash.slice(1);
        return { link, section: targetId ? document.getElementById(targetId) : null };
      })
      .filter(({ section }) => section);
    const prefersReducedMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

    let animationFrame = 0;
    let lockedEntry = null;
    let unlockTimer = 0;

    const updateIndicator = (link) => {
      if (!nav || !indicator || window.getComputedStyle(nav).display === 'none') return false;

      const navRect = nav.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      if (!navRect.width || !linkRect.width) return false;

      const width = Math.round(linkRect.width * 0.62);
      const x = Math.round(linkRect.left - navRect.left + (linkRect.width - width) / 2);
      const y = Math.round(navRect.height - 7);

      nav.style.setProperty('--indicator-x', `${x}px`);
      nav.style.setProperty('--indicator-y', `${y}px`);
      nav.style.setProperty('--indicator-w', `${width}px`);
      return true;
    };

    const setActiveEntry = (activeEntry) => {
      entries.forEach(({ link }) => {
        const isActive = link === activeEntry.link;
        link.classList.toggle('active', isActive);
        link.classList.toggle('active-link', isActive);
        if (isActive) {
          link.setAttribute('aria-current', 'page');
        } else {
          link.removeAttribute('aria-current');
        }
      });
      const positioned = updateIndicator(activeEntry.link);
      if (positioned && !nav?.classList.contains('is-ready')) {
        nav.getBoundingClientRect();
        nav.classList.add('is-ready');
      }
    };

    const activeEntryForScrollPosition = () => {
      const probe = window.scrollY + Math.max(140, window.innerHeight * 0.34);
      return entries.reduce(
        (current, entry) => (entry.section.offsetTop <= probe ? entry : current),
        entries[0],
      );
    };

    const entryForLocationHash = () =>
      entries.find(({ link }) => link.hash === window.location.hash);

    const synchronizeViewportState = (preferLocationHash = false) => {
      animationFrame = 0;
      header?.classList.toggle('is-scrolled', window.scrollY > HEADER_SCROLL_THRESHOLD);
      if (!entries.length) return;

      if (lockedEntry) {
        setActiveEntry(lockedEntry);
        if (Math.abs(lockedEntry.section.getBoundingClientRect().top) > NAV_ARRIVAL_THRESHOLD) {
          return;
        }
        lockedEntry = null;
      }

      setActiveEntry(
        (preferLocationHash ? entryForLocationHash() : null) ??
        activeEntryForScrollPosition(),
      );
    };

    const requestViewportSynchronization = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(synchronizeViewportState);
    };

    entries.forEach((entry) => {
      entry.link.addEventListener('click', (event) => {
        event.preventDefault();
        lockedEntry = entry;
        window.clearTimeout(unlockTimer);
        setActiveEntry(entry);
        window.history.replaceState(null, '', entry.link.hash);
        window.requestAnimationFrame(() => {
          entry.section.scrollIntoView({
            behavior: prefersReducedMotion ? 'auto' : 'smooth',
            block: 'start',
          });
        });
        unlockTimer = window.setTimeout(() => {
          lockedEntry = null;
          requestViewportSynchronization();
        }, NAV_LOCK_TIMEOUT_MS);
      });
    });

    window.addEventListener('scroll', requestViewportSynchronization, { passive: true });
    window.addEventListener('resize', requestViewportSynchronization, { passive: true });
    window.addEventListener('pagehide', () => {
      nav?.classList.remove('is-ready');
    });
    window.addEventListener('pageshow', () => {
      nav?.classList.remove('is-ready');
      window.requestAnimationFrame(() => synchronizeViewportState(true));
    });
    requestViewportSynchronization();
  };

  const initializeRevealAnimations = () => {
    const items = [...document.querySelectorAll('.reveal')];
    if (!items.length) return;

    const reveal = (item) => item.classList.add('is-visible');
    if (!('IntersectionObserver' in window)) {
      items.forEach(reveal);
      return;
    }

    const observer = new IntersectionObserver(
      (observations) => {
        observations.forEach((observation) => {
          if (!observation.isIntersecting) return;
          reveal(observation.target);
          observer.unobserve(observation.target);
        });
      },
      { threshold: 0.14 },
    );

    items.forEach((item) => observer.observe(item));
    window.requestAnimationFrame(() => {
      items.forEach((item) => {
        const bounds = item.getBoundingClientRect();
        if (bounds.top < window.innerHeight && bounds.bottom > 0) {
          reveal(item);
          observer.unobserve(item);
        }
      });
    });
  };

  initializeNavigation();
  initializeRevealAnimations();
  initializeReleaseInfo();
})();
