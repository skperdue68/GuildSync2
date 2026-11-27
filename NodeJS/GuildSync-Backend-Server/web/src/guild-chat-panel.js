export const GUILD_CHAT_URL = 'https://mafia.perdues.me/';
export const GUILD_CHAT_EMBED_URL = `${GUILD_CHAT_URL}?embedded=1`;
const externalIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/></svg>';

export function createGuildChatPanel({web = false, openExternal, onError = () => {}} = {}) {
  const wired = new WeakSet();
  function render() {
    const external = web
      ? `<a class="refresh-discord-button guild-chat-external-button" href="${GUILD_CHAT_URL}" target="_blank" rel="noopener noreferrer">${externalIcon}Open in new tab</a>`
      : `<button class="refresh-discord-button guild-chat-external-button" type="button" data-guild-chat-external>${externalIcon}Open in browser</button>`;
    return `<section class="guildsync-tab-panel guild-chat-panel" data-active-tab="guild-chat" aria-label="Guild Chat">
      <div class="guild-chat-toolbar"><h2>Guild Chat</h2>${external}</div>
      <iframe class="guild-chat-frame" src="${GUILD_CHAT_EMBED_URL}" title="Alphabet Mafia guild chat archive" allow="clipboard-write" referrerpolicy="strict-origin-when-cross-origin"></iframe>
    </section>`;
  }
  function wire(root) {
    const button = root?.querySelector('[data-guild-chat-external]');
    if (!button || wired.has(button)) return;
    wired.add(button);
    button.addEventListener('click', async () => {
      try { await openExternal(GUILD_CHAT_URL); }
      catch (error) { onError(error); }
    });
  }
  return {render, wire};
}
