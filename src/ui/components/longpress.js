export function attachLongPress(el, onLongPress, duration = 450) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    clear();
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      onLongPress(e);
    }, duration);
  });

  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
      clear();
    }
  });

  el.addEventListener('pointerup', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener(
    'click',
    (e) => {
      if (fired) {
        e.stopImmediatePropagation();
        e.preventDefault();
        fired = false;
      }
    },
    true
  );
}
