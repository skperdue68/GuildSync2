const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

// Desktop-only profile controls: window/tray behaviour, login item and the
// in-client update check. Everything that touches the host lives in Go; this
// module only renders the result and forwards the user's choices.
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

  async function saveCloseToTray(enabled) {
    try { prefs = await bridge.SetCloseToTray(enabled); message = enabled ? 'Closing GuildSync will keep it running in the tray.' : 'Closing GuildSync will quit it.'; }
    catch (error) { message = String(error); }
    notify();
  }

  async function saveStartAtLogin(enabled) {
    try { prefs = await bridge.SetStartAtLogin(enabled); message = enabled ? 'GuildSync will start when you log in.' : 'GuildSync will no longer start at login.'; }
    catch (error) { message = String(error); }
    notify();
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
    const version = prefs.version && prefs.version !== 'dev' ? 'v' + prefs.version : 'development build';
    const trayNote = prefs.trayAvailable ? '' : '<p class="voice-hotkey-help">No system tray is available in this session, so closing quits GuildSync.</p>';
    const available = update?.available === true;
    const updateState = available ? 'Version ' + escapeHtml(update.latest) + ' available' : '';
    const downloadButton = available && update?.assetUrl
      ? `<button id="desktopDownloadUpdate" type="button" class="voice-hotkey-capture-button" ${busy ? 'disabled' : ''}>${busy === 'download' ? 'Downloading...' : 'Download & install ' + escapeHtml(update.latest)}</button>`
      : '';
    const notesButton = available && update?.pageUrl
      ? '<button id="desktopReleaseNotes" type="button" class="voice-hotkey-capture-button">Release notes</button>'
      : '';
    return `<div id="desktopControlsSection" class="profile-section"><div class="profile-section-header"><span>Desktop</span><span class="profile-section-subtitle">${escapeHtml(version)}</span></div><label class="profile-row voice-hotkey-row">Close button hides to tray <input id="desktopCloseToTray" type="checkbox" ${prefs.closeToTray ? 'checked' : ''} ${prefs.trayAvailable ? '' : 'disabled'}></label>${trayNote}<label class="profile-row voice-hotkey-row">Start GuildSync at login <input id="desktopStartAtLogin" type="checkbox" ${prefs.startAtLogin ? 'checked' : ''} ${prefs.startAtLoginSupported ? '' : 'disabled'}></label><div class="profile-row voice-hotkey-row">Updates <span>${updateState}</span></div><button id="desktopCheckUpdates" type="button" class="voice-hotkey-capture-button" ${busy ? 'disabled' : ''}>${busy === 'check' ? 'Checking...' : 'Check for updates'}</button>${downloadButton}${notesButton}<p id="desktopControlsStatus" class="voice-hotkey-help" role="status"></p></div>`;
  }

  async function openNotes() {
    try { await bridge.OpenReleasePage(); }
    catch (error) { message = String(error); notify(); }
  }

  function wire(menu) {
    menu.querySelector('#desktopCloseToTray')?.addEventListener('change', event => void saveCloseToTray(event.target.checked));
    menu.querySelector('#desktopStartAtLogin')?.addEventListener('change', event => void saveStartAtLogin(event.target.checked));
    menu.querySelector('#desktopCheckUpdates')?.addEventListener('click', () => void checkForUpdates());
    menu.querySelector('#desktopDownloadUpdate')?.addEventListener('click', () => void downloadUpdate());
    menu.querySelector('#desktopReleaseNotes')?.addEventListener('click', () => void openNotes());
    const status = menu.querySelector('#desktopControlsStatus');
    if (status) status.textContent = message;
  }

  return { initialize, render, wire };
}
