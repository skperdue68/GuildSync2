// Each icon is the mark its own site ships, inlined so both clients draw the same
// picture without an asset hop and every one lands in the same 22px box. Guild’s
// Bounty ships square artwork rather than a mark, so it is scaled to a 48px PNG and
// inlined the same way.
const BOUNTY_ICON = 'data:image/png;base64,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';

const TOOL_ICONS = Object.freeze({
  // SmartChatMsg-Web/public/logo.svg
  scm: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gsToolScm" x2="1" y2="1"><stop stop-color="#74b8ed"/><stop offset="1" stop-color="#7b86d9"/></linearGradient></defs><rect width="64" height="64" rx="17" fill="#17243e"/><path d="M14 15h30a7 7 0 0 1 7 7v15a7 7 0 0 1-7 7H27l-12 9v-12a7 7 0 0 1-5-7V22a7 7 0 0 1 4-7Z" fill="none" stroke="url(#gsToolScm)" stroke-width="3"/><path d="M19 25h15m-15 7h9" stroke="#c6d9ef" stroke-width="3" stroke-linecap="round"/><circle cx="44" cy="43" r="14" fill="#d7c38b" stroke="#101827" stroke-width="3"/><path d="M44 35v8l5 3" fill="none" stroke="#17243e" stroke-width="3" stroke-linecap="round"/></svg>',
  bounty: `<img class="guild-tool-icon-image" src="${BOUNTY_ICON}" alt="" width="48" height="48">`,
  // GuildSyncApplications-Web/public/logo.svg
  applications: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path fill="#d8b771" d="M32 2 58 13v20c0 15-26 29-26 29S6 48 6 33V13z"/><path fill="#132436" d="m32 7 21 9v17c0 10-15 21-21 25-6-4-21-15-21-25V16z"/><path fill="none" stroke="#d8b771" stroke-width="3" d="M42 25c-3-7-18-7-20 4-3 14 17 17 20 6H32"/><path fill="#d8b771" d="m32 12 2 4-2 4-2-4z"/></svg>',
  // The chat archive has no icon file; this is its brand tile from mafia/styles.css.
  chat: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gsToolChat" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#3B82F6"/><stop offset="1" stop-color="#2563EB"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#gsToolChat)"/><path d="M18 20h28a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H31l-9 7v-7h-4a4 4 0 0 1-4-4V24a4 4 0 0 1 4-4z" fill="#fff" opacity=".92"/></svg>',
});

export const GUILD_TOOLS = Object.freeze([
  {name: 'Smart Chat Messages', description: 'Create and manage scheduled chat messages', url: 'https://scm.perdues.me/', icon: TOOL_ICONS.scm},
  {name: 'Guild’s Bounty', description: 'Share items with your guild members', url: 'https://guildsbounty.perdues.me/', icon: TOOL_ICONS.bounty},
  {name: 'Application & Welcome Messages', description: 'Manage application emails and welcome messages', url: 'https://gsa.perdues.me/', icon: TOOL_ICONS.applications},
  {name: 'Guild Chat Logs', description: 'View and search guild chat history', url: 'https://mafia.perdues.me/', icon: TOOL_ICONS.chat},
].map(Object.freeze));

export function renderGuildTools() {
  return `<div class="guild-tool-list">${GUILD_TOOLS.map((tool) => `<a class="guild-tool-link" href="${tool.url}" target="_blank" rel="noopener noreferrer"><span class="guild-tool-icon" aria-hidden="true">${tool.icon}</span><span class="guild-tool-copy"><strong>${tool.name}</strong><small>${tool.description}</small><small class="guild-tool-domain">${new URL(tool.url).hostname}</small></span><span aria-hidden="true">↗</span></a>`).join('')}</div>`;
}

export function wireGuildToolLinks(root, openExternal) {
  root.querySelectorAll('.guild-tool-link').forEach(link => {
    link.addEventListener('click', event => {
      // Web uses the browser's normal safe new-tab behavior.
      if (!openExternal) return;
      event.preventDefault();
      void Promise.resolve().then(() => openExternal(link.href)).catch(error => {
        const status = root.querySelector('.guild-tools-error');
        if (status) status.textContent = 'Could not open your browser. Please try again.';
        console.error('Could not open guild tool', error);
      });
    });
  });
}

let removeLauncherListeners = () => {};
export function resetGuildToolsLauncher() {
  removeLauncherListeners();
  removeLauncherListeners = () => {};
}

export function wireGuildToolsLauncher(area, {openExternal, closeProfile}) {
  resetGuildToolsLauncher();
  const launcher = document.createElement('details');
  launcher.className = 'guild-tools-launcher';
  launcher.innerHTML = `<summary aria-label="Guild tools"><span aria-hidden="true">▦</span> Tools <span aria-hidden="true">⌄</span></summary><section class="guild-tools-popup" aria-label="Guild tools"><div class="guild-tools-heading">Guild Tools</div><p class="guild-tools-caption">Your guild tools, all in one place</p>${renderGuildTools()}<p class="guild-tools-error" role="status"></p></section>`;
  const wrap = area.querySelector('.discord-profile-wrap');
  wrap.prepend(launcher);
  wireGuildToolLinks(launcher, openExternal);
  const trigger = launcher.querySelector('summary');
  launcher.addEventListener('toggle', () => {if (launcher.open) closeProfile();});
  const outside = event => {if (!launcher.contains(event.target)) launcher.open = false;};
  const escape = event => {
    if (event.key === 'Escape' && launcher.open) {
      launcher.open = false;
      trigger.focus();
    }
  };
  document.addEventListener('click', outside);
  document.addEventListener('keydown', escape);
  removeLauncherListeners = () => {
    document.removeEventListener('click', outside);
    document.removeEventListener('keydown', escape);
  };
}

export function decorateProfileMenu(menu, {openExternal, openSections = new Set(), onDesktopClose = () => {}}) {
  const card = menu.querySelector('.profile-card');
  const settings = card.querySelector('.profile-user-settings-mount');
  const title = card.querySelector('.profile-card-title');
  const rows = [...card.querySelectorAll(':scope > .profile-row')];
  const name = rows[0]?.querySelector('.profile-value')?.textContent;
  if (name && title) {
    title.textContent = name;
    rows[0].remove();
  }
  if (settings && title) (rows.at(-1) || title).after(settings);
  const collapse = (element, key, label) => {
    if (!element) return;
    const details = document.createElement('details');
    details.className = 'profile-disclosure';
    details.dataset.profileSection = key;
    const summary = document.createElement('summary');
    summary.textContent = label;
    element.before(details);
    details.append(summary, element);
    // A section the server did not grant renders nothing; it must not leave a
    // summary behind that opens onto an empty pane.
    const syncPresence = () => {
      details.hidden = element.children.length === 0 && element.textContent.trim() === '';
    };
    syncPresence();
    new MutationObserver(syncPresence).observe(element, {childList: true, subtree: true, characterData: true});
  };
  collapse(card.querySelector('.profile-filewatch-section'), 'watch', 'SavedVariables & File Watch');
  collapse(card.querySelector('#voiceHotkeyMount'), 'desktop', 'Voice');
  const switchControl = card.querySelector('#switchGuildSyncAccount');
  collapse(switchControl?.closest('.profile-section'), 'switch', 'Switch Account');
  menu.querySelectorAll('[data-profile-section]').forEach(section => {
    const key = section.dataset.profileSection;
    section.open = openSections.has(key);
    section.addEventListener('toggle', () => {
      if (section.open) openSections.add(key); else {
        openSections.delete(key);
        if (key === 'desktop') onDesktopClose();
      }
    });
  });
}
