/**
 * CityBot browser app entry point.
 * Loads feature modules in dependency order (each attaches handlers to window/DOM).
 */
import './cesium.js';
import './state.js';
import './events.js';
import './wot.js';
import './bootstrap.js';
import './chat.js';
import './camera.js';
import './auth.js';
import './ready.js';

if (typeof window.WoT === 'undefined') {
  console.error('Failed to load WoT library from CDN');
}
