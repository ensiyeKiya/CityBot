// Readiness includes event subscriptions: an HTTP client alone cannot receive replies.
let transportReady = false;
let initialized = false;
let busy = false;

function updateControls() {
  window.citybotReady = initialized && transportReady && !!window.llmThing;
  for (const id of ['messageInput', 'sendButton', 'micButton', 'presetMenuButton']) {
    const control = document.getElementById(id);
    if (control) control.disabled = !window.citybotReady || busy;
  }
  const status = document.getElementById('connectionStatus');
  if (status && window.citybotReady) status.textContent = 'Connected';
}

window.setCitybotConnection = function(ready, message = 'Connecting…') {
  initialized = ready;
  const status = document.getElementById('connectionStatus');
  if (status) status.textContent = message;
  updateControls();
};
window.setCitybotTransportReady = function(ready) {
  transportReady = ready;
  if (!ready) {
    const status = document.getElementById('connectionStatus');
    if (status) status.textContent = 'Reconnecting…';
  }
  updateControls();
};
window.setCitybotBusy = function(value) {
  busy = value;
  updateControls();
};
window.requireCitybotReady = function() {
  if (busy) {
    window.addMessage?.('Please wait for the current response to finish.');
    return false;
  }
  if (window.citybotReady && typeof window.llmThing?.invokeAction === 'function') return true;
  window.addMessage?.('CityBot is still connecting. Please wait until the status says Connected.');
  return false;
};
updateControls();
