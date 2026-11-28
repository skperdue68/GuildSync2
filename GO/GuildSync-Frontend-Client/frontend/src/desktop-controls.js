const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

// Desktop-only profile controls: the in-client update check. Everything that
// touches the host lives in Go; this module only renders the result and forwards
// the user's choices. Tray and login-item choices live with the rows they belong
// to at the top of the profile menu.
export function createDesktopControls({ bridge, changed = () => {} }) {
  let prefs = null;
  let update = null;
  let busy = '';
  let message = '';
  let initialized = false;
  let loading = false;
  // Bindings generated before this section existed should hide it rather than
  // raise on every open.
  const supported = typeof bridge?.GetDesktopPreferences === 'function';
  const notify = () => changed();

  async function initialize() {
    if (!supported || initialized || loading) return;
    loading = true;
    try {
      prefs = await bridge.GetDesktopPreferences();
      // Show the cached result immediately; the network check only runs on demand.
      try { update = await bridge.CheckForUpdate(false); } catch {}
    } catch (error) {
      message = String(error);
    } finally {
      initialized = true;
      loading = false;
      notify();
    }
  }

  async function checkForUpdates() {
    busy = 'check'; message = 'Checking for updates...'; notify();
    try {
      update = await bridge.CheckForUpdate(true);
      message = update?.message || '';
    } catch (error) { message = String(error); }
    busy = ''; notify();
  }

  async function downloadUpdate() {
    busy = 'download'; message = 'Downloading version ' + (update?.latest || 'update') + '...'; notify();
    try {
      const path = await bridge.DownloadUpdate();
      message = 'Saved ' + path + ' and opened it. Run the installer inside to update.';
    } catch (error) { message = String(error); }
    busy = ''; notify();
  }

  function render() {
    if (!supported) return '';
    if (!prefs) { void initialize(); return ''; }
    const available = update?.available === true;
    const updateState = available ? 'Version ' + escapeHtml(update.latest) + ' available' : '';
    const downloadButton = available && update?.assetUrl
      ? `<button id="desktopDownloadUpdate" type="button" class="voice-hotkey-capture-button" ${busy ? 'disabled' : ''}>${busy === 'download' ? 'Downloading...' : 'Download ' + escapeHtml(update.latest)}</button>`
      : '';
    const notesButton = available && update?.pageUrl
      ? '<button id="desktopReleaseNotes" type="button" class="voice-hotkey-capture-button">Release notes</button>'
      : '';
    return `<div id="desktopControlsSection" class="profile-section"><div class="profile-section-header"><span>Updates</span></div><div class="profile-row voice-hotkey-row"><span class="voice-hotkey-keys">${updateState}</span><button id="desktopCheckUpdates" type="button" class="voice-hotkey-capture-button" ${busy ? 'disabled' : ''}>${busy === 'check' ? 'Checking...' : 'Check for updates'}</button></div>${downloadButton}${notesButton}<p id="desktopControlsStatus" class="voice-hotkey-help" role="status"></p></div>`;
  }

  async function openNotes() {
    try { await bridge.OpenReleasePage(); }
    catch (error) { message = String(error); notify(); }
  }

  function wire(menu) {
    menu.querySelector('#desktopCheckUpdates')?.addEventListener('click', () => void checkForUpdates());
    menu.querySelector('#desktopDownloadUpdate')?.addEventListener('click', () => void downloadUpdate());
    menu.querySelector('#desktopReleaseNotes')?.addEventListener('click', () => void openNotes());
    const status = menu.querySelector('#desktopControlsStatus');
    if (status) status.textContent = message;
  }

  return { initialize, render, wire };
}
