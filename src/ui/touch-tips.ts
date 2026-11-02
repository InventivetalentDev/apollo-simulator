// Touch screens have no hover, so the `title` text on the DSKY's lamps and
// labels, the status lamps and the short forms (<abbr>) never shows there. A tap
// on one of them shows that text in a small bubble next to it instead. Controls
// (buttons, links, tabs) keep their tap action and show no bubble.

const CONTROL = 'button, a, input, select, textarea, label, summary, [role="button"], [role="radio"], [role="tab"]';
const GAP = 8; // px between the element and the bubble, and between the bubble and the window edge

/** Shows `title` text on a tap for taps inside `root`. */
export function setUpTouchTips(root: HTMLElement): void {
  const noHover = matchMedia('(hover: none)');
  const usePopover = 'showPopover' in HTMLElement.prototype;
  const tip = document.createElement('div');
  tip.className = 'touch-tip';
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-live', 'polite');
  if (usePopover) tip.popover = 'manual';
  else tip.hidden = true;
  document.body.append(tip);

  let owner: HTMLElement | null = null;
  let lastPointer = '';

  const hide = (): void => {
    if (!owner) return;
    owner = null;
    if (usePopover) tip.hidePopover();
    else tip.hidden = true;
  };

  const show = (el: HTMLElement): void => {
    hide();
    owner = el;
    tip.textContent = el.title;
    // On a phone the guide is a modal dialog and the page behind it is inert, so a bubble
    // for something in the guide goes into the guide.
    (el.closest('dialog[open]') ?? document.body).append(tip);
    if (usePopover) tip.showPopover();
    else tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const below = r.bottom + GAP + h <= innerHeight - GAP;
    tip.dataset.side = below ? 'below' : 'above';
    tip.style.left = `${Math.max(GAP, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - GAP))}px`;
    tip.style.top = `${below ? r.bottom + GAP : Math.max(GAP, r.top - GAP - h)}px`;
  };

  // A mouse click on a touch laptop shows the usual hover text, so only taps count.
  root.addEventListener('pointerdown', (e) => (lastPointer = e.pointerType), true);
  // Listening on the page's own root, not on document: iOS Safari sends a tap on plain
  // text only to elements that have a click handler of their own.
  root.addEventListener('click', (e) => {
    const target = e.target as Element;
    const el = target.closest<HTMLElement>('[title]');
    if (!(noHover.matches || lastPointer === 'touch') || !el?.title || target.closest(CONTROL) || el === owner) {
      hide();
      return;
    }
    show(el);
  });
  tip.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  // Close with the guide, and when the element moves away. The listing scrolls by itself
  // while the computer runs, so only a scroll that moves the element counts.
  document.addEventListener('close', hide, true);
  addEventListener('resize', hide);
  addEventListener('scroll', (e) => owner && (e.target as Node).contains(owner) && hide(), { capture: true, passive: true });
}
