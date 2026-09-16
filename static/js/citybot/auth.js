/**
 * Authentication — fetch session user before WoT/MQTT init.
 * Export authReady so bootstrap waits for currentUserId.
 */

window.currentAuthenticatedUser = null;
window.currentUserId = null;
window.chatSessionId = crypto.randomUUID();

const userNameEl = document.getElementById('userName');
const logoutBtn = document.getElementById('logoutBtn');

/** Never resolves when redirecting away from the app page. */
function hangUntilRedirect() {
  return new Promise(() => {});
}

export const authReady = (async function loadCurrentUser() {
  try {
    const response = await fetch('/api/auth/check', {
      credentials: 'include',
    });
    const data = await response.json();

    if (data.authenticated && data.email && data.userId != null) {
      window.currentAuthenticatedUser = data.email;
      window.currentUserId = data.userId;

      if (userNameEl) {
        userNameEl.textContent = data.name || data.email;
      }

      const resetResponse = await fetch('/api/session/start', {
        method: 'POST',
        credentials: 'include',
      });
      const reset = await resetResponse.json();
      if (!resetResponse.ok || !reset.success) {
        throw new Error(reset.message || 'Could not initialize a clean session. Refresh to retry.');
      }
      window.citybotResetReceipt = reset.reset;
      window.llmSelectedBuilding = null;

      return data;
    }

    console.warn('Not authenticated, redirecting to login...');
    window.location.href = '/login';
    return hangUntilRedirect();
  } catch (error) {
    console.error('Failed to check authentication:', error);
    if (userNameEl) userNameEl.textContent = 'Error';
    throw error;
  }
})();
// bootstrap observes the same rejected promise after Cesium initialization.
authReady.catch(() => {});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      const data = await response.json();
      if (data.success) {
        window.location.href = '/login';
      } else {
        console.error('Logout failed:', data.message);
        alert('Failed to logout. Please try again.');
      }
    } catch (error) {
      console.error('Logout error:', error);
      alert('Failed to logout. Please try again.');
    }
  });

  logoutBtn.addEventListener('mouseenter', () => {
    logoutBtn.style.background = 'rgba(255,255,255,0.3)';
  });
  logoutBtn.addEventListener('mouseleave', () => {
    logoutBtn.style.background = 'rgba(255,255,255,0.2)';
  });
}
