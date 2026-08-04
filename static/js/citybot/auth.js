/* ========================= 7. Authentication and User Display =========================== */
    /**
     * AUTHENTICATION APPROACH:
     * - Do NOT use config.CURRENT_USER for authentication (unreliable, static)
     * - Always fetch username dynamically from /api/auth/check API
     * - Store in window.currentAuthenticatedUser (global variable)
     * - Use this variable when sending messages to LLM for user isolation
     * - Always include credentials: 'include' in fetch requests to send session cookies
     */
    
    // Global variable to store current authenticated user
    window.currentAuthenticatedUser = null;
    window.currentUserId = null; // numeric PK from users table

    // Generate a unique session ID on every page load (including refresh).
    // A plain variable (no storage) guarantees a fresh UUID each time the page loads.
    window.chatSessionId = crypto.randomUUID();
    
    // Display current user
    const userNameEl = document.getElementById('userName');
    const logoutBtn = document.getElementById('logoutBtn');
    
    // Fetch real user from server (NEVER trust static config for auth!)
    (async function loadCurrentUser() {
      try {        const response = await fetch('/api/auth/check', {
          credentials: 'include' // CRITICAL: Include session cookies
        });
        const data = await response.json();        
        if (data.authenticated && data.email) {
          window.currentAuthenticatedUser = data.email;
          window.currentUserId = data.userId ?? null; // numeric PK
          
          // Display full name in UI (or email if no full name)
          const displayName = data.name || data.email;
          userNameEl.textContent = displayName;
          // Notify the server that a new browser session has started so it clears
          // any stale selected-building state left over from the previous page load.
          fetch('/api/session/start', {
            method: 'POST',
            credentials: 'include'
          }).then(() => {
            window.llmSelectedBuilding = null;
          }).catch(e => console.warn('session/start failed:', e));
        } else {
          console.warn('⚠️ Not authenticated, redirecting to login...');
          window.location.href = '/login';
        }
      } catch (error) {
        console.error('❌ Failed to check authentication:', error);
        userNameEl.textContent = 'Error';
        setTimeout(() => window.location.href = '/login', 2000);
      }
    })();
    
    // Logout button handler
    logoutBtn.addEventListener('click', async () => {
      try {
        const response = await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include' // Include session cookies
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
    
    // Add hover effect to logout button
    logoutBtn.addEventListener('mouseenter', () => {
      logoutBtn.style.background = 'rgba(255,255,255,0.3)';
    });
    logoutBtn.addEventListener('mouseleave', () => {
      logoutBtn.style.background = 'rgba(255,255,255,0.2)';
    });
