(() => {
  'use strict';

  const links = [...document.querySelectorAll('.help-toc a[href^="#"]')];
  const select = document.querySelector('[data-help-select]');
  const sections = links
    .map((link) => ({
      id: link.hash.slice(1),
      link,
      section: document.getElementById(link.hash.slice(1)),
    }))
    .filter(({ section }) => section);

  if (!sections.length) return;

  const setActive = (active) => {
    sections.forEach(({ id, link }) => {
      const current = id === active.id;
      link.classList.toggle('is-active', current);
      if (current) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    if (select && select.value !== active.id) {
      select.value = active.id;
    }
  };

  const activeForViewport = () => {
    const probe = window.scrollY + Math.max(160, window.innerHeight * 0.28);
    return sections.reduce(
      (current, entry) => (entry.section.offsetTop <= probe ? entry : current),
      sections[0],
    );
  };

  let frame = 0;
  const synchronize = () => {
    frame = 0;
    setActive(activeForViewport());
  };
  const requestSynchronization = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(synchronize);
  };

  select?.addEventListener('change', () => {
    const target = document.getElementById(select.value);
    if (!target) return;
    window.history.replaceState(null, '', `#${select.value}`);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  window.addEventListener('scroll', requestSynchronization, { passive: true });
  window.addEventListener('resize', requestSynchronization, { passive: true });
  requestSynchronization();

  const reduceMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

  const faqControllers = [...document.querySelectorAll('.help-faq details')]
    .map((details) => {
    const summary = details.querySelector('summary');
    const answer = details.querySelector('.help-faq-answer');
    if (!summary || !answer) return null;

    let animation = null;
    let state = details.open ? 'open' : 'closed';

    const open = () => {
      const startHeight = answer.getBoundingClientRect().height;
      const startOpacity = Number.parseFloat(window.getComputedStyle(answer).opacity) || 0;
      animation?.cancel();
      details.open = true;
      state = 'opening';

      if (reduceMotion || typeof answer.animate !== 'function') {
        state = 'open';
        return;
      }

      const targetHeight = answer.scrollHeight;
      animation = answer.animate(
        [
          { height: `${startHeight}px`, opacity: startOpacity },
          { height: `${targetHeight}px`, opacity: 1 },
        ],
        {
          duration: 300,
          easing: 'cubic-bezier(.2, .8, .2, 1)',
        },
      );
      animation.onfinish = () => {
        animation = null;
        state = 'open';
      };
    };

    const close = () => {
      if (state === 'closed') return;

      const startHeight = answer.getBoundingClientRect().height || answer.scrollHeight;
      const startOpacity = Number.parseFloat(window.getComputedStyle(answer).opacity) || 1;
      animation?.cancel();
      state = 'closing';

      if (reduceMotion || typeof answer.animate !== 'function') {
        details.open = false;
        state = 'closed';
        return;
      }

      animation = answer.animate(
        [
          { height: `${startHeight}px`, opacity: startOpacity },
          { height: '0px', opacity: 0 },
        ],
        {
          duration: 240,
          easing: 'cubic-bezier(.4, 0, .2, 1)',
        },
      );
      animation.onfinish = () => {
        animation = null;
        details.open = false;
        state = 'closed';
      };
    };

    return {
      close,
      details,
      isExpanded: () => state === 'open' || state === 'opening',
      open,
      summary,
    };
  })
    .filter(Boolean);

  faqControllers.forEach((controller) => {
    controller.summary.addEventListener('click', (event) => {
      event.preventDefault();
      if (controller.isExpanded()) {
        controller.close();
      } else {
        faqControllers.forEach((other) => {
          if (other !== controller) other.close();
        });
        controller.open();
      }
    });
  });
})();
