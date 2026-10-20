// Embers drifting up behind the title screens and the game: gold ones, and every third a violet one.

/**
 * Fixed spreads rather than random ones, so a page looks the same on every visit. `slow` stretches every ember's
 * climb, for behind the game, where they should not catch the eye.
 */
export function fillEmbers(box: HTMLElement, count: number, slow = 1): void {
  for (let i = 0; i < count; i++) {
    const e = document.createElement('span');
    e.className = i % 3 === 0 ? 'hx-ember dusk' : 'hx-ember';
    e.style.setProperty('--x', `${(i * 37 + 11) % 100}%`);
    e.style.setProperty('--size', `${2 + (i % 3)}px`);
    e.style.setProperty('--drift', `${((i * 29) % 70) - 35}px`);
    e.style.animationDuration = `${((7 + ((i * 13) % 7)) * slow).toFixed(1)}s`;
    e.style.animationDelay = `${(-i * 1.37 * slow).toFixed(2)}s`;
    box.append(e);
  }
}
