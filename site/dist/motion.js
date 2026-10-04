"use strict";

// Motion is progressive enhancement. Content is visible before JavaScript runs.
(() => {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const active = new Map();
  const busy = new Set();
  const revealed = new WeakSet();
  const revealTargets = document.querySelectorAll('.intro, .loom, .threshold > div, section > h2, .steps article, .install-grid > div, .compat, .limits > div');
  let entryObserver = null, activeObserver = null, busyObserver = null;
  const inView = element => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  };
  const cancel = element => {
    const animation = active.get(element);
    if (!animation) return;
    active.delete(element);
    element.removeAttribute('data-motion-active');
    activeObserver?.unobserve(element);
    animation.cancel();
  };
  const cancelAll = () => [...active.keys()].forEach(cancel);
  function animate(element, { duration = 200, distance = 4, delay = 0, opacity = .55 } = {}) {
    if (!element) return;
    cancel(element);
    if (preference.matches || document.hidden || !inView(element) || !element.animate) return;
    const animation = element.animate([
      { opacity, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration, delay, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'none' });
    active.set(element, animation);
    element.setAttribute('data-motion-active', 'true');
    activeObserver?.observe(element);
    const release = () => {
      if (active.get(element) !== animation) return;
      active.delete(element);
      element.removeAttribute('data-motion-active');
      activeObserver?.unobserve(element);
    };
    animation.finished.then(release, release);
  }
  function stop() {
    cancelAll();
    entryObserver?.disconnect();
    activeObserver?.disconnect();
    busyObserver?.disconnect();
    for (const element of busy) element.classList.remove('is-visible-busy');
    entryObserver = activeObserver = busyObserver = null;
  }
  function start() {
    stop();
    if (preference.matches || document.hidden || !('IntersectionObserver' in window)) return;
    activeObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (!entry.isIntersecting) cancel(entry.target);
    });
    busyObserver = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.classList.toggle('is-visible-busy', entry.isIntersecting && busy.has(entry.target) && !document.hidden && !preference.matches);
    });
    for (const element of busy) busyObserver.observe(element);
    entryObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entryObserver.unobserve(entry.target);
        if (revealed.has(entry.target)) continue;
        revealed.add(entry.target);
        const isStep = entry.target.matches('.steps article');
        const index = isStep ? [...entry.target.parentElement.children].indexOf(entry.target) : 0;
        animate(entry.target, { duration: 420, distance: 10, opacity: .3, delay: isStep ? index * 45 : 0 });
      }
    }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
    for (const element of revealTargets) if (!revealed.has(element)) entryObserver.observe(element);
  }
  document.querySelectorAll('details').forEach(details => {
    details.addEventListener('toggle', () => {
      for (const element of details.children) {
        if (element.tagName === 'SUMMARY') continue;
        if (details.open) animate(element, { duration: 220, distance: 4 });
        else cancel(element);
      }
    });
  });
  // Focus never lands in a half-revealed panel.
  document.addEventListener('focusin', event => {
    for (const element of active.keys()) if (element.contains(event.target)) cancel(element);
  });
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
  preference.addEventListener('change', start);
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  window.LoomMotion = {
    pulse: animate,
    watchBusy(element, value) {
      if (value) {
        busy.add(element);
        if (busyObserver && !preference.matches && !document.hidden && inView(element)) element.classList.add('is-visible-busy');
        busyObserver?.observe(element);
      } else {
        busy.delete(element);
        busyObserver?.unobserve(element);
        element.classList.remove('is-visible-busy');
      }
    }
  };
  start();
})();
