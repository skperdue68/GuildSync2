// Each icon is the mark its own site ships, inlined so both clients draw the same
// picture without an asset hop and every one lands in the same 22px box.
// GuildsBounty-Web/public/brand/mark.svg is wider than it is tall, so it sits scaled
// on its brand tile to keep the same square footprint as the other three.
const BOUNTY_MARK = '<g stroke="#f1573c" stroke-width="5.5" stroke-linecap="round" fill="none"><path d="M100 16v13"/><path d="M86 21l7 12"/><path d="M114 21l-7 12"/></g><g fill="#12a08f"><circle cx="40" cy="42" r="23"/><path d="M12 114c0-28 10-46 30-46 17 0 26 11 29 25l3 21z"/></g><path d="M52 92c13 2 24 4 32 5" stroke="#12a08f" stroke-width="14" stroke-linecap="round" fill="none"/><g fill="#f1573c"><circle cx="160" cy="42" r="23"/><path d="M188 114c0-28-10-46-30-46-17 0-26 11-29 25l-3 21z"/></g><path d="M148 92c-13 2-24 4-32 5" stroke="#f1573c" stroke-width="14" stroke-linecap="round" fill="none"/><g><path d="M100 62c-2-13-15-13-14-3 1 6 9 7 14 3z" fill="#f1573c"/><path d="M100 62c2-13 15-13 14-3-1 6-9 7-14 3z" fill="#f1573c"/><rect x="82" y="64" width="36" height="38" rx="6" fill="#12a08f"/><rect x="96" y="64" width="8" height="38" fill="#f1573c"/><circle cx="100" cy="64" r="4.5" fill="#d9462f"/></g><g fill="#12a08f"><circle cx="86" cy="97" r="8"/></g><g fill="#f1573c"><circle cx="114" cy="97" r="8"/></g><g fill="none" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round"><path d="M29 38q5-6 10 0"/><path d="M42 38q5-6 10 0"/><path d="M149 38q5-6 10 0"/><path d="M162 38q5-6 10 0"/></g><g fill="#ffffff"><path d="M33 47c2 12 16 12 18 0-6 5-12 5-18 0z"/><path d="M149 47c2 12 16 12 18 0-6 5-12 5-18 0z"/></g>';

const TOOL_ICONS = Object.freeze({
  // SmartChatMsg-Web/public/logo.svg
  scm: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="gsToolScm" x2="1" y2="1"><stop stop-color="#74b8ed"/><stop offset="1" stop-color="#7b86d9"/></linearGradient></defs><rect width="64" height="64" rx="17" fill="#17243e"/><path d="M14 15h30a7 7 0 0 1 7 7v15a7 7 0 0 1-7 7H27l-12 9v-12a7 7 0 0 1-5-7V22a7 7 0 0 1 4-7Z" fill="none" stroke="url(#gsToolScm)" stroke-width="3"/><path d="M19 25h15m-15 7h9" stroke="#c6d9ef" stroke-width="3" stroke-linecap="round"/><circle cx="44" cy="43" r="14" fill="#d7c38b" stroke="#101827" stroke-width="3"/><path d="M44 35v8l5 3" fill="none" stroke="#17243e" stroke-width="3" stroke-linecap="round"/></svg>',
  bounty: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" rx="24" fill="#10241f"/><g transform="translate(5 27) scale(.55)">${BOUNTY_MARK}</g></svg>`,
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
