// Profile-menu chrome shared by the desktop sections: keep the menu above the
// status bar (scrolling inside it when the window is short) and make the whole
// menu read-only while an admin is acting as another account.
let menuElement = null;
let resizeBound = false;

function measureMenu() {
  const menu = menuElement;
  if (!menu || typeof window === 'undefined' || !menu.classList?.contains('open')) return;
  const bar = document.querySelector('.status-bar');
  const limit = bar ? bar.getBoundingClientRect().top : window.innerHeight;
  const top = menu.getBoundingClientRect().top;
  if (top <= 0 || limit <= top) return;
  menu.style.maxHeight = Math.max(160, Math.floor(limit - top - 8)) + 'px';
}

// main.js renders "Return to my account" only while acting as someone else; every
// other control in the menu edits the acting account's settings, so lock them.
function applyReadOnly(menu) {
  if (!menu.querySelector('#returnToMyAccount')) return;
  menu.classList.add('profile-read-only');
  menu.querySelectorAll('button, input, select').forEach((control) => {
    if (control.id === 'returnToMyAccount') return;
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
  });
}

export function wireProfileMenuShell(menu) {
  if (!menu?.classList) return;
  applyReadOnly(menu);
  menuElement = menu;
  measureMenu();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measureMenu);
  if (!resizeBound && typeof window !== 'undefined') {
    resizeBound = true;
    window.addEventListener('resize', measureMenu);
  }
}
