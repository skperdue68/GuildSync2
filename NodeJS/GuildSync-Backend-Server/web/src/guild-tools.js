export const GUILD_TOOLS = Object.freeze([
  {name: 'Smart Chat Messages', description: 'Create and manage scheduled chat messages', url: 'https://scm.perdues.me/', icon: '✦'},
  {name: 'Guild’s Bounty', description: 'Share items with your guild members', url: 'https://guildsbounty.perdues.me/', icon: '◆'},
  {name: 'Application & Welcome Messages', description: 'Manage application emails and welcome messages', url: 'https://gsa.perdues.me/', icon: '✉'},
  {name: 'Guild Chat Logs', description: 'View and search guild chat history', url: 'https://mafia.perdues.me/', icon: '☷'},
].map(Object.freeze));

export function renderGuildTools() {
  return `<div class="guild-tool-list">${GUILD_TOOLS.map((tool, index) => `<a class="guild-tool-link" href="${tool.url}" target="_blank" rel="noopener noreferrer"><span class="guild-tool-icon tool-color-${index}" aria-hidden="true">${tool.icon}</span><span class="guild-tool-copy"><strong>${tool.name}</strong><small>${tool.description}</small><small class="guild-tool-domain">${new URL(tool.url).hostname}</small></span><span aria-hidden="true">↗</span></a>`).join('')}</div>`;
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
  const tools = document.createElement('details');
  tools.className = 'profile-disclosure profile-tools-section';
  tools.dataset.profileSection = 'tools';
  tools.innerHTML = `<summary>Guild Tools <span aria-hidden="true">⌄</span></summary>${renderGuildTools()}<p class="guild-tools-error" role="status"></p>`;
  const management = card.querySelector('.profile-user-management-section');
  (management || settings || title).after(tools);
  const collapse = (element, key, label) => {
    if (!element) return;
    const details = document.createElement('details');
    details.className = 'profile-disclosure';
    details.dataset.profileSection = key;
    const summary = document.createElement('summary');
    summary.textContent = label;
    element.before(details);
    details.append(summary, element);
  };
  collapse(card.querySelector('.profile-filewatch-section'), 'watch', 'SavedVariables & File Watch');
  collapse(card.querySelector('#voiceHotkeyMount'), 'desktop', 'Desktop & Voice');
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
  wireGuildToolLinks(tools, openExternal);
}
